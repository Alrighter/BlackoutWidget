# More outage-schedule sources: Kyiv, Volyn (Kovel), Odesa, Dnipro

Date: 2026-10-20. Status: design for review.

Research behind this document, with real responses and what was fetched live versus only read about: `docs/superpowers/research/2026-10-20-outage-sources/` (`kyiv.md`, `volyn.md`, `ukraine.md`, and two sample Volyn schedule images).

## Intent

Today the widget reads one source, the DTEK Kyiv Regional site (`dtek-krem`, Kyiv oblast). The user asked to add sources for other places in Ukraine and named Kovel and Kyiv. The research came back with an order the user approved («підходить»):

1. **Now (this document):**
   - Kyiv city: DTEK Kyiv Electric Networks.
   - Volyn oblast, including Kovel: Volynoblenergo.
   - Odesa oblast: DTEK Odesa.
   - Dnipropetrovsk oblast: DTEK Dnipro, which also carries the CEK groups.
2. **Next step (a separate document):** Lviv, Ternopil, Mykolaiv, Zhytomyr and Chernivtsi. Each has its own service with an address lookup.

## Goals

- The setup wizard offers five sources: the current Kyiv oblast one plus the four above. A person picks their region, then their address, exactly as today.
- The widget, tray, schedule view and actual-power features work the same for every source.
- Anyone already set up on `dtek-krem` sees no change, except the quiet-day rule below, which the user chose for every provider («робимо так»).

## Non-goals

- YASNO's API for Kyiv. It could remove the captcha from refreshes later; that is its own change.
- The five «easy» regions of step 2.
- Third-party aggregator repositories (`yaroslav2901/OE_OUTAGE_DATA`, `Baskerville42/outage-data-ua`). They have no licence and one maintainer each.
- The emergency-queue schedules (ГАВ). They are not published as time grids.
- A manual «pick your queue» mode for regions without an address lookup.
- DTEK Donetsk: its engine could not be confirmed behind the bot wall.

## Anti-goals (failure even if it «works»)

- **Never show «світло є» when the source failed or could not be read.** A Volyn image that does not parse cleanly is an error, never all «on».
- **No extra load on DTEK.** Each DTEK site gets its own hidden browser session, created only when that provider is used. A person set up on one provider never loads another provider's site in the background.
- **No unlicensed data bundled.** `Elvis129/prosvitlo-addresses-db` has no licence and is not used.
- **No cloud relay.** All requests go from the person's machine. Volynoblenergo reportedly blocks foreign and datacenter IPs anyway.

## The sources

### DTEK family: Kyiv city, Odesa, Dnipro

All three run the same page engine as `dtek-krem`: the `/ua/shutdowns` page, the `DisconSchedule` global (`fact`, `preset.sch_names`, `streets`), and `POST /ua/ajax` `getHomeNum`. The same Imperva bot wall is there too, but each site is a separate Imperva site with its own cookies. The research verified this live (Odesa and Dnipro in `ukraine.md` §1; Kyiv in `kyiv.md` §2).

| id | Display name | Region card | Site |
|---|---|---|---|
| `dtek-kem` | ДТЕК Київські електромережі | м. Київ | `https://www.dtek-kem.com.ua/ua/shutdowns` |
| `dtek-oem` | ДТЕК Одеські електромережі | Одеська область | `https://www.dtek-oem.com.ua/ua/shutdowns` |
| `dtek-dnem` | ДТЕК Дніпровські електромережі | Дніпропетровська область | `https://www.dtek-dnem.com.ua/ua/shutdowns` |

- **One provider class.** The current `DtekKremProvider` becomes a DTEK provider configured by id, site and whether the site has a city level. All the parsing, line, outage and retry logic is shared. Log lines carry the provider id instead of a hard-coded `dtek-krem`. The Imperva-page detection in `browser-session.ts` (the `/ДТЕК|dtek-krem/` test) must work for every DTEK host.
- **Each provider gets its own session:** partition `persist:<id>`, its own allowed host, and the same ready check, timer neutralizing and poll blocking as today.
- **Kyiv city has no city level.**
  - `DisconSchedule.streets` is a flat list of about 2,500 streets.
  - The form has no `city` field.
  - `getHomeNum` gave identical answers with `city` omitted, empty, or `м. Київ`.

  So `listCities()` returns `['м. Київ']`, `listStreets` returns the flat list whatever the city, and `getHomeNum` is sent without a city.
