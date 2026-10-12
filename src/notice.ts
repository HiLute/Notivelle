/** Кнопка в плашке. */
export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

/**
 * Плашка над редактором: «файл изменён на диске» и подобное. Сообщение и
 * кнопки действий; крестик прячет плашку.
 */
export class NoticeBar {
  readonly #root: HTMLElement;
  /** Пользователь закрыл плашку крестиком. */
  onDismiss: () => void = () => {};

  constructor(root: HTMLElement) {
    this.#root = root;
    root.classList.add("notice");
    root.setAttribute("role", "alert");
    // Клик по кнопке не забирает фокус у редактора.
    root.addEventListener("mousedown", (event) => event.preventDefault());
    root.hidden = true;
  }

  show(message: string, actions: readonly NoticeAction[]): void {
    const text = document.createElement("span");
    text.className = "notice-text";
    text.textContent = message;
    const buttons = actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "notice-button";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      return button;
    });
    const close = document.createElement("button");
    close.type = "button";
    close.className = "notice-close";
    close.title = "Скрыть";
    close.setAttribute("aria-label", "Скрыть");
    close.addEventListener("click", () => this.onDismiss());
    this.#root.replaceChildren(text, ...buttons, close);
    this.#root.hidden = false;
  }

  hide(): void {
    this.#root.hidden = true;
    this.#root.replaceChildren();
  }
}
