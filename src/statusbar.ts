import type { EditorState } from "@codemirror/state";

import type { FormatInfo } from "./ipc";

type MessageKind = "info" | "error";

/** Сколько висит информационное сообщение. Ошибки висят до следующего действия. */
const INFO_TIMEOUT_MS = 4000;

/** Строка состояния: файл, сообщения, формат файла и позиция курсора. */
export class StatusBar {
  readonly #file: HTMLElement;
  readonly #message: HTMLElement;
  readonly #format: HTMLElement;
  readonly #cursor: HTMLElement;
  #messageTimer: number | undefined;

  constructor(root: HTMLElement) {
    this.#file = part(root, "file");
    this.#message = part(root, "message");
    this.#format = part(root, "format");
    this.#cursor = part(root, "cursor");
  }

  setFile(text: string, fullPath = ""): void {
    this.#file.textContent = text;
    this.#file.title = fullPath;
  }

  /** null — открыт не файл, а приветственная страница. */
  setFormat(format: FormatInfo | null): void {
    if (!format) {
      this.#format.textContent = "";
      this.#format.title = "";
      return;
    }
    const encoding = format.hasBom ? "UTF-8 BOM" : "UTF-8";
    const mixed = format.mixedLineEndings ? " (смешанные)" : "";
    this.#format.textContent = `${format.lineEnding}${mixed} · ${encoding}`;
    this.#format.title = format.mixedLineEndings
      ? `В файле переводы строк разных видов. При сохранении все станут ${format.lineEnding}.`
      : "";
  }

  setCursor(state: EditorState): void {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    this.#cursor.textContent = `Стр. ${line.number}, стлб ${head - line.from + 1}`;
  }

  showMessage(text: string, kind: MessageKind = "info"): void {
    window.clearTimeout(this.#messageTimer);
    this.#message.textContent = text;
    this.#message.dataset.kind = kind;
    if (kind === "info") {
      this.#messageTimer = window.setTimeout(() => this.clearMessage(), INFO_TIMEOUT_MS);
    }
  }

  clearMessage(): void {
    window.clearTimeout(this.#messageTimer);
    this.#message.textContent = "";
    delete this.#message.dataset.kind;
  }
}

function part(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (!element) throw new Error(`В строке состояния нет элемента data-part="${name}"`);
  return element;
}
