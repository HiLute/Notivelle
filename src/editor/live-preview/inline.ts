import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { imageSize, isImageName, parseWikiTarget, wikiDisplay } from "../../wikilink";
import { documentIdFacet, linkHandlersFacet, openHref } from "../context";
import { touches, touchesLines } from "./selection";
import {
  BulletWidget,
  CheckboxWidget,
  CodeHeaderWidget,
  embedUrl,
  ImageWidget,
  imageUrl,
  MathWidget,
  RuleWidget,
  WikiLinkWidget,
} from "./widgets";

const hidden = Decoration.replace({});
const quoteLine = Decoration.line({ class: "cm-lp-quote" });
const codeLine = Decoration.line({ class: "cm-lp-codeblock" });
const codeBeginLine = Decoration.line({ class: "cm-lp-codeblock-begin" });
const codeEndLine = Decoration.line({ class: "cm-lp-codeblock-end" });
const frontMatterLine = Decoration.line({ class: "cm-lp-frontmatter" });
const taskDone = Decoration.mark({ class: "cm-lp-task-done" });

/** Узлы с парными метками, которые прячутся, пока курсор не внутри: `**`, `` ` `` … */
const MARKED_INLINE: Record<string, string> = {
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  Highlight: "HighlightMark",
  InlineCode: "CodeMark",
};

/**
 * Строчные HTML-теги, которые Live Preview показывает оформленными, как
 * Obsidian: `<kbd>Ctrl</kbd>`, `<sup>2</sup>`, `<u>…</u>`. Теги прячутся, а
 * текст между ними оборачивается в такой же элемент. Атрибуты не переносятся
 * (у `<a>` берётся только адрес), поэтому ничего опасного сюда не попадёт.
 */
const INLINE_HTML_TAGS = new Set([
  "abbr", "b", "big", "cite", "code", "del", "dfn", "em", "i", "ins", "kbd", "mark",
  "q", "s", "samp", "small", "span", "strike", "strong", "sub", "sup", "time", "u", "var",
]);
const OPEN_TAG = /^<([a-z][a-z0-9]*)(?:\s[^>]*)?>$/i;
const CLOSE_TAG = /^<\/([a-z][a-z0-9]*)\s*>$/i;
const HREF_ATTRIBUTE = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Строчная часть Live Preview: прячет разметку там, где курсора нет, и
 * заменяет её виджетами (точки списков, чекбоксы, линии, картинки, формулы).
 * Считается только для видимой части документа, поэтому быстра и на больших
 * файлах. Блоки (callouts, таблицы, диаграммы) — в blocks.ts.
 */
