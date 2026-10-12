//! Markdown → HTML для режима чтения.
//!
//! Конвейер:
//! 1. comrak разбирает текст в дерево (AST);
//! 2. цитаты вида `> [!type] …` превращаются в callouts;
//! 3. comrak выводит дерево в HTML, по пути переписывая адреса картинок;
//! 4. ammonia вычищает из HTML всё опасное: скрипты, обработчики событий,
//!    ссылки `javascript:`.
//!
//! Формулы и диаграммы рисует фронтенд, уже после санитайзинга: здесь они
//! остаются текстом в элементах с атрибутом `data-math-style` и в блоках
//! кода `language-mermaid`.

use std::panic::RefUnwindSafe;
use std::sync::{Arc, LazyLock};

use comrak::nodes::{NodeValue, Sourcepos};
use comrak::options::URLRewriter;
use comrak::{Arena, Node, Options};

use crate::assets;
use crate::callouts::{self, Fold};

/// Превращает Markdown в безопасный HTML.
///
/// `rewrite_image` получает адрес каждой картинки из Markdown и возвращает
/// адрес для HTML (локальные картинки уходят на протокол `mdimg://`).
pub fn render_html<F>(markdown: &str, rewrite_image: F) -> String
where
    // Требования трейта `URLRewriter` из comrak: замыкание может вызываться
    // из разных потоков и не должно оставлять мусор при панике.
    F: Fn(&str) -> String + Send + Sync + RefUnwindSafe + 'static,
{
    let options = options(Some(Arc::new(rewrite_image)));
    // Арена — хранилище узлов дерева. Узлы ссылаются друг на друга обычными
    // ссылками `&'a`, и все живут ровно столько, сколько арена: в конце
    // функции дерево освобождается целиком, без подсчёта ссылок.
    let arena = Arena::new();
    let root = comrak::parse_document(&arena, markdown, &options);
    transform_callouts(&arena, root, &options);

    let mut html = String::new();
    // Запись в `String` не может завершиться ошибкой, а comrak проверяет
    // дерево перед выводом: ошибка здесь — баг в наших преобразованиях.
    comrak::format_html(root, &options, &mut html).expect("comrak выводит HTML в строку");
    SANITIZER.clean(&html).to_string()
}

fn options<'c>(rewrite_image: Option<Arc<dyn URLRewriter + 'c>>) -> Options<'c> {
    let mut options = Options::default();

    let extension = &mut options.extension;
    extension.strikethrough = true;
    extension.table = true;
    extension.autolink = true;
    extension.tasklist = true;
    extension.footnotes = true;
    extension.math_dollars = true;
    extension.math_code = true;
    // `==выделение==`, как в Obsidian.
    extension.highlight = true;
    // YAML-шапку `---` в начале файла не показываем.
    extension.front_matter_delimiter = Some("---".to_owned());
    // Якоря у заголовков: ссылки вида `[раздел](#заголовок)` работают.
    extension.header_id_prefix = Some(String::new());
    extension.image_url_rewriter = rewrite_image;

    let render = &mut options.render;
    // Сырой HTML из Markdown пропускаем (`<kbd>`, `<details>` и т. п.):
    // опасное из него всё равно вычистит ammonia.
    render.r#unsafe = true;
    // `data-sourcepos` у блоков: по ним фронтенд синхронизирует прокрутку
    // режима чтения и редактора.
    render.sourcepos = true;
    render.tasklist_classes = true;
    options
}

/// Санитайзер HTML. Настраивается один раз при первом обращении:
/// `LazyLock` — ленивая статическая переменная из стандартной библиотеки.
static SANITIZER: LazyLock<ammonia::Builder<'static>> = LazyLock::new(|| {
    let mut builder = ammonia::Builder::default();
    builder
        // Чекбоксы задач, сноски и сворачиваемые callouts.
        .add_tags(["input", "section", "details", "summary"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_tag_attributes("details", ["open"])
        .add_tag_attributes("ol", ["start"])
        .add_tag_attributes("th", ["align"])
        .add_tag_attributes("td", ["align"])
        // Классы и id нужны для оформления, сносок и якорей заголовков,
        // а data-атрибуты — для формул, callouts и синхронизации прокрутки.
        .add_generic_attributes(["class", "id"])
        .add_generic_attribute_prefixes(["data-"])
        .add_url_schemes([assets::IMAGE_SCHEME]);
    builder
});

/// Находит все цитаты-callouts и заменяет их разметкой callout.
fn transform_callouts<'a>(arena: &'a Arena<'a>, root: Node<'a>, options: &Options) {
    // Сначала собираем узлы, потом меняем дерево: менять его на ходу во
    // время обхода нельзя. Вложенные callouts тоже попадут в список.
    let quotes: Vec<Node<'a>> = root
        .descendants()
        .filter(|node| matches!(node.data().value, NodeValue::BlockQuote))
        .collect();
    for quote in quotes {
        transform_callout(arena, quote, options);
    }
}

