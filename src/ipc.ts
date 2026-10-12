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
  /** Один общий вопрос о несохранённых изменениях в перечисленных документах. */
  askUnsavedChanges: (ids: DocumentId[]) => invoke<UnsavedChoice>("ask_unsaved_changes", { ids }),
  closeDocument: (id: DocumentId) => invoke<void>("close_document", { id }),
  /** HTML для режима чтения, уже очищенный Rust. id — чтобы найти картинки рядом с файлом. */
  renderMarkdown: (id: DocumentId | null, text: string) =>
    invoke<string>("render_markdown", { id, text }),
  /** Открыть ссылку в браузере (только http, https, mailto). */
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** Открыть во вкладке Markdown-файл по ссылке относительно документа. */
  openLink: (id: DocumentId, href: string) => invoke<OpenOutcome[]>("open_link", { id, href }),
  /** Слова с ошибками из присланных (spellcheck.rs). */
  spellCheck: (words: string[]) => invoke<string[]>("spell_check", { words }),
  /** Варианты исправления слова. */
  spellSuggest: (word: string) => invoke<string[]>("spell_suggest", { word }),
  /** Добавить слово в личный словарь. */
  spellAddWord: (word: string) => invoke<void>("spell_add_word", { word }),
};
