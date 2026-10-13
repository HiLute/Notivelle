import chevronIcon from "lucide-static/icons/chevron-down.svg?raw";

/**
 * Сворачивание разделов в режиме чтения, как в Obsidian. При наведении на
 * заголовок слева от него появляется стрелка; щелчок прячет всё до
 * следующего заголовка того же или более высокого уровня. У свёрнутого
 * заголовка стрелка видна всегда и смотрит вправо.
 *
 * Сворачиваются заголовки верхнего уровня документа, не внутри callouts,
 * списков и цитат — там разделов нет.
 *
 * Состояние — множество ключей свёрнутых заголовков. Оно живёт во вкладке
 * и переживает перерисовку после правок. Поэтому ключ — уровень, текст и
 * номер среди заголовков с тем же уровнем и текстом, а не строка в файле:
 * строки сдвигаются, стоит дописать абзац выше.
 */
export type FoldState = Set<string>;

/** Класс элементов, спрятанных в свёрнутом разделе. */
const HIDDEN = "fold-hidden";

/** Уровень заголовка (1–6) или null, если это не заголовок. */
function headingLevel(element: Element): number | null {
  const match = /^H([1-6])$/.exec(element.tagName);
  return match ? Number(match[1]) : null;
}

/**
 * Добавляет стрелки к заголовкам, у которых есть что сворачивать, и
 * прячет свёрнутые разделы из `folds`.
 */
export function setupHeadingFolds(content: HTMLElement, folds: FoldState): void {
  const seen = new Map<string, number>();
  const blocks = [...content.children];
  blocks.forEach((element, index) => {
    const level = headingLevel(element);
    if (level === null || !(element instanceof HTMLElement)) return;
    const base = `${level}:${element.textContent.trim()}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);

    // Раздел пуст, если сразу за заголовком идёт заголовок того же или
    // более высокого уровня (или документ кончился).
    const next = blocks[index + 1];
    const nextLevel = next ? headingLevel(next) : 0;
    if (nextLevel !== null && nextLevel <= level) return;

    element.dataset.foldKey = `${base}:${occurrence}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "heading-fold";
    button.innerHTML = chevronIcon;
    element.prepend(button);
  });
  applyFolds(content, folds);
}

/** Свёрнут раздел — развернуть, развёрнут — свернуть. */
export function toggleFold(content: HTMLElement, folds: FoldState, heading: HTMLElement): void {
  const key = heading.dataset.foldKey;
  if (key === undefined) return;
  if (!folds.delete(key)) folds.add(key);
  applyFolds(content, folds);
}

/**
 * Разворачивает разделы, в которых спрятан `element` (блок верхнего уровня
 * или что-то внутри него): переход по ссылке к заголовку должен его
 * показать.
 */
export function unfoldAround(content: HTMLElement, folds: FoldState, element: Element): void {
  let block: Element | null = element;
  while (block && block.parentElement !== content) block = block.parentElement;
  if (!block) return;

  // Идём вверх по документу; каждый заголовок уровнем выше текущего —
  // раздел, в который вложен блок. Свёрнутые из них разворачиваем.
  let level = headingLevel(block) ?? 7;
  for (let previous = block.previousElementSibling; previous && level > 1; previous = previous.previousElementSibling) {
    const previousLevel = headingLevel(previous);
    if (previousLevel === null || previousLevel >= level) continue;
    level = previousLevel;
    const key = (previous as HTMLElement).dataset.foldKey;
    if (key !== undefined) folds.delete(key);
  }
  applyFolds(content, folds);
}

/** Спрятан ли элемент в свёрнутом разделе. */
export function isFoldedAway(element: Element): boolean {
  return element.closest(`.${HIDDEN}`) !== null;
}

/**
 * Показывает и прячет блоки по `folds`. Свёрнутый раздел внутри свёрнутого
 * тоже остаётся свёрнутым, когда внешний развернут.
 */
function applyFolds(content: HTMLElement, folds: FoldState): void {
  // Уровень свёрнутого заголовка, под которым сейчас всё спрятано; 7 —
  // ничего не спрятано.
  let hiddenBelow = 7;
  for (const element of content.children) {
    const level = headingLevel(element);
    // Заголовок того же или более высокого уровня закрывает раздел.
    if (level !== null && level <= hiddenBelow) hiddenBelow = 7;
    const hidden = hiddenBelow < 7;
    element.classList.toggle(HIDDEN, hidden);

    const key = (element as HTMLElement).dataset.foldKey;
    if (level === null || key === undefined) continue;
    const collapsed = folds.has(key);
    element.classList.toggle("is-collapsed", collapsed);
    const button = element.querySelector(":scope > .heading-fold");
    if (button) {
      button.setAttribute("aria-expanded", String(!collapsed));
      button.setAttribute("title", collapsed ? "Развернуть раздел" : "Свернуть раздел");
      button.setAttribute("aria-label", collapsed ? "Развернуть раздел" : "Свернуть раздел");
    }
    if (!hidden && collapsed) hiddenBelow = level;
  }
}
