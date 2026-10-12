//! Callouts в стиле Obsidian: `> [!type]± Заголовок`.
//!
//! Здесь только знания о callouts: какие бывают типы и синонимы и как
//! разобрать маркер в начале первой строки. Как callout превращается в HTML,
//! решает `render.rs`.

/// Стандартные типы Obsidian и их синонимы. От типа зависят цвет и иконка.
const KINDS: &[(&str, &[&str])] = &[
    ("note", &[]),
    ("abstract", &["summary", "tldr"]),
    ("info", &[]),
    ("todo", &[]),
    ("tip", &["hint", "important"]),
    ("success", &["check", "done"]),
    ("question", &["help", "faq"]),
    ("warning", &["caution", "attention"]),
    ("failure", &["fail", "missing"]),
    ("danger", &["error"]),
    ("bug", &[]),
    ("example", &[]),
    ("quote", &["cite"]),
];

/// Канонический тип для оформления. Незнакомые типы выглядят как `note`,
/// но заголовок по умолчанию у них свой (см. [`default_title`]).
pub fn canonical_kind(kind: &str) -> &'static str {
    KINDS
        .iter()
        .find(|(name, aliases)| {
            name.eq_ignore_ascii_case(kind)
                || aliases.iter().any(|alias| alias.eq_ignore_ascii_case(kind))
        })
        .map_or("note", |(name, _)| name)
}

/// Можно ли свернуть callout и каким он показывается сначала.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fold {
    /// `[!note]+` — свёрнутый можно открыть, по умолчанию открыт.
    Open,
    /// `[!note]-` — по умолчанию свёрнут.
    Closed,
}

/// Разобранный маркер callout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header<'a> {
    /// Тип в нижнем регистре, как его написали: `[!TIP]` → `tip`.
    pub kind: String,
    pub fold: Option<Fold>,
    /// Текст после маркера — начало заголовка, без ведущих пробелов.
    /// Пустой, если заголовок не указан.
    pub title: &'a str,
}

/// Разбирает начало первой строки callout: `[!type]`, необязательный
/// `+` или `-` и заголовок. Возвращает `None`, если это не callout.
///
/// Время жизни `'a` у результата связывает заголовок с исходной строкой:
/// [`Header::title`] — срез `line`, а не копия.
pub fn parse_header(line: &str) -> Option<Header<'_>> {
    let rest = line.strip_prefix("[!")?;
    let end = rest.find(']')?;
    let kind = &rest[..end];
    let is_kind_char = |c: char| c.is_alphanumeric() || c == '-' || c == '_';
    if kind.is_empty() || !kind.chars().all(is_kind_char) {
        return None;
    }

    let mut rest = &rest[end + 1..];
    let fold = if let Some(after) = rest.strip_prefix('+') {
        rest = after;
        Some(Fold::Open)
    } else if let Some(after) = rest.strip_prefix('-') {
        rest = after;
        Some(Fold::Closed)
    } else {
        None
    };

    // После маркера — либо конец строки, либо пробел перед заголовком.
    // `[!note]text` — это просто текст в цитате.
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }

    Some(Header {
        kind: kind.to_lowercase(),
        fold,
        title: rest.trim_start(),
    })
}

/// Заголовок по умолчанию — тип с заглавной буквы, как в Obsidian:
/// `[!tip]` → «Tip», `[!мой-тип]` → «Мой-тип».
pub fn default_title(kind: &str) -> String {
    let mut chars = kind.chars();
    match chars.next() {
        // `to_uppercase` возвращает итератор: в Unicode одна строчная буква
        // может превратиться в несколько заглавных (ß → SS).
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_kind_fold_and_title() {
        assert_eq!(
            parse_header("[!WARNING]- Осторожно, **горячо**"),
            Some(Header {
                kind: "warning".into(),
                fold: Some(Fold::Closed),
                title: "Осторожно, **горячо**",
            })
        );
        assert_eq!(
            parse_header("[!tip]+"),
            Some(Header {
                kind: "tip".into(),
                fold: Some(Fold::Open),
                title: "",
            })
        );
        assert_eq!(parse_header("[!note]").map(|h| h.fold), Some(None));
    }

    #[test]
    fn rejects_things_that_are_not_callouts() {
        assert_eq!(parse_header("just a quote"), None);
        assert_eq!(parse_header("[!] empty"), None);
        assert_eq!(parse_header("[!two words] nope"), None);
        assert_eq!(parse_header("[!note]glued"), None);
        assert_eq!(parse_header("[note] missing bang"), None);
    }

    #[test]
    fn resolves_aliases_case_insensitively() {
        assert_eq!(canonical_kind("TLDR"), "abstract");
        assert_eq!(canonical_kind("error"), "danger");
        assert_eq!(canonical_kind("cite"), "quote");
        assert_eq!(canonical_kind("something-custom"), "note");
    }

    #[test]
    fn default_title_capitalizes_first_letter() {
        assert_eq!(default_title("tip"), "Tip");
        assert_eq!(default_title("мой-тип"), "Мой-тип");
        assert_eq!(default_title(""), "");
    }
}
