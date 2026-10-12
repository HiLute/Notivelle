import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/**
 * Модель таблицы GFM для редактора таблиц в Live Preview.
 *
 * Правки таблицы (ячейка, новая строка, перенос столбца) меняют только то,
 * что нужно: остальные символы исходника, включая выравнивающие пробелы,
 * остаются байт-в-байт. Поэтому строки хранятся как есть, а ячейки
 * вычисляются из них по чертам `|`.
 */

export type Align = "left" | "center" | "right" | null;

/**
 * Строки таблицы: [0] — шапка, [1] — разделитель `|---|:-:|`, дальше тело.
 * `prefixes` — то, что стоит перед таблицей в каждой строке: отступ списка
 * или `> ` цитаты. `rows` — сами строки таблицы.
 */
export interface TableLines {
  readonly prefixes: readonly string[];
  readonly rows: readonly string[];
}

/** Отрезок строки `[from, to)`. */
interface Span {
  readonly from: number;
  readonly to: number;
}

/** Строка таблицы, разрезанная по чертам. */
interface SplitRow {
  /** Всё до первой ячейки: `|` или пусто. */
  readonly lead: string;
  /** Сырые ячейки вместе с пробелами вокруг текста. */
  readonly cells: readonly string[];
  /** Всё после последней ячейки: `|` с хвостовыми пробелами или пусто. */
  readonly trail: string;
  /** Где лежат ячейки в строке. */
  readonly spans: readonly Span[];
}

/**
 * Режет строку по неэкранированным `|`. Как в GFM, `\|` — это черта внутри
 * текста ячейки, в том числе в `кода`.
 */
export function splitRow(text: string): SplitRow {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(i);
  }
  const contentStart = text.length - text.trimStart().length;
  const contentEnd = text.trimEnd().length;
  const hasLead = pipes.length > 0 && pipes[0] === contentStart;
  const hasTrail = pipes.length > (hasLead ? 1 : 0) && pipes.at(-1) === contentEnd - 1;

  const inner = pipes.slice(hasLead ? 1 : 0, hasTrail ? -1 : undefined);
  const start = hasLead ? (pipes[0] ?? 0) + 1 : 0;
  const end = hasTrail ? (pipes.at(-1) ?? text.length) : text.length;

  const spans: Span[] = [];
  let from = start;
  for (const pipe of inner) {
    spans.push({ from, to: pipe });
    from = pipe + 1;
  }
  spans.push({ from, to: end });
  return {
    lead: text.slice(0, start),
    cells: spans.map((span) => text.slice(span.from, span.to)),
    trail: text.slice(end),
    spans,
  };
}

function joinRow(row: SplitRow, cells: readonly string[]): string {
  return row.lead + cells.join("|") + row.trail;
}

/**
 * Где внутри сырой ячейки лежит её текст — без пробелов по краям. У пустой
 * ячейки это точка вставки: после первого пробела, чтобы из `|   |`
 * получилось `| x  |`, а не `|x   |`.
 */
function textSpan(span: Span, raw: string): Span {
  const start = raw.length - raw.trimStart().length;
  const end = raw.trimEnd().length;
  if (start >= end) {
    const at = span.from + (raw.length > 0 ? 1 : 0);
    return { from: at, to: at };
  }
  return { from: span.from + start, to: span.from + end };
}

/** Индекс строки в `rows` для строки таблицы: 0 — шапка, дальше тело. */
export function lineIndex(row: number): number {
  return row === 0 ? 0 : row + 1;
}

/** Сколько строк таблицы с данными: шапка плюс тело. */
export function rowCount(lines: TableLines): number {
  return lines.rows.length - 1;
}

/** Столбцов столько, сколько ячеек в шапке. */
export function columnCount(lines: TableLines): number {
  return splitRow(lines.rows[0] ?? "").cells.length;
}

