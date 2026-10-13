import { Compartment, Facet, type Extension, type StateEffect } from "@codemirror/state";

import type { DocumentId } from "../ipc";

/**
 * Документ, открытый в этом EditorState. Нужен Live Preview: картинки
 * ищутся рядом с файлом, а блоки рендерит Rust для конкретного документа.
 * null — новый документ, ещё не сохранённый в файл.
 */
export const documentIdFacet = Facet.define<DocumentId | null, DocumentId | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Ячейка конфигурации для documentIdFacet: у нового документа id
 * появляется при первом сохранении, и его подставляют, не пересоздавая
 * EditorState (история отмены остаётся).
 */
const documentCompartment = new Compartment();

/** Расширение для нового EditorState документа `id`. */
export function documentId(id: DocumentId | null): Extension {
  return documentCompartment.of(documentIdFacet.of(id));
}

/** Эффект транзакции: документ получил `id` (сохранён в файл). */
export function setDocumentId(id: DocumentId | null): StateEffect<unknown> {
  return documentCompartment.reconfigure(documentIdFacet.of(id));
}

/** Что делать при Ctrl+клике по ссылке в Live Preview. */
export interface LinkHandlers {
  openExternal(url: string): void;
  openLocal(href: string): void;
  /** Вики-ссылка `[[цель]]`: заметку по имени ищет Rust (wikilinks.rs). */
  openWikiLink(target: string): void;
}

export const linkHandlersFacet = Facet.define<LinkHandlers, LinkHandlers | null>({
  combine: (values) => values[0] ?? null,
});

/** Открывает ссылку так же, как режим чтения: внешнюю — в браузере. */
export function openHref(handlers: LinkHandlers, href: string): void {
  if (/^(https?:|mailto:)/i.test(href)) handlers.openExternal(href);
  else handlers.openLocal(href);
}
