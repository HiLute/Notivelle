import "./styles.css";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { editorExtensions } from "./editor/setup";
import { api, errorMessage, type OpenedDocument, type StartupDocument } from "./ipc";
import { DocumentSession } from "./session";
import { StatusBar } from "./statusbar";
import welcomeDoc from "./welcome.md?raw";

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
        // `session` объявлена ниже, но слушатель срабатывает только на
        // правки, а они возможны лишь после того, как всё создано.
        if (update.docChanged) session.handleDocChanged();
        if (update.docChanged || update.selectionSet) statusBar.setCursor(update.state);
      }),
    ],
  });
}

const view = new EditorView({ parent: requireElement("editor"), state: createState(welcomeDoc) });
const session = new DocumentSession(view, createState, statusBar);
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

// Горячие клавиши приложения. Слушаем на фазе погружения (capture), чтобы
// получить их раньше редактора.
window.addEventListener(
  "keydown",
  (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod || event.altKey || event.shiftKey) return;
    switch (shortcutLetter(event)) {
      case "o":
        event.preventDefault();
        void session.openWithDialog();
        break;
      case "s":
        event.preventDefault();
        void session.save();
        break;
    }
  },
  { capture: true },
);

// Закрытие окна с несохранёнными изменениями. Если обработчик не вызвал
// preventDefault, Tauri закрывает окно сам.
void getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await session.confirmClose())) event.preventDefault();
});

void openStartupDocuments();
void showAppInfo();

/** Файлы из командной строки: `md-editor note.md`. */
async function openStartupDocuments(): Promise<void> {
  let results: StartupDocument[];
  try {
    results = await api.takeStartupDocuments();
  } catch (error) {
    statusBar.showMessage(errorMessage(error), "error");
    return;
  }

  const opened = results.flatMap((r) => (r.status === "opened" ? [r.document] : []));
  const failures = results.flatMap((r) => (r.status === "failed" ? [r.message] : []));

  const [first, ...rest] = opened;
  if (first) session.show(first);
  // Вкладок пока нет (они появятся в M2), поэтому показываем только первый
  // файл, а остальные сразу закрываем, чтобы Rust их не держал.
  rest.forEach((document: OpenedDocument) => void api.closeDocument(document.id));

  if (failures.length > 0) {
    statusBar.showMessage(failures.join(" · "), "error");
  } else if (rest.length > 0) {
    statusBar.showMessage(`Открыт только первый файл: вкладки появятся позже (ещё ${rest.length})`);
  }
}

/** Версия в строке состояния, пока не открыт ни один файл. */
async function showAppInfo(): Promise<void> {
  try {
    const info = await api.appInfo();
    if (!session.isDirty && view.state.doc.toString() === welcomeDoc) {
      statusBar.setFile(`${info.name} ${info.version} · Tauri ${info.tauriVersion} · ${info.os}`);
    }
  } catch (error) {
    statusBar.showMessage(`Нет связи с Rust-частью: ${errorMessage(error)}`, "error");
  }
}
