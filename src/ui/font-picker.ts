import "./font-picker.css";

import checkIcon from "lucide-static/icons/check.svg?raw";
import chevronIcon from "lucide-static/icons/chevrons-up-down.svg?raw";
import resetIcon from "lucide-static/icons/rotate-ccw.svg?raw";
import searchIcon from "lucide-static/icons/search.svg?raw";
import warningIcon from "lucide-static/icons/triangle-alert.svg?raw";

import { fontFamilyCss, isGenericFamily } from "../appearance";
import type { FontFamily } from "../ipc";

/** Для чего шрифт: от этого зависят порядок вариантов и шрифт по умолчанию. */
export type FontRole = "interface" | "text" | "monospace";

/** Шрифт по умолчанию для каждой роли — переменные из styles.css. */
const DEFAULT_FONT: Record<FontRole, string> = {
  interface: "var(--font-ui-default)",
  text: "var(--font-text-default)",
  monospace: "var(--font-mono-default)",
};

/**
 * Шрифты, которые настроены в системе (на Linux — в fontconfig). Значение —
 * общее семейство CSS: WebView сам узнаёт у системы, какой это шрифт.
 */
const SYSTEM_FONTS: Record<string, string> = {
  "system-ui": "Шрифт интерфейса системы",
  "sans-serif": "Системный без засечек",
  serif: "Системный с засечками",
  monospace: "Системный моноширинный",
};

const SYSTEM_ORDER: Record<FontRole, readonly string[]> = {
  interface: ["system-ui", "sans-serif", "serif"],
  text: ["sans-serif", "serif", "system-ui"],
  monospace: ["monospace"],
};

/** Вариант в списке. */
interface Option {
  /** Что попадёт в настройки: имя шрифта, общее семейство или "" — по умолчанию. */
  readonly value: string;
  /** Строка для поиска: подпись и значение в нижнем регистре. */
  readonly search: string;
  readonly element: HTMLElement;
  /** Заголовок группы, в которой стоит вариант. */
  readonly section: HTMLElement | null;
}

let nextId = 0;

/**
 * Выбор шрифта, как в настройках Obsidian: кнопка с названием шрифта и
 * всплывающий список с поиском. В списке — шрифт по умолчанию, шрифты,
 * настроенные в системе, и все установленные; каждый показан своим
 * начертанием. Если нужного шрифта в списке нет, его имя можно ввести
 * в поиск и выбрать как есть.
 *
 * Стрелки ходят по списку, Enter выбирает, Escape закрывает.
 */
export class FontPicker {
  /** Кнопка сброса и кнопка выбора — вставляется в строку настроек. */
  readonly element: HTMLElement;
  onChange: (value: string) => void = () => {};

  readonly #role: FontRole;
  readonly #label: string;
  readonly #button: HTMLButtonElement;
  readonly #name: HTMLElement;
  readonly #warning: HTMLElement;
  readonly #reset: HTMLButtonElement;
  #value = "";
  /** Установленные шрифты; null — список ещё загружается. */
  #installed: readonly FontFamily[] | null = null;
  #popup: Popup | null = null;

