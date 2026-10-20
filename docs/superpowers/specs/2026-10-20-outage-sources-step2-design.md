# Outage-schedule sources, step 2: Lviv, Ternopil, Mykolaiv, Zhytomyr, Chernivtsi, CEK (Dnipro)

Date: 2026-10-20. Status: design for review.

Research behind this document: `docs/superpowers/research/2026-10-20-outage-sources-step2/`. It has one note per operator (`lviv.md`, `ternopil.md`, `mykolaiv.md`, `zhytomyr.md`, `chernivtsi.md`, `cek.md`) and the saved live responses in `<op>-raw/`. Every fact there is marked as fetched live on 2026-10-20 or only read in third-party code. The notes hold the exact URLs, shapes and quirks; this document does not repeat them.

## Intent

Step 1 added Kyiv city, Volyn, Odesa and Dnipro (`docs/superpowers/specs/2026-10-20-more-outage-sources-design.md`). Step 2 was agreed then: Lviv, Ternopil, Mykolaiv, Zhytomyr and Chernivtsi, which have their own services with an address lookup. CEK joins them. It is the second distribution company in Dnipropetrovsk oblast, and step 1 could not serve it: DTEK Dnipro never assigns a CEK house a group.

The research changed one assumption about CEK. Its schedule is not DTEK's. CEK publishes its own, and on a real outage day (15.01.2026) it differed from DTEK's same-numbered groups by up to 14 half-hours. YASNO's «ЦЕК» schedule is a byte-for-byte copy of DTEK's. So CEK gets its own source, read from cek.dp.ua.

## Goals

- The setup wizard offers eleven sources. A person in any of the six new areas sets up their address the way they do today: region → settlement → street → house → line.
- The widget, tray, schedule view, quiet-day note, current-outage banner and actual-power features work for every new source as they do for the existing ones.
- Nothing changes for anyone already set up.

## Non-goals

- Regions without a usable address lookup, or with schedules only as images or posts: Rivne, Poltava, Kharkiv, Chernihiv, Zaporizhzhia, Ivano-Frankivsk, Khmelnytskyi, Zakarpattia, Cherkasy, Vinnytsia, Sumy, Kirovohrad (`ukraine.md` §2.3).
- Third-party aggregators (no licence, one maintainer each), as in step 1.
- Planned works further ahead than «now» (Chernivtsi and Ternopil list days ahead). Only the current outage is shown, as today.
- CEK's current outages: CEK publishes them only on Telegram and Viber.
- The emergency queues (ГАВ/СГАВ) as schedules. They have no time grid; where a source says one is switched on now, that becomes the current outage.

## Anti-goals (failure even if it «works»)

