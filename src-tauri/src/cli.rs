//! Командная строка: `notivelle [ПАРАМЕТРЫ] [ФАЙЛ…]`.
//!
//! Здесь разбираются параметры (`--help`, `--version`) и запуск из терминала.
//! Пути к файлам превращает в абсолютные `pending::paths_from_args`: ей же
//! пользуется повторный запуск программы.

use std::ffi::OsStr;

/// Название программы для справки и версии.
const PRODUCT: &str = "Notivelle";

/// Переменная окружения: не уходить в фон из терминала. Ставится и самим
/// перезапуском (см. [`relaunch_in_background`]), чтобы тот не повторялся.
const FOREGROUND_VAR: &str = "NOTIVELLE_FOREGROUND";

/// Что делать с аргументами командной строки.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Запустить программу и открыть файлы из аргументов.
    Run,
    /// Напечатать справку и выйти.
    Help,
    /// Напечатать версию и выйти.
    Version,
}

/// Ищет в аргументах (без имени программы) `--help` и `--version`. После
/// `--` параметров нет: там только файлы, даже с дефисом в начале имени.
#[must_use]
pub fn action<I>(args: I) -> Action
where
    I: IntoIterator,
    I::Item: AsRef<OsStr>,
{
    for arg in args {
        match arg.as_ref().to_str() {
            Some("--") => break,
            Some("-h" | "--help") => return Action::Help,
            Some("-V" | "--version") => return Action::Version,
            _ => {}
        }
    }
    Action::Run
}

/// `Notivelle 0.1.0`.
#[must_use]
pub fn version() -> String {
    format!("{PRODUCT} {}", env!("CARGO_PKG_VERSION"))
}

/// Справка для `notivelle --help`.
#[must_use]
pub fn help() -> String {
    format!(
        "\
{version} — редактор Markdown-файлов

Использование: notivelle [ПАРАМЕТРЫ] [ФАЙЛ…]

  ФАЙЛ            Markdown-файл: откроется во вкладке. Если Notivelle уже
                  запущен, файлы откроются в его окне. Без файлов программа
                  начинает с нового пустого документа.
  -h, --help      показать эту справку
  -V, --version   показать версию
  --              дальше только файлы (для имён, начинающихся с «-»)

Путь с пробелами лучше взять в кавычки: notivelle \"Без названия.md\".
Если кавычки забыты, Notivelle попробует собрать путь из частей.

Из терминала программа уходит в фон, и он сразу свободен. Остаться в
терминале (например, чтобы видеть сообщения): {FOREGROUND_VAR}=1 notivelle …
",
        version = version()
    )
}

/// Если программу запустили из терминала, перезапускает её в фоне и
/// возвращает `true`: этому процессу остаётся только завершиться.
///
/// Иначе терминал был бы занят, пока открыт редактор, в него сыпались бы
/// сообщения GTK и `WebKit`, а закрытие терминала закрыло бы и редактор.
/// Так же ведут себя `code` и `subl`. Новый процесс получает свою группу
/// процессов (`process_group(0)`): Ctrl+C и закрытие терминала до него не
/// доходят. Ввод и вывод — в никуда.
///
/// В отладочной сборке не перезапускается: её запускает `tauri dev` и
/// следит за процессом.
#[cfg(unix)]
#[must_use = "при `true` процессу нужно завершиться: программа уже работает в фоне"]
pub fn relaunch_in_background() -> bool {
    use std::io::IsTerminal;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let from_terminal = std::io::stdin().is_terminal()
        || std::io::stdout().is_terminal()
        || std::io::stderr().is_terminal();
    if cfg!(debug_assertions) || !from_terminal || std::env::var_os(FOREGROUND_VAR).is_some() {
        return false;
    }
    let Ok(program) = std::env::current_exe() else {
        return false;
    };
    let spawned = Command::new(program)
        .args(std::env::args_os().skip(1))
        .env(FOREGROUND_VAR, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
    match spawned {
        Ok(_) => true,
        Err(err) => {
            eprintln!("notivelle: не удалось перейти в фон, работаю в терминале: {err}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_alone_mean_run() {
        assert_eq!(action(["note.md", "other.md"]), Action::Run);
        assert_eq!(action::<[&str; 0]>([]), Action::Run);
    }

    #[test]
    fn help_and_version_are_found_anywhere_before_double_dash() {
        assert_eq!(action(["note.md", "--help"]), Action::Help);
        assert_eq!(action(["-h"]), Action::Help);
        assert_eq!(action(["--version", "note.md"]), Action::Version);
        assert_eq!(action(["-V"]), Action::Version);
    }

    #[test]
    fn after_double_dash_everything_is_a_file() {
        assert_eq!(action(["--", "--help"]), Action::Run);
    }

    #[test]
    fn help_mentions_usage_and_version() {
        let help = help();
        assert!(help.starts_with(&version()), "{help}");
        assert!(help.contains("notivelle [ПАРАМЕТРЫ] [ФАЙЛ…]"), "{help}");
    }
}
