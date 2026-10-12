/** Режимы просмотра документа, как в Obsidian. */
export type ViewMode = "reading" | "live" | "source";

/** Режимы редактирования: в последний из них Ctrl+E возвращается из чтения. */
export type EditingMode = Exclude<ViewMode, "reading">;

/** Live Preview появится на этапе M4, до тех пор переключатель его не включает. */
export const LIVE_PREVIEW_READY = false;

export const MODE_LABELS: Record<ViewMode, string> = {
  reading: "Чтение",
  live: "Live Preview",
  source: "Исходник",
};