- **Never show «світло є» when the source failed, could not be read, or answered in a shape we do not know.** Every source below has a structural check, and anything that fails it is an error, never all `on`.
- **Never guess a person's queue.** A saved settlement, street or house that no longer resolves to exactly one operator record is an error that asks the person to choose the address again. It is never a namesake's record.
- **No personal data.** Several APIs carry a free-text comment that can name customers (Lviv's `koment`). Parsers drop such fields as they read them. Error causes and logs never contain raw response bodies.
- **No extra load.** One provider's requests run one at a time, with the spacing noted per source. Settlement lists are fetched once per run or bundled, never polled.

## Shared changes

### Plain-HTTPS plumbing, extracted once

Volyn's provider has the request plumbing: one operation at a time, a guard that turns anything unexpected into «Не вдалося прочитати графік {company}», a timeout, and offline or no-answer errors. Six more copies would be wrong. That plumbing moves into one shared helper, and Volyn uses it too, with behaviour unchanged and its tests passing as they are. Each provider supplies its company texts.

### Lines resolved when the house is picked

Two sources cannot list every house's queues in one request.
- **Ternopil:** the house list shows one queue per house. A second queue shows only through a per-house call.
- **Mykolaiv:** queues exist only per house.

The fix:
- **The interface.** `ScheduleProvider` gets an optional `houseLines(city, street, house)`. A provider that has it may return houses from `listHouses` whose lines are not yet known.
- **The wizard.** For such a provider, once the house is picked, the wizard asks main for that house's lines through a new IPC call and shows a short loading state. The line step and its previews use the answer.
- **The empty-line note.** «Для цього будинку … не публікує графік» shows only once the lines are known to be empty. «Not fetched yet» never shows as «no schedule».
- **`previewLines` and the refresh line check** use `houseLines` when the provider has it.
- **Existing providers.** DTEK and Volyn do not implement `houseLines`, and their wizard path is unchanged. A test pins that.

### Houses outside the hourly schedule

Lviv and Ternopil mark some houses «Не входить». Zhytomyr writes «В цей час не вимикається…». Some Mykolaiv houses have only ГАВ/СГАВ queues.

These houses get the line «Не входить до ГПВ» (`groupId: 'none'`), exactly as Volyn's «Не залучено до ГПВ» in step 1. The line is always `on`, and current outages still apply to it. So a Mykolaiv house on ГАВ alone still sees a switched-on ГАВ as an emergency.

A house with such a line is never refused in the wizard. For a `'none'` line, the refresh checks only that the house is still in the operator's house list, and reads current outages. It does not read the schedule.

### A saved queue that is gone

Sometimes the operator moves a house to another queue. Ternopil is the sharp case: its schedule call answers only for the house's current queues.

So when the refresh's queue check finds the saved queue gone, the snapshot carries the house's new lines and today `unknown`. The app's existing «лінія змінилась» prompt then fires (`refresh.ts`). A schedule that lacks the saved queue even though the queue check passed is still an error.

### From saved labels back to operator records

`Address` stores labels only, and saved settings keep that shape. Lviv, Ternopil, Mykolaiv, Zhytomyr and Chernivtsi address their APIs by ids, so each provider maps labels back to records through the same lists the wizard showed. It caches them for the run.

One rule for every provider:
1. An exact label match.
2. Failing that, the one record whose name equals the whole saved label, or, when the label ends in « (громада)», whose name and громада both match it. A numeric « (2)» suffix never matches here, and zero or several matches are not a match.
3. Otherwise the error «Адресу не знайдено у {company} — оберіть її в налаштуваннях заново».

Identity comes from the operator's record (its id, district or громада), never from how a label looks. That is the lesson of the Volyn namesake fix. Settlement labels carry the district or громада only for namesakes, as in Volyn, so a label can stop matching when a second settlement of that name appears. Rule 2 then finds a bare label only while the name stays unique, and never moves a label saved with a громада to a namesake in another one.

### Quiet days and fail-closed checks

The user's rule from step 1 applies: when a company answered normally but published nothing for today, today is all `on` with the dated note «{company} не опублікувало / не опублікував графік на сьогодні — зазвичай це означає, що відключень за графіком немає». Tomorrow without a schedule is left out. What «answered normally», «nothing for today» and «broken» mean differs per source:

| Source | Quiet day (note) | Error (fail closed) |
|---|---|---|
| Lviv | The Today item, the archive and its structure are valid, and no revision is dated today | A non-JSON answer, an unexpected item, any group line outside the grammar, a zero-length range (the archive's placeholder item), or a missing group |
| Ternopil | The house's queues come back first (`building-groups`) and include the saved one, then the schedule answers `null` or `[]` | The house missing from `building-names`, a collection of the wrong shape, or a member without the saved queue (after the check passed) or without exactly 48 keys |
| Mykolaiv | `active` is a JSON array with no row for today, and the time-series (48 slots) and queue (12) dictionaries check out | Non-JSON or HTML, a body that is not an array, broken dictionaries, or an unknown slot type |
| Zhytomyr | None. The site always publishes today's table, and an all-white table is a real «no outages» day (no note) | No table dated today, not 12 × 48 cells, a colour other than the two known, or no update stamp |
| Chernivtsi | A valid 12 × 48 table dated before today (the operator leaves the last table up). The note names that date | No table and no emergency banner, a broken table, a date after tomorrow, or an unknown cell code |
| CEK | The form answers «На цей день відключень немає.» and the 12-queue form is present | No form, neither the sentence nor tables, or an unparseable time row |

Two residual risks are accepted and written down here. First, CEK cannot tell «nothing published yet» from «no outages». Second, Ternopil would read a silent change of its key scheme as a quiet day. A refresh after such a change shows «on» until the company publishes or we notice.

## The sources

The card for each source shows the region, with the company under it. Ids, names and links:

| id | Name (short name) | Region card | Opened from the wizard |
|---|---|---|---|
| `loe` | Львівобленерго | Львівська область | `https://poweron.loe.lviv.ua/` |
| `toe` | Тернопільобленерго | Тернопільська область | `https://poweron.toe.com.ua/` |
| `mkoe` | Миколаївобленерго | Миколаївська область | `https://off.energy.mk.ua/` |
| `ztoe` | Житомиробленерго | Житомирська область | `https://www.ztoe.com.ua/unhooking-search.php` |
| `cvoe` | Чернівціобленерго | Чернівецька область | `https://oblenergo.cv.ua/shutdowns/` |
| `cek` | ПЕЕМ «ЦЕК» (ЦЕК) | Дніпропетровська область | CEK's schedule page (`cek.md` §1.1) |

All six use plain HTTPS from the main process through Electron's `net`, like Volyn. None needs a hidden window or a captcha.

### Lviv: Lvivoblenergo (`lviv.md`)

- **Schedule.** The text in `rawHtml`: 12 lines «Група N.M. Електроенергії немає з HH:MM до HH:MM[, …].» or «… Електроенергія є.».
  - Read the Today and Tomorrow items first, then the archive (`menus`, with a cache-buster, because Cloudflare keeps it up to 2 h).
  - For each heading date, take the latest «станом на».
  - The heading date decides the day, never the item's name.
  - «станом на HH:MM DD.MM.YYYY» is `sourceUpdatedAt`.
  - There is no «maybe» in this source.
- **Address.** `pw_cities` (one call), then `pw_streets`, then `pw_accounts`.
  - Accept both the array and the Hydra shape.
  - Dedupe accounts by `buildingName`. A house's lines are its distinct `chergGpv` values minus «Не входить». If only «Не входить» is left, the house gets the `'none'` line.
  - Read `pw_accounts` only for the fields named here.
  - Namesake settlements get « (… громада)». Rows from other oblasts (`codeOtg` not `UA46…`) are dropped.
- **Current outage.** `pw_accidents` for the saved city and street, with the house matched in `buildingNames`.
  - `typeOff` 0 → planned, 1 → emergency.
  - 2 and 30 («можливе») → `other`, so they never override the schedule.
  - `koment` is never read.
- **Access.**
  - Space `power-api` calls at least 1.5 s apart.
  - Treat a 429 or an HTML challenge as «не відповідає». Never retry in a loop.

### Ternopil: Ternopiloblenergo (`ternopil.md`)

- **Schedule.** `a_gpv_g` with `X-debug-key` = base64 of «cityId/streetId/house».
  - Make `time` unique on every call, because the edge cache ignores the key.
  - Group by `dateGraph`'s date part, taken as a Kyiv date.
  - `"0"` → on, `"1"` → off, `"10"` → maybe-off. Anything else is an error.
  - A time key is the slot's start.
  - `dateCreate`, read as Kyiv wall clock, is `sourceUpdatedAt`.
- **Address.**
  - Settlements come from `pw_cities`; names that are empty are dropped, and namesakes get « (… громада)».
  - Streets come from `pw_streets`.
  - Houses come from `pw-accounts/building-names` (house text kept byte for byte; the API matches it exactly).
  - Lines come from `building-groups` through `houseLines`.
  - «Не входить» and empty mean not in the schedule: the `'none'` line.
- **Every refresh.** The `building-groups` precheck runs first: it is both the fail-closed guard and the line-change check.
- **Current outage.** `pw_accidents` (emergency) and `pw_accident_planeds` (planned) for the saved city and street, with the house in `buildingNames`.
  - Only rows running now, in Kyiv time, count.
  - `switchSubReason` 2 repeats the hourly schedule and is ignored.
- **Electron.** Send no `Origin`. The smoke run (below) must show a 200 from `net.fetch`. If Chromium sends `Origin: null`, the provider sets `Origin: https://poweron.toe.com.ua`.

### Mykolaiv: Mykolaivoblenergo (`mykolaiv.md`)

- **Schedule.** Three calls, joined: `v2/schedule/active`, `schedule/time-series` and `outage-queue/by-type/3`.
  - Bucket by the Kyiv date of `from`.
  - Index slots by `time_series_id - 1`.
  - `OFF` and `SURE_OFF` → off, `PROBABLY_OFF` → maybe-off, no row → on. An unknown type is an error.
  - The newest `series[].updated_at`, in Kyiv time, is `sourceUpdatedAt`.
- **Not seen live yet.** A day with outages has never been observed: the API keeps no history, and the test fixture is built by hand from the site's code and three independent clients. Until a real day is captured, the parser takes only that shape and fails closed on anything else.
- **Address.**
  - The settlement list is bundled from the 20 branches (`ns` per `filii`, generated by a script, with the source and date recorded). Namesakes get « (… дільниця)».
  - Streets come from `ns/{id}/street`, houses from `street/{id}/dom`.
  - Lines come from `dom/{id}/outage-queue` through `houseLines`. They are the type-3 rows, with `groupId` = the queue name («2.2») and the label «Черга 2.2».
  - Mykolaiv city is three settlements and stays three.
- **Current outage.**
  - A switched-on ГАВ or СГАВ queue of the house (`enabled` 1) → emergency, with a text naming the queue.
  - A switched-on ГПВ queue is already in the schedule and is ignored.
  - There are no times.

### Zhytomyr: Zhytomyroblenergo (`zhytomyr.md`)

- **Schedule.** `GET unhooking-search.php`, decoded from windows-1251.
  - There is one table per date, chosen by its date header.
  - Each table has 12 rows by 48 cells: `#ffffff` → on, `#ff3333` → off.
  - «Дата оновлення інформації - HH:MM DD.MM.YYYY» is `sourceUpdatedAt`.
  - The Ukrenergo banner above the table becomes the snapshot's note when present.
- **Address.** A stateless form POST cascade (no cookies): `rem_id`, then `naspunkt_id`, then `vulica_id`, with `all=1`.
  - The settlement list (19 РЕМ, 1,758 settlements) is bundled, with its ids. Namesakes get « (… РЕМ)».
  - Use household rows. Legal-entity rows count only when a house has no household row.
  - A house's lines are its distinct «N.M».
  - «В цей час не вимикається…» means not in the schedule: the `'none'` line.
- **Current outage.** It is best effort, through the inneti API (`pw_accidents`, `pw_accident_planeds`), joined by name: РЕМ, settlement, street, house.
  - `switchSubReason` 0 → emergency, 1 → other, 2 ignored. Planned works running now → planned.
  - Its failure never fails the snapshot.

### Chernivtsi: Chernivtsioblenergo (`chernivtsi.md`)

- **Schedule.** `GET /shutdowns/`. Fetch `/shutdowns/?next` only when the page links to it, and keep it only if its table is dated tomorrow.
  - Cells: `<u>з` → on, `<o>в` → off, `<s>мз` → maybe-off.
  - The day is the table's own date.
  - `sourceUpdatedAt` is «станом на HH:MM» plus the table date. It is approximate, and the operator gives nothing better.
- **Emergency mode.** No table, but the emergency banner: the operator has voided the schedule for everyone. Today is `unknown`, and the current outage is an emergency with the text «Аварійні відключення — графік не діє».
- **Address.**
  - The settlement → district index is bundled. A script builds it from the 12 district pages; the city is «м. Чернівці». Namesakes get « (… дільниця)».
  - Streets and houses come from that district's page, fetched once per run. It is heavy: up to 270 KB on the wire.
  - Matching folds case, Latin look-alikes, «буд.» and house spellings (`chernivtsi.md` §2.5).
  - A house's lines are all its groups, labelled «Група N» in the operator's own word.
- **Current outage.** `planovi_avarijni_result.php` for today, with type 0 (emergency) and type 1 (planned).
  - Use the form's own district ids.
  - Match the house by token in the house list.
  - A validation reply or non-JSON means «unknown», never «no outage».

### CEK: ПЕЕМ «ЦЕК», Dnipropetrovsk oblast (`cek.md`)

- **Schedule.** CEK's own form: a POST with `queue=all&date=YYYY-MM-DD`, one for today and one for tomorrow.
  - Off intervals become slots by overlap; `23:59` means the end of the day.
  - There is no update time, so `sourceUpdatedAt` stays unset.
- **Address.** CEK's own map, the inline `locations` object (14 settlements, 441 streets, 9,022 houses). Fetch it when the wizard opens and once per run, never bundled: it changes about monthly.
  - «Черга n.m» → one line.
  - «X та Y» → two lines.
  - A bare «Черга N» → two lines, `N.1` and `N.2`, and the line step's previews let the person choose.
  - «Група n.m (АТ "ДТЕК ДЕМ")» means DTEK switches the house, not CEK. Such a house shows the note «Цей будинок відключає ДТЕК — оберіть «ДТЕК Дніпровські електромережі»».
  - Literal «Усі будинки» and «Усі дома» stay selectable house entries.
- **Current outage.** None.
- **DTEK Dnipro, the other way round.** When DTEK Dnipro finds no group for a house, the wizard's note adds «Якщо ваш будинок обслуговує ЦЕК, оберіть «ПЕЕМ «ЦЕК»»».

## Setup wizard

- **Eleven cards.** Kyiv city comes first, then the oblasts alphabetically. In Dnipropetrovsk oblast, DTEK comes before CEK, and the company under each card tells them apart. The card list scrolls inside the step as it already can. There is no other layout change.
- **Picking the house.** Lines can now load after the house is picked (above).
- **Everything else** stays as in step 1: no preselection with several providers, the single-city skip for Kyiv, and the empty-street note.

## Constraints

- **The stack stays as is.** No new runtime dependencies. HTML is parsed without a DOM library, as for Volyn. Windows-1251 is decoded with `TextDecoder`.
- **Tests run offline** against the saved responses in `<op>-raw/`, trimmed into `tests/fixtures/<op>/`. They include a real outage day for every source except Mykolaiv: Lviv 17.10.2026, Ternopil 17.10.2026, Zhytomyr 13–14.10.2026, Chernivtsi 05.11.2025 (MIT-licensed third-party copy), CEK 15.01.2026. Each source also has hand-made broken inputs for its fail-closed checks.
- **«Done» includes one Electron smoke run per source.** This is a script like `smoke-voe` that runs the provider in Electron's main process, with a temporary user-data folder, and goes from the settlement list to a snapshot. Plain Node probes cannot settle three things:
  - `net.fetch` and Origin (Ternopil);
  - windows-1251 decoding in Electron (Zhytomyr);
  - Cloudflare's treatment of Chromium's network stack (Lviv's 429, Chernivtsi's block of datacenter IPs).
- **Bundled lists** (Mykolaiv, Zhytomyr, Chernivtsi) are checked-in JSON made by a script, with the source and date written next to it, like Volyn's.
- **No live probe or smoke script touches the person's app data** (`%APPDATA%\Blackout Widget`). Cyrillic never goes into shell literals; probes are Node script files.
- **Two waves.** Each wave merges on its own:
  - **Wave 1:** the shared plumbing, `houseLines`, label resolution, Ternopil, Lviv and Mykolaiv.
  - **Wave 2:** Zhytomyr, Chernivtsi and CEK.

## Calls made (mine, not the user's)

- CEK is read from cek.dp.ua, not from DTEK or YASNO, which carry a different schedule under the same numbers.
- Houses outside the hourly schedule get the always-on line «Не входить до ГПВ», as Volyn's «Не залучено» does.
- A saved queue the operator has moved shows as «лінія змінилась» with today `unknown`, rather than as an error.
- Zhytomyr's red cells are `off`, as every aggregator reads them. The legend says «off when Ukrenergo applies the limits», and the published table is that application.
- A bare CEK «Черга N» becomes two lines, and the previews decide.
- Chernivtsi's emergency banner means an emergency for everyone, with today `unknown`.
- CEK houses switched by DTEK, and DTEK Dnipro houses with no group, each get a note pointing to the other company.
- Lviv `typeOff` 30 («можливе аварійне») is `other`: shown in the log, never overriding the schedule.
- Mykolaiv's and Ternopil's switched-on ГПВ queues are ignored as current outages, because the schedule already shows them.
- Ids `loe`, `toe`, `mkoe`, `ztoe`, `cvoe` and `cek`, and the card order.
- Namesake labels carry the operator's own grouping: громада, дільниця or РЕМ.

## Left to the builder

- Module layout under `src/main/providers/`, and the shape of the shared HTTP helper.
- How the wizard shows the loading state for `houseLines`.
- Caching beyond the running app (none required). Chernivtsi's district page may be kept on disk if a run-long cache proves too slow.
- The exact Chernivtsi and Zhytomyr house-matching folds, within `chernivtsi.md` §2.5 and `zhytomyr.md` §2.3.
- The generator scripts for the bundled lists.
