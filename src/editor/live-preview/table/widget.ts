import { type ChangeSet, Transaction } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import arrowDown from "lucide-static/icons/arrow-down.svg?raw";
import arrowLeft from "lucide-static/icons/arrow-left.svg?raw";
import arrowRight from "lucide-static/icons/arrow-right.svg?raw";
import arrowUp from "lucide-static/icons/arrow-up.svg?raw";
import rowAbove from "lucide-static/icons/between-horizontal-end.svg?raw";
import rowBelow from "lucide-static/icons/between-horizontal-start.svg?raw";
import columnLeft from "lucide-static/icons/between-vertical-end.svg?raw";
import columnRight from "lucide-static/icons/between-vertical-start.svg?raw";
import copy from "lucide-static/icons/copy.svg?raw";
import gripHorizontal from "lucide-static/icons/grip-horizontal.svg?raw";
import gripVertical from "lucide-static/icons/grip-vertical.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import alignCenter from "lucide-static/icons/text-align-center.svg?raw";
import alignRight from "lucide-static/icons/text-align-end.svg?raw";
import alignLeft from "lucide-static/icons/text-align-start.svg?raw";
import trash from "lucide-static/icons/trash-2.svg?raw";

import type { DocumentId } from "../../../ipc";
import { renderMath } from "../../../reading/math";
import { type MenuEntry, showMenu } from "../../../ui/menu";
import { linkHandlersFacet, openHref } from "../../context";
import { blockPreview } from "../blocks";
import {
  blockKey,
  cachedBlockHtml,
  knownBlockHeight,
  rememberBlockHeight,
  renderBlockHtml,
} from "../rendered-block";
import { type CellNavigation, createCellEditor } from "./cell-editor";
import {
  type Align,
  aligns,
  type CellPosition,
  cellOffset,
  cellRange,
  cellTexts,
  columnCount,
  deleteColumn,
  deleteRow,
  duplicateColumn,
  duplicateRow,
  insertColumn,
  insertRow,
  moveColumn,
  moveRow,
  padRow,
  rowCount,
  setAlign,
  type TableEdit,
  type TableLines,
  type TableModel,
  tableText,
} from "./model";

/** Ячейка, в которой стоит курсор основного редактора. */
export interface ActiveCellSpec extends CellPosition {
  /** Текст ячейки в исходнике — ровно то, что покажет редактор ячейки. */
  readonly text: string;
  /** Выделение внутри этого текста. */
  readonly anchor: number;
  readonly head: number;
}

/** Всё, что нужно виджету, чтобы нарисовать таблицу. Собирает blocks.ts. */
export interface TableSpec {
  /** Начало таблицы в документе — только для оценки высоты (см. estimatedHeight). */
  readonly from: number;
  readonly lines: TableLines;
  readonly source: string;
  readonly documentId: DocumentId | null;
  readonly active: ActiveCellSpec | null;
  /** Таблица целиком внутри выделения основного редактора. */
  readonly selected: boolean;
}

/**
 * Таблица в Live Preview — как в Obsidian: она всегда нарисована, а ячейку
 * правят прямо на месте. Клик по ячейке (или стрелки и Tab) открывает в ней
 * маленький редактор с исходным текстом ячейки; остальные ячейки остаются
 * отрендеренными. Строки и столбцы добавляются кнопками «+», через ручки
 * слева и сверху (их можно перетаскивать) и через контекстное меню.
 */
export class TableWidget extends WidgetType {
  constructor(readonly spec: TableSpec) {
    super();
  }

  override eq(other: TableWidget): boolean {
    const a = this.spec;
    const b = other.spec;
    return (
      a.source === b.source &&
      a.documentId === b.documentId &&
      a.selected === b.selected &&
      sameActive(a.active, b.active)
    );
  }

  /**
   * Высота таблицы для карты высот редактора. Её спрашивают у каждого нового
   * виджета таблицы — а новый виджет появляется на каждую букву и каждый
   * переход по ячейкам. Неверная оценка дорого стоит: редактор потом
   * перемеряет таблицу и, удерживая верхнюю строку экрана, прокручивает
   * страницу на разницу. Поэтому высота запоминается по месту таблицы в
   * документе (оно не меняется, пока правят саму таблицу), а не по её тексту.
   */
  override get estimatedHeight(): number {
    const { documentId, from, source } = this.spec;
    return tableHeights.get(heightKey(documentId, from)) ?? knownBlockHeight(blockKey(documentId, source));
  }

