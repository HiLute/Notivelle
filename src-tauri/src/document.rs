//! Преобразование между байтами файла и текстом в редакторе.
//!
//! `CodeMirror` хранит текст со строками, разделёнными `\n`. На диске же
//! переводы строк бывают `\r\n` (Windows) и `\r` (классическая Mac OS), а в
//! начале UTF-8-файла может стоять BOM. [`decode`] запоминает эти особенности
//! в [`TextFormat`], а [`encode`] восстанавливает их, поэтому цикл
//! «открыть → сохранить» возвращает исходные байты один в один.
//!
//! Модуль ничего не знает о файлах и путях — только байты и строки,
//! поэтому его легко покрыть тестами.

use std::borrow::Cow;
use std::path::Path;

use serde::Serialize;

/// Расширения файлов, которые редактор считает Markdown. Их показывает
/// диалог открытия, и только такие файлы открываются по ссылкам из текста.
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "txt"];

/// Похож ли файл на Markdown (по расширению, без учёта регистра).
pub fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            MARKDOWN_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        })
}

/// Метка порядка байтов (BOM) в начале UTF-8-файла.
const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// BOM других кодировок, которые мы распознаём, чтобы дать понятную ошибку.
/// Порядок важен: BOM UTF-32 LE начинается с тех же байтов, что и BOM
/// UTF-16 LE, поэтому более длинные метки проверяются первыми.
const FOREIGN_BOMS: &[(&[u8], &str)] = &[
    (&[0x00, 0x00, 0xFE, 0xFF], "UTF-32 BE"),
    (&[0xFF, 0xFE, 0x00, 0x00], "UTF-32 LE"),
    (&[0xFE, 0xFF], "UTF-16 BE"),
    (&[0xFF, 0xFE], "UTF-16 LE"),
];

/// Вид перевода строки в файле.
///
/// Во фронтенд уходит строкой: `"LF"`, `"CRLF"` или `"CR"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum LineEnding {
    /// `\n` — Linux, macOS и большинство Markdown-файлов.
    #[default]
    Lf,
    /// `\r\n` — Windows.
    CrLf,
    /// `\r` — классическая Mac OS, сейчас встречается редко.
    Cr,
}

impl LineEnding {
    /// Байты, которыми этот перевод строки записывается в файл.
    pub const fn as_bytes(self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::CrLf => b"\r\n",
            Self::Cr => b"\r",
        }
    }
}

/// Особенности файла, которые нужно восстановить при сохранении.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TextFormat {
    /// Перевод строки, которым будут записаны все строки файла.
    pub line_ending: LineEnding,
    /// Был ли в начале файла UTF-8 BOM.
    pub has_bom: bool,
    /// В файле встречались переводы строк разных видов. Сохранить такой
    /// файл байт-в-байт нельзя: при записи все они станут `line_ending`.
    pub mixed_line_endings: bool,
}

/// Результат [`decode`]: текст для редактора и формат для обратной записи.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decoded {
    /// Текст, где каждый перевод строки — `\n`.
    pub text: String,
    pub format: TextFormat,
}

/// Почему байты нельзя показать в редакторе как текст.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("файл в кодировке {0}, а поддерживается только UTF-8")]
    UnsupportedEncoding(&'static str),

    #[error("файл похож на двоичный: в нём есть нулевые байты")]
    Binary,

    #[error("файл не в кодировке UTF-8: некорректный байт на позиции {position}")]
    InvalidUtf8 {
        /// Смещение первого некорректного байта от начала файла (с учётом BOM).
        position: usize,
    },
}

/// Разбирает байты файла: снимает BOM, проверяет UTF-8, определяет вид
/// переводов строк и приводит их к `\n`.
///
/// Функция ничего не теряет: [`encode`] с полученным форматом вернёт
/// исходные байты, если только переводы строк не были смешанными.
pub fn decode(bytes: &[u8]) -> Result<Decoded, DecodeError> {
    if let Some(&(_, encoding)) = FOREIGN_BOMS.iter().find(|(bom, _)| bytes.starts_with(bom)) {
        return Err(DecodeError::UnsupportedEncoding(encoding));
    }

    let (has_bom, body) = match bytes.strip_prefix(UTF8_BOM) {
        Some(body) => (true, body),
        None => (false, bytes),
    };

    // Нулевой байт в тексте не встречается, зато есть почти в любом двоичном
    // файле (картинке, архиве) и в UTF-16 без BOM.
    if body.contains(&0) {
        return Err(DecodeError::Binary);
    }

    let raw = std::str::from_utf8(body).map_err(|err| DecodeError::InvalidUtf8 {
        position: (bytes.len() - body.len()) + err.valid_up_to(),
    })?;

    let stats = LineEndingStats::count(raw);
    Ok(Decoded {
        text: normalize_to_lf(raw).into_owned(),
        format: TextFormat {
            line_ending: stats.dominant(),
            has_bom,
            mixed_line_endings: stats.is_mixed(),
        },
    })
}

