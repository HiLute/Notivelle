import type { DocumentId } from "./ipc";

/** Данные для отрисовки одной вкладки. */
export interface TabView {
  id: DocumentId;
  label: string;
  /** Полный путь — во всплывающей подсказке. */
  path: string;
  dirty: boolean;
  active: boolean;
}

/**
 * Полоса вкладок, как в Kate: клик — переключиться, крестик или средняя
 * кнопка мыши — закрыть, колесо — прокрутить полосу. Вкладками она не
 * управляет: рисует то, что ей передали, и сообщает о действиях через колбэки.
 */
export class TabBar {
  onActivate: (id: DocumentId) => void = () => {};
  onClose: (id: DocumentId) => void = () => {};
  readonly #root: HTMLElement;

  constructor(root: HTMLElement) {
    this.#root = root;

    // Один обработчик на всю полосу (делегирование событий): вкладки
    // перерисовываются, а обработчики остаются прежними.
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const id = tabIdAt(target);
      if (id === null) return;
      if (target.closest(".tab-close")) this.onClose(id);
      else this.onActivate(id);
    });
    root.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const id = tabIdAt(event.target as HTMLElement);
      if (id !== null) this.onClose(id);
    });
    // Клик по вкладке не должен забирать фокус у редактора, а средняя
    // кнопка — включать автопрокрутку.
    root.addEventListener("mousedown", (event) => event.preventDefault());
    root.addEventListener(
      "wheel",
      (event) => {
        if (event.deltaY === 0) return;
        root.scrollLeft += event.deltaY;
        event.preventDefault();
      },
      { passive: false },
    );
  }

  render(tabs: readonly TabView[]): void {
    this.#root.hidden = tabs.length === 0;
    this.#root.replaceChildren(...tabs.map(renderTab));
    this.#root
      .querySelector(".tab[aria-selected='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function renderTab(tab: TabView): HTMLElement {
  const element = document.createElement("div");
  element.className = "tab";
  element.setAttribute("role", "tab");
  element.setAttribute("aria-selected", String(tab.active));
  element.dataset.id = String(tab.id);
  element.title = tab.path;
  if (tab.dirty) element.dataset.dirty = "";

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.label;

  // Кнопка показывает «●», пока есть несохранённые изменения, и «×» при
  // наведении (см. styles.css), как в VS Code.
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tab-close";
  close.tabIndex = -1;
  close.title = "Закрыть (Ctrl+W)";
  close.setAttribute("aria-label", `Закрыть ${tab.label}`);

  element.append(label, close);
  return element;
}

function tabIdAt(target: HTMLElement): DocumentId | null {
  const id = target.closest<HTMLElement>(".tab")?.dataset.id;
  return id === undefined ? null : (Number(id) as DocumentId);
}
