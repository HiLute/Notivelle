//! Команды, которые фронтенд вызывает через `invoke()`.
//!
//! Каждая функция с атрибутом `#[tauri::command]` должна быть перечислена в
//! `tauri::generate_handler![]` в `lib.rs`, иначе фронтенд её не увидит.
//! Аргументы приходят из JSON, а возвращаемое значение Tauri сериализует
//! обратно через `serde`; `Err` становится отклонённым промисом в JS.
//!
//! Обычные (синхронные) команды Tauri выполняет в главном потоке, и пока
//! они работают, интерфейс стоит. Поэтому всё, что ходит на диск или ждёт
//! ответа в диалоге, сделано `async` и уходит в отдельный поток через
//! [`run_blocking`].

use serde::Serialize;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::assets;
use crate::config::{Config, LoadedSettings, Settings};
use crate::dialogs::{self, UnsavedChoice};
use crate::document;
use crate::documents::{DocumentId, Documents, FormatInfo, OpenOutcome, Opened, OpenedDocument};
use crate::error::AppError;
use crate::fonts::{self, FontFamily};
use crate::pending::PendingFiles;
use crate::render;
use crate::spellcheck::{self, PersonalDictionary};
use crate::watcher::FileWatcher;
use crate::wikilinks;

/// Сведения о сборке для строки состояния.
///
/// `rename_all = "camelCase"` переименовывает поля при сериализации:
/// `tauri_version` в Rust становится `tauriVersion` в JSON, как принято в TS.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    tauri_version: &'static str,
    os: &'static str,
}

impl AppInfo {
    /// Сведения о текущей сборке.
    ///
    /// Всё здесь известно ещё при компиляции: `env!` подставляет значения из
    /// `Cargo.toml`, а `std::env::consts::OS` — константа целевой платформы.
    /// Поэтому поля имеют тип `&'static str`: строки лежат в самом бинарнике,
    /// в кучу ничего не копируется.
    fn current() -> Self {
        Self {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            tauri_version: tauri::VERSION,
            os: std::env::consts::OS,
        }
    }
}

/// Возвращает сведения о сборке: имя, версию приложения, версию Tauri и ОС.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo::current()
}

/// Открывает файлы из очереди: командная строка, повторный запуск программы,
/// перетаскивание в окно (см. `pending.rs`).
#[tauri::command]
pub async fn take_pending_documents(window: WebviewWindow) -> Result<Vec<OpenOutcome>, AppError> {
    run_blocking(window, |window, documents| {
        let paths = window.state::<PendingFiles>().take();
        let outcomes = documents.open_all(&paths);
        watch_open_files(window, documents);
        Ok(outcomes)
    })
    .await
}

/// Перечитывает уже открытые документы. Фронтенд вызывает её при загрузке
/// страницы: если страница перезагрузилась, вкладки восстановятся.
#[tauri::command]
pub async fn restore_documents(window: WebviewWindow) -> Result<Vec<OpenOutcome>, AppError> {
    run_blocking(window, |window, documents| {
        let outcomes = documents.reopen_all();
        watch_open_files(window, documents);
        Ok(outcomes)
    })
    .await
}

/// Показывает диалог открытия и открывает выбранные файлы.
/// Пустой список — пользователь закрыл диалог, ничего не выбрав.
#[tauri::command]
pub async fn open_document_dialog(window: WebviewWindow) -> Result<Vec<OpenOutcome>, AppError> {
    run_blocking(window, |window, documents| {
        let paths = dialogs::pick_markdown_files(window);
        let outcomes = documents.open_all(&paths);
        watch_open_files(window, documents);
        Ok(outcomes)
    })
    .await
}

/// Сохраняет документ. Если файл успели изменить или удалить снаружи,
/// спрашивает пользователя, перезаписать ли его.
///
/// Возвращает новый формат файла или `None`, если пользователь отказался
/// перезаписывать.
#[tauri::command]
pub async fn save_document(
    window: WebviewWindow,
    id: DocumentId,
    text: String,
) -> Result<Option<FormatInfo>, AppError> {
    run_blocking(window, move |window, documents| {
        match documents.save(id, &text, false) {
            // `conflict @ (A | B)` связывает с именем значение, совпавшее с
            // любым из вариантов: дальше оно нужно целиком для текста диалога.
            Err(conflict @ (AppError::ModifiedOnDisk { .. } | AppError::MissingOnDisk { .. })) => {
                if dialogs::confirm_overwrite(window, &conflict) {
                    documents.save(id, &text, true).map(Some)
                } else {
                    Ok(None)
                }
            }
            result => result.map(Some),
        }
    })
    .await
}

