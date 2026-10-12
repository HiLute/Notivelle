type Katex = (typeof import("katex"))["default"];

/**
 * KaTeX со шрифтами весит заметно больше всего остального приложения,
 * поэтому загружается только при первой формуле (вместе со своими стилями).
 */
let loading: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => module.default,
  );
  return loading;
}

/**
 * Рисует формулы, которые Rust оставил текстом в элементах с атрибутом
 * `data-math-style` (`$…$`, `$$…$$` и блоки ```math).
 *
 * `throwOnError: false`: ошибка в формуле показывается красным на месте
 * формулы, а не ломает весь документ. `trust` не включаем — тогда KaTeX не
 * выполняет команды вроде `\href` и `\includegraphics`. `strict: false`:
 * кириллица в формулах (`$x_{макс}$`) — обычное дело, предупреждать о ней
 * в консоли незачем.
 */
export async function renderMath(root: HTMLElement): Promise<void> {
  const elements = [...root.querySelectorAll<HTMLElement>("[data-math-style]")];
  if (elements.length === 0) return;

  const katex = await loadKatex();
  for (const element of elements) {
    katex.render(element.textContent ?? "", element, {
      displayMode: element.dataset.mathStyle === "display",
      throwOnError: false,
      strict: false,
    });
  }
}

/** Рисует одну формулу в элемент (для виджетов Live Preview). */
export async function renderTex(element: HTMLElement, tex: string, displayMode: boolean): Promise<void> {
  const katex = await loadKatex();
  katex.render(tex, element, { displayMode, throwOnError: false, strict: false });
}
