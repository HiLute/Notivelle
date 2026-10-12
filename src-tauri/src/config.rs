//! Настройки программы: `settings.toml` в каталоге конфигурации (на Linux
//! `~/.config/dev.maksim.notivelle/settings.toml`).
//!
//! Файл читается при запуске и переписывается, когда пользователь меняет
//! настройки в панели. Его можно править и руками: ключей, которых нет,
//! берутся значения по умолчанию, лишние ключи не мешают. Если файл
//! испорчен, программа работает с настройками по умолчанию и говорит об этом.

use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::disk;
use crate::error::AppError;

/// Допустимый размер шрифта редактора, пиксели.
const FONT_SIZES: std::ops::RangeInclusive<u8> = 10..=32;

/// Комментарий в начале файла: TOML-сериализатор комментариев не пишет.
const HEADER: &str = "\
# Настройки Notivelle. Их можно менять в панели настроек (Ctrl+,) или здесь.
# theme: \"system\", \"light\" или \"dark\"
# default_mode: режим новых вкладок — \"live\", \"source\" или \"reading\"
# interface_font, text_font, monospace_font: шрифт интерфейса, текста и кода.
#   Имя семейства из системы (\"JetBrains Mono\"), можно несколько через
#   запятую: если первого нет в системе, берётся следующий. \"\" — шрифт по умолчанию.

";

/// Тема оформления.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Как в системе.
    #[default]
    System,
    Light,
    Dark,
}

/// Режим, в котором открываются файлы.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Live,
    Source,
    Reading,
}

/// Все настройки. Имена полей — это и ключи в `settings.toml`, и поля
/// объекта во фронтенде (`src/settings.ts`).
///
/// `serde(default)`: отсутствующий в файле ключ берётся из [`Default`], так
/// что старый файл настроек читается и после появления новых ключей.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: Theme,
    pub default_mode: Mode,
    /// Шрифты, как в Obsidian: интерфейса (меню, вкладки, панели), текста
    /// (редактор и чтение) и моноширинный (код). Пустая строка — шрифт по
    /// умолчанию.
    pub interface_font: String,
    pub text_font: String,
    pub monospace_font: String,
    pub font_size: u8,
    /// Ограниченная ширина строки по центру, как «Readable line length» в Obsidian.
    pub readable_line_length: bool,
    pub spellcheck: bool,
    pub vim: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::default(),
            default_mode: Mode::default(),
            interface_font: String::new(),
            text_font: String::new(),
            monospace_font: String::new(),
            font_size: 16,
            readable_line_length: true,
            spellcheck: true,
            vim: false,
        }
    }
}

impl Settings {
    /// Приводит значения к допустимым: размер шрифта — в пределах
    /// [`FONT_SIZES`], списки шрифтов — к виду `Имя, Имя`.
    fn normalized(mut self) -> Self {
        self.font_size = self.font_size.clamp(*FONT_SIZES.start(), *FONT_SIZES.end());
        for font in [
            &mut self.interface_font,
            &mut self.text_font,
            &mut self.monospace_font,
        ] {
            *font = normalize_font_list(font);
        }
        self
    }
}

/// Список шрифтов из настроек → `Имя, Имя`: без кавычек вокруг имён (их
/// расставит фронтенд, когда соберёт CSS), без управляющих символов, лишних
/// пробелов и пустых элементов. Так руками написанное `"Inter",,  serif`
/// становится `Inter, serif`.
fn normalize_font_list(fonts: &str) -> String {
    fonts
        .split(',')
        .map(|name| {
            let name: String = name.chars().filter(|c| !c.is_control()).collect();
            name.trim().trim_matches(['"', '\'']).trim().to_owned()
        })
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Настройки и проблема с файлом, если она была, — для фронтенда.
#[derive(Debug, Clone, Serialize)]
pub struct LoadedSettings {
    pub settings: Settings,
    /// Почему файл не прочитался; `None` — всё в порядке.
    pub problem: Option<String>,
    /// Где лежит файл — показываем в панели настроек.
    pub path: Option<String>,
}

/// Настройки в состоянии приложения.
pub struct Config {
    /// `None` — каталог конфигурации неизвестен: настройки не сохраняются.
    path: Option<PathBuf>,
    inner: Mutex<LoadedSettings>,
}

impl Config {
    /// Читает настройки. Нет файла — настройки по умолчанию, без жалоб.
    pub fn load(path: Option<PathBuf>) -> Self {
        let (settings, problem) = match path.as_deref().map(fs::read_to_string) {
            None => (Settings::default(), None),
            Some(Err(err)) if err.kind() == io::ErrorKind::NotFound => (Settings::default(), None),
            Some(Err(err)) => (
                Settings::default(),
                Some(format!("файл настроек не прочитан: {err}")),
            ),
            Some(Ok(text)) => match parse(&text) {
                Ok(settings) => (settings, None),
                Err(err) => (Settings::default(), Some(describe_error(&text, &err))),
            },
        };
        if let Some(problem) = &problem {
            log::warn!("{problem}");
        }
        let shown_path = path.as_ref().map(|path| path.display().to_string());
        Self {
            path,
            inner: Mutex::new(LoadedSettings {
                settings,
                problem,
                path: shown_path,
            }),
        }
    }

    /// Текущие настройки.
    pub fn current(&self) -> LoadedSettings {
        self.lock().clone()
    }

    /// Сохраняет новые настройки и возвращает их уже приведёнными к
    /// допустимым значениям.
    ///
    /// Если прежний файл был испорчен, перед перезаписью он копируется в
    /// `settings.toml.bak`: правленное руками не пропадёт бесследно.
    ///
    /// # Errors
    ///
    /// Возвращает ошибку, если файл не удалось записать. Новые настройки
    /// при этом всё равно действуют до закрытия программы.
    pub fn save(&self, settings: Settings) -> Result<Settings, AppError> {
        let settings = settings.normalized();
        let had_problem = {
            let mut inner = self.lock();
            inner.settings = settings.clone();
            inner.problem.take().is_some()
        };

        let Some(path) = &self.path else {
            return Ok(settings);
        };
        let write_error = |source| AppError::Write {
            path: path.clone(),
            source,
        };
        if had_problem {
            fs::copy(path, path.with_extension("toml.bak")).map_err(write_error)?;
        }
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory).map_err(write_error)?;
        }
        disk::write(path, to_toml(&settings).as_bytes())?;
        Ok(settings)
    }

    fn lock(&self) -> MutexGuard<'_, LoadedSettings> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn parse(text: &str) -> Result<Settings, toml::de::Error> {
    toml::from_str::<Settings>(text).map(Settings::normalized)
}