  toDOM(view: EditorView): HTMLElement {
    return new TableController(view, this.spec).dom;
  }

  /**
   * Пока правят ячейку, таблица меняется на каждую букву. Обновляем её DOM
   * на месте, а не рисуем заново: иначе пропал бы редактор ячейки с фокусом
   * и набором текста.
   */
  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const controller = controllers.get(dom);
    if (controller?.view !== view) return false;
    controller.update(this.spec);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    controllers.get(dom)?.destroy();
  }

  /**
   * Координаты позиции внутри таблицы. Без этого редактор считал бы
   * курсором всю таблицу и, прокручивая к нему, мог бы уехать к её краю.
   */
  override coordsAt(dom: HTMLElement): DOMRect | null {
    return controllers.get(dom)?.openCellRect() ?? null;
  }

  /** Все события внутри таблицы обрабатывает она сама. */
  override ignoreEvent(): boolean {
    return true;
  }
}

function sameActive(a: ActiveCellSpec | null, b: ActiveCellSpec | null): boolean {
  if (a === null || b === null) return a === b;
  return a.row === b.row && a.col === b.col && a.text === b.text && a.anchor === b.anchor && a.head === b.head;
}

const controllers = new WeakMap<HTMLElement, TableController>();

/** Измеренные высоты таблиц по документу и началу таблицы. */
const tableHeights = new Map<string, number>();
const TABLE_HEIGHTS_LIMIT = 200;

function heightKey(documentId: DocumentId | null, from: number): string {
  return `${documentId ?? ""}:${from}`;
}

/**
 * Редакторы, которым следующий открытый редактор ячейки должен отдать
 * фокус: переход Tab'ом, клик, правка из меню. Запрос живёт до конца
 * текущей задачи — ячейка открывается в том же обновлении редактора.
 */
const focusRequests = new WeakSet<EditorView>();

function requestCellFocus(view: EditorView): void {
  focusRequests.add(view);
  queueMicrotask(() => focusRequests.delete(view));
}

/**
 * Применяет правку структуры таблицы и ставит курсор в ячейку `focus`.
 * В документ уходит только изменившийся кусок текста.
 */
function applyTableEdit(view: EditorView, table: TableModel, lines: TableLines, focus: CellPosition): void {
  const cell = cellOffset(lines, focus.row, focus.col);
  requestCellFocus(view);
  view.dispatch({
    changes: minimalChange(view.state.sliceDoc(table.from, table.to), tableText(lines), table.from),
    selection: { anchor: table.from + (cell?.to ?? 0) },
    userEvent: "input.table",
  });
}

/** Самая короткая замена, превращающая `before` в `after`: общие начало и конец не трогаем. */
function minimalChange(before: string, after: string, offset = 0): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: offset + start, to: offset + before.length - end, insert: after.slice(start, after.length - end) };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function button(className: string, title: string, icon: string): HTMLButtonElement {
  const node = element("button", `cm-lp-table-control ${className}`);
  node.type = "button";
  node.title = title;
  node.tabIndex = -1;
  // SVG из пакета lucide-static: innerHTML безопасен.
  node.innerHTML = icon;
  return node;
}

/** Открытый редактор ячейки. */
interface OpenCell extends CellPosition {
  readonly editor: EditorView;
}

/** DOM таблицы и всё её поведение. Живёт столько же, сколько DOM виджета. */
class TableController {
  readonly dom: HTMLElement;
  readonly #table: HTMLTableElement;
  readonly #rowHandle: HTMLButtonElement;
  readonly #columnHandle: HTMLButtonElement;
  readonly #dropMarker: HTMLElement;
  #spec: TableSpec;
  /** Ячейки по строкам: [0] — шапка. Столбцов столько, сколько в шапке. */
  #cells: HTMLTableCellElement[][] = [];
  #open: OpenCell | null = null;
  /** Идёт перенос текста из основного редактора в редактор ячейки. */
  #syncing = false;
  /** Исходник, HTML которого сейчас в ячейках; null — ячейки показывают сырой текст. */
  #renderedSource: string | null = null;
  #renderRequest = 0;
  /** Куда кликнули мышью: курсор встанет туда, когда откроется редактор ячейки. */
  #clickPoint: { x: number; y: number } | null = null;
  #destroyed = false;

