import { EditorView } from "@codemirror/view";

/** Номер строки (с 1) вверху видимой области редактора. */
export function topVisibleLine(view: EditorView): number {
  const top = view.scrollDOM.getBoundingClientRect().top;
  // lineBlockAtHeight считает от начала документа, а documentTop — это
  // положение начала документа на экране.
  const block = view.lineBlockAtHeight(top - view.documentTop);
  return view.state.doc.lineAt(block.from).number;
}

/** Прокручивает редактор так, чтобы строка `line` оказалась вверху. */
export function scrollToLine(view: EditorView, line: number): void {
  const { doc } = view.state;
  const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
  view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: "start" }) });
}
