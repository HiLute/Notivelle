import { Facet } from "@codemirror/state";

import type { DocumentId } from "../ipc";

/**
 * Документ, открытый в этом EditorState. Нужен Live Preview: картинки
 * ищутся рядом с файлом, а блоки рендерит Rust для конкретного документа.
 * null — приветственная страница.
 */
export const documentIdFacet = Facet.define<DocumentId | null, DocumentId | null>({
  combine: (values) => values[0] ?? null,
});

/** Что делать при Ctrl+клике по ссылке в Live Preview. */
export interface LinkHandlers {
  openExternal(url: string): void;
  openLocal(href: string): void;
}

export const linkHandlersFacet = Facet.define<LinkHandlers, LinkHandlers | null>({
  combine: (values) => values[0] ?? null,
});

/** Открывает ссылку так же, как режим чтения: внешнюю — в браузере. */
export function openHref(handlers: LinkHandlers, href: string): void {
  if (/^(https?:|mailto:)/i.test(href)) handlers.openExternal(href);
  else handlers.openLocal(href);
}
