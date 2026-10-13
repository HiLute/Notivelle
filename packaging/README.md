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

### Новая версия

Версия записана в нескольких файлах, и все они должны совпадать:

| Файл | Что поменять | Как |
|---|---|---|
| `src-tauri/Cargo.toml` | `version = "X.Y.Z"` | руками; отсюда версию берут Tauri (настройки → «О программе», установщики), `release.yml` и `pkgver()` |
| `src-tauri/Cargo.lock` | версия пакета `notivelle` | `cargo update --workspace` в `src-tauri` (зависимости не трогает) |
| `package.json` и `package-lock.json` | `"version"` (в lock — два места) | `npm version X.Y.Z --no-git-tag-version` |
| `packaging/arch/PKGBUILD` | `pkgver=X.Y.Z` | руками; это только подсказка, настоящую версию считает `pkgver()` |

В `tauri.conf.json` версии нет — Tauri берёт её из `Cargo.toml`.

Потом коммит и тег — без тега пакет и релиз будут не `X.Y.Z`:

```sh
git commit -am "Версия X.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z    # запускает release.yml
```

Почему без коммита и тега версия не меняется: `makepkg` собирает не рабочую
папку, а клон закоммиченного состояния (источник `git+file`), а версию пакета
считает `pkgver()`: на коммите с тегом `vX.Y.Z` это `X.Y.Z`, иначе — версия
из закоммиченного `Cargo.toml` плюс номер и хеш коммита (`0.2.0.r16.ab12cd3`).
Эту версию `makepkg` записывает и в строку `pkgver=` самого PKGBUILD, поэтому
между релизами после сборки PKGBUILD окажется изменённым — эту правку
коммитить не нужно, её можно отменить (`git restore packaging/arch/PKGBUILD`).

`release.yml` проверяет, что тег совпадает с версией в `Cargo.toml`, иначе
релиз не создаётся.

Проверить сборки без релиза: Actions → Release → Run workflow. Файлы
останутся в артефактах запуска.

Если сборка по тегу упала, релиз остаётся черновиком. Исправьте ошибку,
закоммитьте и переставьте тег на новый коммит — Release запустится заново,
найдёт тот же черновик и заменит в нём файлы:

```sh
git push origin main
git tag -f vX.Y.Z
git push --force origin vX.Y.Z
```

Установщик MSI собирается на русском (`src-tauri/tauri.windows.conf.json`,
строки — `src-tauri/windows/ru-RU.wxl`): WiX пишет строки в однобайтовой
кодировке Windows, и с английской (1252) он не может записать кириллическое
описание типа файла. NSIS (`setup.exe`) — в Юникоде; он говорит по-русски
или по-английски, смотря по языку Windows.

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