/// Собирает байты файла из текста редактора: заменяет `\n` на перевод строки
/// из `format` и при необходимости добавляет BOM.
pub fn encode(text: &str, format: TextFormat) -> Vec<u8> {
    // Редактор присылает текст только с `\n`, но одиночный `\r` в нём
    // превратился бы в лишний перевод строки неправильного вида. Нормализация
    // почти всегда бесплатна: если `\r` нет, Cow не копирует строку.
    let text = normalize_to_lf(text);
    let newline = format.line_ending.as_bytes();
    let bom: &[u8] = if format.has_bom { UTF8_BOM } else { &[] };

    let line_breaks = text.bytes().filter(|&byte| byte == b'\n').count();
    let mut out = Vec::with_capacity(bom.len() + text.len() + line_breaks * (newline.len() - 1));
    out.extend_from_slice(bom);
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.extend_from_slice(newline);
        }
        out.extend_from_slice(line.as_bytes());
    }
    out
}

/// Приводит все переводы строк к `\n`.
///
/// Возвращает [`Cow`]: если в тексте нет `\r`, менять нечего, и мы отдаём
/// заимствованную исходную строку без выделения памяти.
fn normalize_to_lf(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// Сколько переводов строк каждого вида встретилось в тексте.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct LineEndingStats {
    lf: usize,
    crlf: usize,
    cr: usize,
}

impl LineEndingStats {
    fn count(text: &str) -> Self {
        let mut stats = Self::default();
        let mut bytes = text.bytes().peekable();
        while let Some(byte) = bytes.next() {
            match byte {
                // `next_if_eq` забирает следующий байт, только если это `\n`:
                // так пара `\r\n` считается одним переводом строки.
                b'\r' if bytes.next_if_eq(&b'\n').is_some() => stats.crlf += 1,
                b'\r' => stats.cr += 1,
                b'\n' => stats.lf += 1,
                _ => {}
            }
        }
        stats
    }

    /// Самый частый вид перевода строки.
    fn dominant(self) -> LineEnding {
        // `max_by_key` при равенстве возвращает последний из максимальных
        // элементов, поэтому LF стоит в конце: при ничьей и в файле без
        // переводов строк выбирается он.
        [
            (LineEnding::Cr, self.cr),
            (LineEnding::CrLf, self.crlf),
            (LineEnding::Lf, self.lf),
        ]
        .into_iter()
        .max_by_key(|&(_, count)| count)
        .map_or(LineEnding::Lf, |(ending, _)| ending)
    }

