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

export type StartupDocument =
  | { status: "opened"; document: OpenedDocument }
  | { status: "failed"; path: string; message: string };

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
  takeStartupDocuments: () => invoke<StartupDocument[]>("take_startup_documents"),
  /** null — пользователь закрыл диалог, ничего не выбрав. */
  openDocumentDialog: () => invoke<OpenedDocument | null>("open_document_dialog"),
  /** null — файл изменили снаружи, и пользователь отказался его перезаписывать. */
  saveDocument: (id: DocumentId, text: string) =>
    invoke<FormatInfo | null>("save_document", { id, text }),
  askUnsavedChanges: (id: DocumentId) => invoke<UnsavedChoice>("ask_unsaved_changes", { id }),
  closeDocument: (id: DocumentId) => invoke<void>("close_document", { id }),
};