- **Kyiv has 60 groups.** Since 29 Jan 2026 Kyiv uses 60 groups (`GPV1.1` … `GPV60.1`) assigned per building. Labels come from `preset.sch_names` as today.
- **Dnipro also carries CEK.** The DNEM object also holds the CEK groups (`GPV1001.x`, labelled «ЦЕК n.n» in `sch_names`). No separate CEK provider is needed, provided a CEK-served house really comes back from `getHomeNum` with its `GPV1001.x` group.
  - That was seen only in `sch_names` on a quiet day, so a live `getHomeNum` for a CEK house is part of the work.
  - If DNEM gives CEK houses no group, CEK is left out of this step: those houses get today's «не публікує графік» note, and CEK moves to step 2. This is my call; the alternative is the cek.dp.ua address map, which is larger work.
- **Captcha.** The «пройти перевірку» flow works per provider: it opens that provider's own hidden window.

### Volynoblenergo: Volyn oblast, Kovel

Id `voe`, display name «Волиньобленерго», region card «Волинська область». There is no hidden browser window. Requests go from the main process over plain HTTPS with Electron's `net`, and form bodies are UTF-8 URL-encoded. Cloudflare sits in front but served no challenge in testing. The details of every endpoint are in `volyn.md`.

**Schedule (`fetchSnapshot`).**
- **Source.** The hourly schedule is published only as a PNG: one oblast-wide picture per day, with 12 rows (queues 1.1 … 6.2) and 48 half-hour columns in two colours.
- **Finding the images.**
  - `GET https://api-voe-poweron.inneti.net/api/archive_gpv_graphs?dateGraph[after]=<today, Kyiv>` lists the published images with their dates.
  - Take the newest entry for each `dateGraph`. Key by date, never by the `pw_gpv_image_today` option, which can point at an older day.
  - The `dateCreate`/`dateGraph` values are Kyiv local time mislabelled `+00:00`. `imageUrl.uploadTimestamp` is true UTC. `sourceUpdatedAt` comes from `uploadTimestamp`, shown in the same style as DTEK's.
- **Reading the image.** Download the PNG only when its URL changed since the last fetch. Decode it with a small in-house PNG reader on `node:zlib` (8-bit RGB or RGBA, not interlaced, which is what the operator publishes; anything else fails closed). Revised while planning: `nativeImage` returns pixels in a platform-specific channel order and cannot run under vitest, so the same reader serves the app and the tests. No dependency is added.
  - Geometry, measured on the 1750×2250 image:
    - time columns: x = 176 … 1726;
    - top-half rows: y = 417 … 1131;
    - bottom-half rows: y = 1304 … 2019.
  - Sample a small patch at each cell centre. Classify by distance to:
    - light `#B8C8D8` → `on`;
    - dark `#446F9B` → `off`.
  - There is no «maybe off» in this source.
