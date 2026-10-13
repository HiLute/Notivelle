//! Вики-ссылки в стиле Obsidian: `[[Заметка]]`, `[[Заметка#Заголовок|текст]]`
//! и вложения `![[картинка.png|300]]`.
//!
//! Здесь только то, что не зависит от Tauri и HTML:
//! - [`Target`] — цель ссылки: имя заметки и заголовок;
//! - [`find_embeds`] — вложения `![[…]]` в тексте;
//! - [`resolve`] — поиск файла по имени, как это делает Obsidian.
//!
//! В Obsidian ссылка — это имя заметки, а не путь: `[[План]]` найдёт
//! `План.md` в любой папке хранилища. У Notivelle хранилища нет, поэтому им
//! считается ближайшая папка выше документа, в которой есть `.obsidian`
//! (документ лежит в хранилище Obsidian), а если такой нет — папка самого
//! документа.

use std::collections::VecDeque;
use std::fs;
use std::ops::Range;
use std::path::{Path, PathBuf};

/// Сколько записей в папках просматривает поиск по имени. Хранилище на
/// десятки тысяч файлов — редкость, а папка документа может оказаться и
/// домашней: поиск не должен уйти в неё на минуты.
const MAX_SCANNED_ENTRIES: usize = 20_000;

/// Насколько глубоко во вложенные папки заходит поиск по имени.
const MAX_DEPTH: usize = 16;

/// Цель вики-ссылки: `Заметка#Заголовок` → заметка `Заметка`, заголовок
/// `Заголовок`.
///
/// Поля — срезы `&'a str` исходной строки: разбор ничего не копирует, а
/// время жизни `'a` не даёт пользоваться `Target` дольше, чем живёт строка.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target<'a> {
    /// Имя или путь заметки, как в ссылке (обычно без `.md`). Пустое —
    /// ссылка на заголовок в этом же документе: `[[#Заголовок]]`.
    pub note: &'a str,
    /// Заголовок внутри заметки.
    pub heading: Option<&'a str>,
}

impl<'a> Target<'a> {
    /// Разбирает цель ссылки — то, что стоит в `[[…]]` до `|`.
    pub fn parse(target: &'a str) -> Self {
        let (note, rest) = match target.split_once('#') {
            Some((note, rest)) => (note, Some(rest)),
            None => (target, None),
        };
        // `[[Заметка#^abc]]` — ссылка на блок; блоков Notivelle не знает и
        // ведёт просто на заметку. `[[Заметка#Раздел#Подраздел]]` — путь по
        // вложенным заголовкам: нужен последний. `rsplit` идёт с конца строки.
        let heading = rest.filter(|rest| !rest.starts_with('^')).and_then(|rest| {
            rest.rsplit('#')
                .map(str::trim)
                .find(|part| !part.is_empty())
        });
        Self {
            note: note.trim(),
            heading,
        }
    }

    /// Текст ссылки без подписи — так его показывает Obsidian:
    /// `Заметка > Заголовок`, `Заголовок` или `Заметка`.
    pub fn display(&self) -> String {
        match (self.note, self.heading) {
            ("", Some(heading)) => heading.to_owned(),
            (note, Some(heading)) => format!("{note} > {heading}"),
            (note, None) => note.to_owned(),
        }
    }
}

/// Вложение `![[цель|подпись]]`, найденное в тексте.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Embed<'a> {
    /// Где в тексте стоит `![[…]]` (байты, как у срезов строк).
    pub range: Range<usize>,
    /// Цель — как в вики-ссылке.
    pub target: &'a str,
    /// Текст после `|`: у картинок это размер (`300`, `300x200`) или
    /// подпись.
    pub label: Option<&'a str>,
}

/// Находит в тексте вложения `![[…]]`. Правила те же, что у comrak для
/// `[[…]]`: внутри нет `[` и `]`, а `|` отделяет цель от подписи.
pub fn find_embeds(text: &str) -> Vec<Embed<'_>> {
    let mut embeds = Vec::new();
    let mut from = 0;
    while let Some(offset) = text[from..].find("![[") {
        let start = from + offset;
        if let Some(embed) = parse_embed(text, start) {
            from = embed.range.end;
            embeds.push(embed);
        } else {
            // `!` — один байт, так что `start + 1` — граница символа.
            from = start + 1;
        }
    }
    embeds
}

/// Разбирает `![[…]]`, начинающееся в байте `start`.
fn parse_embed(text: &str, start: usize) -> Option<Embed<'_>> {
    const STOP: [char; 3] = ['[', ']', '|'];
    let inner = &text[start + "![[".len()..];
    let target_len = inner.find(STOP)?;
    let (target, after) = inner.split_at(target_len);
    let (label, tail) = match after.strip_prefix('|') {
        Some(after_pipe) => {
            let label_len = after_pipe.find(STOP)?;
            let (label, tail) = after_pipe.split_at(label_len);
            (Some(label.trim()), tail)
        }
        None => (None, after),
    };
    let target = target.trim();
    if target.is_empty() || !tail.starts_with("]]") {
        return None;
    }
    // Конец вложения — после `]]`; `tail` — хвост исходной строки, поэтому
    // его позиция считается от конца.
    let end = text.len() - tail.len() + "]]".len();
    Some(Embed {
        range: start..end,
        target,
        label,
    })
}

