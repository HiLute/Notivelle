import type { EditorState } from "@codemirror/state";
import bookOpen from "lucide-static/icons/book-open.svg?raw";
import codeXml from "lucide-static/icons/code-xml.svg?raw";
import penLine from "lucide-static/icons/pen-line.svg?raw";
import settingsIcon from "lucide-static/icons/settings.svg?raw";

import type { FormatInfo } from "./ipc";
import { MODE_LABELS, type ViewMode } from "./modes";

type MessageKind = "info" | "error";

/** Сколько висит информационное сообщение. Ошибки висят до следующего действия. */
const INFO_TIMEOUT_MS = 4000;

const MODE_ICONS: Record<ViewMode, string> = {
  reading: bookOpen,
  live: penLine,
  source: codeXml,
};

const MODE_HINTS: Record<ViewMode, string> = {
  reading: "Чтение (Ctrl+E)",
  live: "Live Preview (Ctrl+Shift+E)",
  source: "Исходник (Ctrl+Shift+E)",
};

/**
 * Строка состояния: файл, сообщения, формат файла, переключатель режимов и
 * позиция курсора.
 */
export class StatusBar {
  /** Пользователь выбрал режим в переключателе. */
  onModeChange: (mode: ViewMode) => void = () => {};
  /** Нажата кнопка настроек. */
  onOpenSettings: () => void = () => {};

  readonly #file: HTMLElement;
  readonly #message: HTMLElement;
  readonly #format: HTMLElement;
  readonly #cursor: HTMLElement;
  readonly #modeButtons = new Map<ViewMode, HTMLButtonElement>();
  #messageTimer: number | undefined;

  constructor(root: HTMLElement) {
    this.#file = part(root, "file");
    this.#message = part(root, "message");
    this.#format = part(root, "format");
    this.#cursor = part(root, "cursor");
    this.#buildModeSwitch(part(root, "mode"));

    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "statusbar-button";
    settings.title = "Настройки (Ctrl+,)";
    settings.setAttribute("aria-label", "Настройки");
    settings.innerHTML = settingsIcon;
    settings.addEventListener("mousedown", (event) => event.preventDefault());
    settings.addEventListener("click", () => this.onOpenSettings());
    root.append(settings);
  }

  setFile(text: string, fullPath = ""): void {
    this.#file.textContent = text;
    this.#file.title = fullPath;
  }

  /** null — формат неизвестен (строка формата пустая). */
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

  /** Отмечает текущий режим; в режиме чтения позиции курсора нет. */
  setMode(mode: ViewMode): void {
    for (const [candidate, button] of this.#modeButtons) {
      button.setAttribute("aria-pressed", String(candidate === mode));
    }
    this.#cursor.hidden = mode === "reading";
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

  /** Три кнопки-иконки, как сегменты одного переключателя. */
  #buildModeSwitch(container: HTMLElement): void {
    container.classList.add("mode-switch");
    container.setAttribute("role", "group");
    container.setAttribute("aria-label", "Режим просмотра");
    // Клик по кнопке не должен забирать фокус у редактора.
    container.addEventListener("mousedown", (event) => event.preventDefault());

    for (const mode of ["reading", "live", "source"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mode-button";
      button.dataset.mode = mode;
      button.innerHTML = MODE_ICONS[mode];
      button.title = MODE_HINTS[mode];
      button.setAttribute("aria-label", MODE_LABELS[mode]);
      button.addEventListener("click", () => this.onModeChange(mode));
      this.#modeButtons.set(mode, button);
      container.append(button);
    }
  }
}

function part(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-part="${name}"]`);
  if (!element) throw new Error(`В строке состояния нет элемента data-part="${name}"`);
  return element;
}
