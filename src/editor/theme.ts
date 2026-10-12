import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

import { highlightTag, mathTag } from "./markdown-syntax";

/**
 * Оформление редактора.
 *
 * Все цвета берутся из CSS-переменных (src/styles.css), поэтому светлая и
 * тёмная темы переключаются без пересоздания редактора.
 */
export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--text-normal)",
    backgroundColor: "var(--background-primary)",
    fontSize: "var(--editor-font-size)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-text)",
    lineHeight: "1.6",
    padding: "0 var(--editor-padding)",
  },
  // Ограниченная ширина строки по центру, как «readable line length» в Obsidian.
  // Большой нижний отступ позволяет докрутить последнюю строку до середины экрана.
  ".cm-content": {
    maxWidth: "var(--line-width)",
    margin: "0 auto",
    padding: "2rem 0 40vh",
    caretColor: "var(--accent)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--selection-match)",
    outline: "1px solid var(--border-strong)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--search-match)",
    outline: "1px solid var(--search-match-border)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--search-match-selected)" },
  ".cm-panels": {
    backgroundColor: "var(--background-secondary)",
    color: "var(--text-normal)",
    fontFamily: "var(--font-ui)",
  },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-textfield": {
    backgroundColor: "var(--background-primary)",
    color: "var(--text-normal)",
    border: "1px solid var(--border-strong)",
    borderRadius: "4px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--background-primary)",
    color: "var(--text-normal)",
    border: "1px solid var(--border-strong)",
    borderRadius: "4px",
  },
});

/** Подсветка Markdown-разметки и кода внутри блоков. */
export const markdownHighlightStyle = HighlightStyle.define([
  // Разметка
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700", color: "var(--text-heading)" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "700", color: "var(--text-heading)" },
  { tag: t.heading3, fontSize: "1.25em", fontWeight: "650", color: "var(--text-heading)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650", color: "var(--text-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--link)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: t.quote, color: "var(--text-muted)" },
  // Служебные символы: #, *, `, >, маркеры списков
  { tag: [t.processingInstruction, t.contentSeparator, t.labelName], color: "var(--text-faint)" },

  // Код внутри блоков
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--code-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--code-string)" },
  { tag: [t.number, t.bool, t.atom, t.null], color: "var(--code-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-function)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--code-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
  { tag: [t.tagName, t.macroName], color: "var(--code-tag)" },
  { tag: [t.operator, t.escape], color: "var(--code-operator)" },
  { tag: t.invalid, color: "var(--text-error)" },

  // Наш синтаксис (markdown-syntax.ts): ==выделение== и формулы.
  { tag: highlightTag, backgroundColor: "var(--mark-background)", borderRadius: "2px" },
  { tag: mathTag, color: "var(--code-number)" },
]);
