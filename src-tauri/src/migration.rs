//! Переезд со старого имени программы.
//!
//! До M7 программа называлась md-editor, и её каталог конфигурации был
//! `~/.config/dev.maksim.md-editor`. Вместе с именем сменился идентификатор
//! приложения (`dev.maksim.notivelle`), а значит, и каталог. Чтобы настройки
//! и личный словарь не потерялись, при запуске старый каталог переносится
//! на новое место — один раз, пока нового каталога ещё нет.

use std::fs;
use std::io;
use std::path::Path;

/// Идентификатор приложения до переименования в Notivelle.
pub const LEGACY_IDENTIFIER: &str = "dev.maksim.md-editor";

/// Чем закончился перенос.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migration {
    /// Старого каталога нет — переносить нечего.
    NothingToMove,
    /// Новый каталог уже есть: перенос уже был или программа успела
    /// поработать под новым именем. Ничего не трогаем, чтобы не смешать
    /// старые настройки с новыми.
    AlreadyDone,
    /// Старый каталог переименован в новый.
    Moved,
    /// Каталоги на разных файловых системах, переименовать нельзя: файлы
    /// скопированы, старый каталог остался на месте.
    Copied,
}

/// Переносит каталог конфигурации `legacy` в `current`, если `current` ещё нет.
///
/// # Errors
///
/// Возвращает ошибку ввода-вывода, если каталог не удалось ни переименовать,
/// ни скопировать. Программа при этом запускается с настройками по умолчанию.
pub fn move_config_dir(legacy: &Path, current: &Path) -> io::Result<Migration> {
    if !legacy.is_dir() {
        return Ok(Migration::NothingToMove);
    }
    if current.exists() {
        return Ok(Migration::AlreadyDone);
    }
    if let Some(parent) = current.parent() {
        fs::create_dir_all(parent)?;
    }
    // Переименование атомарно: каталог либо на старом месте, либо на новом.
    match fs::rename(legacy, current) {
        Ok(()) => Ok(Migration::Moved),
        Err(err) if err.kind() == io::ErrorKind::CrossesDevices => {
            copy_files(legacy, current)?;
            Ok(Migration::Copied)
        }
        Err(err) => Err(err),
    }
}

/// Копирует файлы каталога (без подкаталогов — в каталоге конфигурации их нет).
fn copy_files(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            fs::copy(entry.path(), to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Временный `~/.config` со старым каталогом, если `with_legacy`.
    fn config_home(with_legacy: bool) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        if with_legacy {
            let legacy = home.path().join(LEGACY_IDENTIFIER);
            fs::create_dir(&legacy).unwrap();
            fs::write(legacy.join("settings.toml"), "theme = \"dark\"\n").unwrap();
            fs::write(legacy.join("dictionary.txt"), "Notivelle\n").unwrap();
        }
        home
    }

    #[test]
    fn legacy_directory_is_moved_with_its_files() {
        let home = config_home(true);
        let legacy = home.path().join(LEGACY_IDENTIFIER);
        let current = home.path().join("dev.maksim.notivelle");

        assert_eq!(
            move_config_dir(&legacy, &current).unwrap(),
            Migration::Moved
        );
        assert!(!legacy.exists());
        assert_eq!(
            fs::read_to_string(current.join("settings.toml")).unwrap(),
            "theme = \"dark\"\n"
        );
        assert_eq!(
            fs::read_to_string(current.join("dictionary.txt")).unwrap(),
            "Notivelle\n"
        );
    }

    #[test]
    fn existing_new_directory_is_left_alone() {
        let home = config_home(true);
        let legacy = home.path().join(LEGACY_IDENTIFIER);
        let current = home.path().join("dev.maksim.notivelle");
        fs::create_dir(&current).unwrap();
        fs::write(current.join("settings.toml"), "theme = \"light\"\n").unwrap();

        assert_eq!(
            move_config_dir(&legacy, &current).unwrap(),
            Migration::AlreadyDone
        );
        assert!(legacy.join("settings.toml").exists());
        assert_eq!(
            fs::read_to_string(current.join("settings.toml")).unwrap(),
            "theme = \"light\"\n"
        );
    }

    #[test]
    fn nothing_happens_without_legacy_directory() {
        let home = config_home(false);
        let current = home.path().join("dev.maksim.notivelle");
        assert_eq!(
            move_config_dir(&home.path().join(LEGACY_IDENTIFIER), &current).unwrap(),
            Migration::NothingToMove
        );
        assert!(!current.exists());
    }

    #[test]
    fn missing_parent_of_new_directory_is_created() {
        let home = config_home(true);
        let legacy = home.path().join(LEGACY_IDENTIFIER);
        let current = home.path().join("nested").join("dev.maksim.notivelle");
        assert_eq!(
            move_config_dir(&legacy, &current).unwrap(),
            Migration::Moved
        );
        assert!(current.join("dictionary.txt").exists());
    }

    #[test]
    fn copying_takes_files_and_keeps_the_original() {
        let home = config_home(true);
        let legacy = home.path().join(LEGACY_IDENTIFIER);
        let current = home.path().join("copy");
        copy_files(&legacy, &current).unwrap();
        assert!(legacy.join("settings.toml").exists());
        assert!(current.join("settings.toml").exists());
        assert!(current.join("dictionary.txt").exists());
    }
}
