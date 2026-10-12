import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import addIcon from "lucide-static/icons/book-plus.svg?raw";
import ignoreIcon from "lucide-static/icons/eye-off.svg?raw";

import { api, errorMessage } from "../ipc";
import { type MenuEntry, showMenu } from "../ui/menu";

/**
 * Проверка орфографии в редакторе.
 *
 * Словари и сама проверка — в Rust (spellcheck.rs). Здесь — какие слова
 * проверять и как показать ошибки: в видимой части документа берутся слова
 * обычного текста (не код, не ссылки, не формулы, не YAML-шапка), их
 * пачкой отправляют в Rust, а ошибки подчёркиваются волнистой линией.
 * Правый клик по ошибке — меню с вариантами исправления.
 */

/** Ответы Rust по словам: true — ошибка. Общие для всех вкладок. */
const verdicts = new Map<string, boolean>();
/** Слова, пропущенные через меню, — до закрытия программы. */
const ignored = new Set<string>();
const VERDICTS_LIMIT = 50_000;

/** Слова, ждущие отправки в Rust, и уже отправленные. */
const queued = new Set<string>();
const inFlight = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Открытые редакторы с проверкой: им сообщаем о новых ответах. */
const views = new Set<EditorView>();
const refresh = StateEffect.define<null>();

let reportError: (message: string) => void = (message) => console.error(message);

/** Куда сообщать об ошибках проверки (нет словаря, не сохранился личный словарь). */
export function setSpellcheckErrorHandler(handler: (message: string) => void): void {
  reportError = handler;
}

/** Текст этих узлов не проверяется. */
const SKIPPED_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "URL",
  "Autolink",
  "InlineMath",
  "BlockMath",
  "FrontMatter",
  "HTMLTag",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "LinkReference",
]);

/**
 * Кандидат в слова: буквы с апострофами и дефисами внутри. Цифры и `_` тоже
 * захватываются — чтобы потом отбросить такие токены целиком (`utf8`,
 * `my_var`), а не проверять их буквенные куски.
 */
