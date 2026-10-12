import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorMessage, type DocumentId, type FormatInfo, type OpenOutcome, type OpenedDocument } from "./ipc";
import type { StatusBar } from "./statusbar";
import type { TabBar } from "./tabbar";

const APP_TITLE = "md-editor";

type ScrollSnapshot = ReturnType<EditorView["scrollSnapshot"]>;

/** Вкладка с открытым файлом. */
interface Tab {
  readonly id: DocumentId;
  readonly path: string;
  readonly fileName: string;
  format: FormatInfo;
  /**
   * Состояние редактора: текст, курсор, история отмены. У активной вкладки
   * актуальное состояние живёт в view.state, а здесь лежит снимок на момент
   * ухода с неё.
   */
  state: EditorState;
  /** Позиция прокрутки на момент ухода с вкладки. */
  scroll: ScrollSnapshot | null;
  /** Текст на момент открытия или последнего сохранения. */
  savedDoc: Text;
}

/**
 * Открытые файлы во вкладках. Редактор (EditorView) один: при переключении
 * вкладок в него подставляется EditorState нужного файла, поэтому у каждого
 * файла своя история отмены, позиция курсора и прокрутка. Когда вкладок
 * нет, показывается приветственная страница.
 */
export class Workspace {
  readonly #view: EditorView;
  readonly #createState: (text: string) => EditorState;
  readonly #statusBar: StatusBar;
  readonly #tabBar: TabBar;
  #tabs: Tab[] = [];
  #active: Tab | null = null;
  /** Приветственная страница; хранится, пока открыта какая-нибудь вкладка. */
  #welcome: EditorState;
  #welcomeLabel = "Приветственная страница";
  /** Идёт операция с диалогом: вторую параллельно не запускаем. */
  #busy = false;
  #shownTitle = "";
  /**
   * Была ли активная вкладка «грязной» при прошлой проверке. Полосу вкладок
   * перерисовываем, только когда это меняется, а не на каждую букву.
   */
  #activeDirty = false;

  constructor(
    view: EditorView,
    createState: (text: string) => EditorState,
    statusBar: StatusBar,
    tabBar: TabBar,
  ) {
    this.#view = view;
    this.#createState = createState;
    this.#statusBar = statusBar;
    this.#tabBar = tabBar;
    this.#welcome = view.state;
    tabBar.onActivate = (id) => this.activate(id);
    tabBar.onClose = (id) => void this.close(id);
    this.#refresh();
  }

  get hasTabs(): boolean {
    return this.#tabs.length > 0;
  }

  /** Подпись в строке состояния, пока не открыт ни один файл. */
  set welcomeLabel(label: string) {
    this.#welcomeLabel = label;
    if (!this.#active) this.#refresh();
  }

  /** Вызывается редактором при каждом изменении текста активной вкладки. */
  handleDocChanged(): void {
    const tab = this.#active;
    if (!tab) return;
    const dirty = this.#isDirty(tab);
    if (dirty !== this.#activeDirty) {
      this.#activeDirty = dirty;
      this.#refresh();
    }
  }

  /**
   * Показывает результаты открытия файлов: новые вкладки, переход на уже
   * открытые, ошибки. Активной становится вкладка первого файла из пачки.
   */
  accept(outcomes: readonly OpenOutcome[]): void {
    let target: DocumentId | null = null;
    const failures: string[] = [];
    const mixed: string[] = [];

    for (const outcome of outcomes) {
      switch (outcome.status) {
        case "opened":
          this.#tabs.push(this.#createTab(outcome.document));
          target ??= outcome.document.id;
          if (outcome.document.mixedLineEndings) mixed.push(outcome.document.fileName);
          break;
        case "alreadyOpen":
          target ??= outcome.id;
          break;
        case "failed":
          failures.push(outcome.message);
          break;
      }
    }

    if (target !== null) this.activate(target);
    if (failures.length > 0) {
      this.#statusBar.showMessage(failures.join(" · "), "error");
    } else if (mixed.length > 0) {
      this.#statusBar.showMessage(
        `Смешанные переводы строк в ${mixed.join(", ")}: при сохранении станут одного вида`,
      );
    }
  }

