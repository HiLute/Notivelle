import "./settings-panel.css";

import minusIcon from "lucide-static/icons/minus.svg?raw";
import plusIcon from "lucide-static/icons/plus.svg?raw";
import closeIcon from "lucide-static/icons/x.svg?raw";

import { api, errorMessage, type Settings } from "./ipc";
import { currentSettings, FONT_SIZE_RANGE, onSettingsChange, updateSettings } from "./settings";
import { FontPicker, type FontRole } from "./ui/font-picker";

type Choice<T extends string> = readonly (readonly [value: T, label: string])[];

const THEMES: Choice<Settings["theme"]> = [
  ["system", "Как в системе"],
  ["light", "Светлая"],
  ["dark", "Тёмная"],
];

const MODES: Choice<Settings["default_mode"]> = [
  ["live", "Live Preview"],
  ["source", "Исходник"],
  ["reading", "Чтение"],
];

/** Шрифты, как в Obsidian: поле настроек, роль, подпись и пояснение. */
const FONTS = [
  ["interface_font", "interface", "Шрифт интерфейса", "Вкладки, строка состояния, меню и панели."],
  ["text_font", "text", "Шрифт текста", "Редактор и режим чтения."],
  ["monospace_font", "monospace", "Моноширинный шрифт", "Блоки кода и код внутри строки."],
] as const satisfies readonly (readonly [keyof Settings, FontRole, string, string])[];

/** Флажки: поле настроек → подпись и пояснение. */
const TOGGLES = [
  ["readable_line_length", "Ограничить ширину строки", "Текст колонкой по центру, как «Readable line length» в Obsidian."],
  ["spellcheck", "Проверка орфографии", "Русский и английский. Правый клик по ошибке — варианты исправления."],
  ["vim", "Режим Vim", "Команды Vim в редакторе. Работают и в русской раскладке."],
] as const satisfies readonly (readonly [keyof Settings, string, string])[];

/**
 * Панель настроек: модальное окно поверх редактора. Изменения действуют
 * сразу и сохраняются в settings.toml (через Rust, config.rs). Escape или
 * крестик закрывают панель.
 */
export class SettingsPanel {
  readonly #dialog: HTMLDialogElement;
  /** Панель закрылась: вернуть фокус в документ. */
  onClose: () => void = () => {};
  /** Обновить элементы управления по настройкам. */
  readonly #sync: ((settings: Readonly<Settings>) => void)[] = [];
  /** Где лежит файл настроек — показываем внизу панели. */
  #pathNote: HTMLElement;
  /** Версия программы — внизу панели, под путём. */
  #about: HTMLElement;
  readonly #fontPickers: FontPicker[] = [];

