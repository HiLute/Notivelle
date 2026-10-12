import { api, errorMessage, type LoadedSettings, type Settings } from "./ipc";

/**
 * Текущие настройки во фронтенде. Хранит их Rust (config.rs, файл
 * settings.toml); здесь — копия, которую читают редактор и панель настроек.
 */

/** Те же значения, что `Settings::default()` в config.rs: до загрузки и на случай ошибки. */
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  theme: "system",
  default_mode: "live",
  interface_font: "",
  text_font: "",
  monospace_font: "",
  font_size: 16,
  readable_line_length: true,
  spellcheck: true,
  vim: false,
};

/** Пределы размера шрифта — как FONT_SIZES в config.rs. */
export const FONT_SIZE_RANGE = { min: 10, max: 32 } as const;

type Listener = (settings: Readonly<Settings>, previous: Readonly<Settings>) => void;

let current: Readonly<Settings> = DEFAULT_SETTINGS;
const listeners = new Set<Listener>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function currentSettings(): Readonly<Settings> {
  return current;
}

/** Подписка на любые изменения настроек (и на загрузку при старте). */
export function onSettingsChange(listener: Listener): void {
  listeners.add(listener);
}

/**
 * Загружает настройки при запуске. В ответе ещё путь к файлу настроек и
 * проблема с ним, если файл испорчен (тогда действуют настройки по умолчанию).
 */
export async function loadSettings(): Promise<LoadedSettings> {
  const loaded = await api.getSettings();
  replace(loaded.settings);
  return loaded;
}

/**
 * Меняет настройки: сразу применяет и чуть позже сохраняет на диск — так
 * перетаскивание ползунка размера шрифта не пишет файл на каждый шаг.
 */
export function updateSettings(patch: Partial<Settings>, onError: (message: string) => void): void {
  replace({ ...current, ...patch });
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const wanted = current;
    api
      .saveSettings(wanted)
      .then((saved) => {
        // Rust мог поправить значение (например, размер шрифта вне пределов).
        if (current === wanted && JSON.stringify(saved) !== JSON.stringify(wanted)) replace(saved);
      })
      .catch((error: unknown) => onError(`Настройки не сохранены: ${errorMessage(error)}`));
  }, 300);
}

function replace(next: Settings): void {
  const previous = current;
  current = Object.freeze({ ...next });
  for (const listener of listeners) listener(current, previous);
}