/** Тексты ячеек строки `row` (без пробелов по краям). */
export function cellTexts(lines: TableLines, row: number): string[] {
  return splitRow(lines.rows[lineIndex(row)] ?? "").cells.map((cell) => cell.trim());
}

/** Выравнивание столбцов из строки-разделителя: `:--`, `:-:`, `--:`. */
export function aligns(lines: TableLines): Align[] {
  return splitRow(lines.rows[1] ?? "").cells.map((raw) => {
    const cell = raw.trim();
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/** Весь текст таблицы. */
export function tableText(lines: TableLines): string {
  return lines.rows.map((row, index) => (lines.prefixes[index] ?? "") + row).join("\n");
}

/**
 * Где лежит текст ячейки `(row, col)` относительно начала таблицы. null —
 * в этой строке такой ячейки нет (строка короче шапки).
 */
export function cellOffset(lines: TableLines, row: number, col: number): Span | null {
  const index = lineIndex(row);
  const text = lines.rows[index];
  if (text === undefined) return null;
  const split = splitRow(text);
  const span = split.spans[col];
  const raw = split.cells[col];
  if (!span || raw === undefined) return null;

  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    lineStart += (lines.prefixes[i] ?? "").length + (lines.rows[i] ?? "").length + 1;
  }
  const base = lineStart + (lines.prefixes[index] ?? "").length;
  const cell = textSpan(span, raw);
  return { from: base + cell.from, to: base + cell.to };
}

/* ---------- Таблица в документе ---------- */

/** Таблица в документе: где она и из каких строк состоит. */
export interface TableModel {
  /** Начало первой строки таблицы. */
  readonly from: number;
  /** Конец последней строки. */
  readonly to: number;
  readonly lines: TableLines;
}

/** Модель по узлу `Table` дерева lezer. */
export function tableFromTree(state: EditorState, table: SyntaxNode): TableModel {
  const prefixes: string[] = [];
  const rows: string[] = [];
  // Прямые потомки Table — строки: TableHeader, TableDelimiter (строка
  // `|---|`) и TableRow. Черты внутри строк — внуки, их здесь нет.
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name !== "TableHeader" && child.name !== "TableDelimiter" && child.name !== "TableRow") continue;
    const line = state.doc.lineAt(child.from);
    prefixes.push(state.sliceDoc(line.from, child.from));
    rows.push(state.sliceDoc(child.from, line.to));
  }
  return {
    from: state.doc.lineAt(table.from).from,
    to: state.doc.lineAt(table.to).to,
    lines: { prefixes, rows },
  };
}

/** Ячейка `(row, col)` в документе, или null, если её нет в исходнике. */
export function cellRange(table: TableModel, row: number, col: number): Span | null {
  const span = cellOffset(table.lines, row, col);
  return span && { from: table.from + span.from, to: table.from + span.to };
}

/** Позиция в ячейке таблицы. */
export interface CellPosition {
  readonly row: number;
  readonly col: number;
}

/**
 * В какой ячейке позиция документа `pos`. Если позиция между ячейками (на
 * черте, в отступе), берётся ближайшая ячейка той же строки; на строке-
 * разделителе — ячейка шапки в том же столбце.
 */
export function cellAt(table: TableModel, pos: number): (CellPosition & { range: Span }) | null {
  if (pos < table.from || pos > table.to) return null;
  const { prefixes, rows } = table.lines;
  let lineStart = table.from;
  for (let index = 0; index < rows.length; index++) {
    const prefix = prefixes[index] ?? "";
    const text = rows[index] ?? "";
    const lineEnd = lineStart + prefix.length + text.length;
    if (pos <= lineEnd) {
      const row = index <= 1 ? 0 : index - 1;
      const offset = pos - lineStart - prefix.length;
      let col = 0;
      let nearest = Number.POSITIVE_INFINITY;
      splitRow(text).spans.forEach((span, i) => {
        const distance = offset < span.from ? span.from - offset : offset > span.to ? offset - span.to : 0;
        if (distance < nearest) {
          nearest = distance;
          col = i;
        }
      });
      col = Math.min(col, splitRow(rows[lineIndex(row)] ?? "").cells.length - 1);
      const range = cellRange(table, row, col);
      return range && { row, col, range };
    }
    lineStart = lineEnd + 1;
  }
  return null;
}

