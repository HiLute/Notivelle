import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";
import checkIcon from "lucide-static/icons/check.svg?raw";
import copyIcon from "lucide-static/icons/copy.svg?raw";

import { copyText } from "../clipboard";
import { markdownHighlightStyle } from "../editor/theme";

/**
 * Подсвечивает блоки кода тем же парсером и стилем, что и редактор: цвета в
 * режиме чтения и в редакторе совпадают. Парсеры языков подгружаются по
 * требованию, как и в редакторе.
 */
export async function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>("pre > code[class*='language-']");
  await Promise.all([...blocks].map(highlightBlock));
}

async function highlightBlock(code: HTMLElement): Promise<void> {
  const name = [...code.classList]
    .find((cls) => cls.startsWith("language-"))
    ?.slice("language-".length);
  // Диаграммы и формулы рисуют mermaid.ts и math.ts.
  if (!name || name === "mermaid" || name === "math") return;

  const description = LanguageDescription.matchLanguageName(languages, name, true);
  if (!description) return;
  const support = await description.load();

  const text = code.textContent ?? "";
  const tree = support.language.parser.parse(text);
  const fragment = document.createDocumentFragment();
  highlightCode(
    text,
    tree,
    markdownHighlightStyle,
    (chunk, classes) => {
      if (!classes) {
        fragment.append(chunk);
        return;
      }
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = chunk;
      fragment.append(span);
    },
    () => fragment.append("\n"),
  );
  code.replaceChildren(fragment);
}

/**
 * Кнопка «Копировать» в углу каждого блока кода, как в Obsidian. Видна при
 * наведении на блок. Блок оборачивается в `.code-block`: кнопка внутри
 * самого `<pre>` уезжала бы при горизонтальной прокрутке длинных строк.
 */
export function addCopyButtons(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
    const pre = code.parentElement;
    if (!pre || code.classList.contains("language-mermaid") || code.classList.contains("language-math")) continue;
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(pre);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-block-copy";
    button.title = "Копировать код";
    button.innerHTML = copyIcon;
    button.addEventListener("click", () => {
      void copyText(code.textContent ?? "").then(() => {
        button.innerHTML = checkIcon;
        setTimeout(() => (button.innerHTML = copyIcon), 1200);
      });
    });
    block.append(button);
  }
}