  constructor(
    readonly view: EditorView,
    spec: TableSpec,
  ) {
    this.#spec = spec;
    this.dom = element("div", "cm-lp-table-widget");
    const scroller = element("div", "cm-lp-table-scroll markdown-rendered");
    this.#table = document.createElement("table");
    scroller.append(this.#table);

    const addRow = button("cm-lp-table-add cm-lp-table-add-row", "Добавить строку", plus);
    const addColumn = button("cm-lp-table-add cm-lp-table-add-column", "Добавить столбец", plus);
    this.#rowHandle = button("cm-lp-table-handle cm-lp-table-row-handle", "Строка: меню, перетащите для переноса", gripVertical);
    this.#columnHandle = button(
      "cm-lp-table-handle cm-lp-table-column-handle",
      "Столбец: меню, перетащите для переноса",
      gripHorizontal,
    );
    this.#dropMarker = element("div", "cm-lp-table-drop");
    this.dom.append(scroller, addRow, addColumn, this.#rowHandle, this.#columnHandle, this.#dropMarker);
    controllers.set(this.dom, this);

    for (const control of [addRow, addColumn]) control.addEventListener("mousedown", (event) => event.preventDefault());
    addRow.addEventListener("click", () => this.#edit((lines) => insertRow(lines, rowCount(lines))));
    addColumn.addEventListener("click", () => this.#edit((lines) => insertColumn(lines, columnCount(lines))));
    this.#rowHandle.addEventListener("pointerdown", (event) => this.#dragHandle(event, "row"));
    this.#columnHandle.addEventListener("pointerdown", (event) => this.#dragHandle(event, "column"));

    this.dom.addEventListener("mousedown", (event) => this.#onMouseDown(event));
    this.dom.addEventListener("click", (event) => {
      // Ссылки в ячейках открываются Ctrl+кликом (см. #onMouseDown), а сам
      // переход увёл бы WebView со страницы приложения.
      if ((event.target as Element).closest("a")) event.preventDefault();
    });
    this.dom.addEventListener("contextmenu", (event) => this.#onContextMenu(event));
    this.#table.addEventListener("mouseover", (event) => {
      const cell = (event.target as Element).closest<HTMLTableCellElement>("td, th");
      if (cell) this.#showHandles(cell);
    });
    this.dom.addEventListener("mouseleave", () => this.dom.classList.remove("has-handles"));

    // Пока ячейка открыта, клавиши должны попадать в её редактор. Если фокус
    // вернулся в основной (закрыли меню, переключили окно), передаём его
    // ячейке — иначе Tab или буква изменили бы исходник таблицы напрямую.
    this.view.contentDOM.addEventListener("focus", this.#redirectFocus);

    this.#build();
    this.#syncOpenCell();
    this.dom.classList.toggle("is-selected", spec.selected);
    this.#render();
    this.#measure();
  }

  /** Сразу, а не позже: пока фокус у основного редактора, он может прокрутить страницу (см. #openCell). */
  readonly #redirectFocus = (): void => {
    this.#open?.editor.focus();
  };

  /** Где открытая ячейка: по этому прямоугольнику редактор прокручивает к курсору. */
  openCellRect(): DOMRect | null {
    const open = this.#open;
    return open ? (this.#cells[open.row]?.[open.col]?.getBoundingClientRect() ?? null) : null;
  }

  update(spec: TableSpec): void {
    const previous = this.#spec;
    this.#spec = spec;
    const shapeChanged =
      rowCount(spec.lines) !== rowCount(previous.lines) ||
      columnCount(spec.lines) !== columnCount(previous.lines) ||
      aligns(spec.lines).join() !== aligns(previous.lines).join();

    if (shapeChanged) {
      this.#closeCell();
      this.#build();
    } else if (spec.source !== previous.source || spec.documentId !== previous.documentId) {
      // Пока HTML не пришёл, изменившиеся ячейки показывают сырой текст.
      let othersChanged = spec.documentId !== previous.documentId;
      this.#forEachCell((cell, row, col) => {
        if (this.#isOpen(row, col)) return;
        const text = cellTexts(spec.lines, row)[col] ?? "";
        if (cell.dataset.raw === text) return;
        this.#showRaw(cell, text);
        othersChanged = true;
      });
      // Печатают в открытой ячейке, остальные не менялись: их HTML годится
      // и для нового текста таблицы, просить Rust на каждую букву незачем.
      if (!othersChanged && this.#renderedSource === previous.source) this.#renderedSource = spec.source;
    }
    this.#syncOpenCell();
    this.dom.classList.toggle("is-selected", spec.selected);
    this.#render();
    this.#measure();
  }

  destroy(): void {
    this.#destroyed = true;
    this.view.contentDOM.removeEventListener("focus", this.#redirectFocus);
    this.#closeCell();
  }

  /* ---------- Отрисовка ---------- */

  #build(): void {
    const { lines } = this.#spec;
    const columns = columnCount(lines);
    const align = aligns(lines);
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    this.#cells = [];
    for (let row = 0; row < rowCount(lines); row++) {
      const tr = document.createElement("tr");
      const texts = cellTexts(lines, row);
      const cells: HTMLTableCellElement[] = [];
      for (let col = 0; col < columns; col++) {
        const cell = document.createElement(row === 0 ? "th" : "td");
        cell.dataset.row = String(row);
        cell.dataset.col = String(col);
        const side = align[col];
        if (side) cell.style.textAlign = side;
        this.#showRaw(cell, texts[col] ?? "");
        tr.append(cell);
        cells.push(cell);
      }
      (row === 0 ? head : body).append(tr);
      this.#cells.push(cells);
    }
    this.#table.replaceChildren(head, body);
  }

  #showRaw(cell: HTMLTableCellElement, text: string): void {
    cell.textContent = text;
    cell.dataset.raw = text;
    this.#renderedSource = null;
  }

  #forEachCell(callback: (cell: HTMLTableCellElement, row: number, col: number) => void): void {
    this.#cells.forEach((cells, row) => cells.forEach((cell, col) => callback(cell, row, col)));
  }

  /** Просит у Rust HTML таблицы (из кеша — сразу) и раскладывает его по ячейкам. */
  #render(): void {
    const { documentId, source } = this.#spec;
    if (this.#renderedSource === source) return;
    const cached = cachedBlockHtml(blockKey(documentId, source));
    if (cached !== undefined) {
      this.#fill(cached);
      return;
    }
    const request = ++this.#renderRequest;
    renderBlockHtml(documentId, source)
      .then((html) => {
        if (request === this.#renderRequest && !this.#destroyed && this.#spec.source === source) this.#fill(html);
      })
      .catch(() => {
        // Ячейки остаются сырым текстом: таблицу всё равно можно править.
      });
  }

  #fill(html: string): void {
    const { lines, source } = this.#spec;
    const template = document.createElement("template");
    // HTML очищен Rust (render.rs), поэтому вставлять его можно.
    template.innerHTML = html;
    const rendered = template.content.querySelector("table");
    if (!rendered) return;
    this.#renderedSource = source;
    this.#forEachCell((cell, row, col) => {
      if (this.#isOpen(row, col)) return;
      cell.innerHTML = rendered.rows[row]?.cells[col]?.innerHTML ?? "";
      cell.dataset.raw = cellTexts(lines, row)[col] ?? "";
      for (const image of cell.querySelectorAll("img")) {
        image.addEventListener("load", () => this.#measure());
      }
      if (cell.querySelector("[data-math-style]")) void renderMath(cell).then(() => this.#measure());
    });
    this.#measure();
  }

  /**
   * Запоминает высоту таблицы — в фазе измерений редактора, когда таблица
   * уже на странице и разметка посчитана.
   */
  #measure(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) =>
        this.dom.isConnected ? { height: this.dom.getBoundingClientRect().height, from: view.posAtDOM(this.dom) } : null,
      write: (measured) => {
        if (!measured || measured.height <= 0 || this.#destroyed) return;
        const { documentId, source } = this.#spec;
        const key = heightKey(documentId, measured.from);
        tableHeights.delete(key);
        tableHeights.set(key, measured.height);
        if (tableHeights.size > TABLE_HEIGHTS_LIMIT) {
          const oldest = tableHeights.keys().next().value;
          if (oldest !== undefined) tableHeights.delete(oldest);
        }
        rememberBlockHeight(blockKey(documentId, source), measured.height);
      },
    });
  }

  /* ---------- Редактор ячейки ---------- */

  #isOpen(row: number, col: number): boolean {
    return this.#open !== null && this.#open.row === row && this.#open.col === col;
  }

