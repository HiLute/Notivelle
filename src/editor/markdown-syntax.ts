import { Tag, tags as t } from "@lezer/highlight";
import type { BlockParser, DelimiterType, InlineParser, MarkdownConfig } from "@lezer/markdown";

/**
 * Расширения парсера Markdown (lezer) для синтаксиса, которого нет в GFM,
 * но который понимает Rust-рендер (render.rs) и Obsidian: `==выделение==`,
 * формулы `$…$` и `$$…$$`, вики-ссылки `[[…]]`. Правила повторяют comrak,
 * чтобы редактор и режим чтения одинаково решали, где формула или ссылка.
 */

/** Теги подсветки для новых узлов (их цвет задаёт editor/theme.ts). */
export const highlightTag = Tag.define();
export const mathTag = Tag.define();

const BANG = 33;
const DOLLAR = 36;
const EQUALS = 61;
const BRACKET_OPEN = 91;
const BACKSLASH = 92;
const BRACKET_CLOSE = 93;
const PIPE = 124;

const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === -1;
const isDigit = (ch: number) => ch >= 48 && ch <= 57;
const PUNCTUATION = /[\p{P}\p{S}]/u;

const HighlightDelimiter: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };

/** `==выделение==` — устроено так же, как зачёркивание `~~` в GFM. */
const highlight: InlineParser = {
  name: "Highlight",
  parse(cx, next, pos) {
    if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
    const before = cx.slice(pos - 1, pos);
    const after = cx.slice(pos + 2, pos + 3);
    const spaceBefore = /\s|^$/.test(before);
    const spaceAfter = /\s|^$/.test(after);
    const punctBefore = PUNCTUATION.test(before);
    const punctAfter = PUNCTUATION.test(after);
    return cx.addDelimiter(
      HighlightDelimiter,
      pos,
      pos + 2,
      !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
      !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
    );
  },
  after: "Emphasis",
};

/**
 * `$формула$`. Как в comrak: после открывающего `$` нет пробела, перед
 * закрывающим нет пробела, а сразу за ним нет цифры — иначе «$5 и $10»
 * превратились бы в формулу.
 */
const inlineMath: InlineParser = {
  name: "InlineMath",
  parse(cx, next, pos) {
    if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR || isSpace(cx.char(pos + 1))) return -1;
    for (let i = pos + 1; i < cx.end; i++) {
      const ch = cx.char(i);
      if (ch === BACKSLASH) {
        i++;
        continue;
      }
      if (ch !== DOLLAR) continue;
      if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) return -1;
      return cx.addElement(
        cx.elt("InlineMath", pos, i + 1, [
          cx.elt("InlineMathMark", pos, pos + 1),
          cx.elt("InlineMathMark", i, i + 1),
        ]),
      );
    }
    return -1;
  },
};

/**
 * Вики-ссылка `[[цель|подпись]]` и вложение `![[цель]]`, как в Obsidian.
 * Как у comrak: внутри нет `[` и `]`, первый `|` отделяет подпись. `\|`
 * тоже отделяет — так пишут вики-ссылки в таблицах, где `|` делит ячейки.
 *
 * Узел WikiLink (или WikiEmbed) с детьми: WikiLinkMark (`[[`, `|`, `]]`),
 * WikiLinkTarget и, если есть, WikiLinkLabel.
 */
const wikiLink: InlineParser = {
  name: "WikiLink",
  parse(cx, next, pos) {
    const embed = next === BANG;
    const open = embed ? pos + 1 : pos;
    if ((!embed && next !== BRACKET_OPEN) || cx.char(open) !== BRACKET_OPEN || cx.char(open + 1) !== BRACKET_OPEN) {
      return -1;
    }
    const targetFrom = open + 2;
    let pipeFrom = -1;
    let pipeTo = -1;
    let close = -1;
    for (let i = targetFrom; i < cx.end; i++) {
      const ch = cx.char(i);
      if (ch === BRACKET_OPEN) return -1;
      if (ch === BRACKET_CLOSE) {
        close = i;
        break;
      }
      const escapedPipe = ch === BACKSLASH && cx.char(i + 1) === PIPE;
      if (ch === PIPE || escapedPipe) {
        if (pipeFrom >= 0) return -1;
        pipeFrom = i;
        pipeTo = escapedPipe ? i + 2 : i + 1;
        i = pipeTo - 1;
      } else if (ch === BACKSLASH) {
        i++;
      }
    }
    if (close < 0 || cx.char(close + 1) !== BRACKET_CLOSE) return -1;
    const targetTo = pipeFrom >= 0 ? pipeFrom : close;
    if (cx.slice(targetFrom, targetTo).trim() === "") return -1;

    const children = [cx.elt("WikiLinkMark", pos, targetFrom), cx.elt("WikiLinkTarget", targetFrom, targetTo)];
    if (pipeFrom >= 0) {
      children.push(cx.elt("WikiLinkMark", pipeFrom, pipeTo));
      if (close > pipeTo) children.push(cx.elt("WikiLinkLabel", pipeTo, close));
    }
    children.push(cx.elt("WikiLinkMark", close, close + 2));
    return cx.addElement(cx.elt(embed ? "WikiEmbed" : "WikiLink", pos, close + 2, children));
  },
  // Раньше обычных ссылок и картинок: иначе `[[` разобралось бы как `[`.
  before: "Link",
};

