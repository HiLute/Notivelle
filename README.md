# Notivelle

Редактор Markdown в духе [Obsidian](https://obsidian.md), но для **отдельных
файлов**: без хранилища (vault), без настройки папок. Дважды щёлкнули по
`.md` — файл открылся вкладкой, его можно править в Live Preview и сохранить,
не боясь испортить.

Сделан на [Tauri 2](https://tauri.app) и [CodeMirror 6](https://codemirror.net),
основная логика — на Rust.

## Возможности

- **Три режима, как в Obsidian.** Live Preview (разметка видна только там,
  где курсор), чтение и исходник; переключаются Ctrl+E и Ctrl+Shift+E или
  кнопками в строке состояния. У каждой вкладки свой режим.
- **Callouts** `> [!note]` со всеми типами и синонимами Obsidian,
  сворачивание через `+`/`-`.
- **Формулы** KaTeX (`$…$`, `$$…$$`) и **диаграммы** Mermaid — и в чтении, и
  в Live Preview.
- **Таблицы** правятся на месте, как в Obsidian: Tab, Enter и стрелки ходят
  по ячейкам, у строк и столбцов есть меню и перетаскивание.
- **Задачи** `- [ ]` отмечаются щелчком и в Live Preview, и в режиме чтения.
- **Проверка орфографии** для русского и английского (словари Hunspell,
  проверка на Rust), варианты исправления и личный словарь.
- **Вкладки**, как в Kate: повторный запуск программы открывает файл вкладкой
  в уже открытом окне.
- **Слежение за файлами:** если файл изменила другая программа, вкладка без
  правок обновится сама, а при несохранённых правках появится выбор.
- **Файлы сохраняются байт в байт:** переводы строк (LF/CRLF), BOM и
  последний перевод строки остаются как были; запись атомарная.
- Настройки: тема (светлая, тёмная, как в системе), шрифты интерфейса, текста
  и кода из установленных в системе, размер шрифта, ширина строки, режим
  Vim. Хранятся в `settings.toml`, который можно править руками.
- Работает без интернета: шрифты, KaTeX и Mermaid лежат внутри программы.

## Установка

Готовые сборки — на странице [Releases](../../releases):

| Система | Файл |
|---|---|
| Windows | `Notivelle_*_x64-setup.exe` или `.msi` |
| macOS (Apple Silicon и Intel) | `Notivelle_*_universal.dmg` |
| Arch Linux, Omarchy | `notivelle-*.pkg.tar.zst` — `sudo pacman -U notivelle-*.pkg.tar.zst` |

Сборки не подписаны. Windows SmartScreen может предупредить при запуске
установщика («Подробнее» → «Выполнить в любом случае»). Если macOS пишет, что
программа повреждена: `xattr -cr /Applications/Notivelle.app`.

Сделать Notivelle программой по умолчанию для Markdown в Linux:

```sh
xdg-mime default Notivelle.desktop text/markdown
```

## Использование

```sh
notivelle заметка.md "ещё одна заметка.md"
notivelle --help
```

Без файлов программа начинает с пустого документа; первое сохранение
спросит имя файла. Из терминала Notivelle уходит в фон, и терминал сразу
свободен.

| Клавиши | Действие |
|---|---|
| Ctrl+N | Новый документ |
| Ctrl+O | Открыть файлы |
| Ctrl+S | Сохранить |
| Ctrl+W | Закрыть вкладку |
| Ctrl+Tab, Ctrl+PageDown / PageUp | Следующая / предыдущая вкладка |
| Ctrl+E | Чтение ⇄ правка |
| Ctrl+Shift+E | Live Preview ⇄ исходник |
| Ctrl+F | Поиск и замена |
| Ctrl+, | Настройки |

Сочетания работают и в русской раскладке.

## Сборка из исходников

Нужны [Rust](https://rustup.rs) (stable) и [Node.js](https://nodejs.org) с
npm, а в Linux ещё WebKitGTK 4.1 (`webkit2gtk-4.1` в Arch,
`libwebkit2gtk-4.1-dev` в Debian и Ubuntu) — подробнее в
[требованиях Tauri](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run tauri dev      # запуск для разработки
npm run check          # tsc, rustfmt, clippy и тесты Rust
npm run tauri build    # установщики в src-tauri/target/release/bundle/
```

Пакет для Arch Linux:

```sh
cd packaging/arch
makepkg -si
```

Подробнее о пакетах и выпуске релизов — в [packaging/README.md](packaging/README.md),
об устройстве программы и планах — в [docs/PLAN.md](docs/PLAN.md).

## Лицензия

[MIT](LICENSE). Словари проверки орфографии распространяются под своими
лицензиями — см. [src-tauri/dictionaries](src-tauri/dictionaries).