- **The source stays alive.** On every fetch, check that the unfiltered archive (`archive_gpv_graphs?page=1`) is not empty and that its newest entry has a sane date. If not, the fetch fails, so a dead or moved source never passes for a quiet day. There is no time-based warning: real gaps between images last up to three months. My call.
- **Fail closed.** If the image size differs, or more than a few cells match neither colour, the fetch fails with a clear error and the previous snapshot rules apply, as for any failed refresh. The 2026-10-17 image (`volyn-gpv-2026-10-17.png`) is the test fixture. Its per-queue off-hours must equal the image's own «Загальна тривалість» header: 4, 3.5, 3.5, 3.5, 3, 3, 3.5, 3.5, 1, 1.5, 4, 1.
- **A day with no image** follows the quiet-day rule below. Today without an image is all `on` with the note; tomorrow without one is left out.
- **Current outage.**
  - `POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/chomu-nemaie-elektropostachannia/` with the city and a blank street lists the settlement's live planned and emergency outages per street and house, with start and estimated end. The street is matched in the app, so the operator's other apostrophe or a look-alike letter cannot hide a row.
  - The house cell is a comma list, the same as in `cherga` (checked on the saved Kovel response: «1, 2, 3, 4, 5, 6, 9, 9А, 10, 12»). Match the saved house in that list, and keep only rows whose settlement equals the saved city exactly (the match is by substring).
  - «Аварійне вимкнення» and «Позапланове вимкнення» → `kind: 'emergency'`.
  - «Планове вимкнення» for the saved house → a new `kind: 'planned'`. It overrides the schedule exactly like an emergency, with the badge «Планове». My call: the operator names the house and the hours, so showing «світло є» through it would be wrong. `activeEmergency` in `src/shared/widget-state.ts` and its badge are extended for it. DTEK never fills this kind.
  - Rows about applying the hourly schedule («застосування графіків обмеження», if they appear) are ignored. The image already covers them.
  - The text is the «Причина» column.
  - If this request fails, the snapshot is still delivered without a current outage. The schedule is what matters.

**Address → queue (`listStreets`, `listHouses`).**
- **The lookup.** `POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/` with `formCity=<city>` and `formStreet=%` returns the whole settlement in one HTML table: district, settlement, street, house list, ГПВ queue, ГАВ queue.
  - For Kovel that is about 355 KB and 1,848 rows.
  - Queues are fixed from 1 October to 1 October, so the parsed table is cached per city for the running app.
- **Exact settlement.** Keep only rows whose settlement equals the chosen one, because the match is by substring: «Ковель» also returns «Воля-Ковельська».
- **House cells are comma lists with junk.** Split, trim, and drop empty entries, `<>`, and «Адреса невідома»-style entries. Keep anything that looks like a house number.
- **One house can have several queues** (different supply lines). They become the house's `lines`, so the existing «line» step of the wizard handles them.
- **«Не залучено»** (not in the hourly schedule, about 31% of Kovel rows) is a real line with `groupId: 'none'`, labelled «Не залучено до ГПВ». Its schedule is always `on`; current outages still apply.
- **Queue labels:** `groupId` is the plain queue (`'6.1'`), labelled «Черга 6.1».

**Settlements (`listCities`).**
- **A bundled list.** The operator has no settlement list, so the app bundles the list of Volyn oblast settlements from the state codifier КАТОТТГ (open government data).
- **Duplicates.** Names that occur more than once get their district so they can be told apart. The operator's table has a «Район» column to filter on.
  - The filter applies to every name the operator knows in more than one district, also when the labels differ by kind alone and carry no district («с. Луків» in Луцький, «с-ще Луків» in Ковельський). A name found in one district only is matched by name alone.
  - Whether that column uses the four districts made in 2020 or the old sixteen is checked live. The filter follows whatever the operator uses.
  - Two villages with the same name in the same district cannot be told apart by the operator either. They appear once, with the streets of both. A person on a street that exists in both gets two lines, and the line step's previews let them choose. My call.
- **Spelling check.** The bundled spelling must match what the `cherga` form accepts. A spot check against the live form for Луцьк, Ковель, Володимир (renamed in 2021) and Нововолинськ is part of the work. Where the operator still uses an old name, the bundled entry follows the operator.
- **An unknown settlement.** A settlement the operator does not know shows an empty street list with a note, never an error loop.

### Quiet days, every provider (the user's decision)

A company sometimes publishes nothing for today: between outage waves, for weeks or months. On 20.10 Odesa and Dnipro had `DisconSchedule.fact.data = []`, last updated 17.10. Today the widget then shows «Немає даних».

The user chose («робимо так»):
- **The source answered normally but has no schedule for today** → today is all `on`, and the schedule view shows a note: «{short name} не опублікував(о) графік на сьогодні — зазвичай це означає, що відключень за графіком немає».
- **Tomorrow without a schedule** → the day is left out, as now.

What counts as «answered normally»:
- For DTEK: the page loaded, and `fact` has its `update` stamp, but `fact.data` has no entry for today.
- For Volyn: the archive check above passed, and there is no image for today.