export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        // Парсер дочитал документ в фоне — дерево стало полнее.
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        // Новый документ сохранили в файл: картинки теперь ищутся рядом с ним.
        update.startState.facet(documentIdFacet) !== update.state.facet(documentIdFacet)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      // Ctrl+клик (Cmd+клик на macOS) по ссылке открывает её, как в Obsidian.
      // Обычный клик ставит курсор, и ссылка раскрывается для правки.
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false;
        const link = (event.target as Element).closest<HTMLElement>("[data-href], [data-wikilink]");
        const handlers = view.state.facet(linkHandlersFacet);
        if (!link || !handlers) return false;
        const { href, wikilink } = link.dataset;
        if (wikilink !== undefined) handlers.openWikiLink(wikilink);
        else if (href) openHref(handlers, href);
        else return false;
        event.preventDefault();
        return true;
      },
    },
  },
);

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  const { from, to } = view.viewport;

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node;
      const name = node.name;

      if (name.startsWith("ATXHeading")) {
        if (!touchesLines(state, node.from, node.to)) hideChildren(state, node, "HeaderMark", decorations, true);
        return;
      }
      const mark = MARKED_INLINE[name];
      if (mark) {
        if (!touches(state, node.from, node.to)) hideChildren(state, node, mark, decorations, false);
        return;
      }

      switch (name) {
        case "Link":
          addLink(state, node, decorations);
          return false;
        case "URL":
          // Голая ссылка в тексте (https://…): только Ctrl+клик.
          if (node.parent?.name !== "Link" && node.parent?.name !== "Image") {
            decorations.push(linkMark(state.sliceDoc(node.from, node.to)).range(node.from, node.to));
          }
          return;
        case "Image":
          addImage(state, node, decorations);
          return false;
        case "WikiLink":
        case "WikiEmbed":
          addWikiLink(state, node, decorations);
          return false;
        case "InlineMath":
          if (!touches(state, node.from, node.to)) {
            const tex = state.sliceDoc(node.from + 1, node.to - 1);
            decorations.push(Decoration.replace({ widget: new MathWidget(tex) }).range(node.from, node.to));
          }
          return false;
        case "ListMark":
          addListMark(state, node, decorations);
          return;
        case "TaskMarker": {
          const checked = /x/i.test(state.sliceDoc(node.from, node.to));
          if (!touches(state, node.from, node.to)) {
            decorations.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to));
          }
          // Выполненная задача зачёркнута, как в режиме чтения.
          const task = node.parent;
          if (checked && task && task.to > node.to) decorations.push(taskDone.range(node.to, task.to));
          return;
        }
        case "HTMLTag":
          addInlineHtml(state, node, decorations);
          return false;
        case "QuoteMark":
          if (!touchesLines(state, node.from, node.to)) hideWithSpace(state, node, decorations);
          return;
        case "Blockquote":
          forEachLine(state, node, (lineFrom) => decorations.push(quoteLine.range(lineFrom)));
          return;
        case "HorizontalRule":
          if (!touchesLines(state, node.from, node.to)) {
            decorations.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          }
          return;
        case "FencedCode":
          addCodeBlock(state, node, decorations);
          // Внутрь не идём: в блоке кода (например, ```markdown) разметку
          // прятать нельзя.
          return false;
        case "Table":
          // Таблицу целиком рисует blocks.ts.
          return false;
        case "FrontMatter":
          forEachLine(state, node, (lineFrom) => decorations.push(frontMatterLine.range(lineFrom)));
          return false;
        default:
          return;
      }
    },
  });

  // true — отсортировать: декорации добавлялись в порядке обхода дерева.
  return Decoration.set(decorations, true);
}

/** Прячет дочерние метки узла; для заголовков — вместе с пробелом после `#`. */
function hideChildren(
  state: EditorState,
  node: SyntaxNode,
  markName: string,
  decorations: Range<Decoration>[],
  withSpace: boolean,
): void {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== markName) continue;
    if (withSpace) hideWithSpace(state, child, decorations);
    else decorations.push(hidden.range(child.from, child.to));
  }
}

