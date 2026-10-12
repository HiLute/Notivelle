import type { EditorView } from "@codemirror/view";

/**
 * Начало строки задачи вплоть до символа внутри скобок: `- [`, `* [`,
 * `1. [`, в том числе внутри цитат и callouts: `> - [`.
 */
const TASK_PREFIX = /^((?:[ \t]*>)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[)[ xX]\]/;

/**
 * Отмечает задачу на строке `lineNumber` (нумерация с 1) или снимает отметку.
 * Меняется ровно один символ внутри скобок, поэтому отметку можно отменить
 * через Ctrl+Z, как обычную правку.
 *
 * Возвращает новое состояние (true — отмечена) или null, если на этой строке
 * нет задачи.
 */
export function toggleTaskOnLine(view: EditorView, lineNumber: number): boolean | null {
  const { doc } = view.state;
  if (lineNumber < 1 || lineNumber > doc.lines) return null;
  const line = doc.line(lineNumber);
  const prefix = TASK_PREFIX.exec(line.text)?.[1];
  if (prefix === undefined) return null;

  const at = line.from + prefix.length;
  const checked = doc.sliceString(at, at + 1) === " ";
  view.dispatch({
    changes: { from: at, to: at + 1, insert: checked ? "x" : " " },
    userEvent: "input.task",
  });
  return checked;
}
