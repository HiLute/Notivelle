//! Проверка орфографии.
//!
//! Словари в формате Hunspell (`ru_RU` и `en_US`, см. `dictionaries/`) вшиты
//! в программу через `include_str!` и разбираются крейтом `spellbook` — это
//! чистый Rust, без системной библиотеки hunspell. Разбор русского словаря
//! (почти 150 тысяч основ) занимает заметное время, поэтому [`preload`]
//! запускает его в фоне сразу при старте программы.
//!
//! Язык слова определяется по алфавиту: кириллица — русский, латиница —
//! английский. Слова в других алфавитах и вперемешку не проверяются.
//!
//! Какие слова проверять, решает фронтенд: он не присылает текст из кода,
//! ссылок, формул и YAML-шапки (см. `src/editor/spellcheck.ts`).

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::Instant;

use spellbook::Dictionary;

use crate::disk;
use crate::error::AppError;

/// Сколько вариантов исправления показывать в меню.
const MAX_SUGGESTIONS: usize = 7;

// `LazyLock` разбирает словарь при первом обращении, ровно один раз; если в
// это время слово проверяют из другого потока, тот подождёт окончания разбора.
static RUSSIAN: LazyLock<Dictionary> = LazyLock::new(|| {
    load(
        "ru_RU",
        include_str!("../dictionaries/ru_RU.aff"),
        include_str!("../dictionaries/ru_RU.dic"),
    )
});

static ENGLISH: LazyLock<Dictionary> = LazyLock::new(|| {
    load(
        "en_US",
        include_str!("../dictionaries/en_US.aff"),
        include_str!("../dictionaries/en_US.dic"),
    )
});

fn load(name: &str, aff: &str, dic: &str) -> Dictionary {
    let started = Instant::now();
    // Словари вшиты в программу и проверены тестом ниже, поэтому ошибка
    // разбора здесь — ошибка сборки, а не пользователя.
    let dictionary = Dictionary::new(aff, dic)
        .unwrap_or_else(|err| panic!("встроенный словарь {name} не разбирается: {err}"));
    log::info!("словарь {name} загружен за {:?}", started.elapsed());
    dictionary
}

/// Начинает загрузку словарей в фоне, чтобы к первой проверке они были готовы.
pub fn preload() {
    let spawned = std::thread::Builder::new()
        .name("spellcheck-load".to_owned())
        .spawn(|| {
            LazyLock::force(&RUSSIAN);
            LazyLock::force(&ENGLISH);
        });
    // Не вышло создать поток — не страшно: словари загрузятся при первой
    // проверке, просто первая проверка будет дольше.
    if let Err(err) = spawned {
        log::warn!("словари загрузятся при первой проверке: {err}");
    }
}

/// Язык слова — по алфавиту, которым оно написано.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Language {
    Russian,
    English,
}

impl Language {
    /// `None` — слово не проверяем: другой алфавит или смесь алфавитов.
    fn of(word: &str) -> Option<Self> {
        let mut language = None;
        for c in word.chars() {
            let current = match c {
                // Кириллица: основной блок Unicode, включая «ё».
                '\u{0400}'..='\u{04FF}' => Self::Russian,
                // Латиница, в том числе с диакритикой: café, naïve.
                c if c.is_alphabetic() && c <= '\u{024F}' => Self::English,
                // Апостроф и дефис внутри слова: don't, кто-нибудь.
                '\'' | '’' | '-' => continue,
                _ => return None,
            };
            match language {
                None => language = Some(current),
                Some(previous) if previous != current => return None,
                Some(_) => {}
            }
        }
        language
    }

    fn dictionary(self) -> &'static Dictionary {
        match self {
            Self::Russian => &RUSSIAN,
            Self::English => &ENGLISH,
        }
    }
}

/// Стоит ли проверять слово. Не проверяем однобуквенные слова, аббревиатуры
/// (`HTML`, `МГУ`) и слова с заглавными буквами внутри (`KaTeX`, `iPhone`):
/// в заметках это почти всегда названия, а не опечатки.
fn worth_checking(word: &str) -> bool {
    let mut letters = word
        .chars()
        .filter(|c| c.is_alphabetic())
        .skip(1)
        .peekable();
    letters.peek().is_some() && !letters.any(char::is_uppercase)
}

