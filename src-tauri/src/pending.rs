//! Очередь файлов, которые нужно открыть.
//!
//! Файлы приходят из трёх мест: командная строка при запуске, повторный
//! запуск программы (второй экземпляр передаёт аргументы первому) и
//! перетаскивание в окно. Rust складывает пути в очередь и шлёт фронтенду
//! событие [`FILES_PENDING_EVENT`], а фронтенд забирает очередь командой
//! `take_pending_documents`.
//!
//! Почему не передать файлы прямо в событии: событие, отправленное до того,
//! как фронтенд успел подписаться, теряется. Очередь не теряется — при
//! старте фронтенд забирает её в любом случае.

use std::ffi::OsString;
use std::mem;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Manager, Url};

/// Событие «в очереди появились файлы». Полезной нагрузки нет.
pub const FILES_PENDING_EVENT: &str = "files-pending";

/// Метка главного окна (`app.windows[].label` в `tauri.conf.json`).
pub const MAIN_WINDOW: &str = "main";

#[derive(Debug, Default)]
pub struct PendingFiles(Mutex<Vec<PathBuf>>);

impl PendingFiles {
    pub fn new(paths: Vec<PathBuf>) -> Self {
        Self(Mutex::new(paths))
    }

    pub fn push(&self, paths: impl IntoIterator<Item = PathBuf>) {
        self.lock().extend(paths);
    }

    /// Отдаёт накопленные пути и очищает очередь. Повторный вызов вернёт
    /// пустой список, поэтому файлы не откроются дважды.
    pub fn take(&self) -> Vec<PathBuf> {
        mem::take(&mut *self.lock())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<PathBuf>> {
        // Очередь — простой список; после паники в другом потоке он остаётся
        // корректным, поэтому «отравление» мьютекса игнорируем.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Превращает аргументы командной строки (без имени программы) в пути.
///
/// - Относительные пути считаются от `cwd` — рабочей папки того процесса,
///   который получил аргументы. Для второго экземпляра это его папка, а не
///   наша: `md-editor note.md`, запущенный из `~/notes`, должен открыть
///   `~/notes/note.md`.
/// - Аргументы вида `file:///home/user/a%20b.md` (так их передают некоторые
///   файловые менеджеры) превращаются в обычные пути.
///
/// Аргументы принимаются как `OsString`, а не `String`: путь в Linux — это
/// просто байты, он не обязан быть корректным UTF-8.
pub fn paths_from_args<I>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator,
    I::Item: Into<OsString>,
{
    args.into_iter()
        .map(Into::into)
        .filter(|arg| !arg.is_empty())
        .map(|arg| file_url_to_path(&arg).unwrap_or_else(|| cwd.join(arg)))
        .collect()
}

fn file_url_to_path(arg: &OsString) -> Option<PathBuf> {
    let text = arg.to_str()?;
    if !text.starts_with("file://") {
        return None;
    }
    Url::parse(text).ok()?.to_file_path().ok()
}

/// Ставит файлы в очередь и сообщает об этом фронтенду.
pub fn enqueue(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    app.state::<PendingFiles>().push(paths);
    if let Err(err) = app.emit_to(MAIN_WINDOW, FILES_PENDING_EVENT, ()) {
        // Не страшно: фронтенд заберёт очередь при следующем событии или запуске.
        log::warn!("не удалось уведомить фронтенд о новых файлах: {err}");
    }
}

/// Показывает главное окно поверх остальных (при повторном запуске программы).
///
/// На Wayland композитор может не отдать фокус без токена активации — тогда
/// окно лишь подсветится как требующее внимания. Это ограничение протокола.
pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_is_taken_only_once() {
        let pending = PendingFiles::new(vec![PathBuf::from("/a.md")]);
        pending.push([PathBuf::from("/b.md")]);

        assert_eq!(
            pending.take(),
            [PathBuf::from("/a.md"), PathBuf::from("/b.md")]
        );
        assert_eq!(pending.take(), Vec::<PathBuf>::new());
    }

    #[test]
    fn relative_paths_are_resolved_against_callers_cwd() {
        let paths = paths_from_args(
            ["note.md", "", "/abs/todo.md"],
            Path::new("/home/user/notes"),
        );

        assert_eq!(
            paths,
            [
                PathBuf::from("/home/user/notes/note.md"),
                PathBuf::from("/abs/todo.md"),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_urls_become_paths() {
        let paths = paths_from_args(["file:///tmp/my%20notes/a.md"], Path::new("/ignored"));
        assert_eq!(paths, [PathBuf::from("/tmp/my notes/a.md")]);
    }
}
