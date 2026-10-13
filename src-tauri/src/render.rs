//! Markdown → HTML для режима чтения.
//!
//! Конвейер:
//! 1. comrak разбирает текст в дерево (AST);
//! 2. вики-ссылки `[[…]]` и вложения `![[…]]` получают свою разметку;
//! 3. цитаты вида `> [!type] …` превращаются в callouts;
//! 4. comrak выводит дерево в HTML, по пути переписывая адреса картинок;
//! 5. ammonia вычищает из HTML всё опасное: скрипты, обработчики событий,
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
use crate::wikilinks::{self, Target};

/// Адреса картинок для HTML. Рендер не знает, где лежит документ и как
/// `WebView` получает локальные файлы, — это решает тот, кто его вызывает
/// (`assets::DocumentImages`), а тесты подставляют свою реализацию.
///
/// Ограничения на трейт (`Send + Sync + RefUnwindSafe + 'static`) — из
/// трейта `URLRewriter` comrak: адреса могут переписываться из разных
/// потоков и не должны оставлять мусор при панике.
pub trait ImageUrls: Send + Sync + RefUnwindSafe + 'static {
    /// `![подпись](src)`: адрес из Markdown → адрес для `<img src>`.
    fn image(&self, src: &str) -> String;
    /// `![[имя]]`: файл ищется по имени, как у вики-ссылки.
    fn embed(&self, target: &str) -> String;
}

/// Превращает Markdown в безопасный HTML.
pub fn render_html(markdown: &str, urls: impl ImageUrls) -> String {
    // `Arc` — общий указатель с подсчётом ссылок: адреса нужны и comrak
    // (обычные картинки), и нашему преобразованию (вложения).
    let urls = Arc::new(urls);
    let rewriter = Arc::clone(&urls);
    let options = options(Some(Arc::new(move |src: &str| rewriter.image(src))));
    // Арена — хранилище узлов дерева. Узлы ссылаются друг на друга обычными
    // ссылками `&'a`, и все живут ровно столько, сколько арена: в конце
    // функции дерево освобождается целиком, без подсчёта ссылок.
    let arena = Arena::new();
    let root = comrak::parse_document(&arena, markdown, &options);
    // Вики-ссылки — до callouts: заголовок callout выводится в HTML сразу,
    // и ссылки в нём должны быть уже нашими.
    transform_wikilinks(&arena, root, urls.as_ref());
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
    // `[[Заметка|подпись]]`: подпись после `|`, как в Obsidian.
    extension.wikilinks_title_after_pipe = true;
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

/// Вики-ссылки и вложения Obsidian (`wikilinks.rs`).
///
/// `[[Заметка#Заголовок|подпись]]` comrak разбирает сам (узел `WikiLink`),
/// но вывел бы обычную ссылку с именем заметки вместо адреса. Мы выводим
/// `<a class="internal-link" data-wikilink="цель">`: по щелчку фронтенд
/// отдаёт цель в Rust, а тот ищет файл (`commands::open_wikilink`).
///
/// `![[картинка.png]]` comrak не разбирает (`!` перед `[` он считает
/// началом картинки) и оставляет текстом — вложения ищем в текстовых узлах.
/// Код (`` `![[…]]` ``) лежит в других узлах, его это не касается.
fn transform_wikilinks<'a>(arena: &'a Arena<'a>, root: Node<'a>, urls: &dyn ImageUrls) {
    let nodes: Vec<Node<'a>> = root
        .descendants()
        .filter(|node| {
            matches!(
                node.data().value,
                NodeValue::WikiLink(_) | NodeValue::Text(_)
            )
        })
        .collect();
    for node in nodes {
        // Значение копируем: дальше узел меняется, а `data()` — это
        // заимствование RefCell, которое нельзя держать во время изменений.
        let value = node.data().value.clone();
        match value {
            NodeValue::WikiLink(link) => transform_wikilink(arena, node, &link.url),
            NodeValue::Text(text) => transform_embeds(arena, node, &text, urls),
            _ => {}
        }
    }
}

/// Заменяет узел `WikiLink` нашей ссылкой с тем же содержимым.
fn transform_wikilink<'a>(arena: &'a Arena<'a>, link: Node<'a>, target: &str) {
    // Без подписи comrak кладёт в ссылку саму цель. Obsidian показывает её
    // по-человечески: `Заметка > Заголовок` вместо `Заметка#Заголовок`.
    let label = inline_text(link);
    if label.trim() == target.trim() {
        while let Some(child) = link.first_child() {
            child.detach();
        }
        link.append(text_node(arena, Target::parse(target).display()));
    }
    let (open, close) = wikilink_tags(target);
    link.insert_before(raw_node(arena, open));
    while let Some(child) = link.first_child() {
        link.insert_before(child);
    }
    link.insert_before(raw_node(arena, close));
    link.detach();
}

/// Разрезает текстовый узел по вложениям `![[…]]`: текст до, вложение,
/// текст после.
fn transform_embeds<'a>(arena: &'a Arena<'a>, node: Node<'a>, text: &str, urls: &dyn ImageUrls) {
    let embeds = wikilinks::find_embeds(text);
    if embeds.is_empty() {
        return;
    }
    let mut rest = 0;
    for embed in &embeds {
        if embed.range.start > rest {
            node.insert_before(text_node(arena, text[rest..embed.range.start].to_owned()));
        }
        let target = Target::parse(embed.target);
        if assets::is_image_name(target.note) {
            node.insert_before(raw_node(
                arena,
                embedded_image(target.note, embed.label, urls),
            ));
        } else {
            // Встраивать заметки целиком Notivelle пока не умеет —
            // показываем ссылку на неё.
            let (open, close) = wikilink_tags(embed.target);
            let label = embed.label.map_or_else(|| target.display(), str::to_owned);
            node.insert_before(raw_node(arena, open));
            node.insert_before(text_node(arena, label));
            node.insert_before(raw_node(arena, close));
        }
        rest = embed.range.end;
    }
    if rest < text.len() {
        node.insert_before(text_node(arena, text[rest..].to_owned()));
    }
    node.detach();
}

