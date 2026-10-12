import { runScopeHandlers, type EditorView } from "@codemirror/view";

/**
 * Сочетания клавиш редактора в нелатинских раскладках.
 *
 * CodeMirror ищет сочетание по символу из `event.key`. В русской раскладке
 * Ctrl+Z даёт «я», и сочетание не находится. У CodeMirror есть запасной путь
 * через устаревший `keyCode`, но WebKitGTK для кириллицы отдаёт в нём не
 * латинскую клавишу, и запасной путь не срабатывает.
 *
 * Поэтому, если редактор в фокусе, нажат Ctrl (Cmd) и раскладка дала не
 * латинский символ, повторяем нажатие для сочетаний CodeMirror так, как его
 * дала бы английская раскладка: буква берётся из физической клавиши
 * (`event.code`: `KeyZ` → «z»). Так работают все сочетания редактора: отмена,
 * повтор, поиск, «выделить всё» и остальные.
 *
 * Возвращает true, если сочетание нашлось и выполнено.
 */
export function runEditorKeymapInLatin(view: EditorView, event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
  // Латинский символ CodeMirror обработает сам; клавиши вроде Enter — тоже.
  if (event.key.length !== 1 || /^[\x20-\x7e]$/.test(event.key)) return false;
  // Только когда фокус в тексте: у поля поиска свои сочетания.
  if (!view.hasFocus) return false;

  const letter = /^Key([A-Z])$/.exec(event.code)?.[1];
  if (!letter) return false;

  const latin = new KeyboardEvent("keydown", {
    // Как в английской раскладке: с Shift буква заглавная.
    key: event.shiftKey ? letter : letter.toLowerCase(),
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
  });
  return runScopeHandlers(view, latin, "editor");
}
