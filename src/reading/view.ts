import "./markdown.css";

import { addCopyButtons, highlightCodeBlocks } from "./code";
import { type FoldState, isFoldedAway, setupHeadingFolds, toggleFold, unfoldAround } from "./folds";
import { decorateCallouts } from "./icons";
import { renderMath } from "./math";
import { renderMermaid } from "./mermaid";
import { prepareTaskCheckboxes, taskSourceLine } from "./tasks";

export interface ReadingLinks {
  /** Внешняя ссылка (http, https, mailto) — открыть в браузере. */
  openExternal(url: string): void;
  /** Ссылка на файл относительно документа — открыть во вкладке. */
  openLocal(href: string): void;
  /** Вики-ссылка `[[цель]]` (render.rs выводит её с data-wikilink). */
  openWikiLink(target: string): void;
}

/**
 * Отметить задачу на строке исходника `line` (с 1). Возвращает новое
 * состояние чекбокса или null, если задачу отметить не удалось.
 */
export type ToggleTask = (line: number) => boolean | null;

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
  /** Свёрнутые разделы показанной вкладки (её собственное множество). */
  #folds: FoldState = new Set();

  constructor(host: HTMLElement, links: ReadingLinks, toggleTask: ToggleTask) {
    this.#host = host;
    this.#content = document.createElement("div");
    this.#content.className = "markdown-rendered";
    host.replaceChildren(this.#content);

    // Любую ссылку обрабатываем сами: переход по ней увёл бы WebView со
    // страницы приложения.
    const onLink = (event: MouseEvent) => {
      const link = (event.target as Element).closest("a");
      const wikilink = link?.dataset.wikilink;
      const href = link?.getAttribute("href");
      if (wikilink === undefined && !href) return;
      event.preventDefault();
      if (event.type === "auxclick" && event.button !== 1) return;
      if (wikilink !== undefined) links.openWikiLink(wikilink);
      else if (!href) return;
      else if (href.startsWith("#")) this.#scrollToAnchor(href.slice(1));
      else if (/^(https?:|mailto:)/i.test(href)) links.openExternal(href);
      else links.openLocal(href);
    };
    host.addEventListener("click", onLink);
    host.addEventListener("auxclick", onLink);

    // Стрелки у заголовков сворачивают и разворачивают разделы (folds.ts).
    host.addEventListener("click", (event) => {
      const heading = (event.target as Element).closest(".heading-fold")?.parentElement;
      if (heading) toggleFold(this.#content, this.#folds, heading);
    });

    // Чекбоксы задач меняют исходный текст, как в Obsidian. Браузер уже
    // переключил чекбокс; если правка не удалась, отмена события вернёт его.
    host.addEventListener("click", (event) => {
      const box = event.target;
      if (!(box instanceof HTMLInputElement) || !box.classList.contains("task-list-item-checkbox")) return;
      const line = taskSourceLine(box);
      const checked = line === null ? null : toggleTask(line);
      if (checked === null) event.preventDefault();
      else box.checked = checked;
    });
  }

  get visible(): boolean {
    return !this.#host.hidden;
  }

  /**
   * Показывает HTML и дорисовывает формулы, код и диаграммы. `folds` —
   * свёрнутые разделы вкладки: щелчки по стрелкам меняют это множество.
   */
  async show(html: string, folds: FoldState): Promise<void> {
    const generation = ++this.#generation;
    this.#host.hidden = false;
    this.#folds = folds;
    this.#content.innerHTML = html;
    setupHeadingFolds(this.#content, folds);
    decorateCallouts(this.#content);
    prepareTaskCheckboxes(this.#content);
    addCopyButtons(this.#content);
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
   *
   * Блоки в свёрнутых разделах пропускаются: место в свёрнутом разделе —
   * это его заголовок. `reveal` — наоборот, развернуть разделы и показать
   * сам блок (переход по ссылке к заголовку).
   */
  scrollToSourceLine(line: number, reveal = false): void {
    let target: HTMLElement | null = null;
    for (const element of this.#content.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
      const start = startLine(element);
      if (start === null) continue;
      if (start > line) break;
      if (reveal || !isFoldedAway(element)) target = element;
    }
    if (reveal && target) unfoldAround(this.#content, this.#folds, target);
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
    // Якорь comrak — пустая ссылка внутри заголовка: прокручиваем к самому
    // заголовку и разворачиваем разделы, если он спрятан.
    const anchor = this.#content.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    const target = anchor?.closest<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? anchor;
    if (target) unfoldAround(this.#content, this.#folds, target);
    this.#scrollTo(target);
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
