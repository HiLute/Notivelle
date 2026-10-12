// Иконки callouts — Lucide (https://lucide.dev, лицензия ISC). Импорт `?raw`
// кладёт в сборку только эти SVG, а не весь набор.
import bug from "lucide-static/icons/bug.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
import chevronDown from "lucide-static/icons/chevron-down.svg?raw";
import circleCheck from "lucide-static/icons/circle-check.svg?raw";
import circleHelp from "lucide-static/icons/circle-help.svg?raw";
import clipboardList from "lucide-static/icons/clipboard-list.svg?raw";
import flame from "lucide-static/icons/flame.svg?raw";
import info from "lucide-static/icons/info.svg?raw";
import list from "lucide-static/icons/list.svg?raw";
import pencil from "lucide-static/icons/pencil.svg?raw";
import quote from "lucide-static/icons/quote.svg?raw";
import triangleAlert from "lucide-static/icons/triangle-alert.svg?raw";
import x from "lucide-static/icons/x.svg?raw";
import zap from "lucide-static/icons/zap.svg?raw";

/** Иконка по каноническому типу callout (callouts.rs), как в Obsidian. */
const CALLOUT_ICONS: Record<string, string> = {
  note: pencil,
  abstract: clipboardList,
  info,
  todo: circleCheck,
  tip: flame,
  success: check,
  question: circleHelp,
  warning: triangleAlert,
  failure: x,
  danger: zap,
  bug,
  example: list,
  quote,
};

/**
 * Вставляет иконки в callouts, которые отрендерил Rust (render.rs), и
 * стрелку сворачивания в сворачиваемые. SVG берётся из сборки, а не из
 * документа, поэтому вставлять его через innerHTML безопасно.
 */
export function decorateCallouts(root: HTMLElement): void {
  for (const callout of root.querySelectorAll<HTMLElement>(".callout")) {
    const icon = callout.querySelector(":scope > .callout-title > .callout-icon");
    if (icon) icon.innerHTML = CALLOUT_ICONS[callout.dataset.callout ?? ""] ?? pencil;

    if (callout.dataset.calloutFold) {
      const fold = document.createElement("span");
      fold.className = "callout-fold";
      fold.innerHTML = chevronDown;
      callout.querySelector(":scope > .callout-title")?.append(fold);
    }
  }
}
