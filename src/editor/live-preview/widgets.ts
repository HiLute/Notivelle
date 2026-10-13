import { type EditorView, WidgetType } from "@codemirror/view";

import checkIcon from "lucide-static/icons/check.svg?raw";
import copyIcon from "lucide-static/icons/copy.svg?raw";

import { copyText } from "../../clipboard";
import type { DocumentId } from "../../ipc";
import { renderTex } from "../../reading/math";

/** Маркер списка `-`, `*`, `+` → точка. */
export class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const bullet = document.createElement("span");
    bullet.className = "cm-lp-bullet";
    bullet.textContent = "•";
    return bullet;
  }
}

/** `[ ]` / `[x]` → чекбокс. Клик переключает его прямо в тексте. */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    // task-list-item-checkbox — тот же вид, что в режиме чтения (markdown.css).
    box.className = "cm-lp-checkbox task-list-item-checkbox";
    box.title = "Отметить задачу";
    box.checked = this.checked;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      // Позицию узнаём в момент клика: текст выше мог измениться.
      const from = view.posAtDOM(box);
      // `[ ]` → `[x]`: меняется один символ внутри скобок.
      view.dispatch({
        changes: { from: from + 1, to: from + 2, insert: this.checked ? " " : "x" },
        userEvent: "input.task",
      });
    });
    return box;
  }

  /** События чекбокса обрабатываем сами: редактор не двигает курсор. */
  override ignoreEvent(): boolean {
    return true;
  }
}

/** `---` → горизонтальная линия. */
export class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement("span");
    rule.className = "cm-lp-rule";
    return rule;
  }
}

/**
 * Строка ```` ```язык ```` блока кода, пока курсор не в блоке: вместо неё —
 * название языка и кнопка «Копировать», как в Obsidian.
 */
export class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly code: string,
  ) {
    super();
  }

  override eq(other: CodeHeaderWidget): boolean {
    return other.language === this.language && other.code === this.code;
  }

  toDOM(): HTMLElement {
    const header = document.createElement("span");
    header.className = "cm-lp-code-header";
    if (this.language) {
      const label = document.createElement("span");
      label.className = "cm-lp-code-language";
      label.textContent = this.language;
      header.append(label);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-lp-code-copy";
    button.title = "Копировать код";
    button.innerHTML = copyIcon;
    // Курсор остаётся где был: кнопка не открывает блок для правки.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      void copyText(this.code).then(() => {
        button.innerHTML = checkIcon;
        setTimeout(() => (button.innerHTML = copyIcon), 1200);
      });
    });
    header.append(button);
    return header;
  }

  /** Клик по кнопке — наш; клик по остальной шапке ставит курсор в блок. */
  override ignoreEvent(event: Event): boolean {
    return event.target instanceof Element && event.target.closest(".cm-lp-code-copy") !== null;
  }
}

/** Формула `$…$` → KaTeX прямо в строке. */
export class MathWidget extends WidgetType {
  constructor(readonly tex: string) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return other.tex === this.tex;
  }

  toDOM(): HTMLElement {
    const math = document.createElement("span");
    math.className = "cm-lp-math";
    math.textContent = this.tex;
    void renderTex(math, this.tex, false);
    return math;
  }
}

/** Размер картинки из вложения `![[кот.png|300x200]]`. */
export interface ImageSize {
  width: number;
  height: number | null;
}

/** `![alt](src)` или вложение `![[кот.png|300]]` → картинка. */
export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly size: ImageSize | null = null,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.url === this.url &&
      other.alt === this.alt &&
      other.size?.width === this.size?.width &&
      other.size?.height === this.size?.height
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const image = document.createElement("img");
    image.className = "cm-lp-image";
    image.src = this.url;
    image.alt = this.alt;
    image.title = this.alt;
    if (this.size) {
      image.width = this.size.width;
      if (this.size.height !== null) image.height = this.size.height;
    }
    // Высота строки меняется, когда картинка загрузится.
    image.addEventListener("load", () => view.requestMeasure());
    image.addEventListener("error", () => image.classList.add("cm-lp-image-broken"));
    return image;
  }
}

/**
 * Адрес картинки для Live Preview — как в Rust (assets.rs): локальные пути
 * идут через протокол `mdimg`, `https:` и `data:` остаются как есть.
 * null — показать нельзя (нет документа или неизвестный протокол).
 */
export function imageUrl(documentId: DocumentId | null, src: string): string | null {
  if (/^(https?:|data:)/i.test(src)) return src;
  const isFileUrl = /^file:/i.test(src);
  if (!isFileUrl && /^[a-z][a-z0-9+.-]+:/i.test(src)) return null;
  if (documentId === null) return null;

  let path = isFileUrl ? new URL(src).pathname : (src.split(/[?#]/)[0] ?? src);
  try {
    path = decodeURIComponent(path);
  } catch {
    // Некорректная %-последовательность: оставляем путь как есть.
  }
  return `${protocolBase()}${documentId}/${encodeURIComponent(path)}`;
}

/**
 * Адрес вложения `![[кот.png]]` — как в Rust (assets.rs, embed_url):
 * файл по имени найдёт протокол `mdimg`, увидев `?embed`.
 */
export function embedUrl(documentId: DocumentId | null, name: string): string | null {
  if (documentId === null) return null;
  return `${protocolBase()}${documentId}/${encodeURIComponent(name)}?embed`;
}

/** На Windows WebView2 видит свои протоколы как `http://<схема>.localhost`. */
function protocolBase(): string {
  return navigator.userAgent.includes("Windows") ? "http://mdimg.localhost/" : "mdimg://localhost/";
}

/**
 * Вики-ссылка без подписи, у которой текст не совпадает с исходником:
 * `[[План#Этап]]` показывается как «План > Этап», как в Obsidian.
 */
export class WikiLinkWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly target: string,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    return other.text === this.text && other.target === this.target;
  }

  toDOM(): HTMLElement {
    const link = document.createElement("span");
    link.className = "cm-lp-link";
    link.dataset.wikilink = this.target;
    link.title = "Ctrl+клик — открыть ссылку";
    link.textContent = this.text;
    return link;
  }

  /** Обычный клик ставит курсор в ссылку, Ctrl+клик ловит inline.ts. */
  override ignoreEvent(): boolean {
    return false;
  }
}
