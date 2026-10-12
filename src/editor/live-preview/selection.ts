import type { EditorState } from "@codemirror/state";

/**
 * Касается ли выделение (любой курсор) диапазона, включая границы. Элемент
 * раскрывается в исходный текст, когда курсор внутри или вплотную к нему.
 */
export function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** То же для целых строк: заголовки и цитаты раскрываются построчно. */
export function touchesLines(state: EditorState, from: number, to: number): boolean {
  return touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}
