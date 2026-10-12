// Прячет лишнее окно консоли в релизной сборке под Windows. Не удалять.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

use notivelle_lib::cli::{self, Action};

/// Точка входа бинарника. Вся логика живёт в библиотеке `notivelle_lib`,
/// здесь только командная строка и превращение ошибки запуска в понятное
/// сообщение и код выхода вместо паники.
fn main() -> ExitCode {
    // `--help` и `--version` печатают текст и выходят, окна не будет.
    match cli::action(std::env::args_os().skip(1)) {
        Action::Help => {
            print!("{}", cli::help());
            return ExitCode::SUCCESS;
        }
        Action::Version => {
            println!("{}", cli::version());
            return ExitCode::SUCCESS;
        }
        Action::Run => {}
    }

    // Должно выполниться до запуска других потоков (разбор аргументов
    // выше потоков не создаёт).
    #[cfg(target_os = "linux")]
    disable_webkit_dmabuf_renderer();

    // Запуск из терминала: программа продолжит работу в фоне, отдельным
    // процессом, а этот освободит терминал.
    #[cfg(unix)]
    if cli::relaunch_in_background() {
        return ExitCode::SUCCESS;
    }

    match notivelle_lib::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("notivelle: не удалось запустить приложение: {err}");
            ExitCode::FAILURE
        }
    }
}

/// Обходит падение `WebKitGTK` на Wayland с драйвером NVIDIA:
/// «Error 71 (Protocol error) dispatching to Wayland display».
///
/// DMA-BUF-рендерер `WebKitGTK` конфликтует с некоторыми драйверами NVIDIA.
/// Без него `WebKit` рисует через разделяемую память; для текстового редактора
/// разница в скорости незаметна. Если переменная уже задана (например, `=0`,
/// чтобы проверить новый драйвер), значение пользователя не трогаем.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
fn disable_webkit_dmabuf_renderer() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    if std::env::var_os(VAR).is_none() {
        // SAFETY: с edition 2024 `set_var` помечена unsafe, потому что
        // окружение процесса общее, а запись в него одновременно с чтением из
        // другого потока — гонка данных внутри libc. Функция вызывается первой
        // строкой `main`: стандартная библиотека до `main` потоков не создаёт,
        // а Tauri, GTK и WebKit запускаются позже. Других потоков ещё нет.
        unsafe { std::env::set_var(VAR, "1") };
    }
}
