import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/**
 * Вики-ссылки `[[Заметка#Заголовок|подпись]]` на стороне фронтенда. Правила
 * разбора повторяют Rust (src-tauri/src/wikilinks.rs): Live Preview рисует
 * ссылки сам, а режим чтения получает их от Rust готовыми.
 */

/** Цель ссылки: заметка и заголовок в ней. */
export interface WikiTarget {
  /** Имя заметки; "" — заголовок в этом же документе (`[[#Заголовок]]`). */
  note: string;
  heading: string | null;
}

export function parseWikiTarget(target: string): WikiTarget {
  const hash = target.indexOf("#");
  const note = (hash < 0 ? target : target.slice(0, hash)).trim();
  // `#^abc` — ссылка на блок (ведём просто на заметку); `#Раздел#Подраздел`
  // — путь по вложенным заголовкам, нужен последний.
  const rest = hash < 0 ? "" : target.slice(hash + 1);
  const heading = rest.startsWith("^")
    ? null
    : (rest
        .split("#")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .at(-1) ?? null);
  return { note, heading };
}

/** Текст ссылки без подписи, как в Obsidian: «Заметка > Заголовок». */
export function wikiDisplay(target: string): string {
  const { note, heading } = parseWikiTarget(target);
  if (heading === null) return note;
  return note === "" ? heading : `${note} > ${heading}`;
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/** Картинка ли это по имени файла (`![[кот.png]]` показывается картинкой). */
export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.test(name);
}

/** Размер из подписи вложения: `300` или `300x200`; null — это не размер. */
export function imageSize(label: string): { width: number; height: number | null } | null {
  const match = /^\s*(\d+)\s*(?:x\s*(\d+)\s*)?$/.exec(label);
  if (!match?.[1]) return null;
  return { width: Number(match[1]), height: match[2] ? Number(match[2]) : null };
}

/**
 * Номер строки (с 1) заголовка, на который ведёт `[[…#heading]]`, или null.
 * Сравнение — как у Obsidian: без учёта регистра и разметки, а символы,
 * которых в ссылке быть не может (`#`, `|`, `^`, `:`, `[`, `]`), считаются
 * пробелами.
 */
export function findHeadingLine(state: EditorState, heading: string): number | null {
  const wanted = normalizeHeading(heading);
  // Дерево разбора строится лениво; для поиска нужно всё. Если за секунду
  // документ не разобрался (огромный файл), считаем, что заголовка нет.
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  if (!tree) return null;

  let found: number | null = null;
  tree.iterate({
    enter: (node) => {
      if (found !== null) return false;
      if (!/^(ATX|Setext)Heading/.test(node.name)) return;
      const line = state.doc.lineAt(node.from);
      if (normalizeHeading(headingText(line.text)) === wanted) found = line.number;
      return false;
    },
  });
  return found;
}

/** Текст заголовка без `#` в начале и в конце строки (и без `> ` цитаты). */
function headingText(line: string): string {
  return line.replace(/^[\s>]*#{0,6}\s*/, "").replace(/\s+#+\s*$/, "");
}

function normalizeHeading(text: string): string {
  return text
    .replace(/[*_`~=]/g, "")
    .replace(/[#|^:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