/// «ошибка в файле настроек, строка 3: …» — номер строки ищем по позиции
/// ошибки в тексте (`span` — диапазон байтов).
fn describe_error(text: &str, err: &toml::de::Error) -> String {
    let message = err.message();
    match err.span() {
        Some(span) => {
            let line = text[..span.start.min(text.len())].lines().count().max(1);
            format!("ошибка в файле настроек, строка {line}: {message}")
        }
        None => format!("ошибка в файле настроек: {message}"),
    }
}

fn to_toml(settings: &Settings) -> String {
    // Простые поля (строки, числа, логические значения) TOML записывает
    // всегда; ошибка возможна только у типов, которых в TOML нет (например,
    // `None`), а таких здесь нет.
    let body = toml::to_string(settings).expect("настройки записываются в TOML");
    format!("{HEADER}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_file(text: Option<&str>) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        if let Some(text) = text {
            fs::write(&path, text).unwrap();
        }
        (dir, path)
    }

    #[test]
    fn missing_file_means_defaults_without_complaints() {
        let (_dir, path) = settings_file(None);
        let loaded = Config::load(Some(path)).current();
        assert_eq!(loaded.settings, Settings::default());
        assert_eq!(loaded.problem, None);
    }

    #[test]
    fn missing_keys_take_defaults_and_unknown_keys_are_ignored() {
        let (_dir, path) = settings_file(Some("theme = \"dark\"\nvim = true\nfuture_option = 1\n"));
        let loaded = Config::load(Some(path)).current();
        assert_eq!(
            loaded.settings,
            Settings {
                theme: Theme::Dark,
                vim: true,
                ..Settings::default()
            }
        );
        assert_eq!(loaded.problem, None);
    }

    #[test]
    fn broken_file_means_defaults_with_a_problem() {
        let (_dir, path) = settings_file(Some("theme = \"purple\"\n"));
        let loaded = Config::load(Some(path)).current();
        assert_eq!(loaded.settings, Settings::default());
        let problem = loaded.problem.unwrap_or_default();
        assert!(
            problem.contains("строка 1") && problem.contains("purple"),
            "{problem}"
        );
    }

    #[test]
    fn font_size_is_clamped() {
        let (_dir, path) = settings_file(Some("font_size = 99\n"));
        assert_eq!(Config::load(Some(path)).current().settings.font_size, 32);
    }

    #[test]
    fn font_lists_are_cleaned_up() {
        assert_eq!(normalize_font_list(""), "");
        assert_eq!(normalize_font_list("  JetBrains Mono "), "JetBrains Mono");
        assert_eq!(
            normalize_font_list("\"Inter\",, 'Noto Sans' ,serif"),
            "Inter, Noto Sans, serif"
        );
        assert_eq!(normalize_font_list("Bad\nName;\u{7}"), "BadName;");
        assert_eq!(normalize_font_list(" , \"\" "), "");
    }

    #[test]
    fn fonts_from_file_are_normalized() {
        let (_dir, path) = settings_file(Some("text_font = \" 'Literata' , serif\"\n"));
        let settings = Config::load(Some(path)).current().settings;
        assert_eq!(settings.text_font, "Literata, serif");
        assert_eq!(settings.interface_font, "");
    }

    #[test]
    fn saved_settings_survive_restart() {
        let (dir, _) = settings_file(None);
        let path = dir.path().join("nested").join("settings.toml");
        let config = Config::load(Some(path.clone()));
        let wanted = Settings {
            theme: Theme::Light,
            default_mode: Mode::Source,
            interface_font: "Inter".to_owned(),
            text_font: "Literata, serif".to_owned(),
            monospace_font: String::new(),
            font_size: 5,
            readable_line_length: false,
            spellcheck: false,
            vim: true,
        };
        let saved = config.save(wanted.clone()).unwrap();
        assert_eq!(saved.font_size, 10);

        let reloaded = Config::load(Some(path.clone())).current();
        assert_eq!(
            reloaded.settings,
            Settings {
                font_size: 10,
                ..wanted
            }
        );
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# Настройки Notivelle"), "{text}");
        assert!(text.contains("default_mode = \"source\""), "{text}");
        assert!(text.contains("text_font = \"Literata, serif\""), "{text}");
    }

    #[test]
    fn broken_file_is_backed_up_before_overwriting() {
        let (dir, path) = settings_file(Some("theme = ["));
        let config = Config::load(Some(path.clone()));
        assert!(config.current().problem.is_some());

        config.save(Settings::default()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("settings.toml.bak")).unwrap(),
            "theme = ["
        );
        assert_eq!(config.current().problem, None);
        assert_eq!(Config::load(Some(path)).current().problem, None);
    }
}
