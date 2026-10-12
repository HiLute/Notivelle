import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Надёжный перенос выделенного текста перетаскиванием.
 *
 * CodeMirror умеет переносить текст сам, но в WebKitGTK (Linux) это
 * срабатывает не всегда. Выделение мышью в CodeMirror завершается, как только
 * приходит событие мыши без нажатых кнопок, и при этом забывает, какой
 * фрагмент перетаскивается. Браузеры во время перетаскивания таких событий не
 * присылают, а WebKitGTK иногда присылает. Тогда к моменту отпускания
 * CodeMirror считает текст пришедшим извне и вставляет копию, оставляя
 * исходный фрагмент на месте. Это видно по логу событий: в неудачной попытке
 * на момент `drop` фрагмент уже был забыт.
 *
 * Поэтому фрагмент запоминаем сами и, если на момент отпускания документ не
 * менялся и бросают тот же текст, переносим его сами. Во всех остальных
 * случаях (копирование с Ctrl, текст из другой программы, файлы) работает
 * стандартная логика CodeMirror.
 */
interface ActiveDrag {
  view: EditorView;
  /** Документ на начало перетаскивания. Text неизменяемый: если документ
   *  менялся, это будет уже другой объект, и границы фрагмента устарели. */
  doc: Text;
  from: number;
  to: number;
}

let activeDrag: ActiveDrag | null = null;

// На macOS копию при перетаскивании делает Option, на остальных системах Ctrl
// (так же решает сам CodeMirror).
const isMac = /Mac/.test(navigator.platform);

export const reliableDragMove = EditorView.domEventHandlers({
  dragstart(event, view) {
    const range = view.state.selection.main;
    // Перетаскивание виджета (например, картинки в Live Preview) оставляем
    // CodeMirror: у него свои правила, какой фрагмент тащить.
    const fromWidget = event.target instanceof HTMLElement && event.target.draggable;
    activeDrag =
      range.empty || fromWidget
        ? null
        : { view, doc: view.state.doc, from: range.from, to: range.to };
    // false: CodeMirror всё равно должен заполнить dataTransfer.
    return false;
  },

  dragend() {
    activeDrag = null;
    return false;
  },

  drop(event, view) {
    const drag = activeDrag;
    activeDrag = null;
    if (!drag || drag.view !== view || drag.doc !== view.state.doc) return false;

    const copy = isMac ? event.altKey : event.ctrlKey;
    const data = event.dataTransfer;
    if (copy || !data || data.files.length > 0) return false;

    const text = data.getData("Text");
    if (text !== view.state.sliceDoc(drag.from, drag.to)) return false;

    // Дальше — то же, что делает CodeMirror при удачном переносе: удаление
    // исходного фрагмента и вставка в точку отпускания одной транзакцией,
    // чтобы Ctrl+Z отменял перенос целиком.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const changes = view.state.changes([
      { from: drag.from, to: drag.to },
      { from: pos, insert: text },
    ]);
    view.focus();
    view.dispatch({
      changes,
      selection: { anchor: changes.mapPos(pos, -1), head: changes.mapPos(pos, 1) },
      userEvent: "move.drop",
    });
    // true: CodeMirror вызовет preventDefault и не станет вставлять текст сам.
    return true;
  },
});
