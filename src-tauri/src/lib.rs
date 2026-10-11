//! md-editor — Markdown-редактор для отдельных файлов.
//!
//! Библиотечная часть приложения: здесь собирается [`tauri::Builder`],
//! подключаются плагины и регистрируются команды для фронтенда.
//! `main.rs` только вызывает [`run`].

mod commands;

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
        .invoke_handler(tauri::generate_handler![commands::app_info])
        .run(tauri::generate_context!())
}
