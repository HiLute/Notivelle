import type { ChangeSpec, EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { setDocumentId } from "./editor/context";
import { refreshRenderedBlocks } from "./editor/live-preview/blocks";
import { scrollToLine, topVisibleLine } from "./editor/scroll";
import { applyEditorSettings, setLivePreview } from "./editor/setup";
import { toggleTaskOnLine } from "./editor/tasks";
import {
  api,
  type DiskChange,
  type DiskState,
  errorMessage,
  type DocumentId,
  type FormatInfo,
  type OpenOutcome,
  type OpenedDocument,
} from "./ipc";
import type { EditingMode, ViewMode } from "./modes";
import type { NoticeBar } from "./notice";
import { currentSettings } from "./settings";
import { textChange } from "./text-diff";
import type { ReadingView } from "./reading/view";
import type { StatusBar } from "./statusbar";
import type { TabBar } from "./tabbar";

const APP_TITLE = "Notivelle";

/** Имя нового документа, пока его не сохранили (то же в dialogs.rs). */
const NEW_DOCUMENT_NAME = "Без названия";

/** Формат нового документа: так его и запишет Rust (documents.rs). */
const NEW_DOCUMENT_FORMAT: FormatInfo = { lineEnding: "LF", hasBom: false, mixedLineEndings: false };

type ScrollSnapshot = ReturnType<EditorView["scrollSnapshot"]>;

/** HTML режима чтения и текст, из которого он получен. */
interface Rendered {
  /** Text неизменяемый: если документ правили, это будет уже другой объект. */
  doc: Text;
  html: string;
}

/** Что показано во вкладке: редактор или режим чтения. */
interface Page {
  mode: ViewMode;
  /** Последний режим редактирования: в него Ctrl+E возвращается из чтения. */
  editingMode: EditingMode;
  rendered: Rendered | null;
  /** Строка исходника вверху режима чтения — чтобы вернуться на то же место. */
  readingLine: number | null;
}

/** Вкладка: открытый файл или новый документ, ещё не сохранённый в файл. */
interface Tab extends Page {
  /** Ключ вкладки в полосе вкладок; есть и у нового документа. */
  readonly key: number;
  /** Документ в Rust; null — новый документ, файла у него пока нет. */
  id: DocumentId | null;
  /** Путь для показа; null у нового документа. */
  path: string | null;
  fileName: string;
  format: FormatInfo;
  /**
   * Состояние редактора: текст, курсор, история отмены. У активной вкладки
   * актуальное состояние живёт в view.state, а здесь лежит снимок на момент
   * ухода с неё.
   */
  state: EditorState;
  /** Позиция прокрутки редактора на момент ухода с вкладки. */
  scroll: ScrollSnapshot | null;
  /** Текст на момент открытия или последнего сохранения. */
  savedDoc: Text;
  /** Что с файлом на диске (сообщает Rust, watcher.rs). */
  diskState: DiskState;
  /** Плашку про изменение на диске закрыли — до следующего изменения. */
  noticeDismissed: boolean;
}

export interface WorkspaceParts {
  view: EditorView;
  /** Элемент, в котором живёт редактор: его прячем в режиме чтения. */
  editorHost: HTMLElement;
  createState: (text: string, id: DocumentId | null) => EditorState;
  reading: ReadingView;
  statusBar: StatusBar;
  tabBar: TabBar;
  notice: NoticeBar;
}

/**
 * Открытые файлы во вкладках. Редактор (EditorView) один: при переключении
 * вкладок в него подставляется EditorState нужного файла, поэтому у каждого
 * файла своя история отмены, позиция курсора и прокрутка. У каждой вкладки
 * свой режим: редактор или чтение (Ctrl+E).
 *
 * Вкладка есть всегда, как в Kate: без файлов это новый пустой документ
 * «Без названия». Первое сохранение спрашивает имя файла. Нетронутый пустой
 * документ уступает место файлу, который открыли.
 */
export class Workspace {
  readonly #view: EditorView;
  readonly #editorHost: HTMLElement;
  readonly #createState: (text: string, id: DocumentId | null) => EditorState;
  readonly #reading: ReadingView;
  readonly #statusBar: StatusBar;
  readonly #tabBar: TabBar;
  readonly #notice: NoticeBar;
  #tabs: Tab[] = [];
  /** Активная вкладка; назначается в конструкторе. */
  #active!: Tab;
  #nextKey = 1;
  /** Идёт операция с диалогом: вторую параллельно не запускаем. */
  #busy = false;
  #shownTitle = "";
  /**
   * Была ли активная вкладка «грязной» при прошлой проверке. Полосу вкладок
   * перерисовываем, только когда это меняется, а не на каждую букву.
   */
  #activeDirty = false;

  constructor(parts: WorkspaceParts) {
    this.#view = parts.view;
    this.#editorHost = parts.editorHost;
    this.#createState = parts.createState;
    this.#reading = parts.reading;
    this.#statusBar = parts.statusBar;
    this.#tabBar = parts.tabBar;
    this.#notice = parts.notice;
    parts.tabBar.onActivate = (key) => {
      const tab = this.#tabs.find((candidate) => candidate.key === key);
      if (tab) this.#activate(tab);
    };
    parts.tabBar.onClose = (key) => {
      const tab = this.#tabs.find((candidate) => candidate.key === key);
      if (tab) void this.#close(tab);
    };
    parts.tabBar.onNew = () => this.newDocument();
    parts.notice.onDismiss = () => {
      this.#active.noticeDismissed = true;
      this.#refreshNotice();
    };
    // Пока файлы не открыты (или их нет вовсе) — пустой новый документ.
    this.#show(this.#addNewTab());
  }

  /**
   * Настройки изменились: редактор (Vim, орфография) подстраивается сразу.
   * Режим по умолчанию касается только новых вкладок.
   */
  applySettings(): void {
    applyEditorSettings(this.#view);
    // Шрифт или его размер могли смениться: высоты строк — другие.
    this.#view.requestMeasure();
  }

  /**
   * Сменилась тема или шрифт текста: диаграммы Mermaid нарисованы в цветах
   * темы и этим шрифтом, их нужно перерисовать — и в режиме чтения, и в
   * блоках Live Preview.
   */
  refreshRendered(): void {
    for (const tab of this.#tabs) tab.rendered = null;
    if (this.#active.mode === "reading") void this.#applyMode();
    else this.#view.dispatch({ effects: refreshRenderedBlocks.of(null) });
  }

  /**
   * Файл открытого документа изменился на диске (событие от Rust). Вкладка
   * без правок перечитывает его сама; на вкладке с правками появляется
   * плашка с выбором.
   */
  async handleDiskChange(change: DiskChange): Promise<void> {
    const tab = this.#tabs.find((candidate) => candidate.id === change.id);
    if (!tab) return;
    tab.diskState = change.state;
    tab.noticeDismissed = false;
    if (change.state === "modified" && !this.#isDirty(tab)) {
      await this.#reloadFromDisk(tab, `«${tab.fileName}» обновлён: файл изменила другая программа`);
      return;
    }
    this.#refreshNotice();
  }

  /** Вызывается редактором при каждом изменении текста активной вкладки. */
  handleDocChanged(): void {
    const tab = this.#active;
    const dirty = this.#isDirty(tab);
    if (dirty !== this.#activeDirty) {
      this.#activeDirty = dirty;
      this.#refresh();
    }
  }

  /**
   * Показывает результаты открытия файлов: новые вкладки, переход на уже
   * открытые, ошибки. Активной становится вкладка первого файла из пачки, а
   * нетронутый пустой новый документ закрывается — его место занял файл.
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

    const opened = this.#tabs.find((tab) => tab.id !== null && tab.id === target);
    if (opened) {
      this.#activate(opened);
      for (const tab of this.#tabs.filter((candidate) => this.#isPristine(candidate))) this.#removeTab(tab);
    }
    if (failures.length > 0) {
      this.#statusBar.showMessage(failures.join(" · "), "error");
    } else if (mixed.length > 0) {
      this.#statusBar.showMessage(
        `Смешанные переводы строк в ${mixed.join(", ")}: при сохранении станут одного вида`,
      );
    }
  }

  /**
   * Настройки загрузились. Пустой новый документ появился раньше них —
   * берёт режим правки из настроек (исходник или Live Preview).
   */
  settingsLoaded(): void {
    for (const tab of this.#tabs.filter((candidate) => this.#isPristine(candidate))) {
      Object.assign(tab, newDocumentModes());
    }
    if (this.#isPristine(this.#active)) {
      void this.#applyMode();
      this.#refresh();
    }
  }

  /** Ctrl+N и «+» в полосе вкладок: новый пустой документ. */
  newDocument(): void {
    const tab = this.#addNewTab();
    this.#stashActive();
    this.#show(tab);
  }

  #activate(tab: Tab): void {
    if (tab === this.#active) {
      this.#focusContent();
      return;
    }
    this.#stashActive();
    this.#show(tab);
  }

  /** Фокус в документ: редактор или режим чтения. */
  focus(): void {
    this.#focusContent();
  }

  /** Ctrl+Tab / Ctrl+Shift+Tab: соседняя вкладка по кругу. */
  activateNext(step: 1 | -1): void {
    const count = this.#tabs.length;
    if (count < 2) return;
    const index = this.#tabs.indexOf(this.#active);
    const next = this.#tabs[(index + step + count) % count];
    if (next) this.#activate(next);
  }

  /**
   * Переключает режим текущей страницы, сохраняя место в тексте: что было
   * вверху экрана, останется вверху и в другом режиме.
   */
  setMode(mode: ViewMode): void {
    const page = this.#active;
    if (mode === page.mode) {
      this.#focusContent();
      return;
    }

    if (mode === "reading") {
      page.readingLine = topVisibleLine(this.#view);
      page.mode = "reading";
      void this.#applyMode();
    } else {
      const line = page.mode === "reading" ? this.#reading.topSourceLine() : null;
      page.mode = mode;
      page.editingMode = mode;
      this.#showEditor();
      if (line !== null) scrollToLine(this.#view, line);
    }
    this.#refresh();
  }

  /** Ctrl+E: чтение ⇄ последний режим редактирования, как в Obsidian. */
  toggleReading(): void {
    const page = this.#active;
    this.setMode(page.mode === "reading" ? page.editingMode : "reading");
  }

  /** Ctrl+Shift+E: исходник ⇄ Live Preview. Из чтения — в другой режим правки. */
  toggleEditingMode(): void {
    const page = this.#active;
    const current = page.mode === "reading" ? page.editingMode : page.mode;
    this.setMode(current === "live" ? "source" : "live");
  }

  /**
   * Клик по чекбоксу в режиме чтения: задача отмечается прямо в тексте
   * текущей страницы, и правку можно отменить в редакторе.
   */
  toggleTask(line: number): boolean | null {
    return toggleTaskOnLine(this.#view, line);
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

  /** Ссылка из режима чтения на файл рядом с документом. */
  async openLink(href: string): Promise<void> {
    if (this.#active.id === null) {
      this.#statusBar.showMessage("Ссылки на файлы работают, когда документ сохранён в файл");
      return;
    }
    try {
      this.accept(await api.openLink(this.#active.id, href));
    } catch (error) {
      this.#statusBar.showMessage(errorMessage(error), "error");
    }
  }

  /** Внешняя ссылка из режима чтения: откроется в браузере. */
  async openExternal(url: string): Promise<void> {
    try {
      await api.openExternal(url);
    } catch (error) {
      this.#statusBar.showMessage(errorMessage(error), "error");
    }
  }

  /** Ctrl+S. Новый документ сохраняется всегда: спрашиваем имя файла. */
  save(): Promise<void> {
    return this.#exclusive(undefined, async () => {
      const tab = this.#active;
      if (tab.id !== null && !this.#isDirty(tab)) {
        this.#statusBar.showMessage("Изменений нет");
        return;
      }
      const saved = await this.#saveTab(tab);
      if (saved) this.#statusBar.showMessage(`Сохранено: ${saved.fileName}`);
    });
  }

  /** Ctrl+W. */
  closeActive(): Promise<void> {
    return this.#close(this.#active);
  }

  /** Закрывает вкладку, при необходимости спросив о несохранённых изменениях. */
  #close(tab: Tab): Promise<void> {
    return this.#exclusive(undefined, async () => {
      if (!this.#tabs.includes(tab)) return;
      if (this.#isDirty(tab)) {
        const choice = await api.askUnsavedChanges([tab.fileName]);
        if (choice === "cancel") return;
        if (choice === "save" && !(await this.#saveTab(tab))) return;
      }
      this.#removeTab(tab);
    });
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

      const choice = await api.askUnsavedChanges(dirty.map((tab) => tab.fileName));
      if (choice === "cancel") return false;
      if (choice === "discard") return true;
      for (const tab of dirty) {
        // Сохранение не удалось, пользователь отказался перезаписывать
        // изменённый снаружи файл или закрыл диалог имени нового файла:
        // показываем этот документ и окно не закрываем.
        if (!(await this.#saveTab(tab))) {
          if (this.#tabs.includes(tab)) this.#activate(tab);
          return false;
        }
      }
      return true;
    });
  }

  #createTab(document: OpenedDocument): Tab {
    const state = this.#createState(document.text, document.id);
    return {
      key: this.#nextKey++,
      id: document.id,
      path: document.path,
      fileName: document.fileName,
      format: formatOf(document),
      state,
      scroll: null,
      savedDoc: state.doc,
      diskState: "unchanged",
      noticeDismissed: false,
      ...initialModes(),
      rendered: null,
      readingLine: null,
    };
  }

  /** Добавляет вкладку нового пустого документа (не переключаясь на неё). */
  #addNewTab(): Tab {
    const state = this.#createState("", null);
    const tab: Tab = {
      key: this.#nextKey++,
      id: null,
      path: null,
      fileName: this.#newDocumentName(),
      format: NEW_DOCUMENT_FORMAT,
      state,
      scroll: null,
      savedDoc: state.doc,
      diskState: "unchanged",
      noticeDismissed: false,
      ...newDocumentModes(),
      rendered: null,
      readingLine: null,
    };
    this.#tabs.push(tab);
    return tab;
  }

  /** «Без названия», «Без названия 2»… — первое имя, которое не занято. */
  #newDocumentName(): string {
    const taken = new Set(this.#tabs.filter((tab) => tab.id === null).map((tab) => tab.fileName));
    for (let number = 1; ; number++) {
      const name = number === 1 ? NEW_DOCUMENT_NAME : `${NEW_DOCUMENT_NAME} ${number}`;
      if (!taken.has(name)) return name;
    }
  }

  /** Новый документ, в котором ничего не набрали: его можно закрыть молча. */
  #isPristine(tab: Tab): boolean {
    return tab.id === null && this.#docOf(tab).length === 0;
  }

  /**
   * Берёт текст файла с диска. Текст заменяется одной правкой, а не новым
   * состоянием редактора: курсор остаётся на месте, а Ctrl+Z вернёт текст,
   * который был до перечитывания.
   */
  async #reloadFromDisk(tab: Tab, message: string): Promise<void> {
    if (tab.id === null) return;
    let document: OpenedDocument;
    try {
      document = await api.reloadDocument(tab.id);
    } catch (error) {
      this.#statusBar.showMessage(errorMessage(error), "error");
      return;
    }
    if (!this.#tabs.includes(tab)) return;

    const change: ChangeSpec = textChange(this.#docOf(tab).toString(), document.text);
    if (tab === this.#active) {
      this.#view.dispatch({ changes: change, userEvent: "input.reload" });
    } else {
      tab.state = tab.state.update({ changes: change, userEvent: "input.reload" }).state;
    }
    tab.savedDoc = this.#docOf(tab);
    tab.format = formatOf(document);
    tab.diskState = "unchanged";
    tab.rendered = null;
    if (tab === this.#active) {
      this.#activeDirty = false;
      if (tab.mode === "reading") void this.#applyMode();
    }
    this.#refresh();
    this.#statusBar.showMessage(message);
  }

  /** Плашка про файл на диске у активной вкладки. */
  #refreshNotice(): void {
    const tab = this.#active;
    if (tab.noticeDismissed || tab.diskState === "unchanged") {
      this.#notice.hide();
      return;
    }
    if (tab.diskState === "modified") {
      this.#notice.show(`Файл «${tab.fileName}» изменила другая программа, а здесь есть несохранённые правки.`, [
        {
          label: "Загрузить с диска",
          run: () => void this.#reloadFromDisk(tab, `«${tab.fileName}» загружен с диска. Ctrl+Z вернёт ваши правки`),
        },
        {
          label: "Оставить мои",
          run: () => {
            tab.noticeDismissed = true;
            this.#refreshNotice();
          },
        },
      ]);
    } else {
      this.#notice.show(`Файл «${tab.fileName}» удалили или переместили.`, [
        { label: "Сохранить заново", run: () => void this.save() },
        { label: "Закрыть вкладку", run: () => void this.#close(tab) },
      ]);
    }
  }

  /** Запоминает состояние активной вкладки перед уходом с неё. */
  #stashActive(): void {
    const tab = this.#active;
    if (tab.mode === "reading") tab.readingLine = this.#reading.topSourceLine();
    tab.state = this.#view.state;
    tab.scroll = this.#view.scrollSnapshot();
  }

  /** Подставляет вкладку в редактор. */
  #show(tab: Tab): void {
    this.#active = tab;
    this.#view.setState(tab.state);
    // Настройки могли поменяться, пока вкладка была в фоне.
    applyEditorSettings(this.#view);
    if (tab.scroll) this.#view.dispatch({ effects: tab.scroll });
    this.#activeDirty = this.#isDirty(tab);
    this.#statusBar.setCursor(this.#view.state);
    this.#refresh();
    void this.#applyMode();
  }

  /**
   * Показывает редактор или режим чтения — как задано у активной вкладки.
   * HTML для чтения рендерит Rust; пока текст не менялся, берётся готовый.
   */
  async #applyMode(): Promise<void> {
    const page = this.#active;
    if (page.mode !== "reading") {
      this.#showEditor();
      return;
    }

    const doc = this.#view.state.doc;
    let html = page.rendered?.doc === doc ? page.rendered.html : null;
    if (html === null) {
      try {
        html = await api.renderMarkdown(page.id, doc.toString());
      } catch (error) {
        this.#statusBar.showMessage(errorMessage(error), "error");
        page.mode = page.editingMode;
        this.#showEditor();
        this.#refresh();
        return;
      }
      // Пока Rust рендерил, пользователь мог переключить вкладку или режим.
      if (this.#active !== page || page.mode !== "reading") return;
      page.rendered = { doc, html };
    }

    this.#editorHost.hidden = true;
    // show() вставляет HTML сразу, а формулы, код и диаграммы дорисовывает
    // асинхронно. Прокручиваем к нужному месту и сразу, и после дорисовки:
    // диаграммы меняют высоту блоков.
    const drawn = this.#reading.show(html);
    const line = page.readingLine;
    if (line !== null) this.#reading.scrollToSourceLine(line);
    this.#reading.focus();
    await drawn;
    if (line !== null && this.#active === page && page.mode === "reading") {
      this.#reading.scrollToSourceLine(line);
    }
  }

  /** Показывает редактор в режиме активной вкладки: исходник или Live Preview. */
  #showEditor(): void {
    setLivePreview(this.#view, this.#active.mode === "live");
    this.#reading.hide();
    this.#editorHost.hidden = false;
    this.#view.requestMeasure();
    this.#view.focus();
  }

  #focusContent(): void {
    if (this.#active.mode === "reading") this.#reading.focus();
    else this.#view.focus();
  }

  #removeTab(tab: Tab): void {
    const index = this.#tabs.indexOf(tab);
    if (index < 0) return;
    this.#tabs.splice(index, 1);
    if (tab.id !== null) void api.closeDocument(tab.id);
    if (tab !== this.#active) {
      this.#refresh();
      return;
    }
    // Как в браузере: активной становится соседняя вкладка справа, а если
    // её нет — слева. Закрыли последнюю — остаётся пустой новый документ.
    // Состояние закрытой вкладки сохранять уже незачем.
    this.#show(this.#tabs[index] ?? this.#tabs[index - 1] ?? this.#addNewTab());
  }

  /**
   * Сохраняет вкладку. Возвращает вкладку, в которой теперь сохранённый
   * файл (обычно ту же), или null, если сохранение не состоялось.
   */
  async #saveTab(tab: Tab): Promise<Tab | null> {
    if (tab.id === null) return this.#saveNew(tab);
    // Снимок текста на момент сохранения: пока Rust пишет файл, пользователь
    // может продолжать печатать, и эти правки останутся несохранёнными.
    const doc = this.#docOf(tab);
    const format = await api.saveDocument(tab.id, doc.toString());
    if (!format) return null;
    tab.savedDoc = doc;
    tab.format = format;
    tab.diskState = "unchanged";
    if (tab === this.#active) this.#activeDirty = this.#isDirty(tab);
    this.#refresh();
    return tab;
  }

  /**
   * Первое сохранение нового документа: Rust спрашивает имя файла и
   * записывает его. Вкладка становится вкладкой этого файла, а курсор и
   * история отмены остаются.
   */
  async #saveNew(tab: Tab): Promise<Tab | null> {
    // Диалог спросит имя файла — пусть будет видно, о каком документе речь.
    if (tab !== this.#active) this.#activate(tab);
    const doc = this.#docOf(tab);
    const outcome = await api.saveNewDocument(doc.toString());
    if (!outcome || outcome.status === "failed") return null;

    if (outcome.status === "alreadyOpen") {
      // Заменили файл, который уже открыт в другой вкладке. Та перечитает
      // его сама (watcher.rs), а эта больше не нужна.
      const existing = this.#tabs.find((other) => other.id === outcome.id) ?? null;
      this.#removeTab(tab);
      if (existing) this.#activate(existing);
      return existing;
    }

    const { document } = outcome;
    tab.id = document.id;
    tab.path = document.path;
    tab.fileName = document.fileName;
    tab.format = formatOf(document);
    tab.savedDoc = doc;
    tab.diskState = "unchanged";
    tab.rendered = null;
    // Live Preview ищет картинки рядом с файлом — теперь он есть.
    const effects = [setDocumentId(document.id), refreshRenderedBlocks.of(null)];
    if (tab === this.#active) {
      this.#view.dispatch({ effects });
      this.#activeDirty = this.#isDirty(tab);
    } else {
      tab.state = tab.state.update({ effects }).state;
    }
    this.#refresh();
    return tab;
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
        key: tab.key,
        label: labels[index] ?? tab.fileName,
        title: tab.path ?? "Новый документ: Ctrl+S сохранит его в файл",
        dirty: this.#isDirty(tab),
        active: tab === this.#active,
      })),
    );

    const tab = this.#active;
    this.#statusBar.setFile(tab.path ?? `${tab.fileName} — ещё не сохранён (Ctrl+S)`, tab.path ?? "");
    this.#statusBar.setFormat(tab.format);
    this.#statusBar.setMode(tab.mode);

    this.#refreshNotice();

    const title = `${this.#activeDirty ? "● " : ""}${tab.fileName} — ${APP_TITLE}`;
    // Заголовок меняется через IPC, поэтому дёргаем его только при изменении.
    if (title !== this.#shownTitle) {
      this.#shownTitle = title;
      void getCurrentWindow().setTitle(title);
    }
  }
}

