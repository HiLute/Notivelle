//! Файлы, переданные в командной строке: `md-editor note.md todo.md`.
//!
//! Открыть их прямо при запуске нельзя: фронтенд ещё не загружен, и событие
//! с документом некому было бы принять. Поэтому пути складываются сюда, а
//! фронтенд, когда готов, забирает их командой `take_startup_documents`.

use std::ffi::OsString;
use std::mem;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

#[derive(Debug, Default)]
pub struct StartupFiles(Mutex<Vec<PathBuf>>);

impl StartupFiles {
    /// Собирает пути из аргументов командной строки (без имени программы).
    ///
    /// Аргументы берутся как `OsString`, а не `String`: путь в Linux — это
    /// просто байты, и он не обязан быть корректным UTF-8.
    pub fn from_args(args: impl IntoIterator<Item = OsString>) -> Self {
        let paths = args
            .into_iter()
            .filter(|arg| !arg.is_empty())
            .map(PathBuf::from)
            .collect();
        Self(Mutex::new(paths))
    }

    /// Отдаёт накопленные пути и очищает список. Повторный вызов (например,
    /// после перезагрузки страницы при разработке) вернёт пустой список, и
    /// файлы не откроются дважды.
    pub fn take(&self) -> Vec<PathBuf> {
        let mut paths = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        mem::take(&mut *paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_paths_only_once() {
        let files = StartupFiles::from_args(["a.md", "", "dir/b.md"].map(OsString::from));

        assert_eq!(
            files.take(),
            [PathBuf::from("a.md"), PathBuf::from("dir/b.md")]
        );
        assert_eq!(files.take(), Vec::<PathBuf>::new());
    }
}
