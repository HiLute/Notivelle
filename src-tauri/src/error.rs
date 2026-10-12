//! Ошибки приложения и их передача во фронтенд.

use std::borrow::Cow;
use std::io;
use std::path::PathBuf;

use serde::ser::{Serialize, SerializeStruct, Serializer};

use crate::document::DecodeError;
use crate::documents::DocumentId;

/// Ошибка, которую команда возвращает фронтенду.
///
/// Каждый вариант несёт достаточно контекста (обычно путь), чтобы сообщение
/// было понятно без логов. Сообщения на русском: их видит пользователь.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Не удалось прочитать «{}»: {}", .path.display(), io_reason(.source))]
    Read { path: PathBuf, source: io::Error },

    #[error("Не удалось сохранить «{}»: {}", .path.display(), io_reason(.source))]
    Write { path: PathBuf, source: io::Error },

    #[error("«{}» — не обычный файл", .path.display())]
    NotAFile { path: PathBuf },

    #[error(
        "Файл «{}» слишком большой: {} МиБ, а можно открыть не больше {} МиБ",
        .path.display(), mebibytes(*.size), mebibytes(*.limit)
    )]
    TooLarge {
        path: PathBuf,
        size: u64,
        limit: u64,
    },

    #[error("Не удалось открыть «{}»: {source}", .path.display())]
    Decode { path: PathBuf, source: DecodeError },

    #[error("Файл «{}» защищён от записи", .path.display())]
    ReadOnly { path: PathBuf },

    #[error("Файл «{}» изменила другая программа, пока он был открыт", .path.display())]
    ModifiedOnDisk { path: PathBuf },

    #[error("Файл «{}» удалили или переместили, пока он был открыт", .path.display())]
    MissingOnDisk { path: PathBuf },

    #[error("Документ {0} не открыт")]
    UnknownDocument(DocumentId),

    #[error("Внутренняя ошибка: {0}")]
    Internal(String),
}

impl AppError {
    /// Машиночитаемый код ошибки: по нему фронтенд решает, что делать дальше.
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Read { .. } => "read",
            Self::Write { .. } => "write",
            Self::NotAFile { .. } => "notAFile",
            Self::TooLarge { .. } => "tooLarge",
            Self::Decode { .. } => "decode",
            Self::ReadOnly { .. } => "readOnly",
            Self::ModifiedOnDisk { .. } => "modifiedOnDisk",
            Self::MissingOnDisk { .. } => "missingOnDisk",
            Self::UnknownDocument(_) => "unknownDocument",
            Self::Internal(_) => "internal",
        }
    }
}

/// Во фронтенд ошибка уходит объектом `{ kind, message }`.
///
/// `derive(Serialize)` здесь не подходит: `io::Error` не сериализуется, а
/// фронтенду нужен готовый текст сообщения, а не внутренности ошибки.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut error = serializer.serialize_struct("AppError", 2)?;
        error.serialize_field("kind", self.kind())?;
        error.serialize_field("message", &self.to_string())?;
        error.end()
    }
}

/// Понятное описание частых ошибок ввода-вывода. Системные сообщения
/// приходят на английском («Permission denied (os error 13)»), поэтому самые
/// частые случаи переводим, а остальные показываем как есть.
///
/// [`Cow`] позволяет вернуть либо статическую строку без выделения памяти,
/// либо собранную `String`.
fn io_reason(err: &io::Error) -> Cow<'static, str> {
    use io::ErrorKind;

    let reason = match err.kind() {
        ErrorKind::NotFound => "файл не найден",
        ErrorKind::PermissionDenied => "нет прав доступа",
        ErrorKind::StorageFull => "на диске закончилось место",
        ErrorKind::ReadOnlyFilesystem => "файловая система доступна только для чтения",
        ErrorKind::IsADirectory => "это папка, а не файл",
        ErrorKind::AlreadyExists => "файл с таким именем уже существует",
        _ => return Cow::Owned(err.to_string()),
    };
    Cow::Borrowed(reason)
}

/// Байты в мебибайты с округлением вверх: 1 байт сверх лимита — это уже «больше».
fn mebibytes(bytes: u64) -> u64 {
    bytes.div_ceil(1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let error = AppError::ReadOnly {
            path: PathBuf::from("/notes/todo.md"),
        };
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["kind"], "readOnly");
        assert_eq!(json["message"], "Файл «/notes/todo.md» защищён от записи");
    }

    #[test]
    fn translates_common_io_errors() {
        let error = AppError::Read {
            path: PathBuf::from("a.md"),
            source: io::Error::from(io::ErrorKind::PermissionDenied),
        };
        assert_eq!(
            error.to_string(),
            "Не удалось прочитать «a.md»: нет прав доступа"
        );
    }

    #[test]
    fn rounds_size_up_to_whole_mebibytes() {
        assert_eq!(mebibytes(1), 1);
        assert_eq!(mebibytes(1024 * 1024), 1);
        assert_eq!(mebibytes(1024 * 1024 + 1), 2);
    }
}