/// HTML начала и конца вики-ссылки на `target`.
fn wikilink_tags(target: &str) -> (String, String) {
    let target = escape_html(target);
    (
        format!(r#"<a class="internal-link" data-wikilink="{target}">"#),
        "</a>".to_owned(),
    )
}

/// `<img>` для вложения `![[картинка.png|300x200]]`. Подпись — либо размер,
/// либо текст для `alt`.
fn embedded_image(name: &str, label: Option<&str>, urls: &dyn ImageUrls) -> String {
    let src = escape_html(&urls.embed(name));
    let size = label.and_then(wikilinks::image_size);
    let alt = match (label, size) {
        (Some(label), None) if !label.is_empty() => label,
        _ => name,
    };
    let alt = escape_html(alt);
    let size = match size {
        Some((width, Some(height))) => format!(r#" width="{width}" height="{height}""#),
        Some((width, None)) => format!(r#" width="{width}""#),
        None => String::new(),
    };
    format!(r#"<img class="internal-embed" src="{src}" alt="{alt}"{size}>"#)
}

/// Текст строчных узлов внутри `node`, без разметки.
fn inline_text(node: Node<'_>) -> String {
    node.descendants()
        .filter_map(|node| match &node.data().value {
            NodeValue::Text(text) => Some(text.to_string()),
            _ => None,
        })
        .collect()
}

fn text_node<'a>(arena: &'a Arena<'a>, text: String) -> Node<'a> {
    arena.alloc(NodeValue::Text(text.into()).into())
}

/// Узел с готовым HTML: comrak выводит его как есть (ammonia потом всё
/// равно проверит).
fn raw_node<'a>(arena: &'a Arena<'a>, html: String) -> Node<'a> {
    arena.alloc(NodeValue::Raw(html).into())
}

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

    /// Адреса картинок для тестов: видно, какой метод их построил.
    struct TestUrls;

    impl ImageUrls for TestUrls {
        fn image(&self, src: &str) -> String {
            format!("mdimg://test/{src}")
        }

        fn embed(&self, target: &str) -> String {
            format!("mdimg://test/{target}?embed")
        }
    }

    fn render(markdown: &str) -> String {
        render_html(markdown, TestUrls)
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
    fn wikilinks_become_internal_links() {
        let html = render("[[План]], [[План#Этап 1|первый этап]] и [[#Итоги]]\n");
        assert!(
            html.contains(r#"<a class="internal-link" data-wikilink="План" rel="noopener noreferrer">План</a>"#),
            "{html}"
        );
        assert!(
            html.contains(
                r#"data-wikilink="План#Этап 1" rel="noopener noreferrer">первый этап</a>"#
            ),
            "{html}"
        );
        // Без подписи — как в Obsidian: только заголовок.
        assert!(
            html.contains(r##"data-wikilink="#Итоги" rel="noopener noreferrer">Итоги</a>"##),
            "{html}"
        );
        assert!(!html.contains("href"), "{html}");
    }

    #[test]
    fn wikilink_without_label_shows_note_and_heading() {
        let html = render("[[План#Этап 1]]\n");
        assert!(html.contains(">План &gt; Этап 1</a>"), "{html}");
    }

    #[test]
    fn wikilinks_work_in_tables_and_callout_titles() {
        let html =
            render("| a |\n|---|\n| [[План\\|план]] |\n\n> [!note] См. [[Итоги]]\n> текст\n");
        assert!(html.contains(r#"data-wikilink="План""#), "{html}");
        assert!(html.contains(">план</a>"), "{html}");
        assert!(
            html.contains(r#"<span class="callout-title-inner">См. <a class="internal-link" data-wikilink="Итоги""#),
            "{html}"
        );
    }

    #[test]
    fn image_embeds_become_images() {
        let html = render("Схема: ![[кот 1.png|300]] и ![[кот.png|200x100]], ![[кот.png|Рыжий]]\n");
        assert!(
            html.contains(r#"<img class="internal-embed" src="mdimg://test/кот 1.png?embed" alt="кот 1.png" width="300">"#),
            "{html}"
        );
        assert!(html.contains(r#"width="200" height="100""#), "{html}");
        assert!(html.contains(r#"alt="Рыжий">"#), "{html}");
        assert!(html.contains("Схема: <img"), "{html}");
        assert!(!html.contains("![["), "{html}");
    }

    #[test]
    fn note_embeds_become_links() {
        let html = render("![[План#Этап 1]]\n");
        assert!(
            html.contains(r#"<a class="internal-link" data-wikilink="План#Этап 1" rel="noopener noreferrer">План &gt; Этап 1</a>"#),
            "{html}"
        );
    }

    #[test]
    fn wikilinks_in_code_stay_code() {
        let html = render("`[[План]]` и `![[кот.png]]`\n\n```\n![[кот.png]]\n```\n");
        assert!(!html.contains("internal"), "{html}");
        assert!(html.contains("![[кот.png]]"), "{html}");
    }

    #[test]
    fn wikilink_targets_are_escaped() {
        let html = render("[[a\"><script>x</script>]]\n");
        assert!(!html.contains("<script"), "{html}");
    }

    #[test]
    fn escapes_default_title() {
        assert_eq!(escape_html(r#"<b>&"x""#), "&lt;b&gt;&amp;&quot;x&quot;");
    }
}