/** Режим вкладки с файлом — из настроек. Из чтения Ctrl+E ведёт в Live Preview. */
function initialModes(): Pick<Page, "mode" | "editingMode"> {
  const mode = currentSettings().default_mode;
  return { mode, editingMode: mode === "reading" ? "live" : mode };
}

/** Новый документ — чтобы писать, поэтому сразу режим правки, а не чтение. */
function newDocumentModes(): Pick<Page, "mode" | "editingMode"> {
  const { editingMode } = initialModes();
  return { mode: editingMode, editingMode };
}

function formatOf(document: OpenedDocument): FormatInfo {
  return {
    lineEnding: document.lineEnding,
    hasBom: document.hasBom,
    mixedLineEndings: document.mixedLineEndings,
  };
}

/**
 * Подписи вкладок. Одинаковые имена файлов из разных папок дополняются
 * именем папки: «README.md · docs» и «README.md · src».
 */
function tabLabels(tabs: readonly Tab[]): string[] {
  const counts = new Map<string, number>();
  for (const tab of tabs) counts.set(tab.fileName, (counts.get(tab.fileName) ?? 0) + 1);
  return tabs.map((tab) =>
    tab.path !== null && (counts.get(tab.fileName) ?? 0) > 1
      ? `${tab.fileName} · ${parentDirName(tab.path)}`
      : tab.fileName,
  );
}

function parentDirName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-2) ?? "";
}
