//! Локальные картинки и ссылки на файлы в режиме чтения.
//!
//! `WebView` не может просто загрузить `img.png` из папки документа:
//! страница открыта с адреса приложения, и относительный путь указал бы
//! туда. Поэтому при рендере адрес картинки переписывается на наш протокол
//! `mdimg://localhost/<id документа>/<путь>`, а Rust по такому запросу
//! находит файл относительно папки документа и отдаёт его.
//!
//! Вложения `![[картинка.png]]` из Obsidian указывают не путь, а имя файла.
//! Их адрес — `mdimg://localhost/<id документа>/<имя>?embed`, и файл по
//! имени ищется уже при загрузке картинки (`wikilinks::resolve`): рендер
//! текста не ходит по папкам.
//!
//! Отдаются только файлы с расширениями картинок: даже если в `WebView`
//! выполнится чужой код, через этот протокол он не прочитает, скажем,
//! ключи SSH.

use std::fs;
use std::path::{Path, PathBuf};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use tauri::http::{Request, Response, StatusCode, header};
use tauri::{AppHandle, Manager, Url};

use crate::documents::{DocumentId, Documents};
use crate::render::ImageUrls;
use crate::wikilinks;

/// Схема протокола для локальных картинок.
pub const IMAGE_SCHEME: &str = "mdimg";

/// Запрос адреса с `?embed` — вложение: файл ищется по имени.
const EMBED_QUERY: &str = "embed";

/// Самая большая картинка, которую отдаст протокол.
const MAX_IMAGE_SIZE: u64 = 64 * 1024 * 1024;

/// Что кодировать в пути внутри адреса: всё, кроме букв, цифр и `-._~`.
/// Слеши тоже кодируются — весь путь становится одним сегментом адреса, и
/// `WebView` не станет «упрощать» `../` в нём.
const PATH_ENCODE_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// Начало адреса нашего протокола. На Windows `WebView2` не поддерживает
/// собственные схемы напрямую, и Tauri отдаёт их как `http://<схема>.localhost`.
fn protocol_base() -> String {
    if cfg!(windows) {
        format!("http://{IMAGE_SCHEME}.localhost/")
    } else {
        format!("{IMAGE_SCHEME}://localhost/")
    }
}

/// Адрес картинки для HTML. Адреса с протоколом (`https:`, `data:`) не
/// меняются; локальные пути превращаются в адрес протокола `mdimg`.
/// Без документа (новый, ещё не сохранённый) относительный путь не от чего
/// считать, и адрес остаётся как есть.
pub fn image_url(document: Option<DocumentId>, src: &str) -> String {
    match (document, local_target(src)) {
        (Some(id), Some(path)) => {
            let path = path.to_string_lossy();
            let encoded = utf8_percent_encode(&path, PATH_ENCODE_SET);
            format!("{}{}/{encoded}", protocol_base(), id.get())
        }
        _ => src.to_owned(),
    }
}

/// Адрес картинки-вложения `![[имя]]`: протокол найдёт файл по имени.
/// Без документа искать не от чего, и картинка не покажется.
pub fn embed_url(document: Option<DocumentId>, target: &str) -> String {
    match document {
        Some(id) => {
            let encoded = utf8_percent_encode(target, PATH_ENCODE_SET);
            format!("{}{}/{encoded}?{EMBED_QUERY}", protocol_base(), id.get())
        }
        None => target.to_owned(),
    }
}

/// Адреса картинок документа для рендера (`render::ImageUrls`).
pub struct DocumentImages {
    /// `None` — новый документ, ещё не сохранённый в файл.
    pub document: Option<DocumentId>,
}

impl ImageUrls for DocumentImages {
    fn image(&self, src: &str) -> String {
        image_url(self.document, src)
    }

    fn embed(&self, target: &str) -> String {
        embed_url(self.document, target)
    }
}

/// Путь в файловой системе, на который указывает адрес из Markdown, или
/// `None`, если это не локальный файл (`https:`, `mailto:` и т. п.).
///
/// Убирает `?запрос` и `#якорь` и раскодирует `%20` и подобное:
/// `my%20notes/a.md#часть` → `my notes/a.md`.
pub fn local_target(src: &str) -> Option<PathBuf> {
    if src.starts_with("file:") {
        return Url::parse(src).ok()?.to_file_path().ok();
    }
    if has_scheme(src) || src.starts_with('#') || src.is_empty() {
        return None;
    }
    let without_suffix = src.split(['?', '#']).next().unwrap_or(src);
    let decoded = percent_decode_str(without_suffix).decode_utf8_lossy();
    Some(PathBuf::from(decoded.as_ref()))
}

