//! Реестр открытых документов.
//!
//! Фронтенд никогда не передаёт в Rust пути к файлам. Rust сам открывает
//! файл, который выбрал пользователь (в диалоге или в командной строке), и
//! отдаёт фронтенду только [`DocumentId`]. Дальше фронтенд может сохранить или
//! закрыть документ по этому идентификатору, и больше ничего.
//!
//! Так даже чужой скрипт, если он выполнится в `WebView` (например, из HTML
//! внутри открытого Markdown), не сможет прочитать произвольный файл с диска
//! или записать в него: доступны только файлы, которые открыл сам пользователь.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::disk::{self, DiskState};
use crate::document::{self, LineEnding, TextFormat};
use crate::error::AppError;

/// Идентификатор открытого документа.
///
/// Обёртка над `u64` (newtype) не даёт перепутать его с другим числом, а
/// `serde(transparent)` передаёт его во фронтенд просто числом.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(u64);

impl fmt::Display for DocumentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{}", self.0)
    }
}

/// Что Rust помнит об открытом документе. Сам текст здесь не хранится:
/// он живёт в редакторе и приходит целиком при сохранении.
#[derive(Debug)]
struct Entry {
    path: PathBuf,
    format: TextFormat,
    /// Отпечаток байтов на диске после последнего чтения или записи.
    disk_hash: u64,
}

/// Открытый документ, как его видит фронтенд.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub id: DocumentId,
    /// Путь для показа пользователю. Для операций с файлом он не нужен.
    pub path: String,
    pub file_name: String,
    pub text: String,
    #[serde(flatten)]
    pub format: FormatInfo,
}

/// Формат файла для строки состояния.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub line_ending: LineEnding,
    pub has_bom: bool,
    pub mixed_line_endings: bool,
}

impl From<TextFormat> for FormatInfo {
    fn from(format: TextFormat) -> Self {
        Self {
            line_ending: format.line_ending,
            has_bom: format.has_bom,
            mixed_line_endings: format.mixed_line_endings,
        }
    }
}

/// Реестр. Tauri хранит один его экземпляр в состоянии приложения
/// (`app.manage`), а команды получают к нему доступ из разных потоков, поэтому
/// изменяемые данные защищены мьютексом, а счётчик атомарный.
#[derive(Debug, Default)]
pub struct Documents {
    next_id: AtomicU64,
    entries: Mutex<HashMap<DocumentId, Entry>>,
}

impl Documents {
    /// Читает файл с диска и регистрирует его.
    pub fn open(&self, path: &Path) -> Result<OpenedDocument, AppError> {
        // Относительный путь (из командной строки) превращаем в абсолютный
        // сразу: рабочая папка процесса потом может смениться. Симлинки при
        // этом не раскрываются, пользователь видит путь, который указал.
        let path = std::path::absolute(path).map_err(|source| AppError::Read {
            path: path.to_owned(),
            source,
        })?;

        let bytes = disk::read(&path)?;
        let decoded = document::decode(&bytes).map_err(|source| AppError::Decode {
            path: path.clone(),
            source,
        })?;

        // Relaxed достаточно: от счётчика нужна только уникальность,
        // порядок относительно других операций памяти не важен.
        let id = DocumentId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let opened = OpenedDocument {
            id,
            path: path.display().to_string(),
            file_name: display_name(&path),
            text: decoded.text,
            format: decoded.format.into(),
        };
        self.lock().insert(
            id,
            Entry {
                path,
                format: decoded.format,
                disk_hash: disk::content_hash(&bytes),
            },
        );
        Ok(opened)
    }

    /// Сохраняет текст документа на диск в его исходном формате.
    ///
    /// Без `force` сначала проверяет, что файл на диске не изменился и не
    /// исчез с момента открытия или прошлого сохранения. Иначе возвращает
    /// [`AppError::ModifiedOnDisk`] или [`AppError::MissingOnDisk`], чтобы
    /// пользователь решил, перезаписывать ли чужие изменения.
    pub fn save(&self, id: DocumentId, text: &str, force: bool) -> Result<FormatInfo, AppError> {
        // Берём копию нужных данных и сразу отпускаем мьютекс (временный
        // guard уничтожается в конце выражения). Работа с диском идёт уже без
        // блокировки, и медленная запись не задерживает другие команды.
        let (path, format, disk_hash) = {
            let entries = self.lock();
            let entry = entries.get(&id).ok_or(AppError::UnknownDocument(id))?;
            (entry.path.clone(), entry.format, entry.disk_hash)
        };

        if !force {
            match disk::disk_state(&path, disk_hash)? {
                DiskState::Unchanged => {}
                DiskState::Modified => return Err(AppError::ModifiedOnDisk { path }),
                DiskState::Missing => return Err(AppError::MissingOnDisk { path }),
            }
        }

        // После сохранения переводы строк гарантированно одного вида.
        let format = TextFormat {
            mixed_line_endings: false,
            ..format
        };
        let bytes = document::encode(text, format);
        let new_hash = disk::content_hash(&bytes);

        // Если содержимое совпадает с диском, файл не трогаем: не меняем время
        // изменения и не будим программы, которые за ним следят. С `force`
        // пишем всегда — файл могли удалить, и его нужно создать заново.
        if force || new_hash != disk_hash {
            disk::write(&path, &bytes)?;
        }

        // Документ могли закрыть, пока шла запись. Тогда обновлять нечего.
        if let Some(entry) = self.lock().get_mut(&id) {
            entry.disk_hash = new_hash;
            entry.format = format;
        }
        Ok(format.into())
    }

