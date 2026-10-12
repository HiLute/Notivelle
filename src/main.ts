import "./styles.css";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { editorExtensions } from "./editor/setup";
import { FILES_PENDING_EVENT, api, errorMessage } from "./ipc";
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

/** Состояние редактора для нового документа: свежая история отмены. */
function createState(text: string): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      editorExtensions(),
      EditorView.updateListener.of((update) => {
        // `workspace` объявлена ниже, но слушатель срабатывает только на
        // правки, а они возможны лишь после того, как всё создано.
        if (update.docChanged) workspace.handleDocChanged();
        if (update.docChanged || update.selectionSet) statusBar.setCursor(update.state);
      }),
    ],
  });
}

const view = new EditorView({ parent: requireElement("editor"), state: createState(welcomeDoc) });
const workspace = new Workspace(view, createState, statusBar, new TabBar(requireElement("tabbar")));
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
  if (event.shiftKey) return null;

  switch (shortcutLetter(event)) {
    case "o":
      return () => void workspace.openWithDialog();
    case "s":
      return () => void workspace.save();
    case "w":
      return () => void workspace.closeActive();
    default:
      return null;
  }
}

// Горячие клавиши приложения перехватываем на фазе погружения (capture),
// раньше редактора, и дальше не пускаем: иначе, например, Ctrl+Tab ещё и
// вставил бы табуляцию.
window.addEventListener(
  "keydown",
  (event) => {
    const action = shortcutAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
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
