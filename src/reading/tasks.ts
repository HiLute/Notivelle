/** Блочные элементы, на которых заканчивается текст пункта списка. */
const BLOCK_TAGS = new Set(["P", "UL", "OL", "DIV", "PRE", "BLOCKQUOTE", "TABLE", "DETAILS", "H1", "H2", "H3", "H4", "H5", "H6"]);

/**
 * Готовит чекбоксы задач из HTML, который отрендерил Rust: снимает
 * `disabled` (отмечать задачи можно и в режиме чтения, как в Obsidian) и
 * оборачивает текст задачи в `.task-list-item-text`. Обёртка нужна, чтобы
 * зачеркнуть выполненную задачу, но не её вложенный список.
 */
export function prepareTaskCheckboxes(root: HTMLElement): void {
  for (const box of root.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox")) {
    box.disabled = false;
    box.title = "Отметить задачу";
    moveIntoParagraph(box);

    const text: ChildNode[] = [];
    for (let node = box.nextSibling; node; node = node.nextSibling) {
      if (node instanceof HTMLElement && BLOCK_TAGS.has(node.tagName)) break;
      text.push(node);
    }
    if (text.length === 0) continue;
    const wrapper = document.createElement("span");
    wrapper.className = "task-list-item-text";
    box.after(wrapper);
    wrapper.append(...text);
  }
}

/**
 * В «рыхлом» списке (пункты разделены пустой строкой) текст пункта лежит в
 * абзаце, а чекбокс comrak ставит перед ним: `<input> <p>текст</p>`. Абзац —
 * блок, и текст уезжал на строку ниже чекбокса. Переносим чекбокс в начало
 * абзаца, как это делает GitHub.
 */
function moveIntoParagraph(box: HTMLInputElement): void {
  let next = box.nextSibling;
  while (next instanceof Text && next.data.trim() === "") next = next.nextSibling;
  // Пробел между чекбоксом и текстом — как в обычном («плотном») списке.
  if (next instanceof HTMLParagraphElement) next.prepend(box, " ");
}

/**
 * Строка исходника (с 1), на которой стоит задача этого чекбокса. Rust
 * ставит `data-sourcepos="строка:колонка-…"` на каждый пункт списка.
 */
export function taskSourceLine(box: Element): number | null {
  const item = box.closest<HTMLElement>("li[data-sourcepos]");
  const line = Number.parseInt(item?.dataset.sourcepos ?? "", 10);
  return Number.isNaN(line) ? null : line;
}
