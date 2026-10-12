import type { Settings, Theme } from "./ipc";

/**
 * Оформление: тема, шрифты, размер шрифта, ширина строки.
 *
 * Цвета в styles.css заданы через `light-dark(светлый, тёмный)`, а какой из
 * них брать, решает свойство `color-scheme`. Тема «как в системе» —
 * `color-scheme: light dark` (выбирает WebView по настройке системы), ручная
 * тема — атрибут `data-theme` на `<html>`, который сужает его до одной.
 */

/** Шрифт из настроек → CSS-переменная, которую он задаёт (styles.css). */
const FONT_VARIABLES = [
  ["interface_font", "--font-ui"],
  ["text_font", "--font-text"],
  ["monospace_font", "--font-mono"],
] as const satisfies readonly (readonly [keyof Settings, string])[];

/**
 * Общие семейства CSS. Их нельзя брать в кавычки: `serif` — это «шрифт
 * с засечками, который настроен в системе», а `"serif"` — поиск шрифта
 * с таким именем.
 */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** Общее ли это семейство CSS (`serif`, `system-ui`…), а не имя шрифта. */
export function isGenericFamily(name: string): boolean {
  return GENERIC_FAMILIES.has(name.trim().toLowerCase());
}

/**
 * Шрифты из настроек (`Inter, serif`) → значение `font-family`
 * (`"Inter", serif`). Имена — CSS-строки в кавычках, поэтому никакое имя
 * не выйдет за пределы значения. Пустой список — пустая строка.
 */
export function fontFamilyCss(fonts: string): string {
  return fonts
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
    .map((name) => (isGenericFamily(name) ? name.toLowerCase() : `"${name.replace(/["\\]/g, "\\$&")}"`))
    .join(", ");
}

/** Тема, которая сейчас на экране. */
export type ShownTheme = "light" | "dark";

const systemDark = matchMedia("(prefers-color-scheme: dark)");
let chosen: Theme = "system";
let textFont = "";
const listeners = new Set<() => void>();

export function shownTheme(): ShownTheme {
  if (chosen !== "system") return chosen;
  return systemDark.matches ? "dark" : "light";
}

/**
 * Всё, от чего зависит вид нарисованных блоков: диаграммы Mermaid рисуются
 * в цветах темы и шрифтом текста. Сменилась строка — блок перерисовывается.
 */
export function renderedStyle(): string {
  return `${shownTheme()}\u0000${textFont}`;
}

/**
 * Подписка на смену темы на экране — и по настройке, и по системе.
 * Нужна тем, кто рисует цвета сам: диаграммам Mermaid.
 */
export function onThemeChange(listener: () => void): void {
  listeners.add(listener);
}

systemDark.addEventListener("change", () => {
  if (chosen === "system") notify();
});

function notify(): void {
  for (const listener of listeners) listener();
}

/** Применяет оформление из настроек. */
export function applyAppearance(settings: Settings): void {
  const root = document.documentElement;
  const before = shownTheme();
  chosen = settings.theme;
  textFont = settings.text_font;
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;

  for (const [key, variable] of FONT_VARIABLES) {
    const chosen = fontFamilyCss(settings[key]);
    if (chosen === "") root.style.removeProperty(variable);
    else root.style.setProperty(variable, `${chosen}, var(${variable}-default)`);
  }
  root.style.setProperty("--editor-font-size", `${settings.font_size}px`);
  // Без ограничения строка занимает всю ширину окна.
  if (settings.readable_line_length) root.style.removeProperty("--line-width");
  else root.style.setProperty("--line-width", "none");

  if (shownTheme() !== before) notify();
}
