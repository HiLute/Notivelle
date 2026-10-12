Notivelle — редактор Markdown-файлов в духе Obsidian, но для отдельных файлов, без хранилища: Live Preview, чтение и исходник, callouts, формулы KaTeX, диаграммы Mermaid, проверка орфографии (ru, en).

## Установка

**Windows** — `Notivelle_*_x64-setup.exe` (или `.msi`). Установщик не подписан, поэтому SmartScreen может предупредить: «Подробнее» → «Выполнить в любом случае».

**macOS** — `Notivelle_*_universal.dmg` (Apple Silicon и Intel). Программа не подписана Apple: если macOS пишет, что она повреждена, выполните в терминале
```sh
xattr -cr /Applications/Notivelle.app
```

**Arch Linux, Omarchy** — `notivelle-*.pkg.tar.zst`:
```sh
sudo pacman -U notivelle-*.pkg.tar.zst
xdg-mime default Notivelle.desktop text/markdown   # открывать .md в Notivelle
```