/// Есть ли у адреса протокол (`https:`, `mailto:`). Одна буква перед
/// двоеточием — это диск Windows (`C:\…`), а не протокол.
fn has_scheme(src: &str) -> bool {
    match src.split_once(':') {
        Some((scheme, _)) => {
            scheme.len() > 1
                && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        None => false,
    }
}

/// Похоже ли имя файла на картинку (по расширению).
pub fn is_image_name(name: &str) -> bool {
    image_mime(Path::new(name)).is_some()
}

/// MIME-тип по расширению; `None` — это не картинка, и отдавать файл нельзя.
fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Разбирает путь запроса `/<id>/<закодированный путь>`.
fn parse_request_path(uri_path: &str) -> Result<(DocumentId, PathBuf), StatusCode> {
    let (id, encoded) = uri_path
        .trim_start_matches('/')
        .split_once('/')
        .ok_or(StatusCode::BAD_REQUEST)?;
    let id = id.parse().map_err(|_| StatusCode::BAD_REQUEST)?;
    let path = percent_decode_str(encoded)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok((id, PathBuf::from(path.as_ref())))
}

/// Обработчик протокола `mdimg`. Ошибки отдаются кодами HTTP: `WebView`
/// покажет вместо картинки значок «не загрузилось».
pub fn handle(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let embed = request.uri().query() == Some(EMBED_QUERY);
    let result = load_image(app, request.uri().path(), embed);
    let response = match result {
        Ok((bytes, mime)) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            // Картинку могли поменять на диске: пусть WebView спрашивает заново.
            .header(header::CACHE_CONTROL, "no-cache")
            .body(bytes),
        Err(status) => Response::builder().status(status).body(Vec::new()),
    };
    // Сборка ответа ломается только на некорректных заголовках, а они у нас
    // постоянные.
    response.unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Читает картинку по пути из адреса. `embed` — путь на самом деле имя
/// вложения, и файл надо найти, как для вики-ссылки.
fn load_image(
    app: &AppHandle,
    uri_path: &str,
    embed: bool,
) -> Result<(Vec<u8>, &'static str), StatusCode> {
    let (id, path) = parse_request_path(uri_path)?;
    // Расширение проверяем до поиска: по `?embed` не должны искаться и
    // отдаваться файлы, которые не картинки.
    image_mime(&path).ok_or(StatusCode::FORBIDDEN)?;
    let directory = || {
        app.state::<Documents>()
            .directory(id)
            .map_err(|_| StatusCode::NOT_FOUND)
    };
    let path = if embed {
        wikilinks::resolve(&directory()?, &path.to_string_lossy()).ok_or(StatusCode::NOT_FOUND)?
    } else if path.is_absolute() {
        path
    } else {
        directory()?.join(path)
    };
    // Итоговый путь — тоже картинка: поиск по имени мог найти `имя.md`.
    let mime = image_mime(&path).ok_or(StatusCode::FORBIDDEN)?;

    let metadata = fs::metadata(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    if metadata.len() > MAX_IMAGE_SIZE {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let bytes = fs::read(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    Ok((bytes, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u64) -> DocumentId {
        n.to_string().parse().unwrap()
    }

    #[test]
    fn local_images_go_through_the_protocol_and_back() {
        let url = image_url(Some(id(7)), "../pics/my%20cat.png?raw=1");
        let base = protocol_base();
        assert_eq!(url, format!("{base}7/..%2Fpics%2Fmy%20cat.png"));

        let path = Url::parse(&url).unwrap().path().to_owned();
        assert_eq!(
            parse_request_path(&path),
            Ok((id(7), PathBuf::from("../pics/my cat.png")))
        );
    }

    #[test]
    fn embeds_go_through_the_protocol_with_a_marker() {
        let url = embed_url(Some(id(3)), "Вложения/кот 1.png");
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.query(), Some(EMBED_QUERY));
        assert_eq!(
            parse_request_path(parsed.path()),
            Ok((id(3), PathBuf::from("Вложения/кот 1.png")))
        );
        assert_eq!(embed_url(None, "кот.png"), "кот.png");
    }

    #[test]
    fn remote_and_data_images_are_untouched() {
        for src in ["https://example.com/a.png", "data:image/png;base64,AAAA"] {
            assert_eq!(image_url(Some(id(1)), src), src);
        }
        // Без документа относительный путь не от чего считать.
        assert_eq!(image_url(None, "a.png"), "a.png");
    }

    #[test]
    fn local_target_understands_paths_and_file_urls() {
        assert_eq!(
            local_target("notes/a.md#часть"),
            Some(PathBuf::from("notes/a.md"))
        );
        assert_eq!(local_target("https://example.com"), None);
        assert_eq!(local_target("mailto:a@b.c"), None);
        assert_eq!(local_target("#anchor"), None);
        assert_eq!(
            local_target("C:\\notes\\a.md"),
            Some(PathBuf::from("C:\\notes\\a.md"))
        );
        #[cfg(unix)]
        assert_eq!(
            local_target("file:///tmp/my%20notes/a.md"),
            Some(PathBuf::from("/tmp/my notes/a.md"))
        );
    }

    #[test]
    fn only_images_have_a_mime_type() {
        assert_eq!(image_mime(Path::new("a.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("logo.svg")), Some("image/svg+xml"));
        assert_eq!(image_mime(Path::new(".ssh/id_ed25519")), None);
        assert_eq!(image_mime(Path::new("notes.md")), None);
        assert!(is_image_name("Pasted image 20240101.png"));
        assert!(!is_image_name("План"));
    }

    #[test]
    fn rejects_malformed_request_paths() {
        assert_eq!(
            parse_request_path("/no-slash"),
            Err(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            parse_request_path("/abc/a.png"),
            Err(StatusCode::BAD_REQUEST)
        );
    }
}
