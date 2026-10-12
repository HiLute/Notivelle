import { shownTheme } from "../appearance";

type Mermaid = (typeof import("mermaid"))["default"];

/**
 * Mermaid весит несколько мегабайт, поэтому загружается только при первой
 * диаграмме: `import()` выносит его в отдельный файл сборки.
 */
let loading: Promise<Mermaid> | null = null;
/** Тема и шрифт, с которыми Mermaid настроен сейчас. */
let initializedStyle: string | null = null;
let counter = 0;

/** Готовые SVG по теме, шрифту и тексту диаграммы: повторный показ не перерисовывает. */
const cache = new Map<string, string>();
const CACHE_LIMIT = 100;

function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((module) => module.default);
  return loading;
}

/** Заменяет блоки ```mermaid нарисованными диаграммами. */
export async function renderMermaid(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (blocks.length === 0) return;

  const mermaid = await loadMermaid();
  const theme = shownTheme() === "dark" ? "dark" : "default";
  // Подписи — шрифтом текста документа. Значение переменной приходит уже
  // с подставленными var(), то есть готовым списком шрифтов.
  const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--font-text").trim();
  const style = `${theme}\u0000${fontFamily}`;
  if (initializedStyle !== style) {
    mermaid.initialize({
      startOnLoad: false,
      // strict: подписи экранируются, клики и скрипты в диаграммах отключены.
      securityLevel: "strict",
      theme,
      fontFamily,
    });
    initializedStyle = style;
  }

  for (const code of blocks) {
    const pre = code.parentElement;
    if (!pre) continue;
    const source = code.textContent ?? "";
    const diagram = document.createElement("div");
    diagram.className = "mermaid-diagram";
    // Для синхронизации прокрутки (sourcepos указывает на исходный блок).
    if (pre.dataset.sourcepos) diagram.dataset.sourcepos = pre.dataset.sourcepos;

    try {
      diagram.innerHTML = await renderSvg(mermaid, style, source);
    } catch (error) {
      diagram.classList.add("mermaid-error");
      diagram.textContent = `Ошибка в диаграмме Mermaid: ${error instanceof Error ? error.message : String(error)}`;
    }
    pre.replaceWith(diagram);
  }
}

async function renderSvg(mermaid: Mermaid, style: string, source: string): Promise<string> {
  const key = `${style}\u0000${source}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const id = `mermaid-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    if (cache.size >= CACHE_LIMIT) {
      // Map помнит порядок вставки: первый ключ — самый старый.
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, svg);
    return svg;
  } finally {
    // При ошибке Mermaid может оставить в body временный элемент.
    document.getElementById(`d${id}`)?.remove();
  }
}
