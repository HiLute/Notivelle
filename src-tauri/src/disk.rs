//! Чтение и запись файлов.
//!
//! Главное здесь — безопасное сохранение. Новое содержимое пишется во
//! временный файл в той же папке, сбрасывается на диск (`fsync`) и только
//! потом атомарно переименовывается поверх оригинала. Если посреди записи
//! что-то пойдёт не так (кончится место, упадёт приложение, пропадёт
//! питание), на диске останется либо старая версия целиком, либо новая
//! целиком, но не обрезанная смесь.

use std::fs::{self, File, OpenOptions, Permissions};
use std::hash::{DefaultHasher, Hasher};
use std::io::{self, Write};
use std::path::Path;

use tempfile::NamedTempFile;

use crate::error::AppError;

/// Самый большой файл, который редактор согласится открыть.
///
/// Заметки на порядки меньше; ограничение защищает от случайно открытого
/// гигантского файла, который подвесил бы интерфейс.
pub const MAX_FILE_SIZE: u64 = 32 * 1024 * 1024;

/// Читает файл целиком.
pub fn read(path: &Path) -> Result<Vec<u8>, AppError> {
    read_with_limit(path, MAX_FILE_SIZE)
}

fn read_with_limit(path: &Path, limit: u64) -> Result<Vec<u8>, AppError> {
    // Замыкание захватывает `path` по ссылке, поэтому оно `Copy` и его можно
    // передать в `map_err` несколько раз.
    let read_error = |source| AppError::Read {
        path: path.to_owned(),
        source,
    };

    let metadata = fs::metadata(path).map_err(read_error)?;
    if !metadata.is_file() {
        return Err(AppError::NotAFile {
            path: path.to_owned(),
        });
    }
    if metadata.len() > limit {
        return Err(AppError::TooLarge {
            path: path.to_owned(),
            size: metadata.len(),
            limit,
        });
    }
    fs::read(path).map_err(read_error)
}

/// Отпечаток содержимого файла, чтобы заметить, что его изменили снаружи.
///
/// `DefaultHasher` — не криптографический хеш, но для сравнения версий
/// одного файла внутри одного запуска программы его достаточно.
pub fn content_hash(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

/// Что сейчас лежит на диске по сравнению с тем, что мы прочитали или записали.
///
/// Уходит и во фронтенд (событие слежения за файлами, `watcher.rs`) строкой
/// `"unchanged"`, `"modified"` или `"missing"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiskState {
    Unchanged,
    Modified,
    Missing,
}

/// Сравнивает файл на диске с ожидаемым отпечатком `expected_hash`.
pub fn disk_state(path: &Path, expected_hash: u64) -> Result<DiskState, AppError> {
    match fs::read(path) {
        Ok(bytes) if content_hash(&bytes) == expected_hash => Ok(DiskState::Unchanged),
        Ok(_) => Ok(DiskState::Modified),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(DiskState::Missing),
        Err(source) => Err(AppError::Read {
            path: path.to_owned(),
            source,
        }),
    }
}

/// Сохраняет `bytes` в `path` атомарно, сохраняя права файла.
///
/// Если `path` — символическая ссылка, пишется файл, на который она
/// указывает, а сама ссылка остаётся ссылкой.
pub fn write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let write_error = |source| AppError::Write {
        path: path.to_owned(),
        source,
    };

    // Без этого переименование заменило бы саму ссылку обычным файлом.
    let target = match fs::canonicalize(path) {
        Ok(target) => target,
        // Файла уже нет (его удалили, а пользователь всё равно решил
        // сохранить): заменять нечего, просто создаём новый.
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return create_new(path, bytes).map_err(write_error);
        }
        Err(err) => return Err(write_error(err)),
    };

    let metadata = fs::metadata(&target).map_err(write_error)?;
    if !metadata.is_file() {
        return Err(AppError::NotAFile {
            path: path.to_owned(),
        });
    }

    // Права на запись проверяем явно. Переименование сработало бы и поверх
    // защищённого от записи файла, если в саму папку писать можно, и тихо
    // обошло бы запрет. Открытие на запись без `truncate` файл не меняет.
    if let Err(err) = OpenOptions::new().write(true).open(&target) {
        return Err(if err.kind() == io::ErrorKind::PermissionDenied {
            AppError::ReadOnly {
                path: path.to_owned(),
            }
        } else {
            write_error(err)
        });
    }

    match temp_file_beside(&target) {
        Ok(temp) => replace_with(temp, &target, bytes, metadata.permissions()).map_err(write_error),
        // Писать в папку нельзя, а в сам файл можно (бывает в общих папках):
        // атомарная замена невозможна, поэтому переписываем файл на месте.
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            log::warn!(
                "нет прав на запись в папку {}, сохраняю без атомарной замены",
                target.display()
            );
            overwrite_in_place(&target, bytes).map_err(write_error)
        }
        Err(err) => Err(write_error(err)),
    }
}