/// Есть ли слово в словаре. В русском «ё» необязательна: «еще» и «ещё» —
/// оба верные, как и в большинстве проверок орфографии.
fn in_dictionary(language: Language, word: &str) -> bool {
    let dictionary = language.dictionary();
    if dictionary.check(word) {
        return true;
    }
    if language == Language::Russian && word.contains(['ё', 'Ё']) {
        let without_yo = word.replace('ё', "е").replace('Ё', "Е");
        if dictionary.check(&without_yo) {
            return true;
        }
    }
    // Слово через дефис, которого нет в словаре целиком («онлайн-редактор»,
    // «spell-checker»): верное, если верна каждая часть.
    word.contains('-')
        && word
            .split('-')
            .all(|part| part.is_empty() || in_dictionary(language, part))
}

/// Ошибка ли в слове: проверяем по словарю его языка и по личному словарю.
pub fn is_misspelled(word: &str, personal: &PersonalDictionary) -> bool {
    let Some(language) = Language::of(word) else {
        return false;
    };
    worth_checking(word) && !personal.contains(word) && !in_dictionary(language, word)
}

/// Варианты исправления для слова — из словаря его языка.
pub fn suggestions(word: &str) -> Vec<String> {
    let Some(language) = Language::of(word) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    language.dictionary().suggest(word, &mut found);
    found.truncate(MAX_SUGGESTIONS);
    found
}

/// Личный словарь: слова, которые пользователь добавил через меню «Добавить
/// в словарь». Хранится в каталоге конфигурации, по слову на строке.
pub struct PersonalDictionary {
    /// `None` — каталог конфигурации неизвестен: слова живут до закрытия.
    path: Option<PathBuf>,
    /// `BTreeSet`, а не `HashSet`: файл пишется отсортированным, и его удобно
    /// читать и править руками.
    words: Mutex<BTreeSet<String>>,
}

impl PersonalDictionary {
    /// Читает словарь из файла. Если файла ещё нет, словарь пуст; если
    /// прочитать не удалось, пишет предупреждение в лог и тоже начинает с
    /// пустого — проверка орфографии не должна мешать работе.
    pub fn load(path: Option<PathBuf>) -> Self {
        let words = match path.as_deref().map(fs::read_to_string) {
            Some(Ok(text)) => text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect(),
            Some(Err(err)) if err.kind() != io::ErrorKind::NotFound => {
                log::warn!("личный словарь не прочитан: {err}");
                BTreeSet::new()
            }
            _ => BTreeSet::new(),
        };
        Self {
            path,
            words: Mutex::new(words),
        }
    }

    /// Есть ли слово в словаре. Слово, добавленное строчными («tauri»),
    /// подходит и с заглавной в начале предложения («Tauri»), а добавленное
    /// с заглавной — только с заглавной, как в словарях Hunspell.
    fn contains(&self, word: &str) -> bool {
        let words = self.lock();
        words.contains(word) || words.contains(&word.to_lowercase())
    }

    /// Добавляет слово и сразу сохраняет словарь на диск.
    ///
    /// # Errors
    ///
    /// Возвращает ошибку, если файл словаря не удалось записать. Слово при
    /// этом остаётся в словаре до закрытия программы.
    pub fn add(&self, word: &str) -> Result<(), AppError> {
        let word = word.trim();
        if word.is_empty() {
            return Ok(());
        }
        let text = {
            // Блокировка держится только на время правки: запись на диск
            // идёт уже без неё и не задерживает проверку слов.
            let mut words = self.lock();
            if !words.insert(word.to_owned()) {
                return Ok(());
            }
            words.iter().fold(String::new(), |mut text, word| {
                text.push_str(word);
                text.push('\n');
                text
            })
        };

        let Some(path) = &self.path else {
            return Ok(());
        };
        if let Some(directory) = path.parent() {
            fs::create_dir_all(directory).map_err(|source| AppError::Write {
                path: path.clone(),
                source,
            })?;
        }
        disk::write(path, text.as_bytes())
    }

