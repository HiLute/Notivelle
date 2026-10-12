import "./live-preview.css";

import type { Extension } from "@codemirror/state";

import { blockNavigation, blockPreview } from "./blocks";
import { inlinePreview } from "./inline";

/**
 * Режим Live Preview, как в Obsidian: разметка видна только там, где стоит
 * курсор, а остальной текст выглядит почти как в режиме чтения.
 *
 * Расширение создаётся один раз: по нему (сравнением ссылок) редактор
 * понимает, включён ли Live Preview в конкретном состоянии.
 */
export const livePreview: Extension = [inlinePreview, blockPreview, blockNavigation];
