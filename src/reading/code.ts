import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";

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