/// Превращает цитату в callout, если она начинается с маркера `[!type]`.
///
/// Цитата заменяется последовательностью «сырой HTML начала → её дочерние
/// блоки → сырой HTML конца»: так содержимое callout рендерится обычным
/// путём comrak, со всеми списками, кодом и вложенными callouts.
fn transform_callout<'a>(arena: &'a Arena<'a>, quote: Node<'a>, options: &Options) {
    let Some(paragraph) = quote
        .first_child()
        .filter(|node| matches!(node.data().value, NodeValue::Paragraph))
    else {
        return;
    };

    // Маркер ищем в тексте до первого не-текстового узла. comrak может
    // разбить `[!note]` на несколько Text-узлов (скобку он сначала считает
    // началом ссылки), поэтому склеиваем их. Перевод строки — отдельный узел
    // SoftBreak, так что склеенный текст лежит целиком в первой строке.
    let leading: Vec<Node<'a>> = paragraph
        .children()
        .take_while(|node| matches!(node.data().value, NodeValue::Text(_)))
        .collect();
    let head: String = leading
        .iter()
        .filter_map(|node| match &node.data().value {
            NodeValue::Text(text) => Some(text.to_string()),
            _ => None,
        })
        .collect();
    let Some(header) = callouts::parse_header(&head) else {
        return;
    };

    // Убираем маркер: снимаем склеенные Text-узлы и возвращаем на их место
    // одним узлом то, что шло после маркера (начало заголовка).
    for node in &leading {
        node.detach();
    }
    if !header.title.is_empty() {
        let rest = arena.alloc(NodeValue::Text(header.title.to_owned().into()).into());
        paragraph.prepend(rest);
    }

    // Заголовок — всё до первого перевода строки, дальше начинается
    // содержимое callout.
    let title = arena.alloc(NodeValue::Paragraph.into());
    while let Some(node) = paragraph.first_child() {
        if matches!(
            node.data().value,
            NodeValue::SoftBreak | NodeValue::LineBreak
        ) {
            node.detach();
            break;
        }
        title.append(node);
    }
    if paragraph.first_child().is_none() {
        paragraph.detach();
    }

    let title_html = match render_inline(arena, title, options) {
        html if html.is_empty() => escape_html(&callouts::default_title(&header.kind)),
        html => html,
    };
    let sourcepos = quote.data().sourcepos;
    let (open, close) = callout_wrapper(
        callouts::canonical_kind(&header.kind),
        header.fold,
        &title_html,
        sourcepos,
    );

    quote.insert_before(arena.alloc(NodeValue::Raw(open).into()));
    while let Some(child) = quote.first_child() {
        quote.insert_before(child);
    }
    quote.insert_before(arena.alloc(NodeValue::Raw(close).into()));
    quote.detach();
}

