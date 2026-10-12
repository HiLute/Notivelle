import { syntaxTree } from "@codemirror/language";
import {
  type ChangeDesc,
  type EditorState,
  Prec,
  type Range,
  type SelectionRange,
  StateField,
} from "@codemirror/state";
import { type Command, Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";

import { documentIdFacet } from "../context";
import { RenderedBlockWidget } from "./rendered-block";
import { touches } from "./selection";
import { type CellPosition, cellAt, cellRange, rowCount, type TableModel, tableFromTree, tableText } from "./table/model";
import { TableWidget } from "./table/widget";

/** Первая строка цитаты-callout: `> [!type]`, `> [!type]-`, `> [!type]+ Заголовок`. */
const CALLOUT_START = /^\s*>\s*\[![^\]\s]+\][+-]?(\s|$)/;
/** Открывающая строка блока кода, который рисуется: ```mermaid и ```math. */
const RENDERED_FENCE = /^\s*(`{3,}|~{3,})\s*(mermaid|math)\b/i;
/** Первый тег HTML-блока. */
const FIRST_TAG = /^\s*<([a-z][a-z0-9-]*)/i;
/** Теги без закрывающей пары. */
const VOID_TAGS = new Set(["img", "br", "hr", "input", "source", "wbr"]);

/** Блок, нарисованный вместо исходника. */
export interface Block {
  readonly from: number;
  readonly to: number;
  /** Модель таблицы; у остальных блоков null. */
  readonly table: TableModel | null;
}

/**
 * Ячейка таблицы, в которой стоит курсор: здесь открыт редактор ячейки.
 * `from`–`to` — её текст в документе.
 */
export interface ActiveCell extends CellPosition {
  readonly from: number;
  readonly to: number;
}

interface BlocksState {
  readonly decorations: DecorationSet;
  readonly blocks: readonly Block[];
  readonly active: ActiveCell | null;
}

/**
 * Блочная часть Live Preview.
 *
 * Callouts, диаграммы Mermaid, блоки формул (`$$` и ```math) и HTML-блоки,
 * пока курсор не внутри, заменяются отрендеренным блоком. Таблицы нарисованы
 * всегда, а ячейки правятся на месте (table/widget.ts) — как в Obsidian.
 *
 * Почему StateField, а не плагин, как в inline.ts: CodeMirror разрешает
 * заменять целые строки блочными виджетами только декорациям из поля
 * состояния — от них зависит высота документа, и редактор должен знать их
 * ещё до отрисовки.
 */
export const blockPreview = StateField.define<BlocksState>({
  create: (state) => buildBlocks(state, null),
  update(value, transaction) {
    if (
      !transaction.docChanged &&
      !transaction.selection &&
      syntaxTree(transaction.startState) === syntaxTree(transaction.state)
    ) {
      return value;
    }
    const previous = value.active && transaction.docChanged ? mapCell(value.active, transaction.changes) : value.active;
    return buildBlocks(transaction.state, previous);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * Границы открытой ячейки сдвигаются вместе с правками: вставка на краю
 * ячейки попадает внутрь неё. Так в ячейке можно напечатать пробел в конце —
 * если бы границы каждый раз искались заново, он слился бы с отступом до `|`.
 */
function mapCell(cell: ActiveCell, changes: ChangeDesc): ActiveCell {
  return { ...cell, from: changes.mapPos(cell.from, -1), to: changes.mapPos(cell.to, 1) };
}

function buildBlocks(state: EditorState, previous: ActiveCell | null): BlocksState {
  const decorations: Range<Decoration>[] = [];
  const blocks: Block[] = [];
  let active: ActiveCell | null = null;
  const documentId = state.facet(documentIdFacet);
  const { selection } = state;

  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name === "Table") {
        const table = tableFromTree(state, ref.node);
        const cell = selection.ranges.length === 1 ? activeCell(state, table, selection.main, previous) : null;
        if (cell) active = cell;
        const widget = new TableWidget({
          from: table.from,
          lines: table.lines,
          source: tableText(table.lines),
          documentId,
          active: cell && {
            row: cell.row,
            col: cell.col,
            text: state.sliceDoc(cell.from, cell.to),
            anchor: clampTo(selection.main.anchor - cell.from, cell.to - cell.from),
            head: clampTo(selection.main.head - cell.from, cell.to - cell.from),
          },
          selected: !cell && selection.ranges.some((range) => range.from < table.to && range.to > table.from),
        });
        decorations.push(Decoration.replace({ widget, block: true }).range(table.from, table.to));
        blocks.push({ from: table.from, to: table.to, table });
        return false;
      }

      if (!isRenderedBlock(state, ref.name, ref.from, ref.to)) return;
      // Блок занимает строки целиком: вместе с отступом списка или `>`.
      const from = state.doc.lineAt(ref.from).from;
      const to = state.doc.lineAt(ref.to).to;
      if (!touches(state, from, to)) {
        const widget = new RenderedBlockWidget(state.sliceDoc(from, to), documentId);
        decorations.push(Decoration.replace({ widget, block: true }).range(from, to));
        blocks.push({ from, to, table: null });
      }
      // Вложенные блоки отдельно не рисуем: их нарисует внешний блок, а пока
      // внешний открыт для правки, внутренности видны исходным текстом.
      return false;
    },
  });
  return { decorations: Decoration.set(decorations, true), blocks, active };
}

