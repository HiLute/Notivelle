//! Команды, которые фронтенд вызывает через `invoke()`.
//!
//! Каждая функция с атрибутом `#[tauri::command]` должна быть перечислена в
//! `tauri::generate_handler![]` в `lib.rs`, иначе фронтенд её не увидит.
//! Возвращаемое значение Tauri сериализует в JSON через `serde`.

use serde::Serialize;

/// Сведения о сборке для строки состояния.
///
/// `rename_all = "camelCase"` переименовывает поля при сериализации:
/// `tauri_version` в Rust становится `tauriVersion` в JSON, как принято в TS.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: &'static str,
    version: &'static str,
    tauri_version: &'static str,
    os: &'static str,
}

impl AppInfo {
    /// Сведения о текущей сборке.
    ///
    /// Всё здесь известно ещё при компиляции: `env!` подставляет значения из
    /// `Cargo.toml`, а `std::env::consts::OS` — константа целевой платформы.
    /// Поэтому поля имеют тип `&'static str`: строки лежат в самом бинарнике,
    /// в кучу ничего не копируется.
    fn current() -> Self {
        Self {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            tauri_version: tauri::VERSION,
            os: std::env::consts::OS,
        }
    }
}

/// Возвращает сведения о сборке: имя, версию приложения, версию Tauri и ОС.
#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo::current()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Фронтенд ждёт поля в camelCase (`interface AppInfo` в `src/main.ts`).
    /// Тест фиксирует этот контракт: переименуют поле, и он упадёт.
    #[test]
    fn app_info_serializes_in_camel_case() {
        let json = serde_json::to_value(AppInfo::current()).expect("AppInfo сериализуется в JSON");

        assert_eq!(json["name"], env!("CARGO_PKG_NAME"));
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(json["tauriVersion"], tauri::VERSION);
        assert_eq!(json["os"], std::env::consts::OS);
        assert!(json.get("tauri_version").is_none());
    }
}
