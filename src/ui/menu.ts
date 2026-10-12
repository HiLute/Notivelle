import "./menu.css";

/** Пункт меню. */
export interface MenuItem {
  readonly label: string;
  /** SVG иконки (из lucide-static). */
  readonly icon?: string;
  readonly disabled?: boolean;
  readonly action: () => void;
}

/** Заголовок группы пунктов, например «Строка» и «Столбец». */
export interface MenuSection {
  readonly section: string;
}

export type MenuEntry = MenuItem | MenuSection | "separator";

let closeOpenMenu: (() => void) | null = null;

/**
 * Показывает всплывающее меню в точке `(x, y)` (координаты окна). Меню
 * закрывается кликом мимо, Escape, прокруткой и сменой размера окна.
 * Стрелки вверх/вниз ходят по пунктам, Enter выбирает.
 *
 * Своё меню вместо системного: в WebKitGTK стандартное контекстное меню
 * предлагает «Перезагрузить» и «Проверить элемент», а не действия редактора.
 */
export function showMenu(entries: readonly MenuEntry[], x: number, y: number): void {
  closeOpenMenu?.();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  // Клик по пункту не забирает фокус: действие продолжит работу там, где
  // стоял курсор (например, в ячейке таблицы).
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  const buttons: HTMLButtonElement[] = [];

  for (const entry of entries) {
    if (entry === "separator") {
      menu.append(Object.assign(document.createElement("div"), { className: "menu-separator" }));
    } else if ("section" in entry) {
      menu.append(Object.assign(document.createElement("div"), { className: "menu-section", textContent: entry.section }));
    } else {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "menu-item";
      button.setAttribute("role", "menuitem");
      button.disabled = entry.disabled ?? false;
      const icon = document.createElement("span");
      icon.className = "menu-item-icon";
      // SVG из пакета lucide-static, а не из документа: innerHTML безопасен.
      icon.innerHTML = entry.icon ?? "";
      const label = document.createElement("span");
      label.textContent = entry.label;
      button.append(icon, label);
      button.addEventListener("click", () => {
        close(false);
        entry.action();
      });
      menu.append(button);
      if (!button.disabled) buttons.push(button);
    }
  }

  const onPointerDown = (event: Event) => {
    if (!menu.contains(event.target as Node)) close(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  };
  const onDismiss = () => close(false);

  function close(restoreFocus: boolean): void {
    menu.remove();
    window.removeEventListener("mousedown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onDismiss);
    window.removeEventListener("resize", onDismiss);
    document.removeEventListener("scroll", onDismiss, true);
    closeOpenMenu = null;
    if (restoreFocus) previousFocus?.focus();
  }
  closeOpenMenu = () => close(false);

  document.body.append(menu);
  // Не вылезаем за край окна: если не помещается справа или снизу —
  // открываем влево или вверх от точки.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, x + width > window.innerWidth ? x - width : x)}px`;
  menu.style.top = `${Math.max(4, y + height > window.innerHeight ? y - height : y)}px`;

  window.addEventListener("mousedown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onDismiss);
  window.addEventListener("resize", onDismiss);
  document.addEventListener("scroll", onDismiss, true);
}
