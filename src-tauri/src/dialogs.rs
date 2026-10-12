//! Системные диалоги.
//!
//! Диалоги вызываются из Rust, а не из JS: так путь к файлу приходит от
//! пользователя, а не от кода в `WebView` (см. `documents.rs`).
//!
//! Все функции здесь блокирующие: поток ждёт, пока пользователь ответит.
//! Вызывать их можно только не из главного потока, иначе замрёт интерфейс.
//! Команды запускают их через `spawn_blocking`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::WebviewWindow;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::document::MARKDOWN_EXTENSIONS;
use crate::error::AppError;

const SAVE: &str = "Сохранить";
const DISCARD: &str = "Не сохранять";
const CANCEL: &str = "Отмена";

/// Сколько имён файлов перечислять в вопросе о несохранённых изменениях.
const LISTED_FILES_LIMIT: usize = 10;

/// Имя нового документа, пока его не сохранили (то же во фронтенде).
const NEW_DOCUMENT_NAME: &str = "Без названия";

/// Самое длинное имя файла, которое предлагаем по первой строке текста.
const SUGGESTED_NAME_LIMIT: usize = 60;

/// Символы, которые нельзя использовать в именах файлов (`/` — на Linux и
/// macOS, остальные — на Windows).
const FORBIDDEN_IN_FILE_NAMES: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Спрашивает, какие файлы открыть (можно выбрать несколько). Пустой
/// список — пользователь передумал.
pub fn pick_markdown_files(window: &WebviewWindow) -> Vec<PathBuf> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Открыть файлы")
        .add_filter("Markdown", MARKDOWN_EXTENSIONS)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        // На десктопе диалог всегда возвращает пути; URL бывают только
        // на мобильных платформах, их просто пропускаем.
        .filter_map(|file| file.into_path().ok())
        .collect()
}

/// Спрашивает, куда сохранить новый документ. `None` — пользователь
/// передумал.
///
/// Если имя ввели без расширения, дописывает `.md`: иначе файл потом не
/// узнать как Markdown. Про замену такого файла диалог не спрашивал (он
/// видел имя без `.md`), поэтому спрашиваем сами.
pub fn pick_new_file(window: &WebviewWindow, suggested_name: &str) -> Option<PathBuf> {
    let chosen = window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Сохранить как")
        .set_file_name(suggested_name)
        .add_filter("Markdown", MARKDOWN_EXTENSIONS)
        .blocking_save_file()?
        .into_path()
        .ok()?;
    if chosen.extension().is_some() {
        return Some(chosen);
    }
    let path = chosen.with_extension("md");
    if path.exists() && !confirm_replace(window, &path) {
        return None;
    }
    Some(path)
}

fn confirm_replace(window: &WebviewWindow, path: &Path) -> bool {
    let name = path.file_name().map_or_else(
        || path.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    window
        .dialog()
        .message(format!("Файл «{name}» уже есть. Заменить его?"))
        .title("Сохранить как")
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Заменить".into(),
            CANCEL.into(),
        ))
        .blocking_show()
}

/// Имя файла, которое «Сохранить как» предлагает для нового документа:
/// первая строка текста без решёток заголовка, как в VS Code. YAML-шапка
/// пропускается, недопустимые в именах файлов символы убираются. Пустой
/// документ — «Без названия.md».
pub fn suggested_file_name(text: &str) -> String {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let mut first = lines.next().unwrap_or_default();
    if first == "---" {
        // Шапка `---` … `---`: имя берём из первой строки после неё.
        first = lines
            .by_ref()
            .skip_while(|line| *line != "---")
            .nth(1)
            .unwrap_or_default();
    }
    let title: String = first
        .trim_start_matches('#')
        .chars()
        .filter(|c| !c.is_control() && !FORBIDDEN_IN_FILE_NAMES.contains(c))
        .take(SUGGESTED_NAME_LIMIT)
        .collect();
    // Точки в конце имени Windows молча отрезает.
    let title = title.trim().trim_end_matches('.').trim_end();
    let title = if title.is_empty() {
        NEW_DOCUMENT_NAME
    } else {
        title
    };
    format!("{title}.md")
}

/// Ответ на вопрос о несохранённых изменениях. Во фронтенд уходит строкой
/// `"save"`, `"discard"` или `"cancel"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UnsavedChoice {
    Save,
    Discard,
    Cancel,
}

/// Спрашивает, что делать с несохранёнными изменениями перед тем, как
/// закрыть вкладку или окно. Для нескольких файлов — один общий вопрос.
pub fn ask_unsaved_changes(window: &WebviewWindow, file_names: &[String]) -> UnsavedChoice {
    let result = window
        .dialog()
        .message(unsaved_changes_message(file_names))
        .title("Несохранённые изменения")
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            SAVE.into(),
            DISCARD.into(),
            CANCEL.into(),
        ))
        .blocking_show_with_result();
    unsaved_choice_from(&result)
}

