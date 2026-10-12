import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  rectangularSelection,
} from "@codemirror/view";

import { reliableDragMove } from "./drag-move";
import { livePreview } from "./live-preview";
import { markdownSyntaxExtensions } from "./markdown-syntax";
import { spellcheck } from "./spellcheck";
import { editorTheme, markdownHighlightStyle } from "./theme";

/**
 * «Ячейка» конфигурации для Live Preview: её содержимое можно заменить
 * транзакцией, не пересоздавая состояние редактора (история отмены и
 * курсор сохраняются).
 */
const livePreviewCompartment = new Compartment();

/**
 * Базовый набор расширений редактора.
 *
 * Собран вручную, а не через `basicSetup`: номера строк, автодополнение и
 * fold-gutter в заметках не нужны. Live Preview включается и выключается
 * через `livePreviewCompartment` (см. setLivePreview).
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
    // markdownLanguage — это GFM: таблицы, чекбоксы, зачёркивание. Сверху —
    // наш синтаксис: ==выделение== и формулы $…$, $$…$$.
    // codeLanguages подгружает подсветку языков в блоках кода по требованию.
    // markdown() сам добавляет клавиши: Enter продолжает список или цитату.
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [markdownSyntaxExtensions],
    }),
    syntaxHighlighting(markdownHighlightStyle),
    editorTheme,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    spellcheck,
    livePreviewCompartment.of([]),
  ];
}

/** Включает или выключает Live Preview в текущем состоянии редактора. */
export function setLivePreview(view: EditorView, enabled: boolean): void {
  const isEnabled = livePreviewCompartment.get(view.state) === livePreview;
  if (isEnabled === enabled) return;
  view.dispatch({ effects: livePreviewCompartment.reconfigure(enabled ? livePreview : []) });
}