  activate(id: DocumentId): void {
    const tab = this.#tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (tab === this.#active) {
      this.#view.focus();
      return;
    }
    this.#stashActive();
    this.#show(tab);
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab: соседняя вкладка по кругу. */
  activateNext(step: 1 | -1): void {
    const count = this.#tabs.length;
    if (!this.#active || count < 2) return;
    const index = this.#tabs.indexOf(this.#active);
    const next = this.#tabs[(index + step + count) % count];
    if (next) this.activate(next.id);
  }

  /** Ctrl+O: диалог открытия, можно выбрать несколько файлов. */
  openWithDialog(): Promise<void> {
    return this.#exclusive(undefined, async () => {
      this.accept(await api.openDocumentDialog());
    });
  }

  /**
   * Забирает файлы из очереди Rust (командная строка, повторный запуск,
   * перетаскивание). Не ждёт других операций: если в этот момент открыт
   * диалог, файлы всё равно откроются.
   */
  async openPending(): Promise<void> {
    try {
      this.accept(await api.takePendingDocuments());
    } catch (error) {
      this.#statusBar.showMessage(errorMessage(error), "error");
    }
  }

  /** Ctrl+S. */
  save(): Promise<void> {
    return this.#exclusive(undefined, async () => {
      const tab = this.#active;
      if (!tab) {
        this.#statusBar.showMessage("Это приветственная страница. Откройте файл: Ctrl+O");
        return;
      }
      if (!this.#isDirty(tab)) {
        this.#statusBar.showMessage("Изменений нет");
        return;
      }
      if (await this.#saveTab(tab)) this.#statusBar.showMessage(`Сохранено: ${tab.fileName}`);
    });
  }

  /** Закрывает вкладку, при необходимости спросив о несохранённых изменениях. */
  close(id: DocumentId): Promise<void> {
    return this.#exclusive(undefined, async () => {
      const tab = this.#tabs.find((candidate) => candidate.id === id);
      if (!tab) return;
      if (this.#isDirty(tab)) {
        const choice = await api.askUnsavedChanges([tab.id]);
        if (choice === "cancel") return;
        if (choice === "save" && !(await this.#saveTab(tab))) return;
      }
      this.#removeTab(tab);
    });
  }

  /** Ctrl+W. */
  closeActive(): Promise<void> {
    return this.#active ? this.close(this.#active.id) : Promise.resolve();
  }

  /**
   * Можно ли закрыть окно. Если есть несохранённые изменения, задаёт один
   * общий вопрос по всем таким вкладкам. Пока идёт другая операция
   * (например, открыт диалог), окно не закрываем.
   */
  confirmClose(): Promise<boolean> {
    return this.#exclusive(false, async () => {
      const dirty = this.#tabs.filter((tab) => this.#isDirty(tab));
      if (dirty.length === 0) return true;

      const choice = await api.askUnsavedChanges(dirty.map((tab) => tab.id));
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      for (const tab of dirty) {
        // Сохранение не удалось или пользователь отказался перезаписывать
        // изменённый снаружи файл: показываем этот файл и окно не закрываем.
        if (!(await this.#saveTab(tab))) {
          this.activate(tab.id);
          return false;
        }
      }
      return true;
    });
  }

  #createTab(document: OpenedDocument): Tab {
    const state = this.#createState(document.text);
    return {
      id: document.id,
      path: document.path,
      fileName: document.fileName,
      format: {
        lineEnding: document.lineEnding,
        hasBom: document.hasBom,
        mixedLineEndings: document.mixedLineEndings,
      },
      state,
      scroll: null,
      savedDoc: state.doc,
    };
  }

  /** Запоминает состояние текущей вкладки (или приветственной страницы). */
  #stashActive(): void {
    if (this.#active) {
      this.#active.state = this.#view.state;
      this.#active.scroll = this.#view.scrollSnapshot();
    } else {
      this.#welcome = this.#view.state;
    }
  }

  /** Подставляет в редактор вкладку или, если null, приветственную страницу. */
  #show(tab: Tab | null): void {
    this.#active = tab;
    this.#view.setState(tab ? tab.state : this.#welcome);
    if (tab?.scroll) this.#view.dispatch({ effects: tab.scroll });
    this.#activeDirty = tab !== null && this.#isDirty(tab);
    this.#statusBar.setCursor(this.#view.state);
    this.#refresh();
    this.#view.focus();
  }

  #removeTab(tab: Tab): void {
    const index = this.#tabs.indexOf(tab);
    this.#tabs.splice(index, 1);
    void api.closeDocument(tab.id);
    if (tab === this.#active) {
      // Как в браузере: активной становится соседняя вкладка справа, а если
      // её нет — слева. Состояние закрытой вкладки сохранять уже незачем.
      this.#show(this.#tabs[index] ?? this.#tabs[index - 1] ?? null);
    } else {
      this.#refresh();
    }
  }

  async #saveTab(tab: Tab): Promise<boolean> {
    // Снимок текста на момент сохранения: пока Rust пишет файл, пользователь
    // может продолжать печатать, и эти правки останутся несохранёнными.
    const doc = this.#docOf(tab);
    const format = await api.saveDocument(tab.id, doc.toString());
    if (!format) return false;
    tab.savedDoc = doc;
    tab.format = format;
    if (tab === this.#active) this.#activeDirty = this.#isDirty(tab);
    this.#refresh();
    return true;
  }

  #docOf(tab: Tab): Text {
    return tab === this.#active ? this.#view.state.doc : tab.state.doc;
  }

  #isDirty(tab: Tab): boolean {
    return !this.#docOf(tab).eq(tab.savedDoc);
  }

  /**
   * Запускает операцию, если не идёт другая, и показывает её ошибки в
   * строке состояния. `whenBusy` — что вернуть, если операция не запущена
   * или завершилась ошибкой.
   */
  async #exclusive<T>(whenBusy: T, task: () => Promise<T>): Promise<T> {
    if (this.#busy) return whenBusy;
    this.#busy = true;
    try {
      return await task();
    } catch (error) {
      this.#statusBar.showMessage(errorMessage(error), "error");
      return whenBusy;
    } finally {
      this.#busy = false;
    }
  }

  /** Полоса вкладок, строка состояния и заголовок окна. */
  #refresh(): void {
    const labels = tabLabels(this.#tabs);
    this.#tabBar.render(
      this.#tabs.map((tab, index) => ({
        id: tab.id,
        label: labels[index] ?? tab.fileName,
        path: tab.path,
        dirty: this.#isDirty(tab),
        active: tab === this.#active,
      })),
    );

    const tab = this.#active;
    this.#statusBar.setFile(tab ? tab.path : this.#welcomeLabel, tab?.path);
    this.#statusBar.setFormat(tab?.format ?? null);

    const title = tab ? `${this.#activeDirty ? "● " : ""}${tab.fileName} — ${APP_TITLE}` : APP_TITLE;
    // Заголовок меняется через IPC, поэтому дёргаем его только при изменении.
    if (title !== this.#shownTitle) {
      this.#shownTitle = title;
      void getCurrentWindow().setTitle(title);
    }
  }
}

/**
 * Подписи вкладок. Одинаковые имена файлов из разных папок дополняются
 * именем папки: «README.md · docs» и «README.md · src».
 */
function tabLabels(tabs: readonly Tab[]): string[] {
  const counts = new Map<string, number>();
  for (const tab of tabs) counts.set(tab.fileName, (counts.get(tab.fileName) ?? 0) + 1);
  return tabs.map((tab) =>
    (counts.get(tab.fileName) ?? 0) > 1 ? `${tab.fileName} · ${parentDirName(tab.path)}` : tab.fileName,
  );
}

function parentDirName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-2) ?? "";
}