/** `$$` в начале строки открывает блок формулы до следующего `$$`. */
const blockMath: BlockParser = {
  name: "BlockMath",
  parse(cx, line) {
    if (line.next !== DOLLAR || !line.text.startsWith("$$", line.pos)) return false;
    const start = cx.lineStart + line.pos;
    const marks = [cx.elt("BlockMathMark", start, start + 2)];

    // Формула в одну строку: `$$ x^2 $$`.
    const sameLine = line.text.indexOf("$$", line.pos + 2);
    if (sameLine >= 0) {
      const close = cx.lineStart + sameLine;
      marks.push(cx.elt("BlockMathMark", close, close + 2));
      cx.nextLine();
      cx.addElement(cx.elt("BlockMath", start, close + 2, marks));
      return true;
    }

    // Многострочная: ищем закрывающий `$$`. Объект `line` при nextLine()
    // переиспользуется и указывает уже на следующую строку.
    let end = cx.lineStart + line.text.length;
    while (cx.nextLine()) {
      const close = line.text.indexOf("$$", line.pos);
      if (close >= 0) {
        const from = cx.lineStart + close;
        marks.push(cx.elt("BlockMathMark", from, from + 2));
        end = from + 2;
        cx.nextLine();
        break;
      }
      end = cx.lineStart + line.text.length;
    }
    cx.addElement(cx.elt("BlockMath", start, end, marks));
    return true;
  },
  before: "FencedCode",
};

/**
 * YAML-шапка в самом начале файла: `---`, строки `ключ: значение`, `---`.
 * Без этого парсер принял бы `tags: …` перед закрывающим `---` за заголовок
 * (Setext). Чтобы обычная линия `---` в начале файла не стала шапкой,
 * следующая строка должна быть похожа на YAML.
 */
const frontMatter: BlockParser = {
  name: "FrontMatter",
  parse(cx, line) {
    if (cx.lineStart !== 0 || line.text.trimEnd() !== "---") return false;
    if (!/^[\w-]+\s*:/.test(cx.peekLine())) return false;

    const marks = [cx.elt("FrontMatterMark", 0, 3)];
    let end = line.text.length;
    while (cx.nextLine()) {
      if (/^(---|\.\.\.)\s*$/.test(line.text)) {
        marks.push(cx.elt("FrontMatterMark", cx.lineStart, cx.lineStart + 3));
        end = cx.lineStart + 3;
        cx.nextLine();
        break;
      }
      end = cx.lineStart + line.text.length;
    }
    cx.addElement(cx.elt("FrontMatter", 0, end, marks));
    return true;
  },
  before: "HorizontalRule",
};

export const markdownSyntaxExtensions: MarkdownConfig = {
  defineNodes: [
    { name: "FrontMatter", block: true, style: { "FrontMatter/...": t.meta } },
    { name: "FrontMatterMark", style: t.processingInstruction },
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: t.processingInstruction },
    { name: "InlineMath", style: { "InlineMath/...": mathTag } },
    { name: "InlineMathMark", style: t.processingInstruction },
    { name: "BlockMath", block: true, style: { "BlockMath/...": mathTag } },
    { name: "BlockMathMark", style: t.processingInstruction },
    { name: "WikiLink" },
    { name: "WikiEmbed" },
    { name: "WikiLinkMark", style: t.processingInstruction },
    { name: "WikiLinkTarget", style: t.link },
    { name: "WikiLinkLabel", style: t.link },
  ],
  parseInline: [highlight, inlineMath, wikiLink],
  parseBlock: [frontMatter, blockMath],
};
