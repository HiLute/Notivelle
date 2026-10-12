import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorMessage, type DocumentId, type FormatInfo, type OpenedDocument } from "./ipc";
import type { StatusBar } from "./statusbar";

const APP_TITLE = "md-editor";

/** Открытый в редакторе файл. */
interface OpenFile {
  id: DocumentId;
  path: string;
  fileName: string;
  format: FormatInfo;
  /**
   * Содержимое на момент открытия или последнего сохранения. Документ
   * «грязный», если текущий текст от него отличается; правка с последующей
   * отменой снова делает его чистым.
   */
  savedDoc: Text;
}

/**
 * Документ в редакторе и операции над ним: открыть, сохранить, спросить о
 * несохранённых изменениях. Пока вкладок нет (они появятся в M2), документ
 * один; без файла показывается приветственная страница.
 */
export class DocumentSession {
  readonly #view: EditorView;
  readonly #createState: (text: string) => EditorState;
  readonly #statusBar: StatusBar;
  #file: OpenFile | null = null;
  /** Идёт операция с диалогом: вторую параллельно не запускаем. */
  #busy = false;
  #shownTitle = "";

  constructor(view: EditorView, createState: (text: string) => EditorState, statusBar: StatusBar) {
    this.#view = view;
    this.#createState = createState;
    this.#statusBar = statusBar;
  }

  get isDirty(): boolean {
    return this.#file !== null && !this.#view.state.doc.eq(this.#file.savedDoc);
  }

  /** Вызывается редактором при каждом изменении текста. */
  handleDocChanged(): void {
    this.#refreshChrome();
  }

  /** Показывает документ в редакторе вместо текущего. */
  show(document: OpenedDocument): void {
    const previous = this.#file;
    const state = this.#createState(document.text);
    // Новое состояние, а не замена текста: история отмены не должна
    // тянуться из предыдущего файла.
    this.#view.setState(state);
    this.#file = {
      id: document.id,
      path: document.path,
      fileName: document.fileName,
      format: {
        lineEnding: document.lineEnding,
        hasBom: document.hasBom,
        mixedLineEndings: document.mixedLineEndings,
      },
      savedDoc: state.doc,
    };
    if (previous) void api.closeDocument(previous.id);

    this.#statusBar.setCursor(state);
    this.#refreshChrome();
    if (document.mixedLineEndings) {
      this.#statusBar.showMessage(
        `В файле смешанные переводы строк: при сохранении все станут ${document.lineEnding}`,
      );
    }
    this.#view.focus();
  }

  /** Ctrl+O: спросить о несохранённом, показать диалог, открыть файл. */
  openWithDialog(): Promise<void> {
    return this.#exclusive(undefined, async () => {
      if (!(await this.#resolveUnsaved())) return;
      const document = await api.openDocumentDialog();
      if (document) this.show(document);
    });
  }

  /** Ctrl+S. */
  save(): Promise<void> {
    return this.#exclusive(undefined, async () => {
      if (!this.#file) {
        this.#statusBar.showMessage("Это приветственная страница. Откройте файл: Ctrl+O");
        return;
      }
      if (!this.isDirty) {
        this.#statusBar.showMessage("Изменений нет");
        return;
      }
      if (await this.#saveCurrent()) this.#statusBar.showMessage("Сохранено");
    });
  }

  /**
   * Можно ли закрыть окно. Если есть несохранённые изменения, спрашивает
   * пользователя. Пока идёт другая операция (например, открыт диалог),
   * окно не закрываем.
   */
  confirmClose(): Promise<boolean> {
    return this.#exclusive(false, () => this.#resolveUnsaved());
  }

  /**
   * true — можно продолжать: изменений нет, они сохранены или пользователь
   * решил их не сохранять. false — пользователь отменил действие.
   */
  async #resolveUnsaved(): Promise<boolean> {
    if (!this.#file || !this.isDirty) return true;
    const choice = await api.askUnsavedChanges(this.#file.id);
    switch (choice) {
      case "save":
        return this.#saveCurrent();
      case "discard":
        return true;
      case "cancel":
        return false;
    }
  }

  async #saveCurrent(): Promise<boolean> {
    const file = this.#file;
    if (!file) return true;
    // Снимок документа на момент сохранения: пока Rust пишет файл,
    // пользователь может продолжать печатать, и эти правки останутся
    // несохранёнными.
    const doc = this.#view.state.doc;
    const format = await api.saveDocument(file.id, doc.toString());
    if (!format) return false;
    file.savedDoc = doc;
    file.format = format;
    this.#refreshChrome();
    return true;
  }

  /**
   * Запускает операцию, если не идёт другая, и показывает её ошибки в
   * строке состояния. `whenBusy` — что вернуть, если операция не запущена.
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

  /** Заголовок окна и строка состояния. */
  #refreshChrome(): void {
    const file = this.#file;
    this.#statusBar.setFile(file ? file.path : "Приветственная страница", file?.path);
    this.#statusBar.setFormat(file?.format ?? null);

    const title = file ? `${this.isDirty ? "● " : ""}${file.fileName} — ${APP_TITLE}` : APP_TITLE;
    // Заголовок меняется через IPC, поэтому не дёргаем его на каждую букву.
    if (title !== this.#shownTitle) {
      this.#shownTitle = title;
      void getCurrentWindow().setTitle(title);
    }
  }
}
