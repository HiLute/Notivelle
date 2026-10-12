import "./markdown.css";

import { highlightCodeBlocks } from "./code";
import { decorateCallouts } from "./icons";
import { renderMath } from "./math";
import { renderMermaid } from "./mermaid";

export interface ReadingLinks {
  /** Внешняя ссылка (http, https, mailto) — открыть в браузере. */
  openExternal(url: string): void;
  /** Ссылка на файл относительно документа — открыть во вкладке. */
  openLocal(href: string): void;
}

/**
 * Режим чтения: показывает HTML, который отрендерил и очистил Rust
 * (render.rs), и дорисовывает поверх него формулы, подсветку кода и
 * диаграммы.
 */
export class ReadingView {
  readonly #host: HTMLElement;
  readonly #content: HTMLElement;
  /** Номер последнего показа: устаревшая дорисовка не трогает новый текст. */
  #generation = 0;

  constructor(host: HTMLElement, links: ReadingLinks) {
    this.#host = host;
    this.#content = document.createElement("div");
    this.#content.className = "markdown-rendered";
    host.replaceChildren(this.#content);

    // Любую ссылку обрабатываем сами: переход по ней увёл бы WebView со
    // страницы приложения.
    const onLink = (event: MouseEvent) => {
      const link = (event.target as Element).closest("a");
      const href = link?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      if (event.type === "auxclick" && event.button !== 1) return;
      if (href.startsWith("#")) this.#scrollToAnchor(href.slice(1));
      else if (/^(https?:|mailto:)/i.test(href)) links.openExternal(href);
      else links.openLocal(href);
    };
    host.addEventListener("click", onLink);
    host.addEventListener("auxclick", onLink);
  }

  get visible(): boolean {
    return !this.#host.hidden;
  }

  /** Показывает HTML и дорисовывает формулы, код и диаграммы. */
  async show(html: string): Promise<void> {
    const generation = ++this.#generation;
    this.#host.hidden = false;
    this.#content.innerHTML = html;
    decorateCallouts(this.#content);
    await Promise.all([renderMath(this.#content), highlightCodeBlocks(this.#content)]);
    if (generation !== this.#generation) return;
    await renderMermaid(this.#content);
  }

  hide(): void {
    this.#generation++;
    this.#host.hidden = true;
  }

  focus(): void {
    this.#host.focus({ preventScroll: true });
  }

  /** Строка исходника (с 1), с которой начинается блок вверху экрана. */
  topSourceLine(): number | null {
    const top = this.#host.getBoundingClientRect().top;
    for (const element of this.#content.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
      if (element.getBoundingClientRect().bottom > top + 1) return startLine(element);
    }
    return null;
  }

  /**
   * Прокручивает к блоку, с которого начинается строка исходника `line`, а
   * если такого нет — к ближайшему блоку выше. Элементы идут в порядке
   * документа, и номера их строк не убывают, поэтому можно идти по порядку.
   */
  scrollToSourceLine(line: number): void {
    let target: HTMLElement | null = null;
    for (const element of this.#content.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
      const start = startLine(element);
      if (start === null) continue;
      if (start > line) break;
      target = element;
    }
    this.#scrollTo(target);
  }

  #scrollToAnchor(encodedId: string): void {
    let id = encodedId;
    try {
      // comrak кодирует не-ASCII в адресах ссылок: `#раздел` → `#%D1%80…`.
      id = decodeURIComponent(encodedId);
    } catch {
      // Некорректная %-последовательность: ищем как есть.
    }
    this.#scrollTo(this.#content.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`));
  }

  #scrollTo(element: HTMLElement | null): void {
    if (!element) {
      this.#host.scrollTop = 0;
      return;
    }
    const offset = element.getBoundingClientRect().top - this.#host.getBoundingClientRect().top;
    this.#host.scrollTop += offset - parseFloat(getComputedStyle(this.#host).paddingTop);
  }
}

/** `data-sourcepos="12:1-14:3"` → 12. */
function startLine(element: HTMLElement): number | null {
  const line = Number.parseInt(element.dataset.sourcepos ?? "", 10);
  return Number.isNaN(line) ? null : line;
}