/// HTML начала и конца callout. Сворачиваемые callouts — это `<details>`:
/// браузер сворачивает их сам, без скриптов.
fn callout_wrapper(
    kind: &str,
    fold: Option<Fold>,
    title_html: &str,
    sourcepos: Sourcepos,
) -> (String, String) {
    let (tag, title_tag, fold_attrs) = match fold {
        None => ("div", "div", ""),
        Some(Fold::Open) => ("details", "summary", r#" data-callout-fold="+" open"#),
        Some(Fold::Closed) => ("details", "summary", r#" data-callout-fold="-""#),
    };
    // `\` в конце строки литерала склеивает её со следующей без переноса и
    // отступа: так длинный HTML можно записать по частям.
    let open = format!(
        "<{tag} class=\"callout\" data-callout=\"{kind}\" data-sourcepos=\"{sourcepos}\"{fold_attrs}>\n\
         <{title_tag} class=\"callout-title\"><span class=\"callout-icon\"></span>\
         <span class=\"callout-title-inner\">{title_html}</span></{title_tag}>\n\
         <div class=\"callout-content\">\n"
    );
    let close = format!("</div>\n</{tag}>\n");
    (open, close)
}

/// Рендерит строчное содержимое абзаца `paragraph` без обёртки `<p>`.
fn render_inline<'a>(arena: &'a Arena<'a>, paragraph: Node<'a>, options: &Options) -> String {
    if paragraph.first_child().is_none() {
        return String::new();
    }
    // comrak выводит только целые документы, поэтому временно кладём абзац в
    // отдельный документ, а `data-sourcepos` здесь не нужен.
    let document = arena.alloc(NodeValue::Document.into());
    document.append(paragraph);
    let mut options = options.clone();
    options.render.sourcepos = false;

    let mut html = String::new();
    comrak::format_html(document, &options, &mut html).expect("comrak выводит HTML в строку");
    html.trim_end()
        .strip_prefix("<p>")
        .and_then(|inner| inner.strip_suffix("</p>"))
        .unwrap_or(&html)
        .to_owned()
}

fn escape_html(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(markdown: &str) -> String {
        render_html(markdown, |src: &str| format!("mdimg://test/{src}"))
    }

    #[test]
    fn renders_gfm_basics() {
        let html = render("# Title\n\n- [x] done\n- [ ] todo\n\n~~old~~ ==new==\n");
        assert!(html.contains("<h1"), "{html}");
        assert!(html.contains(r#"type="checkbox""#), "{html}");
        // У строчных элементов тоже есть data-sourcepos, поэтому проверяем
        // тег и содержимое по отдельности.
        assert!(
            html.contains("<del ") && html.contains(">old</del>"),
            "{html}"
        );
        assert!(
            html.contains("<mark ") && html.contains(">new</mark>"),
            "{html}"
        );
        assert!(html.contains("data-sourcepos"), "{html}");
    }

    /// Режим чтения отмечает задачи по строке из `data-sourcepos` у `<li>`:
    /// номер должен указывать на строку исходника, считая YAML-шапку.
    #[test]
    fn task_items_point_to_their_source_lines() {
        let html = render("---\ntags: [a]\n---\n- [ ] one\n\n> [!note]\n> - [x] two\n");
        assert!(
            html.contains(r#"<li class="task-list-item" data-sourcepos="4:"#),
            "{html}"
        );
        assert!(
            html.contains(r#"<li class="task-list-item" data-sourcepos="7:"#),
            "{html}"
        );
        assert!(
            html.contains(r#"class="task-list-item-checkbox""#),
            "{html}"
        );
    }

    #[test]
    fn hides_front_matter() {
        let html = render("---\ntags: [a]\n---\n# Body\n");
        assert!(!html.contains("tags"), "{html}");
        assert!(html.contains("Body"), "{html}");
    }

    #[test]
    fn turns_quote_with_marker_into_callout() {
        let html = render("> [!TIP] Совет **важный**\n> Первая строка\n>\n> - пункт\n");
        assert!(
            html.contains(r#"<div class="callout" data-callout="tip""#),
            "{html}"
        );
        assert!(
            html.contains(
                r#"<span class="callout-title-inner">Совет <strong>важный</strong></span>"#
            ),
            "{html}"
        );
        assert!(html.contains("Первая строка"), "{html}");
        assert!(html.contains("<li"), "{html}");
        assert!(!html.contains("blockquote"), "{html}");
        assert!(!html.contains("[!TIP]"), "{html}");
    }

    #[test]
    fn callout_without_title_uses_kind_name() {
        let html = render("> [!faq]\n> Ответ\n");
        assert!(html.contains(r#"data-callout="question""#), "{html}");
        assert!(
            html.contains(r#"<span class="callout-title-inner">Faq</span>"#),
            "{html}"
        );
    }

    #[test]
    fn foldable_callouts_use_details() {
        let closed = render("> [!note]- Свёрнутый\n> текст\n");
        assert!(closed.contains("<details"), "{closed}");
        assert!(!closed.contains(" open"), "{closed}");
        assert!(
            closed.contains(r#"<summary class="callout-title">"#),
            "{closed}"
        );

        let open = render("> [!note]+ Открытый\n> текст\n");
        assert!(
            open.contains("<details") && open.contains(" open"),
            "{open}"
        );
    }

    #[test]
    fn nested_callouts_are_transformed_too() {
        let html = render("> [!note] Внешний\n> > [!warning] Внутренний\n> > текст\n");
        assert!(html.contains(r#"data-callout="note""#), "{html}");
        assert!(html.contains(r#"data-callout="warning""#), "{html}");
        assert!(!html.contains("blockquote"), "{html}");
    }

    #[test]
    fn ordinary_quotes_stay_quotes() {
        let html = render("> Просто цитата [!не маркер]\n");
        assert!(html.contains("<blockquote"), "{html}");
        assert!(!html.contains("class=\"callout"), "{html}");
    }

    #[test]
    fn keeps_math_for_the_frontend() {
        let html = render("Inline $E=mc^2$ and\n\n$$\\int x$$\n");
        assert!(html.contains(r#"data-math-style="inline""#), "{html}");
        assert!(html.contains(r#"data-math-style="display""#), "{html}");
    }

    #[test]
    fn rewrites_image_urls() {
        let html = render("![pic](images/a.png)\n");
        assert!(
            html.contains(r#"src="mdimg://test/images/a.png""#),
            "{html}"
        );
    }

    #[test]
    fn strips_dangerous_html() {
        let html = render(concat!(
            "<script>alert(1)</script>\n\n",
            "<img src=x onerror=alert(2)>\n\n",
            "[click](javascript:alert(3))\n\n",
            "<a href=\"https://example.com\" onclick=\"alert(4)\">ok</a>\n",
        ));
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("alert(1)"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(!html.contains("onclick"), "{html}");
        assert!(html.contains("https://example.com"), "{html}");
    }

    #[test]
    fn escapes_default_title() {
        assert_eq!(escape_html(r#"<b>&"x""#), "&lt;b&gt;&amp;&quot;x&quot;");
    }
}