function hideWithSpace(state: EditorState, node: SyntaxNode, decorations: Range<Decoration>[]): void {
  const end = state.sliceDoc(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
  decorations.push(hidden.range(node.from, end));
}

function linkMark(href: string): Decoration {
  return Decoration.mark({
    class: "cm-lp-link",
    attributes: { "data-href": href, title: "Ctrl+клик — открыть ссылку" },
  });
}

/** `[текст](адрес)`: без курсора видно только «текст», оформленный как ссылка. */
function addLink(state: EditorState, node: SyntaxNode, decorations: Range<Decoration>[]): void {
  const url = node.getChild("URL");
  // `[текст]` без адреса парсер тоже считает ссылкой (вдруг ниже есть
  // определение `[текст]: адрес`). Это и маркер callout `[!tip]`, и сноска
  // `[^1]` — оставляем их обычным текстом, как Obsidian.
  if (!url) return;
  const href = state.sliceDoc(url.from, url.to);
  const marks = node.getChildren("LinkMark");
  const textFrom = marks[0]?.to;
  const textTo = marks[1]?.from;

  if (touches(state, node.from, node.to) || textFrom === undefined || textTo === undefined) {
    return;
  }
  // Всё, кроме текста ссылки: `[`, `](адрес "заголовок")`.
  decorations.push(hidden.range(node.from, textFrom));
  decorations.push(hidden.range(textTo, node.to));
  if (textTo > textFrom) decorations.push(linkMark(href).range(textFrom, textTo));
}

function wikiLinkMark(target: string): Decoration {
  return Decoration.mark({
    class: "cm-lp-link",
    attributes: { "data-wikilink": target, title: "Ctrl+клик — открыть ссылку" },
  });
}

/**
 * `[[цель|подпись]]`: без курсора видна только подпись (или имя заметки),
 * оформленная как ссылка. `![[кот.png|300]]` показывается картинкой;
 * вложенную заметку Notivelle показывает ссылкой на неё.
 */
function addWikiLink(state: EditorState, node: SyntaxNode, decorations: Range<Decoration>[]): void {
  const targetNode = node.getChild("WikiLinkTarget");
  if (!targetNode || touches(state, node.from, node.to)) return;
  const target = state.sliceDoc(targetNode.from, targetNode.to).trim();
  const labelNode = node.getChild("WikiLinkLabel");
  const label = labelNode ? state.sliceDoc(labelNode.from, labelNode.to).trim() : "";

  if (node.name === "WikiEmbed") {
    const name = parseWikiTarget(target).note;
    if (isImageName(name)) {
      // У нового, ещё не сохранённого документа картинку искать не от чего —
      // остаётся исходный текст, как у обычной картинки (addImage).
      const src = embedUrl(state.facet(documentIdFacet), name);
      if (!src) return;
      const size = imageSize(label);
      const widget = new ImageWidget(src, size || !label ? name : label, size);
      decorations.push(Decoration.replace({ widget }).range(node.from, node.to));
      return;
    }
  }

  if (labelNode && label) {
    decorations.push(hidden.range(node.from, labelNode.from));
    decorations.push(wikiLinkMark(target).range(labelNode.from, labelNode.to));
    decorations.push(hidden.range(labelNode.to, node.to));
    return;
  }
  // Без подписи: «Заметка» остаётся текстом документа, а «Заметка#Раздел»
  // заменяется надписью «Заметка > Раздел», как в Obsidian.
  const display = wikiDisplay(target);
  if (display === state.sliceDoc(targetNode.from, targetNode.to)) {
    decorations.push(hidden.range(node.from, targetNode.from));
    decorations.push(wikiLinkMark(target).range(targetNode.from, targetNode.to));
    decorations.push(hidden.range(targetNode.to, node.to));
  } else {
    const widget = new WikiLinkWidget(display, target);
    decorations.push(Decoration.replace({ widget }).range(node.from, node.to));
  }
}

/** `![подпись](адрес)` без курсора показывается картинкой. */
function addImage(state: EditorState, node: SyntaxNode, decorations: Range<Decoration>[]): void {
  if (touches(state, node.from, node.to)) return;
  const url = node.getChild("URL");
  const marks = node.getChildren("LinkMark");
  if (!url || marks.length < 2) return;

  const src = imageUrl(state.facet(documentIdFacet), state.sliceDoc(url.from, url.to));
  if (!src) return;
  const alt = state.sliceDoc(marks[0]?.to ?? node.from, marks[1]?.from ?? node.from);
  decorations.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to));
}

/**
 * Маркер маркированного списка → точка, а у задач (`- [ ]`) маркер
 * прячется совсем: вместо него стоит чекбокс. Нумерованные списки остаются
 * как есть.
 */
function addListMark(state: EditorState, node: SyntaxNode, decorations: Range<Decoration>[]): void {
  const item = node.parent;
  if (item?.parent?.name !== "BulletList" || touches(state, node.from, node.to)) return;
  if (item.getChild("Task")) {
    hideWithSpace(state, node, decorations);
  } else {
    decorations.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
  }
}

/**
 * Блок кода: фон на всех строках, а пока курсор не в блоке, строки с
 * ```` ``` ```` прячутся — вместо открывающей видны язык и кнопка
 * «Копировать», как в Obsidian.
 */