/// Создаёт временный файл в той же папке, что и `target`.
///
/// Именно в той же: переименование атомарно только в пределах одной
/// файловой системы. Скрытое имя вида `.note.md.Ab3xZ.tmp` подскажет,
/// откуда файл взялся, если приложение упадёт посреди записи.
fn temp_file_beside(target: &Path) -> io::Result<NamedTempFile> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    tempfile::Builder::new()
        .prefix(&format!(".{file_name}."))
        .suffix(".tmp")
        .tempfile_in(dir)
}

/// Записывает `bytes` во временный файл и переименовывает его в `target`.
///
/// Если любой шаг до переименования завершится ошибкой, `temp` будет
/// уничтожен при выходе из функции, а его деструктор удалит временный файл:
/// мусора рядом с оригиналом не останется.
fn replace_with(
    mut temp: NamedTempFile,
    target: &Path,
    bytes: &[u8],
    permissions: Permissions,
) -> io::Result<()> {
    temp.write_all(bytes)?;
    // tempfile создаёт файл с правами 0600. Возвращаем права оригинала,
    // иначе после сохранения его перестали бы видеть другие пользователи.
    temp.as_file().set_permissions(permissions)?;
    // Данные должны оказаться на диске до переименования: иначе после сбоя
    // питания можно получить переименованный, но пустой файл.
    temp.as_file().sync_all()?;
    temp.persist(target).map_err(|err| err.error)?;
    sync_parent_dir(target)
}

/// Сбрасывает на диск саму запись о переименовании в папке.
#[cfg(unix)]
fn sync_parent_dir(target: &Path) -> io::Result<()> {
    match target.parent() {
        Some(dir) => File::open(dir)?.sync_all(),
        None => Ok(()),
    }
}

/// На Windows папку нельзя открыть как файл, поэтому этот шаг пропускаем.
#[cfg(not(unix))]
fn sync_parent_dir(_target: &Path) -> io::Result<()> {
    Ok(())
}

fn overwrite_in_place(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).truncate(true).open(target)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn create_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    // `create_new` завершится ошибкой, если файл успел появиться: не
    // перезапишем то, чего не видели.
    let mut file = File::create_new(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("временная папка для теста")
    }

    #[test]
    fn write_replaces_content_and_leaves_no_temp_files() {
        let dir = temp_dir();
        let path = dir.path().join("note.md");
        fs::write(&path, "old").unwrap();

        write(&path, b"new content").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new content");
        let entries: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(
            entries.len(),
            1,
            "рядом с файлом остался мусор: {entries:?}"
        );
    }

    #[test]
    fn write_recreates_deleted_file() {
        let dir = temp_dir();
        let path = dir.path().join("gone.md");

        write(&path, b"back").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"back");
    }

    #[test]
    fn read_rejects_directories_and_huge_files() {
        let dir = temp_dir();
        assert!(matches!(read(dir.path()), Err(AppError::NotAFile { .. })));

        let path = dir.path().join("big.md");
        fs::write(&path, "12345").unwrap();
        assert!(matches!(
            read_with_limit(&path, 4),
            Err(AppError::TooLarge {
                size: 5,
                limit: 4,
                ..
            })
        ));
        assert_eq!(read_with_limit(&path, 5).unwrap(), b"12345");
    }

    #[test]
    fn disk_state_detects_changes_and_deletion() {
        let dir = temp_dir();
        let path = dir.path().join("note.md");
        fs::write(&path, "v1").unwrap();
        let hash = content_hash(b"v1");

        assert_eq!(disk_state(&path, hash).unwrap(), DiskState::Unchanged);
        fs::write(&path, "v2").unwrap();
        assert_eq!(disk_state(&path, hash).unwrap(), DiskState::Modified);
        fs::remove_file(&path).unwrap();
        assert_eq!(disk_state(&path, hash).unwrap(), DiskState::Missing);
    }

    #[cfg(unix)]
    mod unix {
        use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

        use super::*;

        fn mode(path: &Path) -> u32 {
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn write_preserves_permissions() {
            let dir = temp_dir();
            let path = dir.path().join("shared.md");
            fs::write(&path, "old").unwrap();
            fs::set_permissions(&path, Permissions::from_mode(0o640)).unwrap();

            write(&path, b"new").unwrap();

            assert_eq!(mode(&path), 0o640);
        }

        #[test]
        fn write_through_symlink_keeps_the_link() {
            let dir = temp_dir();
            let target = dir.path().join("real.md");
            let link = dir.path().join("link.md");
            fs::write(&target, "old").unwrap();
            symlink(&target, &link).unwrap();

            write(&link, b"new").unwrap();

            assert!(
                fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(fs::read(&target).unwrap(), b"new");
        }

        #[test]
        fn write_refuses_read_only_file() {
            let dir = temp_dir();
            // root может писать в любой файл, и проверка прав теряет смысл.
            if fs::metadata(dir.path()).unwrap().uid() == 0 {
                return;
            }
            let path = dir.path().join("locked.md");
            fs::write(&path, "keep me").unwrap();
            fs::set_permissions(&path, Permissions::from_mode(0o444)).unwrap();

            let result = write(&path, b"overwrite");

            assert!(
                matches!(result, Err(AppError::ReadOnly { .. })),
                "{result:?}"
            );
            assert_eq!(fs::read(&path).unwrap(), b"keep me");
        }
    }
}
