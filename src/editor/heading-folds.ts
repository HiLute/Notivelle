import "./heading-folds.css";

import { codeFolding, foldable, foldedRanges, foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import type { EditorState, Extension, Line, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import chevronIcon from "lucide-static/icons/chevron-down.svg?raw";

/**
 * Сворачивание разделов в редакторе (Live Preview и исходник), как в
 * Obsidian и как в режиме чтения (reading/folds.ts): при наведении на
 * заголовок слева появляется стрелка, щелчок прячет раздел до следующего
 * заголовка того же или более высокого уровня, а на месте раздела остаётся
 * «…» — щелчок по нему разворачивает.
 *
 * Где кончается раздел, знает сам язык Markdown (lang-markdown: foldService
 * по заголовкам). Свёрнутое хранится в состоянии редактора (codeFolding):
 * у каждой вкладки своё, и при правках оно сдвигается вместе с текстом.
 * Если курсор попадает внутрь свёрнутого раздела, CodeMirror его
 * разворачивает сам — так работает и переход по ссылке к заголовку.
 */
export function headingFolds(): Extension {
  return [
    codeFolding({
      placeholderDOM(_view, onclick) {
        const placeholder = document.createElement("span");
        placeholder.className = "cm-foldPlaceholder";
        placeholder.textContent = "…";
        placeholder.title = "Развернуть раздел";
        placeholder.addEventListener("click", onclick);
        return placeholder;
      },
    }),
    foldMarkers,
  ];
}

const headingLine = Decoration.line({ class: "cm-fold-heading" });

/** Стрелка у заголовка. Щелчок по ней не ставит курсор. */
class FoldMarker extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }

  override eq(other: FoldMarker): boolean {
    return other.folded === this.folded;
  }

  toDOM(view: EditorView): HTMLElement {
    const marker = document.createElement("span");
    marker.className = this.folded ? "cm-heading-fold is-folded" : "cm-heading-fold";
    marker.innerHTML = chevronIcon;
    marker.title = this.folded ? "Развернуть раздел" : "Свернуть раздел";
    marker.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // Позицию берём в момент щелчка: текст выше мог измениться.
      toggleSection(view, view.state.doc.lineAt(view.posAtDOM(marker)));
    });
    return marker;
  }

  // Щелчки обрабатывает сама стрелка (toDOM), редактору они не нужны.
  override ignoreEvent(): boolean {
    return true;
  }
}

/** Свёрнутый раздел, который начинается в конце строки `pos`, или null. */
function foldedAt(state: EditorState, pos: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(pos, pos, (from, to) => {
    if (from === pos) found = { from, to };
  });
  return found;
}

/** Сворачивает или разворачивает раздел заголовка на строке `line`. */
function toggleSection(view: EditorView, line: Line): void {
  const { state } = view;
  const folded = foldedAt(state, line.to);
  if (folded) {
    view.dispatch({ effects: unfoldEffect.of(folded) });
    return;
  }
  const range = foldable(state, line.from, line.to);
  if (!range) return;
  // Курсор внутри сворачиваемого раздела оказался бы в спрятанном тексте —
  // ставим его в конец заголовка.
  const head = state.selection.main.head;
  const inside = head > range.from && head <= range.to;
  view.dispatch({
    effects: foldEffect.of(range),
    selection: inside ? { anchor: line.to } : undefined,
  });
}

/**
 * Стрелки у заголовков верхнего уровня (не в цитатах и списках), у которых
 * есть что сворачивать, — только в видимой части документа.
 */
const foldMarkers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarkers(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state) ||
        foldedRanges(update.startState) !== foldedRanges(update.state)
      ) {
        this.decorations = buildMarkers(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function buildMarkers(view: EditorView): DecorationSet {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  // Заголовок на стыке двух видимых участков встретится дважды.
  const seen = new Set<number>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        // В сам документ заходим, в остальные блоки — нет: заголовки внутри
        // цитат и callouts разделов не образуют.
        if (node.name === "Document") return;
        if (/^(ATX|Setext)Heading/.test(node.name)) {
          const line = state.doc.lineAt(node.from);
          if (seen.has(line.from)) return false;
          seen.add(line.from);
          const folded = foldedAt(state, line.to) !== null;
          if (folded || foldable(state, line.from, line.to)) {
            decorations.push(headingLine.range(line.from));
            decorations.push(Decoration.widget({ widget: new FoldMarker(folded), side: -1 }).range(line.from));
          }
        }
        return false;
      },
    });
  }
  return Decoration.set(decorations, true);
}