function addCodeBlock(state: EditorState, node: SyntaxNode, decorations: Range<Decoration>[]): void {
  forEachLine(state, node, (lineFrom) => decorations.push(codeLine.range(lineFrom)));
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  // Незакрытый блок (в конце документа) идёт до конца файла без ``` внизу.
  const closing = node.lastChild?.name === "CodeMark" && last.number > first.number ? node.lastChild : null;
  decorations.push(codeBeginLine.range(first.from));
  if (closing) decorations.push(codeEndLine.range(last.from));
  if (touchesLines(state, node.from, node.to)) return;

  const info = node.getChild("CodeInfo");
  const language = info ? state.sliceDoc(info.from, info.to) : "";
  const widget = new CodeHeaderWidget(language, codeText(state, node, first.number, closing ? last.number : null));
  // Прячем строки целиком, вместе с отступом списка или `> `: фон блока и
  // так занимает всю строку, а шапке нужна вся её ширина.
  decorations.push(Decoration.replace({ widget }).range(first.from, first.to));
  if (closing) decorations.push(hidden.range(last.from, last.to));
}

/**
 * Текст блока кода для кнопки «Копировать»: строки между ```, без отступа
 * списка или `> ` цитаты, внутри которых стоит блок.
 */
function codeText(state: EditorState, node: SyntaxNode, firstLine: number, closingLine: number | null): string {
  const indent = node.from - state.doc.line(firstLine).from;
  const lastLine = closingLine === null ? state.doc.lineAt(node.to).number : closingLine - 1;
  const lines: string[] = [];
  for (let number = firstLine + 1; number <= lastLine; number++) {
    const text = state.doc.line(number).text;
    const container = /^[ \t>]*/.exec(text)?.[0].length ?? 0;
    lines.push(text.slice(Math.min(indent, container)));
  }
  return lines.join("\n");
}

/**
 * `<kbd>Ctrl</kbd>`: прячет теги и оформляет текст между ними, пока курсор
 * не внутри. Пара ищется среди соседних узлов того же абзаца.
 */
function addInlineHtml(state: EditorState, open: SyntaxNode, decorations: Range<Decoration>[]): void {
  const text = state.sliceDoc(open.from, open.to);
  const name = OPEN_TAG.exec(text)?.[1]?.toLowerCase();
  if (!name || text.endsWith("/>") || !(INLINE_HTML_TAGS.has(name) || name === "a")) return;

  let close: SyntaxNode | null = null;
  let depth = 0;
  for (let node = open.nextSibling; node; node = node.nextSibling) {
    if (node.name !== "HTMLTag") continue;
    const tag = state.sliceDoc(node.from, node.to);
    if (CLOSE_TAG.exec(tag)?.[1]?.toLowerCase() === name) {
      if (depth === 0) {
        close = node;
        break;
      }
      depth--;
    } else if (!tag.endsWith("/>") && OPEN_TAG.exec(tag)?.[1]?.toLowerCase() === name) {
      depth++;
    }
  }
  if (!close || touches(state, open.from, close.to)) return;

  decorations.push(hidden.range(open.from, open.to));
  if (close.from > open.to) {
    let mark: Decoration | null = Decoration.mark({ tagName: name, class: "cm-lp-html" });
    if (name === "a") {
      const href = HREF_ATTRIBUTE.exec(text);
      const url = href?.[1] ?? href?.[2] ?? href?.[3];
      mark = url ? linkMark(url) : null;
    }
    if (mark) decorations.push(mark.range(open.to, close.from));
  }
  decorations.push(hidden.range(close.from, close.to));
}

function forEachLine(state: EditorState, node: SyntaxNode, add: (lineFrom: number) => void): void {
  let line = state.doc.lineAt(node.from);
  for (;;) {
    add(line.from);
    if (line.to >= node.to || line.number >= state.doc.lines) break;
    line = state.doc.line(line.number + 1);
  }
}
