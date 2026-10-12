import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  rectangularSelection,
} from "@codemirror/view";

import { reliableDragMove } from "./drag-move";
import { editorTheme, markdownHighlightStyle } from "./theme";

/**
 * Базовый набор расширений редактора.
 *
 * Собран вручную, а не через `basicSetup`: номера строк, автодополнение и
 * fold-gutter в заметках не нужны, а режимы Source и Live Preview позже будут
 * подменять часть расширений через `Compartment`.
 */
export function editorExtensions(): Extension {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    reliableDragMove,
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    // markdownLanguage — это GFM: таблицы, чекбоксы, зачёркивание.
    // codeLanguages подгружает подсветку языков в блоках кода по требованию.
    // markdown() сам добавляет клавиши: Enter продолжает список или цитату.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxHighlighting(markdownHighlightStyle),
    editorTheme,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
  ];
}