    fn is_mixed(self) -> bool {
        [self.lf, self.crlf, self.cr]
            .into_iter()
            .filter(|&count| count > 0)
            .count()
            > 1
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn format(line_ending: LineEnding, has_bom: bool) -> TextFormat {
        TextFormat {
            line_ending,
            has_bom,
            mixed_line_endings: false,
        }
    }

    #[test]
    fn decodes_plain_lf() {
        let decoded = decode(b"# Title\n\ntext\n").unwrap();
        assert_eq!(decoded.text, "# Title\n\ntext\n");
        assert_eq!(decoded.format, format(LineEnding::Lf, false));
    }

    #[test]
    fn decodes_crlf_into_lf_text() {
        let decoded = decode(b"a\r\nb\r\n").unwrap();
        assert_eq!(decoded.text, "a\nb\n");
        assert_eq!(decoded.format, format(LineEnding::CrLf, false));
    }

    #[test]
    fn decodes_classic_mac_cr() {
        let decoded = decode(b"a\rb").unwrap();
        assert_eq!(decoded.text, "a\nb");
        assert_eq!(decoded.format.line_ending, LineEnding::Cr);
    }

    #[test]
    fn strips_and_remembers_utf8_bom() {
        let decoded = decode("\u{FEFF}Привет".as_bytes()).unwrap();
        assert_eq!(decoded.text, "Привет");
        assert!(decoded.format.has_bom);
    }

    #[test]
    fn text_without_line_breaks_defaults_to_lf() {
        assert_eq!(
            decode(b"one line").unwrap().format,
            format(LineEnding::Lf, false)
        );
        assert_eq!(decode(b"").unwrap().format, format(LineEnding::Lf, false));
    }

    #[test]
    fn mixed_line_endings_pick_the_most_common() {
        let decoded = decode(b"a\r\nb\r\nc\nd").unwrap();
        assert_eq!(decoded.text, "a\nb\nc\nd");
        assert_eq!(decoded.format.line_ending, LineEnding::CrLf);
        assert!(decoded.format.mixed_line_endings);
    }

    #[test]
    fn tie_between_line_endings_prefers_lf() {
        let decoded = decode(b"a\r\nb\nc").unwrap();
        assert_eq!(decoded.format.line_ending, LineEnding::Lf);
        assert!(decoded.format.mixed_line_endings);
    }

    #[test]
    fn reports_position_of_invalid_utf8() {
        // 0xFF не может встретиться в UTF-8 ни в какой позиции.
        assert_eq!(
            decode(b"ab\xFFcd"),
            Err(DecodeError::InvalidUtf8 { position: 2 })
        );
        // Позиция считается от начала файла, вместе с тремя байтами BOM.
        assert_eq!(
            decode(b"\xEF\xBB\xBFab\xFF"),
            Err(DecodeError::InvalidUtf8 { position: 5 })
        );
    }

    #[test]
    fn rejects_utf16_and_utf32() {
        assert_eq!(
            decode(b"\xFF\xFEa\x00"),
            Err(DecodeError::UnsupportedEncoding("UTF-16 LE"))
        );
        assert_eq!(
            decode(b"\xFE\xFF\x00a"),
            Err(DecodeError::UnsupportedEncoding("UTF-16 BE"))
        );
        assert_eq!(
            decode(b"\xFF\xFE\x00\x00a\x00\x00\x00"),
            Err(DecodeError::UnsupportedEncoding("UTF-32 LE"))
        );
    }

    #[test]
    fn rejects_binary_data() {
        assert_eq!(
            decode(b"\x89PNG\r\n\x1a\n\x00\x00"),
            Err(DecodeError::Binary)
        );
    }

    #[test]
    fn encodes_with_original_line_ending_and_bom() {
        assert_eq!(
            encode("a\nb\n", format(LineEnding::CrLf, true)),
            b"\xEF\xBB\xBFa\r\nb\r\n"
        );
        assert_eq!(encode("a\nb", format(LineEnding::Cr, false)), b"a\rb");
    }

    #[test]
    fn encode_normalizes_mixed_input() {
        // Если в тексте всё же оказался `\r`, он не должен размножиться.
        assert_eq!(
            encode("a\r\nb\rc\n", format(LineEnding::CrLf, false)),
            b"a\r\nb\r\nc\r\n"
        );
    }

    #[test]
    fn saving_mixed_file_normalizes_it() {
        let decoded = decode(b"a\r\nb\r\nc\n").unwrap();
        assert_eq!(encode(&decoded.text, decoded.format), b"a\r\nb\r\nc\r\n");
    }

    /// Стратегия для proptest: вид перевода строки.
    fn line_ending() -> impl Strategy<Value = LineEnding> {
        prop_oneof![
            Just(LineEnding::Lf),
            Just(LineEnding::CrLf),
            Just(LineEnding::Cr)
        ]
    }

    proptest! {
        /// Главное свойство модуля: файл с переводами строк одного вида
        /// после decode → encode совпадает с исходным побайтово.
        #[test]
        fn roundtrip_preserves_bytes(
            lines in prop::collection::vec("[^\r\n\x00]{0,20}", 0..30),
            ending in line_ending(),
            trailing_newline in any::<bool>(),
            bom in any::<bool>(),
        ) {
            let newline = std::str::from_utf8(ending.as_bytes()).unwrap();
            let mut text = lines.join(newline);
            if trailing_newline {
                text.push_str(newline);
            }
            let mut bytes = if bom { UTF8_BOM.to_vec() } else { Vec::new() };
            bytes.extend_from_slice(text.as_bytes());

            let decoded = decode(&bytes).unwrap();
            prop_assert!(!decoded.format.mixed_line_endings);
            if lines.len() > 1 || trailing_newline {
                prop_assert_eq!(decoded.format.line_ending, ending);
            }
            prop_assert_eq!(encode(&decoded.text, decoded.format), bytes);
        }

        /// Любые байты: decode не паникует, а всё, что он принял
        /// (кроме смешанных переводов строк), сохраняется без изменений.
        #[test]
        fn arbitrary_bytes_roundtrip_or_fail_cleanly(
            bytes in prop::collection::vec(any::<u8>(), 0..256),
        ) {
            // let-chain (edition 2024): `if let … && условие` без вложенного if.
            if let Ok(decoded) = decode(&bytes) && !decoded.format.mixed_line_endings {
                prop_assert_eq!(encode(&decoded.text, decoded.format), bytes);
            }
        }

        /// То же для произвольного Unicode-текста, где байты почти всегда
        /// валидны (случайные байты редко образуют корректный UTF-8).
        #[test]
        fn arbitrary_text_roundtrips(text in "(?s).{0,200}") {
            if let Ok(decoded) = decode(text.as_bytes()) && !decoded.format.mixed_line_endings {
                prop_assert_eq!(encode(&decoded.text, decoded.format), text.as_bytes());
            }
        }
    }
}
