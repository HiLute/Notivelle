//! Шрифты, установленные в системе, — для выбора в настройках.
//!
//! Список собирает крейт `fontdb`. Он находит каталоги со шрифтами (на
//! Linux — по конфигурации fontconfig, той же, которой пользуется `WebView`),
//! читает из каждого файла только таблицу имён и узнаёт семейство. Сами
//! шрифты в память не загружаются: файлы отображаются (`mmap`) и сразу
//! отпускаются.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::Serialize;

/// Семейство шрифтов в списке выбора.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FontFamily {
    /// Имя семейства — по нему шрифт находит CSS (`font-family`).
    pub name: String,
    /// Что видно по глифам. `serde(flatten)`: поля [`Traits`] уходят во
    /// фронтенд прямо в этом объекте — `{ name, monospace, symbols }`.
    #[serde(flatten)]
    pub traits: Traits,
}

/// Свойства шрифта, которые видно по его глифам.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Traits {
    /// Моноширинный: такие предлагаем для кода первыми.
    pub monospace: bool,
    /// Вместо букв — значки (Dingbats, Symbol): имя такого шрифта, написанное
    /// им самим, не прочитать.
    pub symbols: bool,
}

impl Traits {
    fn of(face: &ttf_parser::Face<'_>) -> Self {
        let glyph = |letter| face.glyph_index(letter);
        let advance = |letter| face.glyph_hor_advance(glyph(letter)?);
        Self {
            // У «i» и «W» одинаковая ширина. Флагу из самого файла
            // (`isFixedPitch` в таблице `post`) верить нельзя: его ставят не
            // все — у `JetBrainsMono Nerd Font` его нет, а у эмодзи он бывает.
            monospace: matches!(
                (advance('i'), advance('W')),
                (Some(narrow), Some(wide)) if narrow == wide
            ),
            // Глиф на месте «A» называется не «A»: в `D050000L` это `a10`
            // (значок), в `Standard Symbols PS` — `Alpha`. Имён у глифов может
            // и не быть — тогда считаем шрифт обычным.
            symbols: glyph('A')
                .and_then(|id| face.glyph_name(id))
                .is_some_and(|name| !matches!(name, "A" | "uni0041" | "u0041")),
        }
    }
}

/// Все семейства шрифтов системы, по алфавиту и без повторов.
///
/// Обходит сотни файлов: обычно это десятки миллисекунд, но пока файлов нет
/// в кэше диска — доли секунды. Поэтому вызывать её надо не в главном потоке.
pub fn system_fonts() -> Vec<FontFamily> {
    let started = Instant::now();
    let mut database = fontdb::Database::new();
    database.load_system_fonts();

    // У начертания может быть несколько имён семейства на разных языках;
    // первое — английское, его и понимает CSS.
    let faces = database.faces().filter_map(|face| {
        let (name, _language) = face.families.first()?;
        Some((name.as_str(), face.id))
    });
    let families: Vec<FontFamily> = group_by_family(faces)
        .into_iter()
        .map(|(name, face)| FontFamily {
            traits: traits(&database, face),
            name,
        })
        .collect();

    log::debug!(
        "шрифты: {} начертаний, {} семейств за {:?}",
        database.len(),
        families.len(),
        started.elapsed()
    );
    families
}

/// Начертания `(семейство, начертание)` → семейства по алфавиту, у каждого
/// одно (первое) начертание.
///
/// Одно семейство — это много файлов (обычный, жирный, курсив…), и регистр
/// имени в них бывает разный (`DejaVu Sans` и `Dejavu Sans`). Поэтому
/// ключ — имя в нижнем регистре, а показываем написание из первого файла.
/// `BTreeMap` хранит ключи упорядоченными: список выходит сразу по алфавиту.
///
/// Тип начертания `T` обобщённый: в программе это `fontdb::ID`, а в тестах
/// хватает чисел.
fn group_by_family<'a, T>(faces: impl IntoIterator<Item = (&'a str, T)>) -> Vec<(String, T)> {
    let mut families: BTreeMap<String, (String, T)> = BTreeMap::new();
    for (name, face) in faces {
        let name = name.trim();
        // Имена с точки — служебные шрифты macOS, по имени их не выбрать.
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        families
            .entry(name.to_lowercase())
            .or_insert_with(|| (name.to_owned(), face));
    }
    families.into_values().collect()
}

/// Свойства начертания по его файлу. Файла уже нет или он не читается —
/// обычный шрифт без особенностей.
fn traits(database: &fontdb::Database, face: fontdb::ID) -> Traits {
    database
        .with_face_data(face, |data, index| {
            ttf_parser::Face::parse(data, index)
                .ok()
                .as_ref()
                .map(Traits::of)
        })
        .flatten()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faces_are_grouped_into_sorted_families() {
        let faces = [
            ("Noto Sans", 1),
            ("JetBrains Mono", 2),
            ("DejaVu Sans", 3),
            ("Noto Sans", 4),
            ("Dejavu Sans", 5),
        ];
        assert_eq!(
            group_by_family(faces),
            [
                ("DejaVu Sans".to_owned(), 3),
                ("JetBrains Mono".to_owned(), 2),
                ("Noto Sans".to_owned(), 1),
            ]
        );
    }

    #[test]
    fn hidden_and_empty_names_are_skipped() {
        let faces = [(".SF NS", 1), ("  ", 2), (" Inter ", 3)];
        assert_eq!(group_by_family(faces), [("Inter".to_owned(), 3)]);
    }

    /// Шрифт, который есть в любой системе, взять неоткуда, поэтому тест
    /// проверяет только то, что список собирается и в нём нет мусора.
    #[test]
    fn system_fonts_are_listed_without_blank_names() {
        let fonts = system_fonts();
        assert!(fonts.iter().all(|font| !font.name.trim().is_empty()));
        assert!(
            fonts
                .windows(2)
                .all(|pair| pair[0].name.to_lowercase() < pair[1].name.to_lowercase())
        );
    }
}