const TOKEN = /[\p{L}\p{M}\p{N}_]+(?:['’-][\p{L}\p{M}\p{N}_]+)*/gu;
const NOT_PROSE = /[\p{N}_]/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Слово в документе. */
interface Word {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

/**
 * Похож ли токен на слово обычного текста. Отбрасываем части адресов, путей
 * и имён файлов (`example.com`, `src/main.ts`, `@user`, `#тег`) и вызовы
 * функций (`print(`).
 */
function isProse(line: string, start: number, end: number): boolean {
  if (NOT_PROSE.test(line.slice(start, end))) return false;
  const before = line[start - 1] ?? " ";
  const after = line[end] ?? " ";
  if ("@#/\\".includes(before) || "/\\@(".includes(after)) return false;
  if (before === "." && LETTER_OR_DIGIT.test(line[start - 2] ?? " ")) return false;
  if (after === "." && LETTER_OR_DIGIT.test(line[end + 1] ?? " ")) return false;
  return true;
}

/** Диапазоны, которые не проверяются: код, ссылки, формулы и т. п. */
function skippedRanges(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (SKIPPED_NODES.has(node.name)) {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      // `[!tip]` (маркер callout) и `[^1]` (сноска) парсер считает ссылками
      // без адреса — это не текст.
      if (node.name === "Link" && /^\[[!^]/.test(state.sliceDoc(node.from, node.from + 2))) {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return ranges;
}

/** Слова обычного текста в видимой части документа. */
function visibleWords(view: EditorView): Word[] {
  const { state } = view;
  const words: Word[] = [];
  for (const { from, to } of view.visibleRanges) {
    const skipped = skippedRanges(state, from, to);
    let skip = 0;
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      for (const match of line.text.matchAll(TOKEN)) {
        const start = line.from + match.index;
        const end = start + match[0].length;
        if (end < from || start > to || !isProse(line.text, match.index, match.index + match[0].length)) continue;
        // Диапазоны отсортированы, слова идут по порядку: двигаемся вместе.
        while (skip < skipped.length && (skipped[skip]?.to ?? 0) <= start) skip++;
        const range = skipped[skip];
        if (range && range.from < end) continue;
        words.push({ from: start, to: end, text: match[0] });
      }
      pos = line.to + 1;
    }
  }
  return words;
}

/** Отправляет слова без ответа в Rust — пачкой, чуть погодя. */
function request(words: Iterable<string>): void {
  for (const word of words) {
    if (!verdicts.has(word) && !inFlight.has(word)) queued.add(word);
  }
  if (queued.size > 0 && flushTimer === null) flushTimer = setTimeout(flush, 120);
}

function flush(): void {
  flushTimer = null;
  const batch = [...queued];
  queued.clear();
  for (const word of batch) inFlight.add(word);
  api
    .spellCheck(batch)
    .then((misspelled) => {
      if (verdicts.size + batch.length > VERDICTS_LIMIT) verdicts.clear();
      const wrong = new Set(misspelled);
      for (const word of batch) verdicts.set(word, wrong.has(word));
      refreshAll();
    })
    .catch((error: unknown) => reportError(`Проверка орфографии: ${errorMessage(error)}`))
    .finally(() => {
      for (const word of batch) inFlight.delete(word);
    });
}

function refreshAll(): void {
  for (const view of views) view.dispatch({ effects: refresh.of(null) });
}

function isMisspelled(word: string): boolean {
  return verdicts.get(word) === true && !ignored.has(word);
}

const errorMark = Decoration.mark({ class: "cm-spell-error" });

const spellcheckPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    /** Где сейчас печатают: недописанное слово не подчёркиваем. */
    #typingAt: number | null = null;

    constructor(readonly view: EditorView) {
      views.add(view);
      this.decorations = this.#build();
    }

    update(update: ViewUpdate): void {
      const typed = update.transactions.some((tr) => tr.isUserEvent("input.type"));
      if (typed) this.#typingAt = update.state.selection.main.head;
      else if (update.selectionSet || update.docChanged) this.#typingAt = null;

      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh))) ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = this.#build();
      }
    }

    destroy(): void {
      views.delete(this.view);
    }

    #build(): DecorationSet {
      const words = visibleWords(this.view);
      request(words.map((word) => word.text));
      const marks: Range<Decoration>[] = [];
      for (const word of words) {
        const typing = this.#typingAt !== null && word.from <= this.#typingAt && this.#typingAt <= word.to;
        if (!typing && isMisspelled(word.text)) marks.push(errorMark.range(word.from, word.to));
      }
      return Decoration.set(marks);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Правый клик по ошибке: варианты исправления, «Пропустить» (до закрытия
 * программы) и «Добавить в словарь» (насовсем). Клик мимо ошибки оставляет
 * обычное меню.
 */
const spellcheckMenu = EditorView.domEventHandlers({
  contextmenu(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const plugin = view.plugin(spellcheckPlugin);
    if (pos === null || !plugin) return false;
    // `as`: присваивание в колбэке TypeScript не видит и иначе считал бы,
    // что здесь всегда null.
    let word = null as Word | null;
    plugin.decorations.between(pos, pos, (from, to) => {
      word = { from, to, text: view.state.sliceDoc(from, to) };
      return false;
    });
    if (!word) return false;
    const target: Word = word;

    event.preventDefault();
    const { clientX: x, clientY: y } = event;
    api
      .spellSuggest(target.text)
      .catch((error: unknown) => {
        reportError(`Варианты исправления: ${errorMessage(error)}`);
        return [];
      })
      .then((suggestions) => showMenu(menuFor(view, target, suggestions), x, y));
    return true;
  },
});

function menuFor(view: EditorView, word: Word, suggestions: readonly string[]): MenuEntry[] {
  const replace = (text: string) => () => {
    // Пока Rust искал варианты, текст могли поправить: меняем, только если
    // слово всё ещё на месте.
    if (view.state.sliceDoc(word.from, word.to) !== word.text) return;
    view.dispatch({ changes: { from: word.from, to: word.to, insert: text }, userEvent: "input.spellcheck" });
    view.focus();
  };
  const entries: MenuEntry[] =
    suggestions.length > 0
      ? suggestions.map((suggestion) => ({ label: suggestion, action: replace(suggestion) }))
      : [{ label: "Нет вариантов", disabled: true, action: () => {} }];
  entries.push(
    "separator",
    {
      label: "Пропустить",
      icon: ignoreIcon,
      action: () => {
        ignored.add(word.text);
        refreshAll();
      },
    },
    {
      label: `Добавить «${word.text}» в словарь`,
      icon: addIcon,
      action: () => {
        api
          .spellAddWord(word.text)
          .then(() => {
            // Добавленное строчными подходит и с заглавной (см. spellcheck.rs):
            // такие слова переспросим у Rust.
            const lower = word.text.toLowerCase();
            for (const known of [...verdicts.keys()]) if (known.toLowerCase() === lower) verdicts.delete(known);
            verdicts.set(word.text, false);
            refreshAll();
          })
          .catch((error: unknown) => reportError(`Словарь не сохранён: ${errorMessage(error)}`));
      },
    },
  );
  return entries;
}

const spellcheckTheme = EditorView.baseTheme({
  ".cm-spell-error": {
    textDecoration: "underline wavy var(--text-error)",
    textDecorationSkipInk: "none",
    textUnderlineOffset: "3px",
  },
});

/** Проверка орфографии: подчёркивание ошибок и меню исправлений. */
export const spellcheck: Extension = [spellcheckPlugin, spellcheckMenu, spellcheckTheme];
