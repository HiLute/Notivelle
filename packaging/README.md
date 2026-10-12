# Сборка и установка Notivelle

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

## Где программа хранит данные

- `~/.config/dev.maksim.notivelle/` — `settings.toml` и личный словарь
  `dictionary.txt`. При первом запуске Notivelle переносит их из каталога,
  который был у программы до переименования (`dev.maksim.md-editor`).
- `~/.local/share/dev.maksim.notivelle/` — кеш WebView. Прежний
  `~/.local/share/dev.maksim.md-editor/` больше не нужен, его можно удалить.
