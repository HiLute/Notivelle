/** Режимы просмотра документа, как в Obsidian. */
export type ViewMode = "reading" | "live" | "source";

/** Режимы редактирования: в последний из них Ctrl+E возвращается из чтения. */
export type EditingMode = Exclude<ViewMode, "reading">;

export const MODE_LABELS: Record<ViewMode, string> = {
  reading: "Чтение",
  live: "Live Preview",
  source: "Исходник",
};
