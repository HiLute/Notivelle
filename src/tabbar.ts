import plusIcon from "lucide-static/icons/plus.svg?raw";

/** Данные для отрисовки одной вкладки. */
export interface TabView {
  /**
   * Ключ вкладки. Не DocumentId: у нового, ещё не сохранённого документа
   * его нет.
   */
  key: number;
  label: string;
  /** Подсказка при наведении: полный путь или пояснение. */
  title: string;
  dirty: boolean;
  active: boolean;
}

/**
 * Полоса вкладок, как в Kate: клик — переключиться, крестик или средняя
 * кнопка мыши — закрыть, колесо — прокрутить полосу, «+» — новый документ.
 * Вкладками она не управляет: рисует то, что ей передали, и сообщает о
 * действиях через колбэки.
 */
export class TabBar {
  onActivate: (key: number) => void = () => {};
  onClose: (key: number) => void = () => {};
  onNew: () => void = () => {};
  readonly #root: HTMLElement;
  readonly #newButton: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#newButton = document.createElement("button");
    this.#newButton.type = "button";
    this.#newButton.className = "tab-new";
    this.#newButton.title = "Новый документ (Ctrl+N)";
    this.#newButton.setAttribute("aria-label", "Новый документ");
    // SVG из пакета lucide-static: innerHTML безопасен.
    this.#newButton.innerHTML = plusIcon;

    // Один обработчик на всю полосу (делегирование событий): вкладки
    // перерисовываются, а обработчики остаются прежними.
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest(".tab-new")) {
        this.onNew();
        return;
      }
      const key = tabKeyAt(target);
      if (key === null) return;
      if (target.closest(".tab-close")) this.onClose(key);
      else this.onActivate(key);
    });
    root.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const key = tabKeyAt(event.target as HTMLElement);
      if (key !== null) this.onClose(key);
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
    this.#root.replaceChildren(...tabs.map(renderTab), this.#newButton);
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
  element.dataset.key = String(tab.key);
  element.title = tab.title;
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

function tabKeyAt(target: HTMLElement): number | null {
  const key = target.closest<HTMLElement>(".tab")?.dataset.key;
  return key === undefined ? null : Number(key);
}
