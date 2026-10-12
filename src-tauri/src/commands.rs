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

use crate::dialogs::{self, UnsavedChoice};
use crate::documents::{DocumentId, Documents, FormatInfo, OpenedDocument};
use crate::error::AppError;
use crate::startup::StartupFiles;

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

/// Результат открытия одного файла из командной строки. Ошибка с одним
/// файлом не должна мешать открыть остальные, поэтому это не `Result`, а
/// перечисление, которое уходит во фронтенд как `{ status: "opened", … }`
/// или `{ status: "failed", … }`.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StartupDocument {
    Opened { document: OpenedDocument },
    Failed { path: String, message: String },
}

/// Открывает файлы, переданные в командной строке при запуске.
#[tauri::command]
pub async fn take_startup_documents(
    window: WebviewWindow,
) -> Result<Vec<StartupDocument>, AppError> {
    run_blocking(window, |window, documents| {
        let paths = window.state::<StartupFiles>().take();
        let results = paths
            .iter()
            .map(|path| match documents.open(path) {
                Ok(document) => StartupDocument::Opened { document },
                Err(err) => StartupDocument::Failed {
                    path: path.display().to_string(),
                    message: err.to_string(),
                },
            })
            .collect();
        Ok(results)
    })
    .await
}

/// Показывает диалог открытия и открывает выбранный файл.
/// `None` — пользователь закрыл диалог, ничего не выбрав.
#[tauri::command]
pub async fn open_document_dialog(
    window: WebviewWindow,
) -> Result<Option<OpenedDocument>, AppError> {
    run_blocking(
        window,
        |window, documents| match dialogs::pick_markdown_file(window) {
            Some(path) => documents.open(&path).map(Some),
            None => Ok(None),
        },
    )
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

/// Спрашивает, что делать с несохранёнными изменениями документа.
#[tauri::command]
pub async fn ask_unsaved_changes(
    window: WebviewWindow,
    id: DocumentId,
) -> Result<UnsavedChoice, AppError> {
    run_blocking(window, move |window, documents| {
        let file_name = documents.file_name(id)?;
        Ok(dialogs::ask_unsaved_changes(window, &file_name))
    })
    .await
}

/// Забывает документ. Команда мгновенная, поэтому синхронная.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri передаёт State в команду только по значению"
)]
pub fn close_document(documents: State<'_, Documents>, id: DocumentId) {
    documents.close(id);
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

    #[test]
    fn startup_document_is_tagged_by_status() {
        let failed = StartupDocument::Failed {
            path: "a.md".into(),
            message: "нет прав".into(),
        };
        let json = serde_json::to_value(failed).unwrap();
        assert_eq!(json["status"], "failed");
        assert_eq!(json["message"], "нет прав");
    }
}