    /// Мьютекс «отравлен», если другой поток упал, держа его. Множество слов
    /// при этом всё равно целое (вставка в `BTreeSet` не оставляет его
    /// наполовину изменённым), поэтому просто продолжаем с ним работать.
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.words.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> PersonalDictionary {
        PersonalDictionary::load(None)
    }

    #[test]
    fn bundled_dictionaries_parse() {
        LazyLock::force(&RUSSIAN);
        LazyLock::force(&ENGLISH);
    }

    #[test]
    fn detects_language_by_alphabet() {
        assert_eq!(Language::of("привет"), Some(Language::Russian));
        assert_eq!(Language::of("ёжик"), Some(Language::Russian));
        assert_eq!(Language::of("кто-нибудь"), Some(Language::Russian));
        assert_eq!(Language::of("hello"), Some(Language::English));
        assert_eq!(Language::of("don't"), Some(Language::English));
        assert_eq!(Language::of("café"), Some(Language::English));
        assert_eq!(Language::of("приvет"), None);
        assert_eq!(Language::of("αβγ"), None);
        assert_eq!(Language::of("abc123"), None);
    }

    #[test]
    fn accepts_correct_words() {
        let personal = empty();
        for word in [
            "привет",
            "Привет",
            "редактор",
            "файлы",
            "сохранится",
            "hello",
            "Editor",
            "dictionaries",
            "don't",
        ] {
            assert!(!is_misspelled(word, &personal), "{word}");
        }
    }

    #[test]
    fn finds_misspelled_words() {
        let personal = empty();
        for word in ["привт", "редактр", "сохраница", "helo", "dictionnary"] {
            assert!(is_misspelled(word, &personal), "{word}");
        }
    }

    #[test]
    fn yo_is_optional_in_russian() {
        let personal = empty();
        for word in ["ещё", "еще", "всё", "зелёный", "зеленый", "Ёлка"] {
            assert!(!is_misspelled(word, &personal), "{word}");
        }
    }

    #[test]
    fn hyphenated_words_are_checked_by_parts() {
        let personal = empty();
        assert!(!is_misspelled("кто-нибудь", &personal));
        assert!(!is_misspelled("онлайн-редактор", &personal));
        assert!(!is_misspelled("well-known", &personal));
        assert!(is_misspelled("кто-нибуть", &personal));
        // Смесь алфавитов не проверяется вовсе.
        assert!(!is_misspelled("Markdown-файл", &personal));
    }

    #[test]
    fn skips_abbreviations_short_words_and_other_scripts() {
        let personal = empty();
        for word in ["HTML", "МГУ", "KaTeX", "iPhone", "x", "я", "日本語", "αβγ"] {
            assert!(!is_misspelled(word, &personal), "{word}");
        }
    }

    #[test]
    fn suggests_corrections() {
        assert!(
            suggestions("привт").iter().any(|s| s == "привет"),
            "{:?}",
            suggestions("привт")
        );
        assert!(
            suggestions("helo").iter().any(|s| s == "hello"),
            "{:?}",
            suggestions("helo")
        );
        assert!(suggestions("helo").len() <= MAX_SUGGESTIONS);
        assert_eq!(suggestions("日本語"), Vec::<String>::new());
    }

    #[test]
    fn personal_dictionary_survives_restart() {
        let dir = tempfile::tempdir().expect("временный каталог");
        let path = dir.path().join("nested").join("dictionary.txt");

        let personal = PersonalDictionary::load(Some(path.clone()));
        assert!(is_misspelled("зюзябра", &personal));
        personal.add("зюзябра").expect("слово сохраняется");
        personal.add("tauri").expect("слово сохраняется");
        personal.add("tauri").expect("повтор не ошибка");
        assert!(!is_misspelled("зюзябра", &personal));

        let reloaded = PersonalDictionary::load(Some(path.clone()));
        assert!(!is_misspelled("зюзябра", &reloaded));
        // Добавлено строчными — подходит и с заглавной.
        assert!(!is_misspelled("Tauri", &reloaded));
        assert_eq!(
            fs::read_to_string(&path).expect("файл словаря"),
            "tauri\nзюзябра\n"
        );
    }
}
