import "./styles.css";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { documentIdFacet, type LinkHandlers, linkHandlersFacet } from "./editor/context";
import { runEditorKeymapInLatin } from "./editor/layout-keys";
import { editorExtensions } from "./editor/setup";
import { setSpellcheckErrorHandler } from "./editor/spellcheck";
import { type DocumentId, FILES_PENDING_EVENT, api, errorMessage } from "./ipc";
import { ReadingView } from "./reading/view";
import { StatusBar } from "./statusbar";
import { TabBar } from "./tabbar";
import welcomeDoc from "./welcome.md?raw";
import { Workspace } from "./workspace";

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`В index.html нет элемента #${id}`);
  return element;
}

const statusBar = new StatusBar(requireElement("statusbar"));

/** Ссылки из режима чтения и Live Preview открываются одинаково. */
const links: LinkHandlers = {
  // `workspace` объявлена ниже; ссылки открываются только после запуска.
  openExternal: (url) => void workspace.openExternal(url),
  openLocal: (href) => void workspace.openLink(href),
};

/**
 * Состояние редактора для нового документа: свежая история отмены.
 * `id` — документ, к которому относятся картинки и блоки Live Preview.
 */
function createState(text: string, id: DocumentId | null): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      editorExtensions(),
      documentIdFacet.of(id),
      linkHandlersFacet.of(links),
      EditorView.updateListener.of((update) => {
        // `workspace` объявлена ниже, но слушатель срабатывает только на
        // правки, а они возможны лишь после того, как всё создано.
        if (update.docChanged) workspace.handleDocChanged();
        if (update.docChanged || update.selectionSet) statusBar.setCursor(update.state);
      }),
    ],
  });
}

const editorHost = requireElement("editor");
const view = new EditorView({ parent: editorHost, state: createState(welcomeDoc, null) });
// `workspace` объявлена ниже; чекбоксы нажимают только после запуска.
const reading = new ReadingView(requireElement("reading"), links, (line) => workspace.toggleTask(line));
const workspace = new Workspace({
  view,
  editorHost,
  createState,
  reading,
  statusBar,
  tabBar: new TabBar(requireElement("tabbar")),
});
statusBar.onModeChange = (mode) => workspace.setMode(mode);
setSpellcheckErrorHandler((message) => statusBar.showMessage(message, "error"));
statusBar.setCursor(view.state);
view.focus();

/**
 * Буква, по которой сравниваются сочетания вроде Ctrl+S.
 *
 * Если раскладка даёт латинскую букву, берём её: в Dvorak «s» стоит на
 * другой физической клавише, и Ctrl+S должен срабатывать именно там. Если
 * раскладка не латинская (в русской вместо «s» будет «ы»), берём физическую
 * клавишу: `code` описывает положение на клавиатуре US, `KeyS` → «s».
 */
function shortcutLetter(event: KeyboardEvent): string {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return event.key.toLowerCase();
}

/** Действие для сочетания клавиш или null, если это не наше сочетание. */
function shortcutAction(event: KeyboardEvent): (() => void) | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;

  switch (event.key) {
    case "Tab":
      return () => workspace.activateNext(event.shiftKey ? -1 : 1);
    case "PageDown":
      return event.shiftKey ? null : () => workspace.activateNext(1);
    case "PageUp":
      return event.shiftKey ? null : () => workspace.activateNext(-1);
  }
  if (event.shiftKey) {
    return shortcutLetter(event) === "e" ? () => workspace.toggleEditingMode() : null;
  }

  switch (shortcutLetter(event)) {
    case "o":
      return () => void workspace.openWithDialog();
    case "s":
      return () => void workspace.save();
    case "w":
      return () => void workspace.closeActive();
    case "e":
      return () => workspace.toggleReading();
    default:
      return null;
  }
}

/**
 * Редактор с фокусом: основной или редактор ячейки таблицы внутри него
 * (см. live-preview/table).
 */
function focusedEditor(): EditorView {
  const root = document.activeElement?.closest<HTMLElement>(".cm-editor");
  return (root && EditorView.findFromDOM(root)) ?? view;
}

// Горячие клавиши приложения перехватываем на фазе погружения (capture),
// раньше редактора, и дальше не пускаем: иначе, например, Ctrl+Tab ещё и
// вставил бы табуляцию. Там же чиним сочетания редактора в нелатинской
// раскладке (Ctrl+Z при русской раскладке и т. п.).
window.addEventListener(
  "keydown",
  (event) => {
    const action = shortcutAction(event);
    if (action) action();
    else if (!runEditorKeymapInLatin(focusedEditor(), event)) return;
    event.preventDefault();
    event.stopPropagation();
  },
  { capture: true },
);

// Закрытие окна с несохранёнными изменениями. Если обработчик не вызвал
// preventDefault, Tauri закрывает окно сам.
void getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await workspace.confirmClose())) event.preventDefault();
});

// Подсветка окна, пока над ним держат перетаскиваемые файлы. Сами файлы
// открывает Rust (lib.rs), а фронтенд получает их через очередь.
const dropOverlay = requireElement("drop-overlay");
void getCurrentWebview().onDragDropEvent((event) => {
  const { type } = event.payload;
  dropOverlay.hidden = !(type === "enter" || type === "over");
});

void init();

async function init(): Promise<void> {
  // Если страница перезагрузилась (при разработке Vite делает это после
  // правок кода), Rust ещё помнит открытые файлы: возвращаем их вкладки.
  try {
    workspace.accept(await api.restoreDocuments());
  } catch (error) {
    statusBar.showMessage(errorMessage(error), "error");
  }

  // Сначала подписываемся на событие, потом забираем очередь: так не
  // потеряются файлы, пришедшие между этими двумя шагами.
  await listen(FILES_PENDING_EVENT, () => void workspace.openPending());
  await workspace.openPending();

  try {
    const info = await api.appInfo();
    workspace.welcomeLabel = `${info.name} ${info.version} · Tauri ${info.tauriVersion} · ${info.os}`;
  } catch (error) {
    statusBar.showMessage(`Нет связи с Rust-частью: ${errorMessage(error)}`, "error");
  }
}
