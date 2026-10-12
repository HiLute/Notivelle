# Словари проверки орфографии

Словари в формате Hunspell, вшиваются в программу при сборке
(`src/spellcheck.rs`, `include_str!`).

| Файлы | Язык | Источник | Лицензия |
|---|---|---|---|
| `ru_RU.aff`, `ru_RU.dic` | русский | [dictionary-ru 3.0.0](https://github.com/wooorm/dictionaries/tree/main/dictionaries/ru) — словарь LibreOffice А. И. Лебедева в UTF-8 | BSD-3-Clause, `ru_RU.LICENSE` |
| `en_US.aff`, `en_US.dic` | английский (США) | [dictionary-en 4.0.0](https://github.com/wooorm/dictionaries/tree/main/dictionaries/en) — SCOWL, en_US | MIT и BSD, `en_US.LICENSE` |

Файлы скопированы без изменений (`index.aff` → `*.aff`, `index.dic` → `*.dic`,
`license` → `*.LICENSE`).
