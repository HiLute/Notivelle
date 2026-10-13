import "./toasts.css";

export type ToastKind = "info" | "error";

/** Сколько висит уведомление, если над ним нет курсора. */
const TIMEOUT_MS: Record<ToastKind, number> = { info: 4000, error: 8000 };

/** Больше уведомлений сразу не показываем: старые уступают место новым. */
const MAX_TOASTS = 4;

/**
 * Всплывающие уведомления сверху справа, как Notice в Obsidian:
 * «Сохранено», ошибки открытия файлов и ссылок и т. п. Уведомление
 * исчезает само; пока над ним курсор — ждёт; щелчок закрывает сразу.
 */
export class Toasts {
  readonly #root: HTMLElement;

  constructor() {
    this.#root = document.createElement("div");
    this.#root.className = "toasts";
    this.#root.setAttribute("role", "region");
    this.#root.setAttribute("aria-label", "Уведомления");
    document.body.append(this.#root);
  }

  show(text: string, kind: ToastKind = "info"): void {
    // То же сообщение ещё на экране (например, дважды нажали Ctrl+S) —
    // показываем его заново, а не второй копией.
    for (const toast of this.#root.children) {
      if (toast instanceof HTMLElement && toast.textContent === text) toast.remove();
    }
    while (this.#root.children.length >= MAX_TOASTS) this.#root.firstElementChild?.remove();

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.kind = kind;
    // Ошибку экранный диктор прочитает сразу, остальное — в паузе.
    toast.setAttribute("role", kind === "error" ? "alert" : "status");
    toast.title = "Щелчок — закрыть";
    toast.textContent = text;
    this.#root.append(toast);

    let timer = 0;
    const close = () => {
      window.clearTimeout(timer);
      toast.classList.add("is-leaving");
      // Без анимации (prefers-reduced-motion) animationend не придёт.
      const remove = () => toast.remove();
      toast.addEventListener("animationend", remove, { once: true });
      window.setTimeout(remove, 300);
    };
    const schedule = () => {
      timer = window.setTimeout(close, TIMEOUT_MS[kind]);
    };
    toast.addEventListener("mouseenter", () => window.clearTimeout(timer));
    toast.addEventListener("mouseleave", schedule);
    // Щелчок не должен забирать фокус у редактора.
    toast.addEventListener("mousedown", (event) => event.preventDefault());
    toast.addEventListener("click", close);
    schedule();
  }
}
