//! Системные диалоги.
//!
//! Диалоги вызываются из Rust, а не из JS: так путь к файлу приходит от
//! пользователя, а не от кода в `WebView` (см. `documents.rs`).
//!
//! Все функции здесь блокирующие: поток ждёт, пока пользователь ответит.
//! Вызывать их можно только не из главного потока, иначе замрёт интерфейс.
//! Команды запускают их через `spawn_blocking`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::WebviewWindow;
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::error::AppError;

/// Расширения, которые показывает диалог открытия.
const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "txt"];

const SAVE: &str = "Сохранить";
const DISCARD: &str = "Не сохранять";
const CANCEL: &str = "Отмена";

/// Спрашивает, какой файл открыть. `None` — пользователь передумал.
pub fn pick_markdown_file(window: &WebviewWindow) -> Option<PathBuf> {
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Открыть файл")
        .add_filter("Markdown", MARKDOWN_EXTENSIONS)
        .blocking_pick_file()?
        .into_path()
        .ok()
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
/// закрыть документ или открыть вместо него другой.
pub fn ask_unsaved_changes(window: &WebviewWindow, file_name: &str) -> UnsavedChoice {
    let result = window
        .dialog()
        .message(format!(
            "В «{file_name}» есть несохранённые изменения. Сохранить их?"
        ))
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
    fn serializes_choice_for_frontend() {
        assert_eq!(
            serde_json::to_value(UnsavedChoice::Discard).unwrap(),
            "discard"
        );
    }
}
