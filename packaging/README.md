# Сборка и установка Notivelle

Готовые сборки для Windows, macOS и Arch Linux — на странице GitHub Releases
(как их выпустить — в конце файла).

## Arch Linux и Omarchy

```sh
cd packaging/arch
makepkg -si
```

`makepkg` клонирует этот репозиторий (только закоммиченное), собирает
программу и ставит пакет `notivelle` через pacman. Нужны Rust (`rustup`) и
Node.js с npm в `PATH` — в Omarchy Node ставится через mise.

После установки в меню появится Notivelle, а в системе — бинарник
`/usr/bin/notivelle`, файл `/usr/share/applications/Notivelle.desktop` и
иконки. Удаление: `sudo pacman -R notivelle`.

## Другие дистрибутивы

```sh
npm ci
npm run tauri build
```

Пакеты появятся в `src-tauri/target/release/bundle/`: `deb/` (Debian, Ubuntu)
и `rpm/` (Fedora, openSUSE). AppImage собирается отдельно, Tauri при этом
скачивает linuxdeploy: `npm run tauri build -- --bundles appimage`.

## Запуск из терминала

```sh
notivelle заметка.md "ещё одна заметка.md"
notivelle --help
```

Если Notivelle уже запущен, файлы откроются вкладками в его окне. Без файлов
программа начинает с пустого документа. Из терминала она уходит в фон, и
терминал сразу свободен; остаться в нём (чтобы видеть сообщения):
`NOTIVELLE_FOREGROUND=1 notivelle …`.

## Программа по умолчанию для Markdown

`.desktop`-файл объявляет `text/markdown`, так что Notivelle есть в списке
«Открыть с помощью». Сделать её программой по умолчанию:

```sh
xdg-mime default Notivelle.desktop text/markdown
```

Проверка: `xdg-mime query default text/markdown`. Настройка пишется в
`~/.config/mimeapps.list`; вернуть прежнюю программу — той же командой с её
`.desktop`-файлом.

## Выпуск релиза (GitHub Actions)

- `.github/workflows/ci.yml` — на каждый push в `main` и pull request:
  `npm run build` и `npm run check` (tsc, rustfmt, clippy, тесты) на Linux,
  Windows и macOS.
- `.github/workflows/release.yml` — по тегу `v*`:
  1. проверяет, что тег совпадает с версией в `src-tauri/Cargo.toml`, и
     создаёт черновик релиза с текстом из `.github/release-notes.md`;
  2. собирает установщики Windows (NSIS `setup.exe` и MSI) и универсальный
     DMG для macOS (`tauri-action`);
  3. собирает пакет Arch (`makepkg` в контейнере `archlinux:base-devel`);
  4. загружает всё в релиз и публикует его.

Выпустить версию:

```sh
# версия в src-tauri/Cargo.toml (и package.json) уже 0.1.0
git tag v0.1.0
git push origin main v0.1.0
```

Проверить сборки без релиза: Actions → Release → Run workflow. Файлы
останутся в артефактах запуска.

Сборки не подписаны: Windows SmartScreen предупредит при запуске
установщика, а macOS может назвать программу повреждённой — лечится
`xattr -cr /Applications/Notivelle.app`. Для подписи нужны сертификаты
(Apple Developer, Windows code signing).

## Где программа хранит данные

- `~/.config/dev.maksim.notivelle/` — `settings.toml` и личный словарь
  `dictionary.txt`. При первом запуске Notivelle переносит их из каталога,
  который был у программы до переименования (`dev.maksim.md-editor`).
- `~/.local/share/dev.maksim.notivelle/` — кеш WebView. Прежний
  `~/.local/share/dev.maksim.md-editor/` больше не нужен, его можно удалить.