function clampTo(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length));
}

/**
 * В какой ячейке таблицы выделение. Если оно не вышло из ячейки, открытой
 * раньше, она остаётся открытой с прежними границами (см. mapCell). Иначе
 * ячейка ищется заново; курсор между ячейками (на `|`, в отступе) попадает
 * в ближайшую. Выделение через несколько ячеек — не ячейка, а таблица целиком.
 */
function activeCell(
  state: EditorState,
  table: TableModel,
  range: SelectionRange,
  previous: ActiveCell | null,
): ActiveCell | null {
  if (range.from < table.from || range.to > table.to) return null;
  if (
    previous &&
    previous.from >= table.from &&
    previous.to <= table.to &&
    range.from >= previous.from &&
    range.to <= previous.to &&
    isCellText(state.sliceDoc(previous.from, previous.to))
  ) {
    const at = cellAt(table, previous.from);
    if (at) return { row: at.row, col: at.col, from: previous.from, to: previous.to };
  }
  const anchor = cellAt(table, range.anchor);
  const head = cellAt(table, range.head);
  if (!anchor || !head || anchor.row !== head.row || anchor.col !== head.col) return null;
  return { row: head.row, col: head.col, from: head.range.from, to: head.range.to };
}

/** Может ли это быть текстом одной ячейки: без перевода строки и голой `|`. */
function isCellText(text: string): boolean {
  return !text.includes("\n") && !/(^|[^\\])\|/.test(text);
}

function isRenderedBlock(state: EditorState, name: string, from: number, to: number): boolean {
  switch (name) {
    case "BlockMath":
      return true;
    case "FencedCode":
      return RENDERED_FENCE.test(state.doc.lineAt(from).text);
    case "Blockquote":
      return CALLOUT_START.test(state.doc.lineAt(from).text);
    case "HTMLBlock":
      return isCompleteHtml(state.sliceDoc(from, to));
    default:
      return false;
  }
}

/**
 * HTML-блок рисуем, только если он законченный: `<img …>` или `<details>…
 * </details>`. Обёртка вида `<div align="center">` … `</div>` вокруг
 * Markdown — это два отдельных HTML-блока, каждый сам по себе пустой; их
 * оставляем текстом, иначе от них остались бы невидимые блоки.
 */
function isCompleteHtml(html: string): boolean {
  const tag = FIRST_TAG.exec(html)?.[1]?.toLowerCase();
  if (!tag) return false;
  return VOID_TAGS.has(tag) || new RegExp(`</${tag}\\s*>`, "i").test(html);
}

/* ---------- Стрелки вверх и вниз ---------- */

/**
 * Стрелка вверх или вниз к нарисованному блоку. Сам CodeMirror
 * перепрыгнул бы блок целиком; как в Obsidian, курсор вместо этого входит в
 * него: callout или диаграмма раскрываются в исходник, в таблице
 * открывается ячейка.
 */
function enterBlock(forward: boolean): Command {
  return (view) => {
    const { state } = view;
    const value = state.field(blockPreview, false);
    const range = state.selection.main;
    if (!value || state.selection.ranges.length > 1 || !range.empty) return false;

    const line = state.doc.lineAt(range.head);
    // Длинная строка переносится: сначала курсор идёт по её визуальным строкам.
    const moved = view.moveVertically(range, forward);
    if (state.doc.lineAt(moved.head).number === line.number) return false;
    const nextNumber = line.number + (forward ? 1 : -1);
    if (nextNumber < 1 || nextNumber > state.doc.lines) return false;
    const next = state.doc.line(nextNumber);

    const block = value.blocks.find((candidate) => (forward ? candidate.from === next.from : candidate.to === next.to));
    if (!block) return false;

    let target: number;
    if (block.table) {
      const row = forward ? 0 : rowCount(block.table.lines) - 1;
      target = cellRange(block.table, row, 0)?.to ?? block.from;
    } else {
      target = next.from + Math.min(range.head - line.from, next.length);
    }
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

export const blockNavigation = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: enterBlock(true) },
    { key: "ArrowUp", run: enterBlock(false) },
  ]),
);