/// Сохраняет новый документ («Без названия»): спрашивает в диалоге, куда,
/// записывает файл и дальше работает с ним как с обычным открытым файлом.
/// `None` — пользователь закрыл диалог.
///
/// Путь выбирает пользователь в системном диалоге, а не фронтенд: правило
/// из `documents.rs` («фронтенд не передаёт пути») соблюдается.
#[tauri::command]
pub async fn save_new_document(
    window: WebviewWindow,
    text: String,
) -> Result<Option<OpenOutcome>, AppError> {
    run_blocking(window, move |window, documents| {
        let suggested = dialogs::suggested_file_name(&text);
        let Some(path) = dialogs::pick_new_file(window, &suggested) else {
            return Ok(None);
        };
        let outcome = match documents.save_new(&path, &text)? {
            Opened::New(document) => OpenOutcome::Opened { document },
            Opened::AlreadyOpen(id) => OpenOutcome::AlreadyOpen { id },
        };
        watch_open_files(window, documents);
        Ok(Some(outcome))
    })
    .await
}

/// Спрашивает, что делать с несохранёнными изменениями (одной вкладки или
/// всех при закрытии окна). Имена приходят из фронтенда: у нового документа
/// ещё нет файла, а значит, и записи в реестре. Имена только показываются.
#[tauri::command]
pub async fn ask_unsaved_changes(
    window: WebviewWindow,
    file_names: Vec<String>,
) -> Result<UnsavedChoice, AppError> {
    run_blocking(window, move |window, _| {
        Ok(dialogs::ask_unsaved_changes(window, &file_names))
    })
    .await
}

/// HTML для режима чтения. `id` нужен, чтобы картинки с относительными путями
/// искались рядом с документом; у нового, ещё не сохранённого документа его нет.
#[tauri::command]
pub async fn render_markdown(
    window: WebviewWindow,
    id: Option<DocumentId>,
    text: String,
) -> Result<String, AppError> {
    run_blocking(window, move |_, _| {
        Ok(render::render_html(
            &text,
            assets::DocumentImages { document: id },
        ))
    })
    .await
}

/// Открывает внешнюю ссылку в браузере (или почтовой программе).
/// Разрешены только `http`, `https` и `mailto`: ссылка из чужого документа не
/// должна запускать на компьютере что попало.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri передаёт окно в команду только по значению"
)]
pub fn open_external(window: WebviewWindow, url: String) -> Result<(), AppError> {
    let allowed = ["http://", "https://", "mailto:"].iter().any(|prefix| {
        url.get(..prefix.len())
            .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
    });
    if !allowed {
        return Err(AppError::Link {
            href: url,
            reason: "такие ссылки не открываются из соображений безопасности".to_owned(),
        });
    }
    window
        .opener()
        .open_url(&url, None::<&str>)
        .map_err(|err| AppError::Link {
            href: url,
            reason: err.to_string(),
        })
}

/// Открывает во вкладке файл по относительной ссылке из документа `id`:
/// `[план](plan.md)` → `plan.md` рядом с документом. Открываются только
/// Markdown-файлы.
#[tauri::command]
pub async fn open_link(
    window: WebviewWindow,
    id: DocumentId,
    href: String,
) -> Result<Vec<OpenOutcome>, AppError> {
    run_blocking(window, move |window, documents| {
        let link_error = |reason: &str| AppError::Link {
            href: href.clone(),
            reason: reason.to_owned(),
        };
        let target =
            assets::local_target(&href).ok_or_else(|| link_error("это не путь к файлу"))?;
        if !document::is_markdown_path(&target) {
            return Err(link_error("по ссылкам открываются только Markdown-файлы"));
        }
        let path = documents.directory(id)?.join(target);
        let outcomes = documents.open_all(&[path]);
        watch_open_files(window, documents);
        Ok(outcomes)
    })
    .await
}

/// Открывает во вкладке заметку по вики-ссылке `[[цель]]` из документа `id`.
///
/// Файл ищется по имени, как в Obsidian (`wikilinks::resolve`). К заголовку
/// из `[[Заметка#Заголовок]]` фронтенд прокручивает сам, когда вкладка
/// откроется; `[[#Заголовок]]` (этот же документ) сюда не приходит.
#[tauri::command]
pub async fn open_wikilink(
    window: WebviewWindow,
    id: DocumentId,
    target: String,
) -> Result<Vec<OpenOutcome>, AppError> {
    run_blocking(window, move |window, documents| {
        let link_error = |reason: String| AppError::Link {
            href: format!("[[{target}]]"),
            reason,
        };
        let note = wikilinks::Target::parse(&target).note;
        if note.is_empty() {
            return Err(link_error("в ссылке нет имени заметки".to_owned()));
        }
        let path = wikilinks::resolve(&documents.directory(id)?, note)
            .ok_or_else(|| link_error(format!("файл «{note}» не найден")))?;
        if !document::is_markdown_path(&path) {
            return Err(link_error(
                "по ссылкам открываются только Markdown-файлы".to_owned(),
            ));
        }
        let outcomes = documents.open_all(&[path]);
        watch_open_files(window, documents);
        Ok(outcomes)
    })
    .await
}