/// Размер картинки из подписи вложения: `300` — ширина, `300x200` —
/// ширина и высота. `None` — подпись не размер, а текст.
pub fn image_size(label: &str) -> Option<(u32, Option<u32>)> {
    let (width, height) = match label.split_once('x') {
        Some((width, height)) => (width, Some(height)),
        None => (label, None),
    };
    let width = width.trim().parse().ok()?;
    // `Option<Result<…>>` → `Result<Option<…>>`: высоты нет — это не ошибка,
    // а высота «abc» — ошибка.
    let height = height
        .map(|height| height.trim().parse())
        .transpose()
        .ok()?;
    Some((width, height))
}

/// Находит файл, на который указывает вики-ссылка `note` из документа в
/// папке `document_dir`.
///
/// Как в Obsidian, `.md` можно не писать, а путь — указывать частично:
/// 1. файл рядом с документом или по пути от корня хранилища;
/// 2. иначе — файл с таким именем (или концом пути) где угодно в
///    хранилище, без учёта регистра; из нескольких — ближайший к корню.
pub fn resolve(document_dir: &Path, note: &str) -> Option<PathBuf> {
    let note = note.trim();
    if note.is_empty() {
        return None;
    }
    let root = vault_root(document_dir);
    // Сначала с `.md`: `[[План]]` — это `План.md`. Если файл уже с
    // расширением (`[[План.md]]`, `[[схема.png]]`), сработает второй вариант.
    let candidates = [format!("{note}.md"), note.to_owned()];
    for name in &candidates {
        for base in [document_dir, root.as_path()] {
            let path = base.join(name);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    find_by_name(&root, &candidates)
}

/// Корень хранилища Obsidian, в котором лежит документ: ближайшая папка
/// выше, где есть `.obsidian`. Если документ не в хранилище — его папка.
pub fn vault_root(document_dir: &Path) -> PathBuf {
    document_dir
        .ancestors()
        .find(|dir| dir.join(".obsidian").is_dir())
        .unwrap_or(document_dir)
        .to_owned()
}

/// Ищет под `root` файл, путь которого заканчивается одним из `candidates`.
///
/// Обход в ширину: папки просматриваются уровень за уровнем, поэтому первые
/// найденные файлы — самые близкие к корню, и глубже можно не идти. Среди
/// найденных на одном уровне берётся первый по алфавиту: порядок файлов в
/// папке зависит от файловой системы, а результат должен быть одинаковым.
fn find_by_name(root: &Path, candidates: &[String]) -> Option<PathBuf> {
    // Obsidian сравнивает имена без учёта регистра и с `/` в путях.
    let wanted: Vec<(String, String)> = candidates
        .iter()
        .map(|name| {
            let name = normalize(name);
            let suffix = format!("/{name}");
            (name, suffix)
        })
        .collect();
    let matches = |relative: &str| {
        wanted
            .iter()
            .any(|(name, suffix)| relative == name || relative.ends_with(suffix.as_str()))
    };

    let mut queue = VecDeque::from([(root.to_owned(), 0)]);
    let mut found: Option<(usize, PathBuf)> = None;
    let mut scanned = 0;
    while let Some((dir, depth)) = queue.pop_front() {
        // Папки идут по возрастанию глубины: дальше будут только глубже.
        if found
            .as_ref()
            .is_some_and(|(found_depth, _)| depth > *found_depth)
        {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > MAX_SCANNED_ENTRIES {
                log::warn!(
                    "поиск по вики-ссылке остановлен: в {} больше {MAX_SCANNED_ENTRIES} файлов",
                    root.display()
                );
                return found.map(|(_, path)| path);
            }
            // Скрытые папки и файлы (.obsidian, .git, .trash) пропускаем,
            // как и Obsidian.
            if entry.file_name().as_encoded_bytes().starts_with(b".") {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            // Ссылки на папки не обходим: они могут вести по кругу.
            if kind.is_dir() {
                if depth < MAX_DEPTH {
                    queue.push_back((path, depth + 1));
                }
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            if !matches(&normalize(&relative.to_string_lossy())) {
                continue;
            }
            let better = match &found {
                Some((_, best)) => path < *best,
                None => true,
            };
            if better {
                found = Some((depth, path));
            }
        }
    }
    found.map(|(_, path)| path)
}

/// Путь для сравнения: `/` вместо `\` (Windows) и нижний регистр.
fn normalize(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Строковые литералы живут всю программу (`&'static str`), поэтому
    /// и `Target` из них — `Target<'static>`.
    fn target(note: &'static str, heading: Option<&'static str>) -> Target<'static> {
        Target { note, heading }
    }

    #[test]
    fn parses_note_and_heading() {
        assert_eq!(Target::parse("План"), target("План", None));
        assert_eq!(Target::parse("План#Этап 1"), target("План", Some("Этап 1")));
        assert_eq!(Target::parse("#Этап 1"), target("", Some("Этап 1")));
        assert_eq!(
            Target::parse(" План # Раздел # Подраздел "),
            target("План", Some("Подраздел"))
        );
        assert_eq!(Target::parse("План#^abc123"), target("План", None));
        assert_eq!(Target::parse("План#"), target("План", None));
    }

    #[test]
    fn displays_like_obsidian() {
        assert_eq!(Target::parse("План").display(), "План");
        assert_eq!(Target::parse("План#Этап").display(), "План > Этап");
        assert_eq!(Target::parse("#Этап").display(), "Этап");
    }

    #[test]
    fn finds_embeds_in_text() {
        let text = "до ![[кот.png|300]] между ![[Заметка]] после";
        let embeds = find_embeds(text);
        assert_eq!(embeds.len(), 2);
        assert_eq!(&text[embeds[0].range.clone()], "![[кот.png|300]]");
        assert_eq!(embeds[0].target, "кот.png");
        assert_eq!(embeds[0].label, Some("300"));
        assert_eq!(&text[embeds[1].range.clone()], "![[Заметка]]");
        assert_eq!(embeds[1].label, None);
    }

    #[test]
    fn skips_malformed_embeds() {
        for text in [
            "![[]]",
            "![[ ]]",
            "![[a[b]]",
            "![[a|b|c]]",
            "![[незакрыто",
            "![a]]",
        ] {
            assert_eq!(find_embeds(text), Vec::new(), "{text}");
        }
        // После неудачной попытки поиск продолжается.
        let embeds = find_embeds("![[a[b]] ![[c.png]]");
        assert_eq!(embeds.len(), 1);
        assert_eq!(embeds[0].target, "c.png");
    }

    #[test]
    fn parses_image_sizes() {
        assert_eq!(image_size("300"), Some((300, None)));
        assert_eq!(image_size("300x200"), Some((300, Some(200))));
        assert_eq!(image_size(" 300 x 200 "), Some((300, Some(200))));
        assert_eq!(image_size("Схема"), None);
        assert_eq!(image_size("300xабв"), None);
    }

    /// Создаёт файлы с пустым содержимым по относительным путям.
    fn files(paths: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for path in paths {
            let path = dir.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "").unwrap();
        }
        dir
    }

    #[test]
    fn resolves_next_to_the_document() {
        let dir = files(&["notes/План.md", "notes/кот.png", "notes/План"]);
        let notes = dir.path().join("notes");
        assert_eq!(resolve(&notes, "План"), Some(notes.join("План.md")));
        assert_eq!(resolve(&notes, "План.md"), Some(notes.join("План.md")));
        assert_eq!(resolve(&notes, "кот.png"), Some(notes.join("кот.png")));
        assert_eq!(resolve(&notes, "Нет такой"), None);
        assert_eq!(resolve(&notes, "  "), None);
    }

    #[test]
    fn searches_subfolders_by_name_ignoring_case() {
        let dir = files(&["Уроки/Урок 1.md", "Уроки/deep/er/Урок 2.md", "a/Итоги.md"]);
        let root = dir.path();
        assert_eq!(
            resolve(root, "урок 2"),
            Some(root.join("Уроки/deep/er/Урок 2.md"))
        );
        assert_eq!(
            resolve(root, "deep/er/Урок 2"),
            Some(root.join("Уроки/deep/er/Урок 2.md"))
        );
        // Папка в пути должна совпасть целиком: `r` — не `er`.
        assert_eq!(resolve(root, "r/Урок 2"), None);
    }

    #[test]
    fn prefers_the_shallowest_match() {
        let dir = files(&["b/c/Заметка.md", "z/Заметка.md", "a/Заметка.md"]);
        assert_eq!(
            resolve(dir.path(), "Заметка"),
            Some(dir.path().join("a/Заметка.md"))
        );
    }

    #[test]
    fn searches_the_whole_obsidian_vault() {
        let dir = files(&[
            "vault/.obsidian/app.json",
            "vault/Уроки/Урок 1.md",
            "vault/Вложения/кот.png",
            "vault/Справка.md",
        ]);
        let vault = dir.path().join("vault");
        let lessons = vault.join("Уроки");
        assert_eq!(vault_root(&lessons), vault);
        assert_eq!(
            resolve(&lessons, "кот.png"),
            Some(vault.join("Вложения/кот.png"))
        );
        // Путь от корня хранилища.
        assert_eq!(
            resolve(&lessons, "Вложения/кот.png"),
            Some(vault.join("Вложения/кот.png"))
        );
        assert_eq!(resolve(&lessons, "Справка"), Some(vault.join("Справка.md")));
    }

    #[test]
    fn without_a_vault_searches_only_below_the_document() {
        let dir = files(&["Справка.md", "notes/Урок.md"]);
        let notes = dir.path().join("notes");
        assert_eq!(vault_root(&notes), notes);
        assert_eq!(resolve(&notes, "Справка"), None);
    }

    #[test]
    fn skips_hidden_folders() {
        let dir = files(&[".trash/Старое.md", ".git/Конфиг.md"]);
        assert_eq!(resolve(dir.path(), "Старое"), None);
        assert_eq!(resolve(dir.path(), "Конфиг"), None);
    }
}
