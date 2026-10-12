//! Слежение за открытыми файлами на диске.
//!
//! Если файл изменила или удалила другая программа, фронтенд получает
//! событие [`DISK_CHANGE_EVENT`]: вкладка без правок перечитывает файл сама,
//! а на вкладке с правками появляется плашка «файл изменён на диске».
//!
//! Следим не за самими файлами, а за их папками. Многие редакторы (и мы
//! сами, см. `disk.rs`) сохраняют атомарно: пишут временный файл и
//! переименовывают его поверх старого. Слежение за самим файлом после этого
//! оборвалось бы — старого файла больше нет, — а за папкой продолжается.
//!
//! События приходят пачками: одно сохранение — это создание, запись,
//! переименование. Поэтому они копятся, пока по файлу не станет тихо
//! ([`Debouncer`]), и только потом файл проверяется — по содержимому, а не по
//! факту события. Так собственные сохранения программы не считаются чужими:
//! после записи реестр уже знает новое содержимое (`documents.rs`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use notify::event::{AccessKind, AccessMode, EventKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::disk::DiskState;
use crate::documents::{DocumentId, Documents};

/// Событие для фронтенда: `{ id, state }`.
pub const DISK_CHANGE_EVENT: &str = "disk-change";

/// Сколько файл должен «помолчать», прежде чем его проверить.
const QUIET_PERIOD: Duration = Duration::from_millis(250);

/// Что случилось с файлом документа.
#[derive(Debug, Clone, Serialize)]
pub struct DiskChange {
    pub id: DocumentId,
    pub state: DiskState,
}

/// Следит за папками открытых файлов. Хранится в состоянии приложения.
pub struct FileWatcher {
    inner: Mutex<WatchedDirectories>,
}

struct WatchedDirectories {
    /// `None` — следить не получилось (например, исчерпан лимит inotify).
    /// Программа работает и так, просто без автообновления вкладок.
    watcher: Option<RecommendedWatcher>,
    directories: HashSet<PathBuf>,
}

impl FileWatcher {
    /// Запускает слежение: системный наблюдатель шлёт пути в канал, а
    /// отдельный поток копит их и проверяет файлы.
    pub fn start(app: &AppHandle) -> Self {
        // Канал `mpsc` (multi-producer, single-consumer): наблюдатель
        // отправляет пути из своего потока, наш поток их получает.
        let (sender, receiver) = mpsc::channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            match result {
                Ok(event) if is_content_change(event.kind) => {
                    for path in event.paths {
                        // Ошибка отправки значит, что поток проверки уже
                        // завершился (программа закрывается): сообщать некому.
                        let _ = sender.send(path);
                    }
                }
                Ok(_) => {}
                Err(err) => log::warn!("слежение за файлами: {err}"),
            }
        })
        .inspect_err(|err| log::warn!("слежение за файлами недоступно: {err}"))
        .ok();

        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("file-watcher".to_owned())
            .spawn(move || check_loop(&app, &receiver));
        if let Err(err) = spawned {
            log::warn!("слежение за файлами недоступно: {err}");
        }

        Self {
            inner: Mutex::new(WatchedDirectories {
                watcher,
                directories: HashSet::new(),
            }),
        }
    }

    /// Приводит набор отслеживаемых папок в соответствие с открытыми
    /// файлами: новые папки добавляет, ненужные убирает. Вызывается после
    /// открытия и закрытия документов.
    pub fn sync(&self, documents: &Documents) {
        let wanted: HashSet<PathBuf> = documents
            .identities()
            .iter()
            .filter_map(|identity| identity.parent().map(Path::to_path_buf))
            .collect();

        let mut inner = self.lock();
        // Разбираем структуру на поля: заимствовать `watcher` для записи и
        // `directories` для чтения одновременно можно только по отдельности.
        let WatchedDirectories {
            watcher,
            directories,
        } = &mut *inner;
        let Some(watcher) = watcher else {
            return;
        };
        for gone in directories.difference(&wanted) {
            if let Err(err) = watcher.unwatch(gone) {
                log::warn!("не удалось перестать следить за {}: {err}", gone.display());
            }
        }
        for new in wanted.difference(directories) {
            if let Err(err) = watcher.watch(new, RecursiveMode::NonRecursive) {
                log::warn!("не удалось следить за {}: {err}", new.display());
            }
        }
        *directories = wanted;
    }

    fn lock(&self) -> MutexGuard<'_, WatchedDirectories> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Может ли событие означать новое содержимое файла. Чтение файла (в том
/// числе нашей же проверкой) — не может; без этого фильтра проверка файла
/// порождала бы новое событие, и так по кругу.
fn is_content_change(kind: EventKind) -> bool {
    match kind {
        EventKind::Access(access) => access == AccessKind::Close(AccessMode::Write),
        _ => true,
    }
}