  constructor(role: FontRole, label: string) {
    this.#role = role;
    this.#label = label;
    this.element = element("div", "font-picker");

    this.#reset = element("button", "font-picker-reset");
    this.#reset.type = "button";
    this.#reset.title = "Вернуть шрифт по умолчанию";
    this.#reset.setAttribute("aria-label", this.#reset.title);
    this.#reset.innerHTML = resetIcon;
    this.#reset.addEventListener("click", () => {
      // Кнопка сброса сейчас скроется: фокус — на кнопку выбора, а не в никуда.
      this.#button.focus();
      this.#choose("");
    });

    this.#button = element("button", "font-picker-button");
    this.#button.type = "button";
    this.#button.setAttribute("aria-haspopup", "listbox");
    this.#button.setAttribute("aria-expanded", "false");
    this.#warning = element("span", "font-picker-warning");
    this.#warning.innerHTML = warningIcon;
    this.#name = element("span", "font-picker-name");
    const chevron = element("span", "font-picker-chevron");
    chevron.innerHTML = chevronIcon;
    this.#button.append(this.#warning, this.#name, chevron);
    this.#button.addEventListener("click", () => {
      if (this.#popup) this.close();
      else this.#open();
    });

    this.element.append(this.#reset, this.#button);
    this.#refreshButton();
  }

  get value(): string {
    return this.#value;
  }

  set value(value: string) {
    if (value === this.#value) return;
    this.#value = value;
    this.#refreshButton();
    this.#popup?.markSelected(value);
  }

  /** Установленные шрифты; null — список ещё не пришёл из Rust. */
  get installed(): readonly FontFamily[] | null {
    return this.#installed;
  }

  set installed(fonts: readonly FontFamily[] | null) {
    this.#installed = fonts;
    this.#refreshButton();
    this.#popup?.fill(this.#options());
  }

  get isOpen(): boolean {
    return this.#popup !== null;
  }

  close(): void {
    if (!this.#popup) return;
    this.#popup.destroy();
    this.#popup = null;
    this.#button.setAttribute("aria-expanded", "false");
  }

  #open(): void {
    // Список живёт внутри окна настроек: модальный <dialog> лежит поверх
    // всего, и элемент снаружи него оказался бы под затемнением.
    const host = this.element.closest("dialog") ?? document.body;
    this.#popup = new Popup(host, this.#button, this.#label, {
      choose: (value) => this.#choose(value),
      close: () => {
        this.close();
        this.#button.focus();
      },
      preview: (value) => this.#css(value),
    });
    this.#button.setAttribute("aria-expanded", "true");
    this.#popup.fill(this.#options());
    this.#popup.markSelected(this.#value);
  }

  #choose(value: string): void {
    const changed = value !== this.#value;
    this.value = value;
    if (this.#popup) {
      this.close();
      this.#button.focus();
    }
    if (changed) this.onChange(value);
  }

  /** `font-family` для показа шрифта: выбранный, а за ним — шрифт по умолчанию. */
  #css(value: string): string {
    const chosen = fontFamilyCss(value);
    return chosen === "" ? DEFAULT_FONT[this.#role] : `${chosen}, ${DEFAULT_FONT[this.#role]}`;
  }

  #refreshButton(): void {
    const missing = this.#missingFonts();
    this.#name.textContent = this.#value === "" ? "По умолчанию" : (SYSTEM_FONTS[this.#value] ?? this.#value);
    this.#name.style.fontFamily = this.#css(this.#value);
    this.#reset.hidden = this.#value === "";
    this.#warning.hidden = missing.length === 0;
    this.#button.classList.toggle("is-missing", missing.length > 0);
    this.#button.title =
      missing.length > 0
        ? `Нет в системе: ${missing.join(", ")}. Вместо него — шрифт по умолчанию`
        : `${this.#label}: выбрать из шрифтов системы`;
  }

  /** Шрифты из настройки, которых нет среди установленных. */
  #missingFonts(): string[] {
    if (this.#installed === null) return [];
    const installed = new Set(this.#installed.map((font) => font.name.toLowerCase()));
    return this.#value
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "" && !isGenericFamily(name) && !installed.has(name.toLowerCase()));
  }

  /** Варианты по группам: [заголовок группы или null, варианты]. */
  #options(): OptionGroup[] {
    const groups: OptionGroup[] = [
      { title: null, items: [{ value: "", label: "По умолчанию", hint: null }] },
      {
        title: "Настроены в системе",
        items: SYSTEM_ORDER[this.#role].map((value) => ({ value, label: SYSTEM_FONTS[value] ?? value, hint: value })),
      },
    ];
    if (this.#installed === null) {
      groups.push({ title: "Установленные", items: [], placeholder: "Загрузка списка шрифтов…" });
      return groups;
    }
    const item = (font: FontFamily): OptionData => ({
      value: font.name,
      label: font.name,
      hint: null,
      symbols: font.symbols,
    });
    if (this.#role === "monospace") {
      // Для кода — сначала моноширинные, остальные ниже.
      groups.push(
        { title: "Моноширинные", items: this.#installed.filter((font) => font.monospace).map(item) },
        { title: "Остальные", items: this.#installed.filter((font) => !font.monospace).map(item) },
      );
    } else {
      groups.push({ title: "Установленные", items: this.#installed.map(item) });
    }
    return groups;
  }
}

interface OptionData {
  readonly value: string;
  readonly label: string;
  /** Пояснение мелко справа (для системных — имя семейства CSS). */
  readonly hint: string | null;
  /** Шрифт из значков: показать его образцом, а не названием. */
  readonly symbols?: boolean;
}

interface OptionGroup {
  readonly title: string | null;
  readonly items: readonly OptionData[];
  /** Текст вместо пустого списка (пока шрифты загружаются). */
  readonly placeholder?: string;
}

interface PopupActions {
  choose(value: string): void;
  /** Закрыть без выбора (Escape, Tab). */
  close(): void;
  /** `font-family` для показа варианта его же шрифтом. */
  preview(value: string): string;
}

/**
 * Всплывающий список с поиском. Создаётся при открытии и удаляется при
 * закрытии — сотни вариантов не держим в DOM, пока список не нужен.
 */
class Popup {
  readonly #root: HTMLElement;
  readonly #search: HTMLInputElement;
  readonly #list: HTMLElement;
  /** Вариант «использовать введённое имя»: шрифта может не быть в списке. */
  readonly #custom: HTMLElement;
  readonly #anchor: HTMLElement;
  readonly #host: HTMLElement;
  readonly #actions: PopupActions;
  #options: Option[] = [];
  #active: Option | null = null;
  #selected = "";
  /** Шрифт варианта подключаем, только когда тот виден: файлы шрифтов грузятся лениво. */
  readonly #previews: IntersectionObserver;
  readonly #cleanup: (() => void)[] = [];

  constructor(host: HTMLElement, anchor: HTMLElement, label: string, actions: PopupActions) {
    this.#host = host;
    this.#anchor = anchor;
    this.#actions = actions;
    const listId = `font-picker-list-${++nextId}`;

    this.#root = element("div", "font-picker-popup");
    const searchRow = element("div", "font-picker-search");
    const icon = element("span", "font-picker-search-icon");
    icon.innerHTML = searchIcon;
    this.#search = element("input", "font-picker-search-input");
    this.#search.type = "text";
    this.#search.placeholder = "Найти шрифт или ввести имя…";
    this.#search.spellcheck = false;
    this.#search.setAttribute("role", "combobox");
    this.#search.setAttribute("aria-label", label);
    this.#search.setAttribute("aria-expanded", "true");
    this.#search.setAttribute("aria-controls", listId);
    this.#search.setAttribute("aria-autocomplete", "list");
    searchRow.append(icon, this.#search);

    this.#list = element("div", "font-picker-list");
    this.#list.id = listId;
    this.#list.setAttribute("role", "listbox");
    this.#list.setAttribute("aria-label", label);

    this.#custom = element("div", "font-picker-option font-picker-custom");
    this.#custom.id = `${listId}-custom`;
    this.#custom.setAttribute("role", "option");
    this.#custom.hidden = true;

    this.#root.append(searchRow, this.#list);
    host.append(this.#root);

    this.#previews = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target as HTMLElement;
          const preview = target.querySelector<HTMLElement>(".font-picker-preview");
          if (preview) preview.style.fontFamily = this.#actions.preview(target.dataset.value ?? "");
          this.#previews.unobserve(target);
        }
      },
      { root: this.#list },
    );

    this.#listen();
    this.#place();
    this.#search.focus();
  }

  /** Перестраивает варианты (при открытии и когда пришёл список шрифтов). */
  fill(groups: readonly OptionGroup[]): void {
    this.#previews.disconnect();
    this.#list.replaceChildren();
    this.#options = [];
    let index = 0;
    for (const group of groups) {
      let section: HTMLElement | null = null;
      if (group.title !== null) {
        section = element("div", "font-picker-section");
        section.textContent = group.title;
        section.setAttribute("role", "presentation");
        this.#list.append(section);
      }
      if (group.items.length === 0 && group.placeholder) {
        const placeholder = element("div", "font-picker-placeholder");
        placeholder.textContent = group.placeholder;
        this.#list.append(placeholder);
      }
      for (const data of group.items) {
        const option = this.#optionElement(data, `${this.#list.id}-${index++}`);
        this.#list.append(option);
        this.#previews.observe(option);
        this.#options.push({
          value: data.value,
          search: `${data.label}\n${data.value}`.toLowerCase(),
          element: option,
          section,
        });
      }
    }
    this.#list.append(this.#custom);
    this.markSelected(this.#selected);
    this.#filter();
  }

  /** Отмечает галочкой выбранный вариант. */
  markSelected(value: string): void {
    this.#selected = value;
    for (const option of this.#options) {
      const selected = option.value === value;
      option.element.classList.toggle("is-selected", selected);
      option.element.setAttribute("aria-selected", String(selected));
    }
  }

  destroy(): void {
    this.#previews.disconnect();
    for (const cleanup of this.#cleanup) cleanup();
    this.#root.remove();
  }

  #optionElement(data: OptionData, id: string): HTMLElement {
    const option = element("div", "font-picker-option");
    option.id = id;
    option.dataset.value = data.value;
    option.setAttribute("role", "option");
    const check = element("span", "font-picker-check");
    check.innerHTML = checkIcon;
    const name = element("span", "font-picker-option-name");
    name.textContent = data.label;
    option.append(check, name);
    if (data.symbols) {
      // Значки вместо букв: название — обычным шрифтом, а справа образец.
      const sample = element("span", "font-picker-option-sample font-picker-preview");
      sample.textContent = "ABC abc 123";
      sample.setAttribute("aria-hidden", "true");
      option.append(sample);
    } else {
      name.classList.add("font-picker-preview");
    }
    if (data.hint !== null) {
      const hint = element("span", "font-picker-option-hint");
      hint.textContent = data.hint;
      option.append(hint);
    }
    return option;
  }

  #listen(): void {
    this.#search.addEventListener("input", () => this.#filter());
    this.#search.addEventListener("keydown", (event) => this.#onKeyDown(event));

    // Клик по списку не уводит фокус из поля поиска.
    this.#root.addEventListener("mousedown", (event) => {
      if (event.target !== this.#search) event.preventDefault();
    });
    this.#list.addEventListener("click", (event) => {
      const option = this.#optionAt(event.target);
      if (option) this.#actions.choose(option.value);
    });
    this.#list.addEventListener("mousemove", (event) => {
      const option = this.#optionAt(event.target);
      if (option && option !== this.#active) this.#setActive(option, null);
    });

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // Клик по кнопке выбора закроет список её же обработчиком.
      if (!this.#root.contains(target) && !this.#anchor.contains(target)) this.#actions.close();
    };
    const onResize = () => this.#actions.close();
    const onScroll = () => this.#place();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    this.#host.addEventListener("scroll", onScroll);
    this.#cleanup.push(
      () => document.removeEventListener("pointerdown", onPointerDown, true),
      () => window.removeEventListener("resize", onResize),
      () => this.#host.removeEventListener("scroll", onScroll),
    );
  }

  #onKeyDown(event: KeyboardEvent): void {
    const visible = this.#visibleOptions();
    const index = this.#active ? visible.indexOf(this.#active) : -1;
    const move = (to: number) => {
      const option = visible[Math.max(0, Math.min(visible.length - 1, to))];
      if (option) this.#setActive(option, "nearest");
    };
    switch (event.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index - 1);
        break;
      case "PageDown":
        move(index + 8);
        break;
      case "PageUp":
        move(index - 8);
        break;
      case "Enter":
        if (this.#active) this.#actions.choose(this.#active.value);
        break;
      // Escape закрывает только список, а не окно настроек целиком.
      case "Escape":
      case "Tab":
        this.#actions.close();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** Показывает варианты, в которых есть введённый текст. */
  #filter(): void {
    const typed = this.#search.value.trim();
    const query = typed.toLowerCase();
    // Вариант с введённым именем собираем заново ниже.
    this.#options = this.#options.filter((option) => option.element !== this.#custom);
    const shownSections = new Set<HTMLElement>();
    let exact = false;
    for (const option of this.#options) {
      const shown = option.search.includes(query);
      option.element.hidden = !shown;
      if (shown && option.section) shownSections.add(option.section);
      if (option.value.toLowerCase() === query) exact = true;
    }
    for (const section of this.#list.querySelectorAll<HTMLElement>(".font-picker-section")) {
      section.hidden = query !== "" && !shownSections.has(section);
    }

    // Введённого имени нет в списке — его можно выбрать как есть: вдруг
    // шрифт установлен, но не нашёлся (или это список через запятую).
    const custom = query !== "" && !exact ? typed : null;
    this.#custom.hidden = custom === null;
    if (custom !== null) {
      this.#custom.dataset.value = custom;
      this.#custom.textContent = `Использовать «${custom}»`;
      this.#options.push({ value: custom, search: query, element: this.#custom, section: null });
    }

    const visible = this.#visibleOptions();
    const selected = query === "" ? visible.find((option) => option.value === this.#selected) : undefined;
    // Без поиска — на выбранном шрифте (он посередине списка), с поиском —
    // на первом найденном.
    if (selected) this.#setActive(selected, "center");
    else this.#setActive(visible[0] ?? null, "top");
  }

  #visibleOptions(): Option[] {
    return this.#options.filter((option) => !option.element.hidden);
  }

  /**
   * Подсвечивает вариант. `scroll`: "nearest" — докрутить список, чтобы
   * вариант стал виден; "center" — поставить его посередине; "top" —
   * прокрутить список в начало.
   */
  #setActive(option: Option | null, scroll: "nearest" | "center" | "top" | null): void {
    this.#active?.element.classList.remove("is-active");
    this.#active = option;
    if (scroll === "top") this.#list.scrollTop = 0;
    if (!option) {
      this.#search.removeAttribute("aria-activedescendant");
      return;
    }
    option.element.classList.add("is-active");
    this.#search.setAttribute("aria-activedescendant", option.element.id);

    // Не scrollIntoView: он прокрутил бы заодно и окно настроек под списком.
    const list = this.#list;
    const top = option.element.offsetTop;
    const bottom = top + option.element.offsetHeight;
    if (scroll === "center") list.scrollTop = top - (list.clientHeight - option.element.offsetHeight) / 2;
    else if (scroll === "nearest" && top < list.scrollTop) list.scrollTop = top;
    else if (scroll === "nearest" && bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }

  #optionAt(target: EventTarget | null): Option | undefined {
    const element = target instanceof Element ? target.closest(".font-picker-option") : null;
    return element ? this.#options.find((option) => option.element === element) : undefined;
  }

  /**
   * Ставит список под кнопкой (или над ней, если снизу мало места).
   * Координаты — окна: у списка `position: fixed`.
   */
  #place(): void {
    const MARGIN = 8;
    const GAP = 4;
    const PREFERRED_HEIGHT = 340;
    const rect = this.#anchor.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 2 * MARGIN);
    // Правый край — по кнопке: она стоит у правого края строки настроек.
    const left = Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - width - MARGIN));
    const below = window.innerHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const style = this.#root.style;
    style.left = `${left}px`;
    style.width = `${width}px`;
    if (below >= Math.min(PREFERRED_HEIGHT, above)) {
      style.top = `${rect.bottom + GAP}px`;
      style.bottom = "";
      style.maxHeight = `${Math.min(PREFERRED_HEIGHT, below)}px`;
    } else {
      style.top = "";
      style.bottom = `${window.innerHeight - rect.top + GAP}px`;
      style.maxHeight = `${Math.min(PREFERRED_HEIGHT, above)}px`;
    }
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
