# Volyn settlements: source note

`settlements.json` is the list of settlements of Volyn oblast that the setup wizard offers for the Volynoblenergo source. The operator has no settlement-list endpoint, so the list is bundled.

## Source

- Dataset: «Кодифікатор адміністративно-територіальних одиниць та територій територіальних громад» (КАТОТТГ), published by the Ministry for Development of Communities and Territories of Ukraine on data.gov.ua: https://data.gov.ua/dataset/43c2a113-a032-4c8a-a409-3b5e1660bb38
- File used: resource «Кодифікатор.xlsx» (`kodifikator.xlsx`), last modified 2021-12-30, 1,476,983 bytes: https://data.gov.ua/dataset/2f4beef4-6bba-43d3-9e9e-120c696f1123/resource/baa61b78-4e0d-499f-89d9-f2863abdb094/download/kodifikator.xlsx
- Edition: order of the Ministry of 26.11.2020 No. 290 as amended by 12.01.2021 No. 3, the sheet header; the file is the 30 December 2021 upload (the newest xlsx on data.gov.ua; the ministry's own site answered 403 to scripted requests, and the stat.gov.ua page only lists the amending orders, up to 14.01.2025 No. 42, without a file). Settlement renames and mergers after that upload are therefore not in the list.
- Retrieved: 2026-10-20.

## How the list was generated

One-off, no change to `package.json`. A throwaway Node script (not committed):

1. Read the .xlsx with `node:zlib`: parse the zip central directory, inflate `xl/sharedStrings.xml` and `xl/worksheets/sheet1.xml`, and turn the rows into `{A..G}` cells (A-E are the code of each level, F the category, G the name).
2. Keep rows whose first-level code is `UA07000000000024379` (Волинська область).
3. The district comes from the level-2 row of the code (category `P`). The names are mapped to the post-2020 districts without «район»: Володимир-Волинський -> Володимирський, Камінь-Каширський, Ковельський, Луцький.
4. Keep the rows with category М, Т, Х or С and write `{name, kind, raion}`; sort by name (`localeCompare` `uk`). Identical entries (same kind, name and district) are collapsed.

## Category mapping

| КАТОТТГ category | `kind` | label prefix |
| --- | --- | --- |
| М (місто) | `м` | `м.` |
| Т (селище міського типу) | `с-ще` | `с-ще` |
| Х (селище) | `с-ще` | `с-ще` |
| С (село) | `с` | `с.` |

## Counts

- Rows of categories М, Т, Х, С in the file: 1,087 (М 11, Т 22, Х 0, С 1,054).
- After collapsing the same name in the same district: 1,065 entries (М 11, Т 22, С 1,032). 22 duplicates collapsed, for example the two villages Бубнів in the Володимирський district.
- 53 labels occur in more than one district (112 entries); `voeSettlements()` appends ` (<район> р-н)` to those. Labels are unique.
- Districts: Ковельський 372, Луцький 342, Володимирський 199, Камінь-Каширський 152.

## Live checks (2026-10-20)

`POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/`, body `formCity=<name>&formStreet=%` (UTF-8). «Rows» are rows whose «Нас. пункт» equals the name; the operator's match is by substring, so the full answer has more.

| Name | Operator rows found | «Район» values seen | Decision |
| --- | --- | --- | --- |
| Луцьк | 3,544 (3,673 incl. substring matches, e.g. Прилуцьке) | Луцький | spelling OK, no `operatorName` |
| Ковель | 1,848 (1,908 incl. Воля-Ковельська) | Ковельський | OK |
| Володимир | 954 (967 incl. Володимирівка) | `Володимирcький` | OK (see district note) |
| Нововолинськ | 930 | `Володимирcький` | OK (see district note) |
| Заріччя (name in 3 districts of the list) | 82: Володимирський 48, Ковельський 20, Луцький 14 | `Володимирcький`, Ковельський, Луцький | OK; the operator's three districts match the three in the list, so a district filter can tell them apart |

District note: the operator uses the post-2020 districts (Луцький, Ковельський, Володимирський, Камінь-Каширський), but writes Володимирський with a Latin `c` in the middle (`Володимир` + `c` U+0063 + `ький`). Compare «Район» normalized (map Latin look-alikes to Cyrillic) or fall back to the name alone. No `operatorName` was needed, because every checked name returned rows. Other names were not checked (no crawling).

## Namesakes that differ by kind alone (live check 2026-10-20)

Four names repeat in another district with a different kind, so their labels carry no ` (<район> р-н)`. The provider filters them by district too: the filter keys on the name the operator sees, not on the label. The same `cherga` form, `formStreet=%`:

| `formCity` sent | Rows per «Район» and exact «Нас. пункт» | In the list |
| --- | --- | --- |
| `Луків` | Ковельський 143, Луцький 14 (plus Луківка 7) | с-ще Луків (Ковельський), с. Луків (Луцький) |
| `Заболоття` | Ковельський 184, `Володимирcький` 3 | с. Заболоття (Ковельський р-н), с. Заболоття (Володимирський р-н), с-ще Заболоття (Ковельський) |
| `Мар’янівка` | Луцький 101, Ковельський 3 (plus Богушівська Мар’янівка 2) | с. Мар’янівка (Луцький р-н), с. Мар’янівка (Ковельський р-н), с-ще Мар’янівка (Луцький) |

Before the fix, «с. Луків» showed the 143 Ковельський rows of «с-ще Луків» as well. The с. and с-ще of one name in one district (Заболоття in Ковельський, Мар’янівка in Луцький, Дубище in Луцький) stay merged, because the operator cannot tell them apart either.

## Apostrophes (live check 2026-10-20)

All 25 bundled names with an apostrophe use U+2019 (`’`), as КАТОТТГ does. One village was sent to the same `cherga` form twice, `formStreet=%`:

| `formCity` sent | HTTP | Table rows | Rows whose «Нас. пункт» is the name verbatim | «Нас. пункт» as the operator writes it | «Район» |
| --- | --- | --- | --- | --- | --- |
| `В’язівне` (U+2019) | 200 | 17 | 17 | `В’язівне` (U+2019) | Камінь-Каширський |
| `В'язівне` (U+0027) | 200 | 17 | 0 | `В’язівне` (U+2019) | Камінь-Каширський |

The operator stores this name with U+2019, like the list, and its search finds it with either apostrophe (the same 43,631-byte answer). So the bundled names are sent as they are, with no `operatorName`. The rows still come back with U+2019 when U+0027 is sent, so the provider compares settlement, street and house names through `names.ts` (one apostrophe, Latin look-alikes as Cyrillic), never verbatim. In the saved Kovel table the streets mix both apostrophes too (`В'ячеслава Хурсенка` with U+0027, `Левка Лук’яненка` with U+2019).