/// Возвращает слова с ошибками из присланных. Первая проверка ждёт, пока
/// загрузятся словари (см. `spellcheck::preload`), поэтому — в отдельном потоке.
#[tauri::command]
pub async fn spell_check(
    window: WebviewWindow,
    words: Vec<String>,
) -> Result<Vec<String>, AppError> {
    run_blocking(window, move |window, _| {
        let personal = window.state::<PersonalDictionary>();
        Ok(words
            .into_iter()
            .filter(|word| spellcheck::is_misspelled(word, &personal))
            .collect())
    })
    .await
}

/// Варианты исправления слова для контекстного меню.
#[tauri::command]
pub async fn spell_suggest(window: WebviewWindow, word: String) -> Result<Vec<String>, AppError> {
    run_blocking(window, move |_, _| Ok(spellcheck::suggestions(&word))).await
}

/// «Добавить в словарь»: слово попадает в личный словарь и сохраняется на диск.
#[tauri::command]
pub async fn spell_add_word(window: WebviewWindow, word: String) -> Result<(), AppError> {
    run_blocking(window, move |window, _| {
        window.state::<PersonalDictionary>().add(&word)
    })
    .await
}

/// Забывает документ. Команда мгновенная, поэтому синхронная.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri передаёт State в команду только по значению"
)]
pub fn close_document(
    documents: State<'_, Documents>,
    watcher: State<'_, FileWatcher>,
    id: DocumentId,
) {
    documents.close(id);
    watcher.sync(&documents);
}

/// Перечитывает документ с диска: файл изменила другая программа.
#[tauri::command]
pub async fn reload_document(
    window: WebviewWindow,
    id: DocumentId,
) -> Result<OpenedDocument, AppError> {
    run_blocking(window, move |_, documents| documents.reload(id)).await
}

/// Настройки и проблема с файлом настроек, если была.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri передаёт State в команду только по значению"
)]
pub fn get_settings(config: State<'_, Config>) -> LoadedSettings {
    config.current()
}

/// Сохраняет настройки; возвращает их приведёнными к допустимым значениям.
#[tauri::command]
pub async fn save_settings(
    window: WebviewWindow,
    settings: Settings,
) -> Result<Settings, AppError> {
    run_blocking(window, move |window, _| {
        window.state::<Config>().save(settings)
    })
    .await
}

/// Шрифты, установленные в системе, — для выбора в настройках.
///
/// Каждый вызов обходит каталоги шрифтов заново: шрифт, установленный при
/// открытой программе, появится в списке при следующем открытии настроек.
#[tauri::command]
pub async fn list_fonts() -> Result<Vec<FontFamily>, AppError> {
    tauri::async_runtime::spawn_blocking(fonts::system_fonts)
        .await
        .map_err(|err| AppError::Internal(format!("список шрифтов не получен: {err}")))
}

/// После открытия файлов следим и за их папками (`watcher.rs`).
fn watch_open_files(window: &WebviewWindow, documents: &Documents) {
    window.state::<FileWatcher>().sync(documents);
}

/// Выполняет блокирующую работу (диск, диалоги) в отдельном потоке.
///
/// `spawn_blocking` требует, чтобы замыкание и результат были `Send +
/// 'static`: задача может пережить вызвавшую её функцию и выполниться в
/// другом потоке. Поэтому `State<'_, Documents>` с временем жизни сюда не
/// передать — замыкание получает окно (оно `'static` и клонируемое) и уже
/// внутри потока достаёт из него реестр документов.
async fn run_blocking<T, F>(window: WebviewWindow, task: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&WebviewWindow, &Documents) -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let documents = window.state::<Documents>();
        task(&window, &documents)
    })
    .await
    .map_err(|err| AppError::Internal(format!("фоновая задача завершилась аварийно: {err}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Фронтенд ждёт поля в camelCase (`interface AppInfo` в `src/ipc.ts`).
    /// Тест фиксирует этот контракт: переименуют поле, и он упадёт.
    #[test]
    fn app_info_serializes_in_camel_case() {
        let json = serde_json::to_value(AppInfo::current()).expect("AppInfo сериализуется в JSON");

        assert_eq!(json["name"], env!("CARGO_PKG_NAME"));
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(json["tauriVersion"], tauri::VERSION);
        assert_eq!(json["os"], std::env::consts::OS);
        assert!(json.get("tauri_version").is_none());
    }
}