  constructor(private readonly onError: (message: string) => void) {
    this.#dialog = document.createElement("dialog");
    this.#dialog.className = "settings-panel";
    this.#dialog.setAttribute("aria-label", "Настройки");

    const header = element("header", "settings-header");
    const title = element("h2", "settings-title");
    title.textContent = "Настройки";
    const close = iconButton("settings-close", "Закрыть (Esc)", closeIcon);
    close.addEventListener("click", () => this.#dialog.close());
    header.append(title, close);

    this.#pathNote = element("p", "settings-path");
    this.#about = element("p", "settings-about");
    this.#dialog.append(
      header,
      this.#section("Оформление", [this.#choice("Тема", "theme", THEMES), this.#toggle(TOGGLES[0])]),
      this.#section("Шрифты", [...FONTS.map((font) => this.#font(font)), this.#fontSize()]),
      this.#section("Редактор", [
        this.#choice("Режим новых вкладок", "default_mode", MODES),
        this.#toggle(TOGGLES[1]),
        this.#toggle(TOGGLES[2]),
      ]),
      this.#pathNote,
      this.#about,
    );
    // Клик по затемнению вокруг панели (это сам <dialog>) закрывает её.
    this.#dialog.addEventListener("click", (event) => {
      if (event.target === this.#dialog) this.#dialog.close();
    });
    // WebKitGTK не возвращает фокус туда, где он был до открытия окна.
    this.#dialog.addEventListener("close", () => {
      for (const picker of this.#fontPickers) picker.close();
      this.onClose();
    });
    document.body.append(this.#dialog);
    onSettingsChange((settings) => this.#refresh(settings));
    this.#refresh(currentSettings());
  }

  /** Путь к settings.toml (от Rust); null — настройки не сохраняются на диск. */
  set settingsPath(path: string | null) {
    this.#pathNote.textContent = path
      ? `Настройки хранятся в ${path} — файл можно править и руками.`
      : "Каталог настроек недоступен: изменения действуют до закрытия программы.";
  }

  /** «Notivelle 0.1.0 · Tauri 2.x · linux» — пригодится, чтобы сообщить об ошибке. */
  set about(text: string) {
    this.#about.textContent = text;
  }

  open(): void {
    if (this.#dialog.open) return;
    this.#refresh(currentSettings());
    this.#dialog.showModal();
    this.#loadFonts();
  }

  /**
   * Список шрифтов системы — заново при каждом открытии панели: шрифт,
   * установленный при открытой программе, тоже появится. Пока список
   * не пришёл, прежний остаётся в силе.
   */
  #loadFonts(): void {
    api
      .listFonts()
      .then((fonts) => {
        for (const picker of this.#fontPickers) picker.installed = fonts;
      })
      .catch((error: unknown) => {
        this.onError(`Список шрифтов не получен: ${errorMessage(error)}`);
        for (const picker of this.#fontPickers) picker.installed ??= [];
      });
  }

  #refresh(settings: Readonly<Settings>): void {
    for (const sync of this.#sync) sync(settings);
  }

  #change(patch: Partial<Settings>): void {
    updateSettings(patch, this.onError);
  }

  #section(title: string, rows: HTMLElement[]): HTMLElement {
    const section = element("section", "settings-section");
    const heading = element("h3", "settings-section-title");
    heading.textContent = title;
    section.append(heading, ...rows);
    return section;
  }

  #row(label: string, description: string | null, control: HTMLElement, labelFor?: string): HTMLElement {
    const row = element("div", "settings-row");
    const text = element("div", "settings-row-text");
    const name = document.createElement(labelFor ? "label" : "span");
    name.className = "settings-row-label";
    name.textContent = label;
    if (labelFor && name instanceof HTMLLabelElement) name.htmlFor = labelFor;
    text.append(name);
    if (description) {
      const hint = element("span", "settings-row-hint");
      hint.textContent = description;
      text.append(hint);
    }
    row.append(text, control);
    return row;
  }

  /** Выбор одного из вариантов — сегменты, как переключатель режимов. */
  #choice<K extends "theme" | "default_mode">(label: string, key: K, options: Choice<Settings[K]>): HTMLElement {
    const group = element("div", "settings-segments");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    const inputs = options.map(([value, text]) => {
      const option = element("label", "settings-segment");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `settings-${key}`;
      input.value = value;
      input.addEventListener("change", () => {
        if (input.checked) this.#change({ [key]: value } as Partial<Settings>);
      });
      const caption = element("span", "settings-segment-label");
      caption.textContent = text;
      option.append(input, caption);
      group.append(option);
      return input;
    });
    this.#sync.push((settings) => {
      for (const input of inputs) input.checked = input.value === settings[key];
    });
    return this.#row(label, null, group);
  }

  /** Шрифт: кнопка со списком шрифтов системы (ui/font-picker.ts). */
  #font([key, role, label, description]: (typeof FONTS)[number]): HTMLElement {
    const picker = new FontPicker(role, label);
    picker.onChange = (value) => this.#change({ [key]: value });
    this.#fontPickers.push(picker);
    this.#sync.push((settings) => {
      picker.value = settings[key];
    });
    return this.#row(label, description, picker.element);
  }

  /** Размер шрифта: ползунок и кнопки «−» и «+». */
  #fontSize(): HTMLElement {
    const control = element("div", "settings-font-size");
    const minus = iconButton("settings-step", "Меньше", minusIcon);
    const plus = iconButton("settings-step", "Больше", plusIcon);
    const range = document.createElement("input");
    range.type = "range";
    range.id = "settings-font-size";
    range.min = String(FONT_SIZE_RANGE.min);
    range.max = String(FONT_SIZE_RANGE.max);
    const value = element("output", "settings-font-size-value");
    const set = (size: number) => {
      const clamped = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, size));
      this.#change({ font_size: clamped });
    };
    range.addEventListener("input", () => set(Number(range.value)));
    minus.addEventListener("click", () => set(currentSettings().font_size - 1));
    plus.addEventListener("click", () => set(currentSettings().font_size + 1));
    control.append(minus, range, plus, value);
    this.#sync.push((settings) => {
      range.value = String(settings.font_size);
      value.textContent = `${settings.font_size} px`;
    });
    return this.#row("Размер шрифта", "Текст в редакторе и режиме чтения.", control, range.id);
  }

  #toggle([key, label, description]: (typeof TOGGLES)[number]): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `settings-${key}`;
    input.className = "settings-switch";
    input.setAttribute("role", "switch");
    input.addEventListener("change", () => this.#change({ [key]: input.checked }));
    this.#sync.push((settings) => {
      input.checked = settings[key];
    });
    return this.#row(label, description, input, input.id);
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function iconButton(className: string, title: string, icon: string): HTMLButtonElement {
  const button = element("button", className);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  // SVG из пакета lucide-static: innerHTML безопасен.
  button.innerHTML = icon;
  return button;
}
