//! Notivelle — Markdown-редактор для отдельных файлов.
//!
//! Библиотечная часть приложения: здесь собирается [`tauri::Builder`],
//! подключаются плагины и регистрируются команды для фронтенда.
//! `main.rs` только вызывает [`run`].
//!
//! Модули:
//! - `cli` — параметры командной строки, справка, уход в фон из терминала;
//! - `document` — байты файла ⇄ текст редактора (переводы строк, BOM);
//! - `disk` — чтение и атомарная запись файлов;
//! - `documents` — реестр открытых документов;
//! - `pending` — очередь файлов на открытие (аргументы, второй запуск, перетаскивание);
//! - `render` — Markdown → безопасный HTML для режима чтения;
//! - `callouts` — типы и разбор callouts в стиле Obsidian;
//! - `assets` — протокол `mdimg://` для локальных картинок, пути из ссылок;
//! - `spellcheck` — проверка орфографии (ru, en) и личный словарь;
//! - `watcher` — слежение за открытыми файлами на диске;
//! - `config` — настройки в `settings.toml`;
//! - `migration` — перенос настроек со старого имени программы (md-editor);
//! - `fonts` — шрифты, установленные в системе;
//! - `dialogs` — системные диалоги;
//! - `commands` — команды для фронтенда;
//! - `error` — общий тип ошибки.

mod assets;
mod callouts;
pub mod cli;
mod commands;
mod config;
mod dialogs;
mod disk;
mod document;
mod documents;
mod error;
mod fonts;
mod migration;
mod pending;
mod render;
mod spellcheck;
mod watcher;

use std::path::Path;

use config::Config;
use documents::Documents;
use pending::PendingFiles;
use spellcheck::PersonalDictionary;
use tauri::{DragDropEvent, Manager, WindowEvent};
use watcher::FileWatcher;

/// Собирает и запускает Tauri-приложение.
///
/// Блокирует поток до закрытия приложения.
///
/// # Errors
///
/// Возвращает ошибку, если Tauri не удалось инициализироваться, например
/// не создалось окно или в системе нет подходящего `WebView`.
pub fn run() -> tauri::Result<()> {
    let cwd = std::env::current_dir().unwrap_or_default();
    let startup_files = pending::paths_from_args(std::env::args_os().skip(1), &cwd);

    tauri::Builder::default()
        // Плагин single instance должен подключаться первым. Если программа
        // уже запущена, новый процесс не создаёт окно: он передаёт свои
        // аргументы первому экземпляру (на Linux — через D-Bus) и завершается,
        // а здесь мы открываем эти файлы вкладками в уже открытом окне.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = pending::paths_from_args(argv.into_iter().skip(1), Path::new(&cwd));
            pending::enqueue(app, paths);
            pending::focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        // Открытие ссылок в браузере (команда `open_external`). Фронтенду
        // прав на него не выдаём: он просит Rust, а Rust проверяет адрес.
        .plugin(tauri_plugin_opener::init())
        // Протокол для локальных картинок в режиме чтения (`assets.rs`).
        // Чтение файла — в отдельном потоке, чтобы не тормозить интерфейс.
        .register_asynchronous_uri_scheme_protocol(
            assets::IMAGE_SCHEME,
            |ctx, request, responder| {
                let app = ctx.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    responder.respond(assets::handle(&app, &request));
                });
            },
        )
        // Общее состояние приложения: команды получают его через
        // `State<'_, T>` или `window.state::<T>()`.
        .manage(Documents::default())
        .manage(PendingFiles::new(startup_files))
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
            log::info!("Notivelle {} запущен", env!("CARGO_PKG_VERSION"));

            // Словари орфографии разбираются в фоне, пока открывается окно.
            // Личный словарь — в каталоге конфигурации
            // (на Linux `~/.config/dev.maksim.notivelle/`).
            spellcheck::preload();
            migrate_legacy_config(app.handle());
            let config_dir = app.path().app_config_dir().ok();
            let config_file = |name: &str| config_dir.as_ref().map(|dir| dir.join(name));
            app.manage(PersonalDictionary::load(config_file("dictionary.txt")));
            app.manage(Config::load(config_file("settings.toml")));
            app.manage(FileWatcher::start(app.handle()));
            Ok(())
        })
        // Файлы, перетащенные в окно. Tauri отдаёт пути и во фронтенд, но мы
        // берём их здесь: фронтенд не должен передавать в Rust пути к файлам
        // (см. `documents.rs`).
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                pending::enqueue(window.app_handle(), paths.clone());
            }
        })
        // Каждая команда, которую вызывает фронтенд, должна быть перечислена здесь.
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::restore_documents,
            commands::take_pending_documents,
            commands::open_document_dialog,
            commands::save_document,
            commands::save_new_document,
            commands::ask_unsaved_changes,
            commands::close_document,
            commands::render_markdown,
            commands::open_external,
            commands::open_link,
            commands::spell_check,
            commands::spell_suggest,
            commands::spell_add_word,
            commands::reload_document,
            commands::get_settings,
            commands::save_settings,
            commands::list_fonts,
        ])
        .build(tauri::generate_context!())?
        .run(|app, event| {
            // macOS передаёт файлы, открытые из Finder (двойной клик,
            // «Открыть с помощью»), не аргументами командной строки, а
            // событием — и при запуске, и когда программа уже открыта. На
            // других системах этого события нет.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                pending::enqueue(app, paths);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
    Ok(())
}

/// Переносит настройки и личный словарь из каталога, который был у программы
/// до переименования в Notivelle (`migration.rs`). Должна выполниться до
/// чтения настроек.
fn migrate_legacy_config(app: &tauri::AppHandle) {
    let paths = app.path();
    let (Ok(base), Ok(current)) = (paths.config_dir(), paths.app_config_dir()) else {
        return;
    };
    let legacy = base.join(migration::LEGACY_IDENTIFIER);
    match migration::move_config_dir(&legacy, &current) {
        Ok(migration::Migration::NothingToMove | migration::Migration::AlreadyDone) => {}
        Ok(outcome) => log::info!(
            "настройки перенесены из {} в {} ({outcome:?})",
            legacy.display(),
            current.display()
        ),
        Err(err) => log::warn!("настройки из {} не перенесены: {err}", legacy.display()),
    }
}