/// Поток проверки: копит пути из канала и проверяет файл, когда по нему
/// стало тихо. Завершается, когда наблюдатель уничтожен и канал закрыт.
fn check_loop(app: &AppHandle, paths: &Receiver<PathBuf>) {
    let mut debouncer = Debouncer::new(QUIET_PERIOD);
    // Что последним сообщили фронтенду о каждом документе.
    let mut reported: HashMap<DocumentId, DiskState> = HashMap::new();
    loop {
        let wait = debouncer
            .next_deadline()
            .map_or(Duration::from_secs(3600), |deadline| {
                deadline.saturating_duration_since(Instant::now())
            });
        match paths.recv_timeout(wait) {
            Ok(path) => debouncer.push(path, Instant::now()),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        for path in debouncer.take_ready(Instant::now()) {
            check(app, &path, &mut reported);
        }
    }
}

/// Сравнивает файл с тем, что знает реестр, и сообщает фронтенду о
/// расхождении. «Без изменений» сообщаем, только если раньше сообщили об
/// изменении: например, файл удалили и вернули — плашку пора убрать.
fn check(app: &AppHandle, path: &Path, reported: &mut HashMap<DocumentId, DiskState>) {
    let documents = app.state::<Documents>();
    for (id, state) in documents.disk_states_at(path) {
        let previous = reported.insert(id, state);
        let worth_telling = state != DiskState::Unchanged
            || previous.is_some_and(|previous| previous != DiskState::Unchanged);
        if worth_telling && let Err(err) = app.emit(DISK_CHANGE_EVENT, DiskChange { id, state }) {
            log::warn!("не удалось сообщить об изменении файла: {err}");
        }
    }
}

/// Копит пути и отдаёт те, по которым событий не было `quiet` времени.
///
/// Время передаётся снаружи (`now`), а не берётся внутри: так поведение
/// проверяется тестами без настоящих пауз.
struct Debouncer {
    quiet: Duration,
    /// Путь → время последнего события по нему.
    last_event: HashMap<PathBuf, Instant>,
}

impl Debouncer {
    fn new(quiet: Duration) -> Self {
        Self {
            quiet,
            last_event: HashMap::new(),
        }
    }

    fn push(&mut self, path: PathBuf, now: Instant) {
        self.last_event.insert(path, now);
    }

    /// Когда созреет ближайший путь; `None` — ждать нечего.
    fn next_deadline(&self) -> Option<Instant> {
        self.last_event.values().min().map(|&at| at + self.quiet)
    }

    /// Забирает пути, по которым стало тихо.
    fn take_ready(&mut self, now: Instant) -> Vec<PathBuf> {
        let ready: Vec<PathBuf> = self
            .last_event
            .iter()
            .filter(|&(_, &at)| now.duration_since(at) >= self.quiet)
            .map(|(path, _)| path.clone())
            .collect();
        for path in &ready {
            self.last_event.remove(path);
        }
        ready
    }
}

#[cfg(test)]
mod tests {
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

    use super::*;

    const QUIET: Duration = Duration::from_millis(100);

    #[test]
    fn waits_until_the_file_is_quiet() {
        let start = Instant::now();
        let mut debouncer = Debouncer::new(QUIET);
        assert_eq!(debouncer.next_deadline(), None);

        debouncer.push("a.md".into(), start);
        // Ещё события по тому же файлу откладывают проверку.
        debouncer.push("a.md".into(), start + Duration::from_millis(60));
        assert_eq!(
            debouncer.next_deadline(),
            Some(start + Duration::from_millis(160))
        );
        assert_eq!(
            debouncer.take_ready(start + Duration::from_millis(120)),
            Vec::<PathBuf>::new()
        );

        let ready = debouncer.take_ready(start + Duration::from_millis(160));
        assert_eq!(ready, vec![PathBuf::from("a.md")]);
        assert_eq!(debouncer.next_deadline(), None);
    }

    #[test]
    fn files_are_debounced_separately() {
        let start = Instant::now();
        let mut debouncer = Debouncer::new(QUIET);
        debouncer.push("a.md".into(), start);
        debouncer.push("b.md".into(), start + Duration::from_millis(80));

        assert_eq!(
            debouncer.take_ready(start + Duration::from_millis(100)),
            vec![PathBuf::from("a.md")]
        );
        assert_eq!(
            debouncer.take_ready(start + Duration::from_millis(180)),
            vec![PathBuf::from("b.md")]
        );
    }

    #[test]
    fn reading_a_file_is_not_a_change() {
        assert!(!is_content_change(EventKind::Access(AccessKind::Read)));
        assert!(!is_content_change(EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(is_content_change(EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(is_content_change(EventKind::Create(CreateKind::File)));
        assert!(is_content_change(EventKind::Modify(ModifyKind::Any)));
        assert!(is_content_change(EventKind::Remove(RemoveKind::File)));
    }
}
