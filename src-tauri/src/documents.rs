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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(u64);

impl DocumentId {
    /// Число внутри — например, для адреса картинки `mdimg://localhost/<id>/…`.
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for DocumentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "#{}", self.0)
    }
}

/// Разбор из строки: `"7".parse::<DocumentId>()`. Нужен протоколу картинок.
impl std::str::FromStr for DocumentId {
    type Err = std::num::ParseIntError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        s.parse().map(Self)
    }
}

/// Что Rust помнит об открытом документе. Сам текст здесь не хранится:
/// он живёт в редакторе и приходит целиком при сохранении.
#[derive(Debug)]
struct Entry {
    /// Путь, по которому файл открыли (для показа и записи).
    path: PathBuf,
    /// Канонический путь: все симлинки раскрыты, `.` и `..` убраны. Это
    /// «личность» файла — по ней узнаём, что он уже открыт, даже если его
    /// открывают по другому пути.
    identity: PathBuf,
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

/// Результат [`Documents::open`].
#[derive(Debug)]
pub enum Opened {
    /// Файл прочитан и зарегистрирован.
    New(OpenedDocument),
    /// Файл уже открыт; заново он не читался.
    AlreadyOpen(DocumentId),
}

/// Результат открытия одного файла из пачки, как его видит фронтенд:
/// `{ status: "opened", document }`, `{ status: "alreadyOpen", id }` или
/// `{ status: "failed", path, message }`.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OpenOutcome {
    Opened {
        document: OpenedDocument,
    },
    /// Фронтенду достаточно переключиться на вкладку этого документа.
    AlreadyOpen {
        id: DocumentId,
    },
    Failed {
        path: String,
        message: String,
    },
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
    ///
    /// Если файл уже открыт — в том числе по другому пути (через симлинк,
    /// относительный путь, `..`), — возвращает [`Opened::AlreadyOpen`] и
    /// файл заново не читает: у одного файла одна вкладка.
    pub fn open(&self, path: &Path) -> Result<Opened, AppError> {
        let read_error = |source| AppError::Read {
            path: path.to_owned(),
            source,
        };
        // Относительный путь (из командной строки) превращаем в абсолютный
        // сразу: рабочая папка процесса потом может смениться. Симлинки при
        // этом не раскрываются: пользователь видит путь, который указал.
        let path = std::path::absolute(path).map_err(read_error)?;
        let identity = std::fs::canonicalize(&path).map_err(read_error)?;
        if let Some(id) = find_by_identity(&self.lock(), &identity) {
            return Ok(Opened::AlreadyOpen(id));
        }

        let (decoded, disk_hash) = load(&path)?;

        let mut entries = self.lock();
        // Пока файл читался, его мог открыть другой поток (например, два
        // быстрых двойных клика по одному файлу). Проверяем ещё раз, уже под
        // замком, и только потом регистрируем.
        if let Some(id) = find_by_identity(&entries, &identity) {
            return Ok(Opened::AlreadyOpen(id));
        }
        // Relaxed достаточно: от счётчика нужна только уникальность,
        // порядок относительно других операций памяти не важен.
        let id = DocumentId(self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let format = decoded.format;
        let opened = opened_document(id, &path, decoded);
        entries.insert(
            id,
            Entry {
                path,
                identity,
                format,
                disk_hash,
            },
        );
        Ok(Opened::New(opened))
    }

    /// Перечитывает с диска все открытые документы, по порядку открытия.
    ///
    /// Нужен, когда перезагрузилась страница фронтенда (при разработке Vite
    /// перезагружает её после правок кода): вкладки пропали, а реестр ещё
    /// помнит файлы. Без этого повторное открытие такого файла вернуло бы
    /// «уже открыт» для вкладки, которой больше нет. Файлы, которые прочитать
    /// не удалось, из реестра убираются.
    pub fn reopen_all(&self) -> Vec<OpenOutcome> {
        let mut known: Vec<(DocumentId, PathBuf)> = self
            .lock()
            .iter()
            .map(|(&id, entry)| (id, entry.path.clone()))
            .collect();
        known.sort_unstable_by_key(|&(id, _)| id);

        known
            .into_iter()
            .map(|(id, path)| match self.reload(id) {
                Ok(document) => OpenOutcome::Opened { document },
                Err(err) => {
                    self.close(id);
                    OpenOutcome::Failed {
                        path: path.display().to_string(),
                        message: err.to_string(),
                    }
                }
            })
            .collect()
    }

    /// Перечитывает документ с диска: файл изменила другая программа, и
    /// пользователь согласился взять новую версию (или вкладка без правок
    /// обновляется сама). Дальше сохранение сравнивает диск уже с ней.
    pub fn reload(&self, id: DocumentId) -> Result<OpenedDocument, AppError> {
        let path = self
            .lock()
            .get(&id)
            .map(|entry| entry.path.clone())
            .ok_or(AppError::UnknownDocument(id))?;
        let (decoded, disk_hash) = load(&path)?;
        if let Some(entry) = self.lock().get_mut(&id) {
            entry.format = decoded.format;
            entry.disk_hash = disk_hash;
        }
        Ok(opened_document(id, &path, decoded))
    }

    /// Канонические пути всех открытых файлов: за их папками следит
    /// `watcher.rs`.
    pub fn identities(&self) -> Vec<PathBuf> {
        self.lock()
            .values()
            .map(|entry| entry.identity.clone())
            .collect()
    }

    /// Состояние на диске документов с каноническим путём `identity`
    /// (обычно такой документ один). Читает файлы, поэтому мьютекс на время
    /// чтения отпускается. Файлы, которые не удалось прочитать (например,
    /// нет прав), пропускаются: о них нечего сообщить.
    pub fn disk_states_at(&self, identity: &Path) -> Vec<(DocumentId, DiskState)> {
        let matching: Vec<(DocumentId, PathBuf, u64)> = self
            .lock()
            .iter()
            .filter(|(_, entry)| entry.identity == identity)
            .map(|(&id, entry)| (id, entry.path.clone(), entry.disk_hash))
            .collect();
        matching
            .into_iter()
            .filter_map(|(id, path, hash)| match disk::disk_state(&path, hash) {
                Ok(state) => Some((id, state)),
                Err(err) => {
                    log::warn!("не удалось проверить файл: {err}");
                    None
                }
            })
            .collect()
    }

    /// Открывает несколько файлов. Ошибка с одним не мешает открыть остальные.
    pub fn open_all(&self, paths: &[PathBuf]) -> Vec<OpenOutcome> {
        paths
            .iter()
            .map(|path| match self.open(path) {
                Ok(Opened::New(document)) => OpenOutcome::Opened { document },
                Ok(Opened::AlreadyOpen(id)) => OpenOutcome::AlreadyOpen { id },
                Err(err) => OpenOutcome::Failed {
                    path: path.display().to_string(),
                    message: err.to_string(),
                },
            })
            .collect()
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

    /// Папка документа: от неё считаются относительные пути картинок и ссылок.
    pub fn directory(&self, id: DocumentId) -> Result<PathBuf, AppError> {
        self.lock()
            .get(&id)
            .map(|entry| entry.path.parent().unwrap_or(&entry.path).to_owned())
            .ok_or(AppError::UnknownDocument(id))
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<DocumentId, Entry>> {
        // Мьютекс «отравляется», если поток запаниковал, удерживая его.
        // Данные реестра при этом остаются согласованными (каждая операция —
        // одна вставка, замена или удаление), поэтому просто продолжаем.
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Читает и разбирает файл. Возвращает текст с форматом и отпечаток байтов.
fn load(path: &Path) -> Result<(document::Decoded, u64), AppError> {
    let bytes = disk::read(path)?;
    let decoded = document::decode(&bytes).map_err(|source| AppError::Decode {
        path: path.to_owned(),
        source,
    })?;
    Ok((decoded, disk::content_hash(&bytes)))
}

fn opened_document(id: DocumentId, path: &Path, decoded: document::Decoded) -> OpenedDocument {
    OpenedDocument {
        id,
        path: path.display().to_string(),
        file_name: display_name(path),
        text: decoded.text,
        format: decoded.format.into(),
    }
}

/// Ищет документ по каноническому пути. Перебор, а не отдельный индекс:
/// открытых файлов единицы, а две структуры пришлось бы держать в согласии.
fn find_by_identity(entries: &HashMap<DocumentId, Entry>, identity: &Path) -> Option<DocumentId> {
    entries
        .iter()
        .find(|(_, entry)| entry.identity == identity)
        .map(|(&id, _)| id)
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

    /// Открывает файл, который ещё не открыт, и возвращает документ.
    fn open_new(documents: &Documents, path: &Path) -> OpenedDocument {
        match documents.open(path) {
            Ok(Opened::New(document)) => document,
            other => panic!("ожидали новый документ, получили {other:?}"),
        }
    }

    #[test]
    fn reopening_returns_the_same_document() {
        let (dir, path) = file_with(b"text\n");
        let documents = Documents::default();
        let opened = open_new(&documents, &path);

        // Тот же файл по пути с `..` — это всё ещё тот же документ.
        let detour = dir.path().join("sub").join("..").join("note.md");
        fs::create_dir(dir.path().join("sub")).unwrap();
        assert!(matches!(
            documents.open(&detour),
            Ok(Opened::AlreadyOpen(id)) if id == opened.id
        ));

        // После закрытия файл открывается заново, с новым идентификатором.
        documents.close(opened.id);
        assert_ne!(open_new(&documents, &path).id, opened.id);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_open_file_is_recognized() {
        let (dir, path) = file_with(b"text\n");
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let documents = Documents::default();
        let opened = open_new(&documents, &path);

        assert!(matches!(
            documents.open(&link),
            Ok(Opened::AlreadyOpen(id)) if id == opened.id
        ));
    }

    #[test]
    fn reopen_all_rereads_files_in_opening_order() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.md");
        let second = dir.path().join("second.md");
        fs::write(&first, "one\n").unwrap();
        fs::write(&second, "two\n").unwrap();
        let documents = Documents::default();
        let first_id = open_new(&documents, &first).id;
        let second_id = open_new(&documents, &second).id;

        fs::write(&first, "one, edited outside\n").unwrap();
        fs::remove_file(&second).unwrap();
        let outcomes = documents.reopen_all();

        let json = serde_json::to_value(&outcomes).unwrap();
        assert_eq!(json[0]["status"], "opened");
        assert_eq!(json[0]["document"]["text"], "one, edited outside\n");
        assert_eq!(json[1]["status"], "failed");
        // Перечитанный документ сохраняется без ложной тревоги «изменён снаружи»,
        // а неудавшийся убран из реестра.
        documents
            .save(first_id, "one, edited outside\nmore\n", false)
            .unwrap();
        assert!(matches!(
            documents.save(second_id, "x", false),
            Err(AppError::UnknownDocument(_))
        ));
    }

    #[test]
    fn reload_takes_the_new_version_from_disk() {
        let (_dir, path) = file_with(b"old\n");
        let documents = Documents::default();
        let opened = open_new(&documents, &path);

        fs::write(&path, "new\r\n").unwrap();
        let identity = fs::canonicalize(&path).unwrap();
        assert_eq!(
            documents.disk_states_at(&identity),
            vec![(opened.id, DiskState::Modified)]
        );

        let reloaded = documents.reload(opened.id).unwrap();
        assert_eq!(reloaded.text, "new\n");
        assert_eq!(reloaded.format.line_ending, LineEnding::CrLf);
        // После перечитывания диск снова совпадает с документом, и
        // сохранение не считает файл чужим.
        assert_eq!(
            documents.disk_states_at(&identity),
            vec![(opened.id, DiskState::Unchanged)]
        );
        documents.save(opened.id, "newer\n", false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"newer\r\n");
    }

    #[test]
    fn disk_states_report_missing_files_and_ignore_others() {
        let (dir, path) = file_with(b"text\n");
        let documents = Documents::default();
        let opened = open_new(&documents, &path);
        let identity = fs::canonicalize(&path).unwrap();
        assert_eq!(documents.identities(), vec![identity.clone()]);

        fs::remove_file(&path).unwrap();
        assert_eq!(
            documents.disk_states_at(&identity),
            vec![(opened.id, DiskState::Missing)]
        );
        assert_eq!(
            documents.disk_states_at(&dir.path().join("other.md")),
            vec![]
        );
    }

    #[test]
    fn open_all_reports_each_file_separately() {
        let (dir, path) = file_with(b"text\n");
        let missing = dir.path().join("missing.md");
        let documents = Documents::default();

        let outcomes = documents.open_all(&[path.clone(), missing, path]);

        let statuses: Vec<_> = outcomes
            .iter()
            .map(|outcome| serde_json::to_value(outcome).unwrap()["status"].clone())
            .collect();
        assert_eq!(statuses, ["opened", "failed", "alreadyOpen"]);
    }

    /// Критерий готовности M1: файл с CRLF и BOM после «открыть → сохранить»
    /// совпадает с исходным побайтово. Проверяем и с реальной записью на диск:
    /// сначала сохраняем правку, потом возвращаем исходный текст.
    #[test]
    fn crlf_bom_file_survives_open_edit_save_roundtrip() {
        let (_dir, path) = file_with(CRLF_WITH_BOM);
        let documents = Documents::default();

        let opened = open_new(&documents, &path);
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
        let opened = open_new(&documents, &path);

        documents.save(opened.id, &opened.text, false).unwrap();

        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), old_time);
    }

    #[test]
    fn refuses_to_overwrite_external_changes_unless_forced() {
        let (_dir, path) = file_with(b"original\n");
        let documents = Documents::default();
        let opened = open_new(&documents, &path);
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
        let opened = open_new(&documents, &path);
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
        let opened = open_new(&documents, &path);
        assert!(opened.format.mixed_line_endings);

        let format = documents.save(opened.id, "a\nb\nc\nd\n", false).unwrap();

        assert!(!format.mixed_line_endings);
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc\r\nd\r\n");
    }

    #[test]
    fn closed_or_unknown_documents_cannot_be_saved() {
        let (_dir, path) = file_with(b"text\n");
        let documents = Documents::default();
        let opened = open_new(&documents, &path);

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
        let opened = open_new(&Documents::default(), &path);
        let json = serde_json::to_value(&opened).unwrap();

        assert_eq!(json["id"], 1);
        assert_eq!(json["fileName"], "note.md");
        assert_eq!(json["lineEnding"], "CRLF");
        assert_eq!(json["hasBom"], true);
        assert_eq!(json["mixedLineEndings"], false);
    }
}
