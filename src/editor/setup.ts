import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  keymap,
  rectangularSelection,
} from "@codemirror/view";

import { currentSettings } from "../settings";
import { reliableDragMove } from "./drag-move";
import { livePreview } from "./live-preview";
import { markdownSyntaxExtensions } from "./markdown-syntax";
import { spellcheck } from "./spellcheck";
import { editorTheme, markdownHighlightStyle } from "./theme";

/**
 * «Ячейка» конфигурации для Live Preview: её содержимое можно заменить
 * транзакцией, не пересоздавая состояние редактора (история отмены и
 * курсор сохраняются).
 */
const livePreviewCompartment = new Compartment();
/** Vim и проверка орфографии включаются в настройках — тоже без пересоздания состояния. */
const vimCompartment = new Compartment();
const spellcheckCompartment = new Compartment();

/**
 * Режим Vim (@replit/codemirror-vim). Пакет загружается, только когда Vim
 * включают в настройках: остальным он не нужен.
 */
let vimExtension: Extension | null = null;
let vimLoading: Promise<void> | null = null;

/**
 * Русская раскладка для команд Vim, как `set langmap` в настоящем Vim:
 * в обычном режиме «о» работает как `j`, «Ж» — как `:` и т. д.
 */
const RUSSIAN_LANGMAP =
  "ФИСВУАПРШОЛДЬТЩЗЙКЫЕГМЦЧНЯ;ABCDEFGHIJKLMNOPQRSTUVWXYZ," +
  "фисвуапршолдьтщзйкыегмцчня;abcdefghijklmnopqrstuvwxyz," +
  "х[,ъ],ж\\;,э',б\\,,ю.,Х{,Ъ},Ж:,Э\",Б<,Ю>,ё`,Ё~";

function loadVim(): Promise<void> {
  vimLoading ??= import("@replit/codemirror-vim").then(({ vim, Vim }) => {
    Vim.langmap(RUSSIAN_LANGMAP, true);
    // status: строка режима (-- INSERT --) и ввод команд `:` внизу редактора.
    vimExtension = vim({ status: true });
  });
  return vimLoading;
}

/**
 * Базовый набор расширений редактора.
 *
 * Собран вручную, а не через `basicSetup`: номера строк, автодополнение и
 * fold-gutter в заметках не нужны. Live Preview включается и выключается
 * через `livePreviewCompartment` (см. setLivePreview).
 */
export function editorExtensions(): Extension {
  const settings = currentSettings();
  return [
    // Vim — первым: его клавиши должны срабатывать раньше остальных.
    vimCompartment.of(settings.vim && vimExtension ? vimExtension : []),
    history(),
    drawSelection(),
    dropCursor(),
    reliableDragMove,
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    // markdownLanguage — это GFM: таблицы, чекбоксы, зачёркивание. Сверху —
    // наш синтаксис: ==выделение== и формулы $…$, $$…$$.
    // codeLanguages подгружает подсветку языков в блоках кода по требованию.
    // markdown() сам добавляет клавиши: Enter продолжает список или цитату.
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [markdownSyntaxExtensions],
    }),
    syntaxHighlighting(markdownHighlightStyle),
    editorTheme,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    spellcheckCompartment.of(settings.spellcheck ? spellcheck : []),
    livePreviewCompartment.of([]),
  ];
}

/** Включает или выключает Live Preview в текущем состоянии редактора. */
export function setLivePreview(view: EditorView, enabled: boolean): void {
  const isEnabled = livePreviewCompartment.get(view.state) === livePreview;
  if (isEnabled === enabled) return;
  view.dispatch({ effects: livePreviewCompartment.reconfigure(enabled ? livePreview : []) });
}

/**
 * Приводит редактор к текущим настройкам: включает или выключает Vim и
 * проверку орфографии. Вызывается при смене настроек и при переключении
 * вкладок (у каждой вкладки своё состояние со своими «ячейками»).
 */
export function applyEditorSettings(view: EditorView): void {
  const settings = currentSettings();
  if (settings.vim && !vimExtension) {
    void loadVim().then(() => applyEditorSettings(view));
  }
  const vimWanted = settings.vim && vimExtension ? vimExtension : null;
  const vimShown = vimCompartment.get(view.state);
  const effects = [];
  if ((vimShown === vimExtension && vimExtension !== null) !== (vimWanted !== null)) {
    effects.push(vimCompartment.reconfigure(vimWanted ?? []));
  }
  if ((spellcheckCompartment.get(view.state) === spellcheck) !== settings.spellcheck) {
    effects.push(spellcheckCompartment.reconfigure(settings.spellcheck ? spellcheck : []));
  }
  if (effects.length > 0) view.dispatch({ effects });
}

/** Включена ли проверка орфографии в этом редакторе (для редакторов ячеек таблиц). */
export function hasSpellcheck(view: EditorView): boolean {
  return spellcheckCompartment.get(view.state) === spellcheck;
}
