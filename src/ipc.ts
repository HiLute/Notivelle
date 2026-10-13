// Типизированные обёртки над командами Rust (src-tauri/src/commands.rs).
// Типы повторяют структуры Rust после сериализации serde (camelCase).

import { invoke } from "@tauri-apps/api/core";

/**
 * Идентификатор документа, выданный Rust. «Брендированный» тип: обычное
 * число нельзя случайно передать туда, где ждут DocumentId.
 */
export type DocumentId = number & { readonly __brand: "DocumentId" };

export type LineEnding = "LF" | "CRLF" | "CR";

/** Формат файла на диске (FormatInfo в documents.rs). */
export interface FormatInfo {
  lineEnding: LineEnding;
  hasBom: boolean;
  mixedLineEndings: boolean;
}

/** Открытый документ (OpenedDocument в documents.rs). */
export interface OpenedDocument extends FormatInfo {
  id: DocumentId;
  /** Путь только для показа: файловые операции идут по id. */
  path: string;
  fileName: string;
  text: string;
}

/** Результат открытия одного файла из пачки (OpenOutcome в documents.rs). */
export type OpenOutcome =
  | { status: "opened"; document: OpenedDocument }
  /** Файл уже открыт: достаточно переключиться на его вкладку. */
  | { status: "alreadyOpen"; id: DocumentId }
  | { status: "failed"; path: string; message: string };

/**
 * Событие Rust «в очереди появились файлы» (pending.rs): повторный запуск
 * программы или перетаскивание в окно. Забрать их — api.takePendingDocuments().
 */
export const FILES_PENDING_EVENT = "files-pending";

/**
 * Событие Rust «файл открытого документа изменился на диске» (watcher.rs).
 * state: "modified" — изменён, "missing" — удалён или перемещён,
 * "unchanged" — снова совпадает с документом (например, файл вернули).
 */
export const DISK_CHANGE_EVENT = "disk-change";

export type DiskState = "unchanged" | "modified" | "missing";

export interface DiskChange {
  id: DocumentId;
  state: DiskState;
}

export type Theme = "system" | "light" | "dark";

/**
 * Настройки (Settings в config.rs). Имена полей — как ключи в settings.toml,
 * поэтому snake_case, а не camelCase, как в остальном API.
 */
export interface Settings {
  theme: Theme;
  default_mode: "live" | "source" | "reading";
  /** Шрифты: имя семейства или несколько через запятую; "" — по умолчанию. */
  interface_font: string;
  text_font: string;
  monospace_font: string;
  font_size: number;
  readable_line_length: boolean;
  spellcheck: boolean;
  vim: boolean;
}

/** Настройки и проблема с файлом настроек, если она была. */
export interface LoadedSettings {
  settings: Settings;
  problem: string | null;
  /** Где лежит settings.toml; null — каталог настроек недоступен. */
  path: string | null;
}

/** Семейство шрифтов, установленное в системе (fonts.rs). */
export interface FontFamily {
  name: string;
  monospace: boolean;
  /** Вместо букв значки (Dingbats): название им самим не написать. */
  symbols: boolean;
}

export type UnsavedChoice = "save" | "discard" | "cancel";

export interface AppInfo {
  name: string;
  version: string;
  tauriVersion: string;
  os: string;
}

/** Ошибка команды (AppError в error.rs). */
export interface AppError {
  kind: string;
  message: string;
}

function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).kind === "string" &&
    typeof (value as AppError).message === "string"
  );
}

/** Текст ошибки для пользователя, что бы ни прилетело в catch. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  /** Уже открытые в Rust документы, перечитанные с диска (после перезагрузки страницы). */
  restoreDocuments: () => invoke<OpenOutcome[]>("restore_documents"),
  /** Файлы из очереди: командная строка, повторный запуск, перетаскивание. */
  takePendingDocuments: () => invoke<OpenOutcome[]>("take_pending_documents"),
  /** Пустой список — пользователь закрыл диалог, ничего не выбрав. */
  openDocumentDialog: () => invoke<OpenOutcome[]>("open_document_dialog"),
  /** null — файл изменили снаружи, и пользователь отказался его перезаписывать. */
  saveDocument: (id: DocumentId, text: string) =>
    invoke<FormatInfo | null>("save_document", { id, text }),
  /**
   * Новый документ («Без названия»): Rust спрашивает в диалоге, куда его
   * сохранить, и записывает файл. null — пользователь закрыл диалог.
   */
  saveNewDocument: (text: string) => invoke<OpenOutcome | null>("save_new_document", { text }),
  /** Один общий вопрос о несохранённых изменениях; имена — для текста вопроса. */
  askUnsavedChanges: (fileNames: string[]) =>
    invoke<UnsavedChoice>("ask_unsaved_changes", { fileNames }),
  closeDocument: (id: DocumentId) => invoke<void>("close_document", { id }),
  /** HTML для режима чтения, уже очищенный Rust. id — чтобы найти картинки рядом с файлом. */
  renderMarkdown: (id: DocumentId | null, text: string) =>
    invoke<string>("render_markdown", { id, text }),
  /** Открыть ссылку в браузере (только http, https, mailto). */
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** Открыть во вкладке Markdown-файл по ссылке относительно документа. */
  openLink: (id: DocumentId, href: string) => invoke<OpenOutcome[]>("open_link", { id, href }),
  /** Открыть во вкладке заметку по вики-ссылке `[[цель]]`: файл ищется по имени. */
  openWikiLink: (id: DocumentId, target: string) => invoke<OpenOutcome[]>("open_wikilink", { id, target }),
  /** Слова с ошибками из присланных (spellcheck.rs). */
  spellCheck: (words: string[]) => invoke<string[]>("spell_check", { words }),
  /** Варианты исправления слова. */
  spellSuggest: (word: string) => invoke<string[]>("spell_suggest", { word }),
  /** Добавить слово в личный словарь. */
  spellAddWord: (word: string) => invoke<void>("spell_add_word", { word }),
  /** Перечитать документ с диска: файл изменила другая программа. */
  reloadDocument: (id: DocumentId) => invoke<OpenedDocument>("reload_document", { id }),
  getSettings: () => invoke<LoadedSettings>("get_settings"),
  /** Возвращает сохранённые настройки, приведённые к допустимым значениям. */
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  /** Семейства шрифтов системы по алфавиту. */
  listFonts: () => invoke<FontFamily[]>("list_fonts"),
};