/* ---------- Правки структуры ---------- */

/** Результат правки: новые строки и ячейка, куда поставить курсор. */
export interface TableEdit {
  readonly lines: TableLines;
  readonly focus: CellPosition;
}

function replaceRows(lines: TableLines, rows: string[], prefixes: string[] = [...lines.prefixes]): TableLines {
  return { prefixes, rows };
}

/** Пустая строка таблицы той же ширины, что разделитель: выровненная таблица остаётся выровненной. */
function blankRow(lines: TableLines): string {
  const delimiter = splitRow(lines.rows[1] ?? "");
  const cells = delimiter.cells.map((cell) => " ".repeat(Math.max(cell.length, 2)));
  return joinRow({ ...delimiter, trail: delimiter.trail.trimEnd() }, cells);
}

/** Вставляет пустую строку так, чтобы она стала строкой `row` (от 1 до rowCount). */
export function insertRow(lines: TableLines, row: number, col = 0): TableEdit {
  const at = lineIndex(Math.max(1, Math.min(row, rowCount(lines))));
  const rows = [...lines.rows];
  const prefixes = [...lines.prefixes];
  rows.splice(at, 0, blankRow(lines));
  prefixes.splice(at, 0, lines.prefixes.at(-1) ?? "");
  return { lines: replaceRows(lines, rows, prefixes), focus: { row: Math.max(1, row), col } };
}

/** Копия строки `row` сразу под ней. Шапку копировать некуда, кроме как в тело. */
export function duplicateRow(lines: TableLines, row: number, col = 0): TableEdit {
  const source = lines.rows[lineIndex(row)] ?? blankRow(lines);
  const target = row + 1;
  const at = lineIndex(target);
  const rows = [...lines.rows];
  const prefixes = [...lines.prefixes];
  rows.splice(at, 0, source);
  prefixes.splice(at, 0, lines.prefixes.at(-1) ?? "");
  return { lines: replaceRows(lines, rows, prefixes), focus: { row: target, col } };
}

/** Удаляет строку тела (шапку удалить нельзя — без неё это не таблица). */
export function deleteRow(lines: TableLines, row: number, col = 0): TableEdit | null {
  if (row < 1 || row >= rowCount(lines)) return null;
  const at = lineIndex(row);
  const rows = lines.rows.filter((_, index) => index !== at);
  const prefixes = lines.prefixes.filter((_, index) => index !== at);
  const next = { prefixes, rows };
  return { lines: next, focus: { row: Math.min(row, rowCount(next) - 1), col } };
}

/** Переносит строку тела `row` на место `target` (тоже в теле). */
export function moveRow(lines: TableLines, row: number, target: number, col = 0): TableEdit | null {
  const count = rowCount(lines);
  if (row < 1 || target < 1 || row >= count || target >= count || row === target) return null;
  const rows = [...lines.rows];
  const [moved] = rows.splice(lineIndex(row), 1);
  if (moved === undefined) return null;
  rows.splice(lineIndex(target), 0, moved);
  return { lines: replaceRows(lines, rows), focus: { row: target, col } };
}

/**
 * Применяет `edit` к ячейкам каждой строки. Короткие строки сначала
 * дополняются пустыми ячейками до `minCells`, чтобы правка попала в нужный
 * столбец.
 */