    /// Забывает документ. Закрыть уже закрытый документ — не ошибка.
    pub fn close(&self, id: DocumentId) {
        self.lock().remove(&id);
    }

    /// Имя файла документа для диалогов.
    pub fn file_name(&self, id: DocumentId) -> Result<String, AppError> {
        self.lock()
            .get(&id)
            .map(|entry| display_name(&entry.path))
            .ok_or(AppError::UnknownDocument(id))
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<DocumentId, Entry>> {
        // Мьютекс «отравляется», если поток запаниковал, удерживая его.
        // Данные реестра при этом остаются согласованными (каждая операция —
        // одна вставка, замена или удаление), поэтому просто продолжаем.
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn display_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{Duration, SystemTime};

    use super::*;

    const CRLF_WITH_BOM: &[u8] = "\u{FEFF}# Заметка\r\n\r\n- пункт\r\n".as_bytes();

    /// Тестовые файлы создаются из кода, а не лежат в репозитории: git с
    /// `core.autocrlf` на Windows незаметно поменял бы в них переводы строк.
    fn file_with(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    /// Критерий готовности M1: файл с CRLF и BOM после «открыть → сохранить»
    /// совпадает с исходным побайтово. Проверяем и с реальной записью на диск:
    /// сначала сохраняем правку, потом возвращаем исходный текст.
    #[test]
    fn crlf_bom_file_survives_open_edit_save_roundtrip() {
        let (_dir, path) = file_with(CRLF_WITH_BOM);
        let documents = Documents::default();

        let opened = documents.open(&path).unwrap();
        assert_eq!(opened.text, "# Заметка\n\n- пункт\n");
        assert_eq!(opened.format.line_ending, LineEnding::CrLf);
        assert!(opened.format.has_bom);

        documents
            .save(opened.id, "# Заметка\n\n- пункт\n- ещё\n", false)
            .unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            "\u{FEFF}# Заметка\r\n\r\n- пункт\r\n- ещё\r\n".as_bytes()
        );

        documents.save(opened.id, &opened.text, false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), CRLF_WITH_BOM);
    }

    #[test]
    fn saving_unchanged_text_does_not_touch_the_file() {
        let (_dir, path) = file_with(CRLF_WITH_BOM);
        let old_time = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old_time)
            .unwrap();
        let documents = Documents::default();
        let opened = documents.open(&path).unwrap();

        documents.save(opened.id, &opened.text, false).unwrap();

        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old_time);
    }

    #[test]
    fn refuses_to_overwrite_external_changes_unless_forced() {
        let (_dir, path) = file_with(b"original\n");
        let documents = Documents::default();
        let opened = documents.open(&path).unwrap();
        fs::write(&path, "changed by another program\n").unwrap();

        let result = documents.save(opened.id, "mine\n", false);
        assert!(
            matches!(result, Err(AppError::ModifiedOnDisk { .. })),
            "{result:?}"
        );
        assert_eq!(fs::read(&path).unwrap(), b"changed by another program\n");

        documents.save(opened.id, "mine\n", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"mine\n");
        // После принудительной записи отпечаток обновлён: следующее обычное
        // сохранение проходит без вопросов.
        documents.save(opened.id, "mine again\n", false).unwrap();
    }

    #[test]
    fn deleted_file_is_reported_and_can_be_recreated() {
        let (_dir, path) = file_with(b"text\n");
        let documents = Documents::default();
        let opened = documents.open(&path).unwrap();
        fs::remove_file(&path).unwrap();

        let result = documents.save(opened.id, "text\n", false);
        assert!(
            matches!(result, Err(AppError::MissingOnDisk { .. })),
            "{result:?}"
        );

        documents.save(opened.id, "text\n", true).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"text\n");
    }

    #[test]
    fn saving_mixed_file_reports_normalized_format() {
        let (_dir, path) = file_with(b"a\r\nb\r\nc\n");
        let documents = Documents::default();
        let opened = documents.open(&path).unwrap();
        assert!(opened.format.mixed_line_endings);

        let format = documents.save(opened.id, "a\nb\nc\nd\n", false).unwrap();

        assert!(!format.mixed_line_endings);
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc\r\nd\r\n");
    }

    #[test]
    fn closed_or_unknown_documents_cannot_be_saved() {
        let (_dir, path) = file_with(b"text\n");
        let documents = Documents::default();
        let opened = documents.open(&path).unwrap();

        documents.close(opened.id);
        documents.close(opened.id);

        assert!(matches!(
            documents.save(opened.id, "x", false),
            Err(AppError::UnknownDocument(_))
        ));
    }

    #[test]
    fn open_reports_undecodable_files_with_path() {
        let (_dir, path) = file_with(b"caf\xE9\n");
        let error = Documents::default().open(&path).unwrap_err();
        assert_eq!(error.kind(), "decode");
        assert!(error.to_string().contains("note.md"), "{error}");
    }

    #[test]
    fn opened_document_serializes_flat_for_frontend() {
        let (_dir, path) = file_with(CRLF_WITH_BOM);
        let opened = Documents::default().open(&path).unwrap();
        let json = serde_json::to_value(&opened).unwrap();

        assert_eq!(json["id"], 1);
        assert_eq!(json["fileName"], "note.md");
        assert_eq!(json["lineEnding"], "CRLF");
        assert_eq!(json["hasBom"], true);
        assert_eq!(json["mixedLineEndings"], false);
    }
}