  /** Открывает, переносит или закрывает редактор ячейки по курсору основного редактора. */
  #syncOpenCell(): void {
    const active = this.#spec.active;
    if (this.#open && !(active && this.#isOpen(active.row, active.col))) this.#closeCell();
    if (!active) return;
    if (this.#open) this.#syncEditor(this.#open.editor, active);
    else this.#openCell(active);
  }

  #openCell(active: ActiveCellSpec): void {
    const cell = this.#cells[active.row]?.[active.col];
    if (!cell) return;
    cell.replaceChildren();
    cell.classList.add("is-editing");
    delete cell.dataset.raw;

    const editor = createCellEditor({
      parent: cell,
      text: active.text,
      anchor: active.anchor,
      head: active.head,
      main: this.view,
      navigation: this.#navigation(),
      dispatch: (transactions, view) => this.#onCellTransactions(transactions, view),
    });
    this.#open = { editor, row: active.row, col: active.col };

    const focus = this.view.hasFocus || focusRequests.has(this.view);
    focusRequests.delete(this.view);
    if (focus) {
      // Фокус забираем сразу, ещё внутри обновления основного редактора. Тот
      // в конце обновления ставит каретку браузера к своему курсору, если
      // фокус у него; а курсор сейчас «внутри» таблицы, и CodeMirror кладёт
      // каретку на строку после неё — WebKit прокрутил бы туда страницу.
      if (this.view.hasFocus) this.view.contentDOM.blur();
      // Только что нарисованная таблица ещё не в документе: фокус — чуть позже.
      if (this.dom.isConnected) editor.focus();
      else queueMicrotask(() => this.#open?.editor === editor && editor.focus());
    }

    const point = this.#clickPoint;
    this.#clickPoint = null;
    if (point) {
      // Курсор — туда, куда кликнули, но уже в исходном тексте ячейки.
      // Позицию можно узнать только после разметки ячейки.
      queueMicrotask(() => {
        if (this.#open?.editor !== editor) return;
        editor.dispatch({ selection: { anchor: editor.posAtCoords(point, false) } });
      });
    }
  }

  #closeCell(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = null;
    // Фокус был в ячейке: если в этом же обновлении откроется другая (Tab,
    // стрелки), она его заберёт. Если нет (Ctrl+Z увёл курсор из таблицы),
    // фокус возвращается основному редактору, а не теряется.
    if (open.editor.hasFocus) {
      requestCellFocus(this.view);
      queueMicrotask(() => {
        // Курсор перешёл в другую ячейку — фокус уже у неё. Отдать его
        // основному редактору здесь значило бы прокрутить страницу (см. #openCell).
        if (this.view.state.field(blockPreview, false)?.active) return;
        if (!document.activeElement?.closest(".cm-lp-table-widget")) this.view.focus();
      });
    }
    open.editor.destroy();
    const cell = this.#cells[open.row]?.[open.col];
    if (cell) {
      cell.classList.remove("is-editing");
      this.#showRaw(cell, cellTexts(this.#spec.lines, open.row)[open.col] ?? "");
    }
  }

  /** Текст и выделение из основного редактора — в редактор ячейки (отмена, поиск). */
  #syncEditor(editor: EditorView, active: ActiveCellSpec): void {
    const current = editor.state.doc.toString();
    const length = active.text.length;
    const anchor = Math.min(active.anchor, length);
    const head = Math.min(active.head, length);
    const selection = editor.state.selection.main;
    if (current === active.text && selection.anchor === anchor && selection.head === head) return;
    this.#syncing = true;
    try {
      editor.dispatch({
        changes: current === active.text ? undefined : minimalChange(current, active.text),
        selection: { anchor, head },
      });
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * Правки в редакторе ячейки: применяем у него и сразу переносим в
   * основной редактор — тот же текст по тем же смещениям от начала ячейки.
   */
  #onCellTransactions(transactions: readonly Transaction[], editor: EditorView): void {
    editor.update(transactions);
    if (this.#syncing || !this.#open || this.#open.editor !== editor) return;
    const active = this.view.state.field(blockPreview, false)?.active;
    if (!active || active.row !== this.#open.row || active.col !== this.#open.col) return;

    const changes: { from: number; to: number; insert: string }[] = [];
    const changeSets = transactions.filter((tr) => tr.docChanged).map((tr) => tr.changes);
    if (changeSets.length > 0) {
      const composed = changeSets.reduce((all: ChangeSet, next) => all.compose(next));
      composed.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({ from: active.from + fromA, to: active.from + toA, insert: inserted.toString() });
      });
    }
    const selection = editor.state.selection.main;
    const userEvent = transactions
      .map((tr) => tr.annotation(Transaction.userEvent))
      .filter((event) => event !== undefined)
      .at(-1);
    this.view.dispatch({
      changes,
      selection: { anchor: active.from + selection.anchor, head: active.from + selection.head },
      ...(userEvent ? { userEvent } : {}),
    });
  }

  /* ---------- Переходы между ячейками ---------- */

  #navigation(): CellNavigation {
    return {
      next: () => this.#step(1),
      previous: () => this.#step(-1),
      below: () => {
        const at = this.#position();
        if (!at) return;
        if (at.row + 1 < rowCount(at.table.lines)) this.#moveTo(at.table, at.row + 1, at.col, "end");
        else this.#applyEdit(at.table, insertRow(at.table.lines, rowCount(at.table.lines), at.col));
      },
      vertical: (forward) => {
        const at = this.#position();
        if (!at) return;
        const row = at.row + (forward ? 1 : -1);
        if (row < 0 || row >= rowCount(at.table.lines)) this.#exit(at.table, forward);
        else this.#moveTo(at.table, row, at.col, "end");
      },
      horizontal: (forward) => {
        const at = this.#position();
        if (!at) return;
        const columns = columnCount(at.table.lines);
        const index = at.row * columns + at.col + (forward ? 1 : -1);
        if (index < 0 || index >= rowCount(at.table.lines) * columns) this.#exit(at.table, forward);
        else this.#moveTo(at.table, Math.floor(index / columns), index % columns, forward ? "start" : "end");
      },
    };
  }

