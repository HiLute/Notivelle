import { defineConfig } from "vite";

// Tauri CLI задаёт TAURI_DEV_HOST при разработке на удалённом устройстве;
// на десктопе переменной нет и сервер слушает только localhost.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Не очищать терминал: иначе пропадают сообщения от cargo.
  clearScreen: false,
  server: {
    // Tauri ждёт фронтенд по фиксированному адресу (devUrl в tauri.conf.json).
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust-часть пересобирает Tauri CLI, Vite за ней следить не нужно.
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // WebKitGTK, WebView2 и WKWebView поддерживают ES2022 целиком.
    target: "es2022",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
