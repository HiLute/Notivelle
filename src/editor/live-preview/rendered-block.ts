import { type EditorView, WidgetType } from "@codemirror/view";

import { renderedStyle } from "../../appearance";
import { api, type DocumentId } from "../../ipc";
import { addCopyButtons, highlightCodeBlocks } from "../../reading/code";
import { decorateCallouts } from "../../reading/icons";
import { renderMath } from "../../reading/math";
import { renderMermaid } from "../../reading/mermaid";
import { prepareTaskCheckboxes, taskSourceLine } from "../../reading/tasks";
import { linkHandlersFacet, openHref } from "../context";
import { toggleTaskOnLine } from "../tasks";

/** HTML блоков по документу и исходному тексту: повторный показ без запроса к Rust. */
const renderedBlocks = new Map<string, string>();
/** Высота уже показанных блоков: помогает редактору не прыгать при прокрутке. */
const blockHeights = new Map<string, number>();
const CACHE_LIMIT = 200;

/** Ключ кеша: один и тот же текст в разных файлах рендерится по-разному (картинки). */
export function blockKey(documentId: DocumentId | null, source: string): string {
  return `${documentId ?? ""}\u0000${source}`;
}

/** Готовый HTML блока, если он уже рендерился. */
export function cachedBlockHtml(key: string): string | undefined {
  return renderedBlocks.get(key);
}

/** HTML блока от Rust — тот же конвейер, что у режима чтения. */
export async function renderBlockHtml(documentId: DocumentId | null, source: string): Promise<string> {
  const key = blockKey(documentId, source);
  const cached = renderedBlocks.get(key);
  if (cached !== undefined) return cached;
  const html = await api.renderMarkdown(documentId, source);
  remember(renderedBlocks, key, html);
  return html;
}

export function knownBlockHeight(key: string): number {
  return blockHeights.get(key) ?? -1;
}

/**
 * Запоминает высоту блока. Ноль не запоминаем: такая высота бывает у блока,
 * которого ещё нет на странице, и редактор, поверив ей, потом прокрутил бы
 * страницу на настоящую высоту блока.
 */
export function rememberBlockHeight(key: string, height: number): void {
  if (height > 0) remember(blockHeights, key, height);
}

/**
 * Блок (callout, диаграмма, блок формулы, HTML), который рендерит Rust — тот
 * же конвейер, что у режима чтения, поэтому выглядит одинаково. Клик по
 * блоку ставит в него курсор, и блок раскрывается в исходный текст.
 */
export class RenderedBlockWidget extends WidgetType {
  readonly #key: string;
  /** Тема и шрифт, с которыми нарисованы диаграммы: сменятся — блок перерисуется. */
  readonly style = renderedStyle();

  constructor(
    readonly source: string,
    readonly documentId: DocumentId | null,
  ) {
    super();
    this.#key = blockKey(documentId, source);
  }

  override eq(other: RenderedBlockWidget): boolean {
    return other.source === this.source && other.documentId === this.documentId && other.style === this.style;
  }

  override get estimatedHeight(): number {
    return knownBlockHeight(this.#key);
  }

  toDOM(view: EditorView): HTMLElement {
    const block = document.createElement("div");
    block.className = "cm-lp-block markdown-rendered";
    block.addEventListener("mousedown", (event) => {
      const target = event.target as Element;
      // Ссылки, сворачивание и «Копировать» оставляем им самим.
      if (target.closest("a, summary, .code-block-copy")) return;
      event.preventDefault();
      // Чекбокс задачи внутри callout отмечается, а не открывает исходник.
      // Номера строк в HTML блока считаются от его первой строки.
      if (target instanceof HTMLInputElement && target.classList.contains("task-list-item-checkbox")) {
        const line = taskSourceLine(target);
        if (line !== null) {
          const first = view.state.doc.lineAt(view.posAtDOM(block)).number;
          toggleTaskOnLine(view, first + line - 1);
        }
        return;
      }
      view.dispatch({ selection: { anchor: view.posAtDOM(block) } });
      view.focus();
    });
    // Переход по ссылке увёл бы WebView со страницы приложения, поэтому
    // ссылки открываем сами — так же, как в режиме чтения.
    block.addEventListener("click", (event) => {
      const href = (event.target as Element).closest("a")?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      const handlers = view.state.facet(linkHandlersFacet);
      if (handlers && !href.startsWith("#")) openHref(handlers, href);
    });

    const cached = cachedBlockHtml(this.#key);
    if (cached !== undefined) {
      void this.#fill(block, cached, view);
    } else {
      block.classList.add("cm-lp-block-loading");
      renderBlockHtml(this.documentId, this.source)
        .then((html) => {
          block.classList.remove("cm-lp-block-loading");
          return this.#fill(block, html, view);
        })
        .catch((error: unknown) => {
          block.classList.remove("cm-lp-block-loading");
          block.textContent = `Не удалось отрисовать блок: ${String(error)}`;
        });
    }
    return block;
  }

  override ignoreEvent(event: Event): boolean {
    // Клики внутри блока обрабатываем сами (см. toDOM), остальное — редактору.
    return event.type === "mousedown";
  }

  async #fill(block: HTMLElement, html: string, view: EditorView): Promise<void> {
    // HTML очищен Rust (render.rs), поэтому вставлять его через innerHTML можно.
    block.innerHTML = html;
    decorateCallouts(block);
    prepareTaskCheckboxes(block);
    addCopyButtons(block);
    await Promise.all([renderMath(block), highlightCodeBlocks(block)]);
    await renderMermaid(block);
    rememberBlockHeight(this.#key, block.getBoundingClientRect().height);
    view.requestMeasure();
  }
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}
