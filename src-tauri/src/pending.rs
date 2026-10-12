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

use std::ffi::{OsStr, OsString};
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
///   наша: `notivelle note.md`, запущенный из `~/notes`, должен открыть
///   `~/notes/note.md`.
/// - Аргументы вида `file:///home/user/a%20b.md` (так их передают некоторые
///   файловые менеджеры) превращаются в обычные пути.
/// - Параметры (`--help`, `-V` и любые другие с дефиса) — не файлы. После
///   `--` параметров нет, там только файлы.
/// - Путь с пробелами без кавычек оболочка разрезает на части:
///   `notivelle Без названия.md` даёт аргументы `Без` и `названия.md`. Если
///   такого файла нет, а склеенный через пробел путь есть — берём его.
///
/// Аргументы принимаются как `OsString`, а не `String`: путь в Linux — это
/// просто байты, он не обязан быть корректным UTF-8.
pub fn paths_from_args<I>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator,
    I::Item: Into<OsString>,
{
    resolve_paths(&file_arguments(args), cwd, Path::exists)
}

/// Аргументы-файлы: без пустых и без параметров.
fn file_arguments<I>(args: I) -> Vec<OsString>
where
    I: IntoIterator,
    I::Item: Into<OsString>,
{
    let mut options_ended = false;
    args.into_iter()
        .map(Into::into)
        .filter(|arg| {
            if arg.is_empty() {
                return false;
            }
            if options_ended {
                return true;
            }
            if arg == "--" {
                options_ended = true;
                return false;
            }
            // Одиночный «-» — не параметр, а файл с таким именем.
            !(arg.as_encoded_bytes().starts_with(b"-") && arg != "-")
        })
        .collect()
}

/// Аргументы → пути. `exists` проверяет, есть ли файл: в тестах её
/// подменяют, чтобы не создавать файлы на диске.
fn resolve_paths(args: &[OsString], cwd: &Path, exists: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let resolve = |arg: &OsStr| file_url_to_path(arg).unwrap_or_else(|| cwd.join(arg));
    let mut paths = Vec::with_capacity(args.len());
    // `rest` — ещё не разобранные аргументы. Срез сдвигается вперёд на столько
    // аргументов, сколько ушло в очередной путь.
    let mut rest = args;
    while let Some((first, tail)) = rest.split_first() {
        let single = resolve(first);
        let (path, used) = if exists(&single) {
            (single, 0)
        } else {
            rejoined(first, tail, resolve, &exists).unwrap_or((single, 0))
        };
        paths.push(path);
        rest = &tail[used..];
    }
    paths
}

/// Склеивает `first` через пробел с одним, двумя, … следующими аргументами,
/// пока не получится существующий файл. Возвращает его и сколько аргументов
/// из `tail` ушло в путь.
fn rejoined(
    first: &OsStr,
    tail: &[OsString],
    resolve: impl Fn(&OsStr) -> PathBuf,
    exists: impl Fn(&Path) -> bool,
) -> Option<(PathBuf, usize)> {
    let mut joined = first.to_os_string();
    for (index, part) in tail.iter().enumerate() {
        joined.push(" ");
        joined.push(part);
        let path = resolve(&joined);
        if exists(&path) {
            return Some((path, index + 1));
        }
    }
    None
}

fn file_url_to_path(arg: &OsStr) -> Option<PathBuf> {
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

    #[test]
    fn options_are_not_files() {
        let paths = paths_from_args(
            ["--color", "-", "a.md", "--", "-b.md", "--help"],
            Path::new("/n"),
        );
        assert_eq!(
            paths,
            [
                PathBuf::from("/n/-"),
                PathBuf::from("/n/a.md"),
                PathBuf::from("/n/-b.md"),
                PathBuf::from("/n/--help"),
            ]
        );
    }

    /// `exists` для тестов: есть только перечисленные файлы.
    fn only(files: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |path| files.iter().any(|file| path == Path::new(file))
    }

    fn args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn path_split_by_spaces_is_put_back_together() {
        let paths = resolve_paths(
            &args(&["/s/Без", "названия.md", "x.md"]),
            Path::new("/"),
            only(&["/s/Без названия.md", "/x.md"]),
        );
        assert_eq!(
            paths,
            [PathBuf::from("/s/Без названия.md"), PathBuf::from("/x.md")]
        );
    }

    #[test]
    fn three_parts_and_relative_paths_are_joined_too() {
        let paths = resolve_paths(
            &args(&["мой", "большой", "план.md"]),
            Path::new("/home/u"),
            only(&["/home/u/мой большой план.md"]),
        );
        assert_eq!(paths, [PathBuf::from("/home/u/мой большой план.md")]);
    }

    #[test]
    fn existing_parts_are_not_joined_and_missing_stay_as_is() {
        // Оба файла есть — это два файла, а не один с пробелом.
        let both = resolve_paths(
            &args(&["a", "b.md"]),
            Path::new("/"),
            only(&["/a", "/b.md", "/a b.md"]),
        );
        assert_eq!(both, [PathBuf::from("/a"), PathBuf::from("/b.md")]);
        // Ничего не нашлось — пути как есть: ошибку покажет открытие файла.
        let missing = resolve_paths(&args(&["нет", "такого.md"]), Path::new("/"), only(&[]));
        assert_eq!(
            missing,
            [PathBuf::from("/нет"), PathBuf::from("/такого.md")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn file_urls_become_paths() {
        let paths = paths_from_args(["file:///tmp/my%20notes/a.md"], Path::new("/ignored"));
        assert_eq!(paths, [PathBuf::from("/tmp/my notes/a.md")]);
    }
}
