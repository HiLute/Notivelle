import { defaultKeymap, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel } from "@codemirror/search";
import { type ChangeSpec, EditorSelection, EditorState, Prec, Transaction } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";

import { documentIdFacet, linkHandlersFacet } from "../../context";
import { markdownSyntaxExtensions } from "../../markdown-syntax";
import { spellcheck } from "../../spellcheck";
import { markdownHighlightStyle } from "../../theme";
import { inlinePreview } from "../inline";

/** Переходы между ячейками; их выполняет таблица (widget.ts). */
export interface CellNavigation {
  /** Tab: следующая ячейка, после последней — новая строка. */
  next(): void;
  /** Shift+Tab: предыдущая ячейка. */
  previous(): void;
  /** Enter: ячейка ниже, в последней строке — новая строка. */
  below(): void;
  /** Стрелки у края ячейки: соседняя ячейка или выход из таблицы. */
  vertical(forward: boolean): void;
  horizontal(forward: boolean): void;
}

export interface CellEditorOptions {
  readonly parent: HTMLElement;
  readonly text: string;
  readonly anchor: number;
  readonly head: number;
  /** Основной редактор: у него история отмены, поиск и настройки документа. */
  readonly main: EditorView;
  readonly navigation: CellNavigation;
  readonly dispatch: (transactions: readonly Transaction[], editor: EditorView) => void;
}

/**
 * Редактор одной ячейки таблицы — маленький CodeMirror внутри виджета
 * таблицы, как в Obsidian. Текст в нём ровно тот, что в ячейке исходника;
 * каждая правка сразу уходит в основной редактор (см. widget.ts), а своей
 * истории отмены у ячейки нет: Ctrl+Z отменяет правку в основном.
 *
 * Внутри ячейки работает тот же Live Preview строчной разметки.
 */
export function createCellEditor(options: CellEditorOptions): EditorView {
  const { main, navigation } = options;
  const length = options.text.length;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, length));

  return new EditorView({
    parent: options.parent,
    dispatchTransactions: options.dispatch,
    state: EditorState.create({
      doc: options.text,
      selection: EditorSelection.single(clamp(options.anchor), clamp(options.head)),
      extensions: [
        Prec.highest(
          keymap.of([
            { key: "Tab", run: () => (navigation.next(), true) },
            { key: "Shift-Tab", run: () => (navigation.previous(), true) },
            { key: "Enter", run: () => (navigation.below(), true) },
            { key: "Mod-Enter", run: () => (navigation.below(), true) },
            // Перевод строки внутри ячейки GFM пишется как <br>.
            { key: "Shift-Enter", run: (view) => (view.dispatch(view.state.replaceSelection("<br>")), true) },
            { key: "ArrowUp", run: (view) => atVisualEdge(view, false) && (navigation.vertical(false), true) },
            { key: "ArrowDown", run: (view) => atVisualEdge(view, true) && (navigation.vertical(true), true) },
            { key: "ArrowLeft", run: (view) => atCellEdge(view, false) && (navigation.horizontal(false), true) },
            { key: "ArrowRight", run: (view) => atCellEdge(view, true) && (navigation.horizontal(true), true) },
            // История и поиск — общие с основным редактором.
            { key: "Mod-z", run: () => undo(main) },
            { key: "Mod-y", run: () => redo(main) },
            { key: "Mod-Shift-z", run: () => redo(main) },
            { key: "Mod-f", run: () => openSearchPanel(main) },
          ]),
        ),
        keymap.of(defaultKeymap),
        cellTextFilter,
        markdown({ base: markdownLanguage, extensions: [markdownSyntaxExtensions], addKeymap: false }),
        syntaxHighlighting(markdownHighlightStyle),
        inlinePreview,
        spellcheck,
        documentIdFacet.of(main.state.facet(documentIdFacet)),
        linkHandlersFacet.of(main.state.facet(linkHandlersFacet) ?? { openExternal() {}, openLocal() {} }),
        drawSelection(),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ "aria-label": "Ячейка таблицы" }),
      ],
    }),
  });
}

/** Курсор на первой (или последней) визуальной строке ячейки. */
function atVisualEdge(view: EditorView, forward: boolean): boolean {
  const range = view.state.selection.main;
  if (!range.empty) return false;
  const head = view.coordsAtPos(range.head);
  const edge = view.coordsAtPos(forward ? view.state.doc.length : 0);
  if (!head || !edge) return true;
  return forward ? head.bottom >= edge.bottom - 2 : head.top <= edge.top + 2;
}

/** Курсор в самом начале (или конце) ячейки. */
function atCellEdge(view: EditorView, forward: boolean): boolean {
  const range = view.state.selection.main;
  return range.empty && range.head === (forward ? view.state.doc.length : 0);
}

/**
 * Текст ячейки не может содержать перевод строки и голую черту `|`: первое
 * разорвало бы строку таблицы, второе — ячейку. При вводе и вставке они
 * заменяются на `<br>` и `\|`, как это делает Obsidian.
 */
const cellTextFilter = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) return transaction;
  let changed = false;
  const changes: ChangeSpec[] = [];
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    const before = transaction.startState.doc.sliceString(Math.max(0, fromA - 1), fromA);
    const safe = cellSafe(text, before);
    if (safe !== text) changed = true;
    changes.push({ from: fromA, to: toA, insert: safe });
  });
  if (!changed) return transaction;

  const changeSet = transaction.startState.changes(changes);
  const userEvent = transaction.annotation(Transaction.userEvent);
  return {
    changes: changeSet,
    selection: EditorSelection.cursor(changeSet.mapPos(transaction.startState.selection.main.head, 1)),
    ...(userEvent ? { userEvent } : {}),
  };
});

function cellSafe(text: string, before: string): string {
  let result = "";
  let previous = before;
  for (const part of text.split(/\r\n|\r|\n/).join("<br>")) {
    result += part === "|" && previous !== "\\" ? "\\|" : part;
    previous = part;
  }
  return result;
}