function mapCells(lines: TableLines, minCells: number, edit: (cells: string[], index: number) => void): TableLines {
  const rows = lines.rows.map((text, index) => {
    const split = splitRow(text);
    const cells = [...split.cells];
    const filler = index === 1 ? " --- " : "  ";
    while (cells.length < minCells) cells.push(filler);
    edit(cells, index);
    // Без закрывающей черты пустые ячейки в конце строки GFM не считает
    // ячейками — ставим её, если ячеек стало больше.
    const trail = split.trail === "" && cells.length > split.cells.length ? "|" : split.trail;
    return joinRow({ ...split, trail }, cells);
  });
  return replaceRows(lines, rows);
}

/**
 * Дополняет строку `row` пустыми ячейками до `count`: так в ячейку, которой
 * нет в исходнике (строка короче шапки), можно писать. null — дополнять нечего.
 */
export function padRow(lines: TableLines, row: number, count: number): TableLines | null {
  const index = lineIndex(row);
  if (splitRow(lines.rows[index] ?? "").cells.length >= count) return null;
  return mapCells(lines, 0, (cells, i) => {
    if (i !== index) return;
    while (cells.length < count) cells.push("  ");
  });
}

/** Новый столбец на месте `col` (от 0 до columnCount). */
export function insertColumn(lines: TableLines, col: number, row = 0): TableEdit {
  const at = Math.max(0, Math.min(col, columnCount(lines)));
  const delimiter = splitRow(lines.rows[1] ?? "").cells;
  // Как соседние ячейки разделителя: с пробелами (`| --- |`) или без (`|---|`).
  const spaced = (delimiter[Math.max(0, at - 1)] ?? " --- ").startsWith(" ");
  const dashes = spaced ? " --- " : "---";
  const next = mapCells(lines, at, (cells, index) => {
    cells.splice(at, 0, index === 1 ? dashes : " ".repeat(dashes.length));
  });
  return { lines: next, focus: { row, col: at } };
}

/** Копия столбца `col` сразу справа от него. */
export function duplicateColumn(lines: TableLines, col: number, row = 0): TableEdit {
  const next = mapCells(lines, col + 1, (cells) => {
    cells.splice(col + 1, 0, cells[col] ?? "  ");
  });
  return { lines: next, focus: { row, col: col + 1 } };
}

/** Удаляет столбец; последний оставшийся удалить нельзя. */
export function deleteColumn(lines: TableLines, col: number, row = 0): TableEdit | null {
  const count = columnCount(lines);
  if (count <= 1 || col < 0 || col >= count) return null;
  const next = mapCells(lines, 0, (cells) => {
    if (col < cells.length) cells.splice(col, 1);
  });
  return { lines: next, focus: { row, col: Math.min(col, count - 2) } };
}

/** Переносит столбец `col` на место `target`. */
export function moveColumn(lines: TableLines, col: number, target: number, row = 0): TableEdit | null {
  const count = columnCount(lines);
  if (col < 0 || target < 0 || col >= count || target >= count || col === target) return null;
  const next = mapCells(lines, count, (cells) => {
    const [moved] = cells.splice(col, 1);
    if (moved !== undefined) cells.splice(target, 0, moved);
  });
  return { lines: next, focus: { row, col: target } };
}

/** Меняет выравнивание столбца, сохраняя ширину ячейки разделителя. */
export function setAlign(lines: TableLines, col: number, align: Align, row = 0): TableEdit {
  const next = mapCells(lines, col + 1, (cells, index) => {
    if (index !== 1) return;
    const raw = cells[col] ?? "---";
    const before = raw.length - raw.trimStart().length;
    const after = raw.length - raw.trimEnd().length;
    const colons = (align === "left" || align === "center" ? 1 : 0) + (align === "right" || align === "center" ? 1 : 0);
    const dashes = "-".repeat(Math.max(3, raw.trim().length - colons));
    const body =
      (align === "left" || align === "center" ? ":" : "") + dashes + (align === "right" || align === "center" ? ":" : "");
    cells[col] = raw.slice(0, before) + body + raw.slice(raw.length - after);
  });
  return { lines: next, focus: { row, col } };
}
