import "./styles.css";

import { invoke } from "@tauri-apps/api/core";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { editorExtensions } from "./editor/setup";
import welcomeDoc from "./welcome.md?raw";

/** Ответ команды `app_info` (src-tauri/src/commands.rs). */
interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`В index.html нет элемента #${id}`);
  return element;
}

const editorHost = requireElement("editor");
const statusApp = requireElement("status-app");
const statusCursor = requireElement("status-cursor");

function showCursor(state: EditorState): void {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  statusCursor.textContent = `Стр. ${line.number}, стлб ${head - line.from + 1}`;
}

const view = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: welcomeDoc,
    extensions: [
      editorExtensions(),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) showCursor(update.state);
      }),
    ],
  }),
});
showCursor(view.state);
view.focus();

// Проверка связи с Rust: если команда ответила, IPC и CSP настроены правильно.
invoke<AppInfo>("app_info")
  .then((info) => {
    statusApp.textContent = `${info.name} ${info.version} · Tauri ${info.tauriVersion} · ${info.os}`;
  })
  .catch((error: unknown) => {
    statusApp.textContent = "Нет связи с Rust-частью";
    console.error("app_info:", error);
  });
