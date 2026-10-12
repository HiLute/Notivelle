//! md-editor — Markdown-редактор для отдельных файлов.
//!
//! Библиотечная часть приложения: здесь собирается [`tauri::Builder`],
//! подключаются плагины и регистрируются команды для фронтенда.
//! `main.rs` только вызывает [`run`].
//!
//! Модули:
//! - `document` — байты файла ⇄ текст редактора (переводы строк, BOM);
//! - `disk` — чтение и атомарная запись файлов;
//! - `documents` — реестр открытых документов;
//! - `dialogs` — системные диалоги;
//! - `startup` — файлы из командной строки;
//! - `commands` — команды для фронтенда;
//! - `error` — общий тип ошибки.

mod commands;
mod dialogs;
mod disk;
mod document;
mod documents;
mod error;
mod startup;

use documents::Documents;
use startup::StartupFiles;

/// Собирает и запускает Tauri-приложение.
///
/// Блокирует поток до закрытия приложения.
///
/// # Errors
///
/// Возвращает ошибку, если Tauri не удалось инициализироваться, например
/// не создалось окно или в системе нет подходящего `WebView`.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Общее состояние приложения: команды получают его через
        // `State<'_, T>` или `window.state::<T>()`.
        .manage(Documents::default())
        .manage(StartupFiles::from_args(std::env::args_os().skip(1)))
        .setup(|app| {
            // Логи в терминал нужны только при разработке. `log::info!` и
            // другие макросы без подключённого логгера ничего не делают,
            // поэтому в релизной сборке их можно оставлять в коде.
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            log::info!("md-editor {} запущен", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        // Каждая команда, которую вызывает фронтенд, должна быть перечислена здесь.
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::take_startup_documents,
            commands::open_document_dialog,
            commands::save_document,
            commands::ask_unsaved_changes,
            commands::close_document,
        ])
        .run(tauri::generate_context!())
}