fn unsaved_changes_message(file_names: &[String]) -> String {
    match file_names {
        [single] => format!("В «{single}» есть несохранённые изменения. Сохранить их?"),
        names => {
            // `write!` в `String` (трейт `fmt::Write`) форматирует сразу в
            // строку, без промежуточной `String` от `format!`. Запись в
            // память не может завершиться ошибкой, поэтому результат игнорируем.
            let mut message = String::from("Несохранённые изменения в файлах:\n");
            for name in names.iter().take(LISTED_FILES_LIMIT) {
                let _ = write!(message, "\n• {name}");
            }
            if names.len() > LISTED_FILES_LIMIT {
                let _ = write!(message, "\n… и ещё {}", names.len() - LISTED_FILES_LIMIT);
            }
            message.push_str("\n\nСохранить их?");
            message
        }
    }
}

/// Переводит нажатую кнопку в [`UnsavedChoice`].
///
/// С кастомными подписями диалог возвращает `Custom(подпись)`, а на некоторых
/// платформах — стандартные `Yes`/`No`. Обрабатываем оба варианта; всё
/// остальное (кнопка «Отмена», Esc, закрытие крестиком) — отмена.
fn unsaved_choice_from(result: &MessageDialogResult) -> UnsavedChoice {
    match result {
        MessageDialogResult::Yes => UnsavedChoice::Save,
        MessageDialogResult::No => UnsavedChoice::Discard,
        MessageDialogResult::Custom(label) if label == SAVE => UnsavedChoice::Save,
        MessageDialogResult::Custom(label) if label == DISCARD => UnsavedChoice::Discard,
        _ => UnsavedChoice::Cancel,
    }
}

/// Спрашивает, перезаписать ли файл, который изменили или удалили снаружи.
/// `conflict` — ошибка, из-за которой обычное сохранение не прошло.
pub fn confirm_overwrite(window: &WebviewWindow, conflict: &AppError) -> bool {
    window
        .dialog()
        .message(format!(
            "{conflict}.\n\nСохранить вашу версию? Изменения, сделанные снаружи, будут потеряны."
        ))
        .title("Файл изменился на диске")
        .kind(MessageDialogKind::Warning)
        .parent(window)
        .buttons(MessageDialogButtons::OkCancelCustom(
            SAVE.into(),
            CANCEL.into(),
        ))
        .blocking_show()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_dialog_buttons_to_choices() {
        let custom = |label: &str| MessageDialogResult::Custom(label.to_owned());

        assert_eq!(unsaved_choice_from(&custom(SAVE)), UnsavedChoice::Save);
        assert_eq!(
            unsaved_choice_from(&custom(DISCARD)),
            UnsavedChoice::Discard
        );
        assert_eq!(unsaved_choice_from(&custom(CANCEL)), UnsavedChoice::Cancel);
        assert_eq!(
            unsaved_choice_from(&MessageDialogResult::Yes),
            UnsavedChoice::Save
        );
        assert_eq!(
            unsaved_choice_from(&MessageDialogResult::No),
            UnsavedChoice::Discard
        );
        assert_eq!(
            unsaved_choice_from(&MessageDialogResult::Cancel),
            UnsavedChoice::Cancel
        );
    }

    #[test]
    fn lists_unsaved_files() {
        assert_eq!(
            unsaved_changes_message(&["a.md".into()]),
            "В «a.md» есть несохранённые изменения. Сохранить их?"
        );
        assert_eq!(
            unsaved_changes_message(&["a.md".into(), "b.md".into()]),
            "Несохранённые изменения в файлах:\n\n• a.md\n• b.md\n\nСохранить их?"
        );

        let many: Vec<String> = (1..=12).map(|n| format!("{n}.md")).collect();
        let message = unsaved_changes_message(&many);
        assert!(message.contains("• 10.md\n… и ещё 2"), "{message}");
        assert!(!message.contains("11.md"), "{message}");
    }

    #[test]
    fn suggests_file_name_from_first_line() {
        assert_eq!(suggested_file_name(""), "Без названия.md");
        assert_eq!(suggested_file_name("\n\n   \n"), "Без названия.md");
        assert_eq!(
            suggested_file_name("# План на неделю\n\nтекст"),
            "План на неделю.md"
        );
        assert_eq!(suggested_file_name("просто текст"), "просто текст.md");
        assert_eq!(
            suggested_file_name("## Вопрос: что/где?*\n"),
            "Вопрос чтогде.md"
        );
        assert_eq!(suggested_file_name("Конец...\n"), "Конец.md");
        assert_eq!(suggested_file_name("#\n"), "Без названия.md");
    }

    #[test]
    fn front_matter_is_skipped_and_long_titles_are_cut() {
        assert_eq!(
            suggested_file_name("---\ntags: [a]\n---\n\n# Заметка\n"),
            "Заметка.md"
        );
        let long = "я".repeat(100);
        assert_eq!(
            suggested_file_name(&long),
            format!("{}.md", "я".repeat(SUGGESTED_NAME_LIMIT))
        );
    }

    #[test]
    fn serializes_choice_for_frontend() {
        assert_eq!(
            serde_json::to_value(UnsavedChoice::Discard).unwrap(),
            "discard"
        );
    }
}