A failed or unreadable fetch is never a quiet day. It stays an error, and the usual stale and failed-refresh behaviour applies.

The cost, accepted by the user: on the first morning of a new wave, until the company publishes, the widget shows «on». The 15-minute refresh picks the schedule up after that.

This applies to `dtek-krem` too. The snapshot gets an optional `note` that the schedule view shows. The widget itself shows only the slots. The line-step previews in the wizard show the same all-`on` day.

### What becomes per-provider in the app

Today several texts and links say «ДТЕК». Each provider gets, in `shared/providers.ts`:
- the display name;
- a short name: «ДТЕК» or «Волиньобленерго»;
- the region label;
- the site URL;
- whether it can ask for a captcha.

These replace the fixed texts:
- `OFFLINE_MESSAGE`: «Немає з’єднання з сайтом {short name}».
- The current-outage banner: «{short name}: «…»».
- «графік {short name} від …» under the schedule.
- The settings row title «Графік ДТЕК». It becomes neutral: «Графік відключень».
- The wizard's «Для цього будинку … не публікує графік відключень» and «Звірте графік … з сайтом …».
- «Відкрити графік на сайті …». It opens the chosen provider's site. The renderer passes only the provider id; main looks the URL up in its fixed table.
- The captcha texts stay «Сайт ДТЕК просить пройти перевірку». Only DTEK providers can raise them.

### Setup wizard

- **The provider step lists five cards**, each showing the region with the company under it:
  1. м. Київ;
  2. Волинська область;
  3. Дніпропетровська область;
  4. Київська область;
  5. Одеська область.

  With more than one provider, nothing is preselected and «Далі» waits for a choice. My call: a preselected Kyiv card would let someone from Kyiv oblast click through into the wrong source.
- **A provider with exactly one city** (Kyiv) has that city chosen for the person and skips the city step. The step still shows as done in the rail.
- Everything after that (street, house, line, style) is unchanged and works for every provider.

## Constraints

- The stack stays as is: Electron 44, TypeScript, React 19, vitest. No new runtime dependencies. PNG decoding uses an in-house reader on `node:zlib`. HTML tables are parsed without a DOM library.
- Main-process network code goes through Electron's `net`, so the system proxy applies. There is no CORS on these sites, so nothing runs in the renderer.
- Tests run offline against recorded fixtures: the two Volyn images, a trimmed `cherga` table, a `chomu-nemaie` table and an archive response. The saved responses are in `docs/superpowers/research/2026-10-20-outage-sources/volyn-raw/`: `cherga-kovel-all.html`, `chomu-nemaie-kovel.html` (a day with one emergency and one planned outage) and `archive-page1.json`.
- **Volyn encoding.** The responses are UTF-8, and so are the request bodies. A test on the saved fixtures pins that «Ковель» reads back correctly. Cyrillic typed into Git Bash commands gets mangled, so live probes go through Node scripts, not shell literals.
- Smoke scripts must never touch the person's real app data (`%APPDATA%\Blackout Widget`); they use a temporary user-data folder, as `smoke-dtek` does today.
- Saved settings keep their shape: `Address.providerId` simply takes the new ids.

## Calls made (mine, not the user's)

- «Не залучено» is offered as a line (always on) rather than hidden.
- The Volyn settlement list comes from КАТОТТГ, bundled.
- The wizard has no preselected provider, and the single-city step is skipped.
- The provider card order is Kyiv city first, then oblasts alphabetically.
- CEK is dropped from this step if DNEM does not give CEK houses their group.
- A planned outage listed for the person's own Volyn house overrides the schedule.
- Volyn source health is checked structurally, with no time-based warning.
- Same-named villages in one district are merged; the line step separates them.

## Left to the builder

- Module layout under `src/main/providers/`, and how the DTEK provider is parametrized.
- How the КАТОТТГ list is produced and stored. A checked-in JSON generated once is fine; record the source and date next to it.
- How long Volyn caches live beyond the running app (none required).
- The exact patch size and colour tolerance for the image cells, within the fail-closed rule.
- Smoke scripts per provider.