  /** Tab / Shift+Tab: по ячейкам слева направо, после последней — новая строка. */
  #step(direction: 1 | -1): void {
    const at = this.#position();
    if (!at) return;
    const rows = rowCount(at.table.lines);
    const columns = columnCount(at.table.lines);
    const index = at.row * columns + at.col + direction;
    if (index < 0) return;
    if (index >= rows * columns) this.#applyEdit(at.table, insertRow(at.table.lines, rows));
    else this.#moveTo(at.table, Math.floor(index / columns), index % columns, "end");
  }

  /** Таблица и открытая ячейка. */
  #position(): (CellPosition & { table: TableModel }) | null {
    const table = this.#model();
    return table && this.#open && { table, row: this.#open.row, col: this.#open.col };
  }

  #moveTo(table: TableModel, row: number, col: number, edge: "start" | "end"): void {
    const range = cellRange(table, row, col);
    if (!range) {
      // В строке нет такой ячейки (строка короче шапки) — дописываем пустые.
      const padded = padRow(table.lines, row, columnCount(table.lines));
      if (padded) applyTableEdit(this.view, table, padded, { row, col });
      return;
    }
    requestCellFocus(this.view);
    this.view.dispatch({ selection: { anchor: edge === "start" ? range.from : range.to }, userEvent: "select" });
  }

  /**
   * Выход из таблицы стрелками: на строку выше или ниже. Если таблица в
   * самом начале или конце документа, там появляется пустая строка — иначе
   * из таблицы было бы некуда выйти.
   */
  #exit(table: TableModel, forward: boolean): void {
    const { doc } = this.view.state;
    if (!forward) {
      if (table.from === 0) {
        this.view.dispatch({ changes: { from: 0, insert: "\n" }, selection: { anchor: 0 }, userEvent: "input" });
      } else {
        this.view.dispatch({ selection: { anchor: table.from - 1 }, userEvent: "select" });
      }
    } else if (table.to >= doc.length) {
      this.view.dispatch({
        changes: { from: doc.length, insert: "\n" },
        selection: { anchor: doc.length + 1 },
        userEvent: "input",
      });
    } else {
      this.view.dispatch({ selection: { anchor: table.to + 1 }, userEvent: "select" });
    }
    this.view.focus();
  }

  /* ---------- Мышь ---------- */

  /** Таблица этого виджета в текущем состоянии документа. */
  #model(): TableModel | null {
    const value = this.view.state.field(blockPreview, false);
    if (!value || !this.dom.isConnected) return null;
    const pos = this.view.posAtDOM(this.dom);
    return value.blocks.find((block) => block.table && block.from <= pos && pos <= block.to)?.table ?? null;
  }

  #cellOf(target: EventTarget | null): (CellPosition & { cell: HTMLTableCellElement }) | null {
    const cell = target instanceof Element ? target.closest<HTMLTableCellElement>("td, th") : null;
    if (!cell || !this.#table.contains(cell)) return null;
    return { cell, row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
  }

  #onMouseDown(event: MouseEvent): void {
    const target = event.target as Element;
    // Внутри открытой ячейки работает её редактор; у кнопок свои обработчики.
    // (Не closest(".cm-editor"): вся таблица и так внутри основного редактора.)
    if (this.#open?.editor.dom.contains(target) || target.closest(".cm-lp-table-control")) return;
    const at = this.#cellOf(target);
    if (!at || event.button !== 0) return;
    event.preventDefault();

    const href = target.closest("a")?.getAttribute("href");
    if (href && (event.ctrlKey || event.metaKey)) {
      const handlers = this.view.state.facet(linkHandlersFacet);
      if (handlers && !href.startsWith("#")) openHref(handlers, href);
      return;
    }
    const table = this.#model();
    if (!table) return;
    this.#clickPoint = { x: event.clientX, y: event.clientY };
    this.#moveTo(table, at.row, at.col, "end");
  }

  #onContextMenu(event: MouseEvent): void {
    const at = this.#cellOf(event.target);
    if (!at) return;
    event.preventDefault();
    showMenu([...this.#rowMenu(at.row, at.col), "separator", ...this.#columnMenu(at.row, at.col)], event.clientX, event.clientY);
  }

  /** Ручки строки (слева) и столбца (сверху) у ячейки под мышью. */
  #showHandles(cell: HTMLTableCellElement): void {
    const box = this.dom.getBoundingClientRect();
    const rowBox = (cell.parentElement ?? cell).getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    const tableBox = this.#table.getBoundingClientRect();
    this.#rowHandle.style.top = `${rowBox.top - box.top + rowBox.height / 2}px`;
    this.#rowHandle.dataset.index = cell.dataset.row;
    this.#columnHandle.style.left = `${cellBox.left - box.left + cellBox.width / 2}px`;
    this.#columnHandle.style.top = `${tableBox.top - box.top}px`;
    this.#columnHandle.dataset.index = cell.dataset.col;
    this.dom.classList.add("has-handles");
  }

  /**
   * Ручка строки или столбца: щелчок открывает меню, перетаскивание
   * переносит строку (кроме шапки) или столбец на новое место.
   */
  #dragHandle(event: PointerEvent, kind: "row" | "column"): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget as HTMLButtonElement;
    const index = Number(handle.dataset.index);
    const start = { x: event.clientX, y: event.clientY };
    const movable = kind === "column" || index > 0;
    let dragging = false;
    let target = index;
    handle.setPointerCapture(event.pointerId);

    const onMove = (move: PointerEvent) => {
      if (!dragging && movable && Math.hypot(move.clientX - start.x, move.clientY - start.y) > 4) {
        dragging = true;
        this.dom.classList.add("is-dragging");
      }
      if (!dragging) return;
      target = kind === "row" ? this.#rowAt(move.clientY) : this.#columnAt(move.clientX);
      this.#showDropMarker(kind, index, target);
    };
    const onEnd = (end: PointerEvent) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      this.dom.classList.remove("is-dragging");
      this.#dropMarker.classList.remove("is-visible");
      if (end.type === "pointercancel") return;
      if (!dragging) {
        const box = handle.getBoundingClientRect();
        const row = kind === "row" ? index : (this.#open?.row ?? 0);
        const col = kind === "column" ? index : (this.#open?.col ?? 0);
        showMenu(kind === "row" ? this.#rowMenu(row, col) : this.#columnMenu(row, col), box.left, box.bottom + 4);
      } else if (target !== index) {
        this.#edit((lines) =>
          kind === "row" ? moveRow(lines, index, target, this.#open?.col ?? 0) : moveColumn(lines, index, target),
        );
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  /** Строка тела под точкой `y` (шапку перетащить нельзя). */
  #rowAt(y: number): number {
    const rows = this.#cells.length;
    for (let row = 1; row < rows; row++) {
      const box = this.#cells[row]?.[0]?.parentElement?.getBoundingClientRect();
      if (box && y < box.bottom) return row;
    }
    return rows - 1;
  }

  #columnAt(x: number): number {
    const header = this.#cells[0] ?? [];
    for (let col = 0; col < header.length; col++) {
      const box = header[col]?.getBoundingClientRect();
      if (box && x < box.right) return col;
    }
    return header.length - 1;
  }

  /** Полоска, куда встанет перетаскиваемая строка или столбец. */
  #showDropMarker(kind: "row" | "column", from: number, to: number): void {
    const box = this.dom.getBoundingClientRect();
    const tableBox = this.#table.getBoundingClientRect();
    const marker = this.#dropMarker;
    marker.classList.toggle("is-row", kind === "row");
    marker.classList.toggle("is-column", kind === "column");
    if (kind === "row") {
      const rowBox = this.#cells[to]?.[0]?.parentElement?.getBoundingClientRect();
      if (!rowBox) return;
      marker.style.top = `${(to > from ? rowBox.bottom : rowBox.top) - box.top}px`;
      marker.style.left = `${tableBox.left - box.left}px`;
      marker.style.width = `${tableBox.width}px`;
      marker.style.height = "";
    } else {
      const cellBox = this.#cells[0]?.[to]?.getBoundingClientRect();
      if (!cellBox) return;
      marker.style.left = `${(to > from ? cellBox.right : cellBox.left) - box.left}px`;
      marker.style.top = `${tableBox.top - box.top}px`;
      marker.style.height = `${tableBox.height}px`;
      marker.style.width = "";
    }
    marker.classList.add("is-visible");
  }

  /* ---------- Меню и правки структуры ---------- */

  #rowMenu(row: number, col: number): MenuEntry[] {
    const rows = this.#cells.length;
    const body = row > 0;
    return [
      { section: "Строка" },
      { label: "Вставить строку выше", icon: rowAbove, disabled: !body, action: () => this.#edit((l) => insertRow(l, row, col)) },
      { label: "Вставить строку ниже", icon: rowBelow, action: () => this.#edit((l) => insertRow(l, row + 1, col)) },
      { label: "Переместить вверх", icon: arrowUp, disabled: row <= 1, action: () => this.#edit((l) => moveRow(l, row, row - 1, col)) },
      { label: "Переместить вниз", icon: arrowDown, disabled: !body || row >= rows - 1, action: () => this.#edit((l) => moveRow(l, row, row + 1, col)) },
      { label: "Дублировать строку", icon: copy, action: () => this.#edit((l) => duplicateRow(l, row, col)) },
      { label: "Удалить строку", icon: trash, disabled: !body, action: () => this.#edit((l) => deleteRow(l, row, col)) },
    ];
  }

  #columnMenu(row: number, col: number): MenuEntry[] {
    const columns = this.#cells[0]?.length ?? 0;
    const align = (side: Align) => () => this.#edit((l) => setAlign(l, col, side, row));
    return [
      { section: "Столбец" },
      { label: "Вставить столбец слева", icon: columnLeft, action: () => this.#edit((l) => insertColumn(l, col, row)) },
      { label: "Вставить столбец справа", icon: columnRight, action: () => this.#edit((l) => insertColumn(l, col + 1, row)) },
      { label: "Переместить влево", icon: arrowLeft, disabled: col === 0, action: () => this.#edit((l) => moveColumn(l, col, col - 1, row)) },
      { label: "Переместить вправо", icon: arrowRight, disabled: col >= columns - 1, action: () => this.#edit((l) => moveColumn(l, col, col + 1, row)) },
      { label: "Дублировать столбец", icon: copy, action: () => this.#edit((l) => duplicateColumn(l, col, row)) },
      { label: "Удалить столбец", icon: trash, disabled: columns <= 1, action: () => this.#edit((l) => deleteColumn(l, col, row)) },
      "separator",
      { label: "По левому краю", icon: alignLeft, action: align("left") },
      { label: "По центру", icon: alignCenter, action: align("center") },
      { label: "По правому краю", icon: alignRight, action: align("right") },
    ];
  }

  #edit(compute: (lines: TableLines) => TableEdit | null): void {
    const table = this.#model();
    if (table) this.#applyEdit(table, compute(table.lines));
  }

  #applyEdit(table: TableModel, edit: TableEdit | null): void {
    if (edit) applyTableEdit(this.view, table, edit.lines, edit.focus);
  }
}
