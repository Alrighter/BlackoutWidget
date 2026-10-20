# CEK (ПрАТ «ПЕЕМ ЦЕК», parts of Dnipro city and oblast): deep dive

Date of research: 2026-10-20. Tags: **[VERIFIED]** = fetched today, **[READ]** = third-party code/docs. Fixtures: `cek-raw/`. Scripts live in the session scratchpad (`.../scratchpad/step2/cek/`).

## TL;DR

- **Recommendation: a new `cek` provider that uses neither DNEM nor YASNO for the schedule.** CEK publishes its **own** schedule on cek.dp.ua through a plain server-rendered POST form (`queue`, `date`) and its own address→queue map on a second page. Both work with a plain Node `fetch` (no cookies, no WAF, no hidden window, 0.3 s, ~100 KB). **[VERIFIED]**
- **Option (a) as written in the brief is wrong for the schedule.** CEK's map names are CEK's own queues («Черга 5.2»), but DNEM's `fact` **never carried `GPV1001.x`…`GPV1006.x` data**: the groups sit in `preset.sch_names` since ~2026-07-24 and are absent from every `fact` I could check (saved fixtures, 12 B42 snapshots from Jan to Oct, incl. 2026-01-15 and 2026-10-17). **[VERIFIED]** Mapping «Черга 5.2» → `GPV5.2` would show DNEM's schedule for a CEK customer, which differs: on 2026-01-15, CEK queue n.m vs DNEM `GPVn.m` differ by 1–14 half-hours of 48 (same label) (table in §3). **[VERIFIED]**
- **Option (b), YASNO DSO 303 (ЦЕК), is also wrong for CEK customers.** `planned-outages` for dso 303 is **byte-identical** to dso 301 (ДнЕМ): same ETag, same body. **[VERIFIED]** And its address→group disagrees with CEK's map for ~35 % of sampled Dnipro houses (YASNO returns «1.2» where CEK says 3.2 / 5.2 / 6.2). **[VERIFIED]** YASNO's CEK data looks like a DNEM copy, not CEK's schedule.
- **Today is a quiet day everywhere** (CEK, DNEM, YASNO all say "no outages"), so a same-day three-way comparison is not possible. I found real outage days instead: CEK's form is queryable by **past date** (2026-01-15, 2026-02-10, 2025-12-20 have real tables; 2026-07-24, 10-16, 10-17 are quiet). DNEM/B42 history exists only for DNEM groups, and CEK's own table is the only source that has CEK-queue data. **[VERIFIED]**
- Verdict: **medium.** Easy transport, but: HTML scraping of two pages, ambiguous queue values («Черга 2», «2.1 та 6.1», DNEM-served houses), no update stamp, and the quiet-day vs broken-source test has to be structural (the page cannot say "not published yet").

## 1. Schedule (CEK's own form)

### 1.1 Endpoint

- `POST https://cek.dp.ua/index.php/cpojivaham/vidkliuchennia/2-uncategorised/921-grafik-pogodinikh-vidklyuchen.html` **[VERIFIED]**
- Header: `content-type: application/x-www-form-urlencoded`. Body: `queue=<all|1.1|1.2|…|6.2>&date=YYYY-MM-DD`. No CSRF token, no cookie needed, no Origin/Referer needed. Node `fetch` + `URLSearchParams` works. **[VERIFIED]**
- A plain `GET` of the same URL shows the form only (no data). **[VERIFIED]**
- Response: 200, `text/html; charset=utf-8`, UTF-8 (no cp1251), ~82 KB empty / ~103 KB with 12 queues; `nginx`, PHP 7.4 (Joomla), `cache-control: no-store`. **[VERIFIED]**
- `robots.txt` disallows `/administrator/ /bin/ /cache/ /cli/ /components/ /includes/ /installation/ /language/ /layouts/ /libraries/ /logs/ /modules/ /plugins/ /tmp/`; `/index.php/...` is not disallowed. **[VERIFIED]**
- Use `queue=all` and parse all 12 queues in one request (one request per day: today, tomorrow). Rate: 0.3 s per request, no limiting seen in ~25 requests. **[VERIFIED]**

### 1.2 Response shape (real sample, `queue=all&date=2026-01-15`; fixture `cek-gpv-post-all-2026-01-15.html.txt`)

```html
<h2 class="queue-heading" id="heading">Усі відключення</h2>
<div class="form-container tableView" id="tableView_1.1" style="display: block;">
<h2 class="queue-heading">Черга 1.1</h2>
<table> <thead>… Номер | Час початку | Час закінчення | Тривалість (год.) …</thead>
<tr><td><div style="text-align: center;">1</td> <td>02:00:00</td> <td>05:30:00</td> <td>3.5</div></td> <!--<td>2026-01-15</td>--> </div></tr>
<tr>… 2 | 09:00:00 | 16:00:00 | 7 …</tr>
<tr>… 3 | 19:30:00 | 23:59:00 | 4.5 …</tr>
</table></div>
<div … id="tableView_1.2">… (same for 1.2 … 6.2)
```

Parse with `/id="tableView_([\d.]+)"[\s\S]*?<\/table>/g`, rows with `/<td>(\d\d:\d\d:\d\d)<\/td>\s*<td>(\d\d:\d\d:\d\d)<\/td>/g`. The markup is sloppy (unbalanced `</div>`), so use regex, not a strict DOM parse. A real DOM parser (jsdom or cheerio) is fine too.

- 2026-01-15, 12 queues: 1.1: 02:00–05:30, 09:00–16:00, 19:30–23:59; 2.1: 00:00–05:30, 09:00–16:00, 23:30–23:59; 5.1/5.2/6.1/6.2 all 00:00–02:00, 05:30–12:30, 16:00–23:30. **[VERIFIED]** (full text in the fixture)
- A single queue (`queue=1.1`) gives one `tableView_1.1` block (fixture `cek-gpv-post-1.1-2026-01-15.html.txt`).
- The page also contains a decorative 24-hour "circle" widget; ignore it. Note an inline `alert('Times Array…')` debug in `updateColors1`: irrelevant for parsing.

### 1.3 Resolution, states, mapping to `Slot`

- **Intervals `start–end` (off), everything else on.** There is no "maybe", no state column; only `off` intervals. **[VERIFIED]**
- Minutes seen across 4 outage days: only `:00`, `:30` and `:59`. `23:59:00` means "until the end of day" (convert to 24:00). **[VERIFIED]** Still convert defensively: mark a half-hour `off` when it overlaps `[start, end)`; treat `end == 23:59` as 24:00.
- Several rows per queue per day are normal (up to 4 seen). **[VERIFIED]**
- Mapping: `off` interval → `'off'`, other slots → `'on'`. `maybe-off` and `unknown` never appear. No fake `unknown`.

### 1.4 Today / tomorrow, update time

- The day is whatever `date` you ask for, interpreted as a plain local date (Kyiv). Send `YYYY-MM-DD` of Kyiv today and Kyiv today+1. No timestamps, no timezone quirks. **[VERIFIED]**
- Past dates work (archive for free): 2025-12-20, 2026-01-15, 2026-02-10 have outages; 2026-07-24, 2026-10-16, 2026-10-17, 2026-10-20, 2026-10-21 are quiet; 2024-08-22 quiet. **[VERIFIED]** The page echoes any `date` value (even `garbage`) and answers quiet.
- **No update time, no revision id** anywhere in the response (searched for оновлен/updated). **[VERIFIED]** `sourceUpdatedAt`: leave undefined (or show our fetch time labelled as such). Do not invent one. Polling is cheap, so refetch about every 5–10 min and detect a change by hashing the parsed tables.
- Whether CEK publishes tomorrow in the evening like DTEK: **unknown** (no outages to observe). A published tomorrow would simply show tables for `date=tomorrow`.

### 1.5 Quiet day vs broken source

- Quiet day: the page contains `<h2 class="no-records-message">На цей день відключень немає.</h2>` and no `tableView_` blocks. **[VERIFIED]** (fixture `cek-gpv-post-all-2026-10-20-quiet.html.txt`)
- A day with data has no such message and ≥ 1 `tableView_` block. **[VERIFIED]**
- **Weakness:** the quiet message is also what the page gives for an *unpublished* day (future dates, `garbage`, an unknown queue like `9.9`). The page cannot tell "no outages" from "not published yet". **[VERIFIED]** Apply the Dnipro rule: show "світло є" for today with a note "ЦЕК не опублікував графік…" and never invent a tomorrow (omit tomorrow when quiet).
- **Fail-closed checks** (all must hold, else `ProviderError`): HTTP 200; the response contains the form with `<select id="queue"` and **all 12 `<option value="n.m">`**; the heading `id="heading"`; then exactly one of (sentinel message) or (≥ 1 `tableView_` block whose queue ids ⊂ the 12 and ≥ 1 parsed row each). A response with neither (e.g. the 81 KB page when `queue=""`: the form is there but no heading/sentinel) is an error. A Cloudflare/maintenance/HTML error page fails the form check. **[VERIFIED]** that `queue=""` gives the form only (no sentinel).
- A moved URL gives a Joomla 404 (no form), which also fails closed.

## 2. Address → queue (CEK's own static map)

### 2.1 Where and what

- Page: `GET https://cek.dp.ua/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html`. 200, `text/html; charset=utf-8`, gzip, 34,982 B on the wire, **475,582 B** decoded. **[VERIFIED]**
- Inline in a `<script>`: `const locations = {…};` (a JSON literal; Cyrillic is `\uXXXX`-escaped, 434,065 B of JSON) followed by `; \n\r\n \nfunction filterCity()`. Extract with a brace/quote-aware scan from `const locations = ` (as I did), or regex `/const locations = (\{[\s\S]*?\});\s*function filterCity/`, then `JSON.parse`. **[VERIFIED]** The decoded JSON is 218,567 B (fixture `cek-locations-2026-10-20.json`).
- Structure: `{ city: { street: { house: "queue string" } } }`. **[VERIFIED]**
- The page's own JS does substring search on city/street/house keys and prints the queue string verbatim (`houses[house]`); "Черга не знайдена" when not found. **[VERIFIED]**

### 2.2 Sizes (matches the survey exactly) **[VERIFIED]**

14 cities, 441 streets, 9,022 houses:

| City | Streets | Houses |
|---|---|---|
| м. Дніпро | 175 | 4,667 |
| м. Жовті Води | 158 | 3,391 |
| м. Вільногірськ | 20 | 235 |
| м. Кривий Ріг | 22 | 192 |
| м. Павлоград | 18 | 137 |
| с. Дніпровське | 14 | 112 |
| с. Радушне | 9 | 86 |
| с. Орільське (с. Партизанське) | 7 | 66 |
| с. Мар'янівка | 3 | 52 |
| с. Зарічне (Гвардійське) | 9 | 39 |
| с. Миролюбівка | 1 | 23 |
| с. Черкаське | 2 | 19 |
| с. Петриківка | 2 | 2 |
| с. Полтаво-Боголюбівка | 1 | 1 |

City keys keep their `м.` / `с.` prefix: use as the settlement label as is. Street keys keep prefixes (`вул.`, `пров.`, `просп.`, `бульвар`, `тупик`, `Площа`, `ЖК "…"`, `Шосе`…); some contain alternate old names in brackets: `вул. Дениса Котенка (вул. 152 Дивізії)`; 4 streets contain quote marks. No duplicate street names inside a city. The empty-map case never occurs (no empty values). **[VERIFIED]**

### 2.3 Every value variant (counts over 9,022 houses) **[VERIFIED]**

| Value | Houses | Meaning / handling |
|---|---|---|
| `Черга 1.1` 1,835; `Черга 1.2` 811; `Черга 2.1` 1,481; `Черга 2.2` 334; `Черга 3.1` 13; `Черга 3.2` 910; `Черга 4.1` 1,007; `Черга 4.2` 87; `Черга 5.1` 1; `Черга 5.2` 314; `Черга 6.1` 651; `Черга 6.2` 1,019 | 8,463 | The normal case: `Черга n.m` → queue id `n.m` (CEK's schedule key; DNEM-style id would be `GPV100n.m`) |
| `Черга 1` 2; `Черга 2` 231; `Черга 3` 19; `Черга 4` 7; `Черга 5` 30; `Черга 6` 87 | 376 | Whole queue, no sub-queue (Dnipro 172, Zhovti Vody 71, Radushne 86, Vilnohirsk 27, Dnipro­vske 17, Kryvyi Rih 3). Ambiguous. Proposal: expand to both `n.1` and `n.2` as two lines and tell the user; or ask a CEK contact. In CEK's data some pairs are identical (5.x/6.x on 2026-01-15), others differ (2.1/2.2 differ by one interval), so don't silently pick one |
| `Черга 6.1 та 2.1` 68; `Черга 2.1 та 6.1` 92; `Черга 1.2 та 3.1` 1; `Черга 1.2 та 5.2` 1; `Черга 2.1 та 4.1` 1; `Черга 4.2 та 2.2` 1; `Черга 4.2 та 6.2` 1 | 165 | House fed from two queues → **two `LineInfo`** (`index` 1 and 2, in the order written). 161 of them are in Zhovti Vody |
| `Група 3.1 (АТ "ДТЕК ДЕМ")` 6; `Група 5.1 (АТ "ДТЕК ДЕМ")` 10 | 16 | The house is **not on CEK's schedule**: it is switched by DTEK DNEM's group 3.1 / 5.1 (DNEM `GPV3.1` / `GPV5.1`, which *are* in DNEM's fact). Examples: Dnipro, вул. Національної Гвардії 9/11/13, Шосе Запорізьке 38/40/48/56. CEK also keeps a page "СПОЖИВАЧІ, БУДИНКИ ЯКИХ ВІДКЛЮЧАЮТЬСЯ ЗА ГРАФІКОМ АТ ДТЕК ДЕМ". Handling: the house line's `groupId` is `dnem:GPV3.1`; either fetch it via the existing DTEK provider or mark it unsupported with a message |
| `4.1` (no prefix) | 2 | Petrykivka (`вул. Леваневського`, `вул. Будівельна`), house key is the literal `Усі дома` («all houses»). Accept; normalise to `4.1` |

Other value anomalies: none (regex `^Черга \d(\.\d)?$` + the above covers all 9,022).

### 2.4 House key and street key spelling **[VERIFIED]**

- House keys: 8,909 are a plain number+letters (`6а`: **lowercase** Cyrillic letter). Others: `a/a` 19, `N a` with a space 83, `a-a` 2, a few with stray whitespace (`" 162"`, `" 49"`, `"75 "`, `"19\r\n"`), one with a quote (`… "…"`), one with commas (`a ,a ,a ,a ,a`), and the literals `Усі будинки` (Dnipro, Zhovti Vody, Vilnohirsk, Radushne, Pavlohrad) and `Усі дома` (Petrykivka). → **trim** house keys; keep the literals as selectable "all houses" entries.
- **No Latin look-alike letters** (0 keys mix scripts in houses or streets). **[VERIFIED]** Apostrophe: only ASCII `'` (4 uses, e.g. `с. Мар'янівка`); the wizard's text normalisation should still fold U+2019/U+02BC to `'`.
- No cp1251; JSON is valid UTF-8 after unescape.

### 2.5 How often does it change, how big

- The Wayback Machine has 15 snapshots between 2025-11-09 and 2026-10-05; the digest differs in ~11 of them, so the page changes **roughly monthly** (houses added/moved), with the gzip size jumping 26 KB ↔ 35 KB (encoding differences). **[VERIFIED]** (CDX output, not saved)
- Practical rule: fetch it **at wizard time** (and re-fetch about once a day or on `groupId` lookup failure when refreshing), 35 KB gzip. Do **not** bundle it: stale within weeks. A bundled fallback copy of the 218 KB JSON is possible but needs a refresh process. Since the schedule fetch uses the stored queue id (not the address), a stale map does not break the widget; it would only mis-assign a house that CEK has since moved.
- No `ETag`/`Last-Modified` usable (`last-modified` = now, `cache-control: no-store`): compare by content hash if you need change detection.

## 3. Option (a) check: does DNEM `fact` carry CEK groups?

- DNEM `DisconSchedule.preset.sch_names` lists 24 names: `GPV1.1…GPV6.2` (12 DNEM groups) + `GPV1001.1…GPV1006.2` = «ЦЕК 1.1…6.2». **[VERIFIED]** (B42 `dnipro.json` now). The 12 CEK names appeared between 2026-07-15 (12 names) and 2026-08-15 (24 names); the 2026-07-24 snapshots already have 24 names. **[VERIFIED]**
- **`fact` never contains a `GPV100x` key.** Checked: `tests/fixtures/dtek/getHomeNum-stale-updateFact.json` (fact for `1792184400` = 2026-10-17: 12 groups, no `GPV100*`; `getHomeNum-fresh.json` has no fact); B42 `dnipro.json` snapshots on 2026-01-15 (00:00, 08:15 and 21:54 updates), 02-15, 03-15, 04-15, 10-17 (14:33 update): all 12 fact groups `GPV1.1…GPV6.2`, 0 `GPV100*`; 05-15…10-10 and 10-19 have an empty `fact.data`. **[VERIFIED]** (fixtures `b42-dnipro-fact-2026-01-15-2154.json`, `b42-dnipro-fact-2026-10-17.json`)
- Why it matters: the groups «ЦЕК n.m» exist in DNEM's preset but with no schedule rows; the YASNO/DNEM numbering «5.2» is **not** the same schedule as CEK's «Черга 5.2». Real comparison on 2026-01-15 (CEK table vs DNEM `GPV` fact, 21:54 update; number of differing half-hours out of 48; diagonal = same label):

| CEK queue | DNEM GPV of the same label | Best-matching DNEM group |
|---|---|---|
| 1.1 | 4 | 1.1 (4) |
| 1.2 | 6 | 1.1 / 1.2 / 2.1 (6) |
| 2.1 | 8 | 1.1 / 1.2 / 2.1 (8) |
| 2.2 | 10 | 1.2 (1 half-hour) |
| 3.1 | 6 | 4.1 (5) |
| 3.2 | 5 | 3.2/3.1 (5) |
| 4.1 | 14 | 3.1/3.2 (7) |
| 4.2 | 1 | 3.1 / 3.2 / 4.2 (1) |
| 5.1 | 5 | 6.2 (1) |
| 5.2 | 5 | 6.2 (1) |
| 6.1 | 7 | 6.2 (1) |
| 6.2 | 1 | 6.2 (1) |

  CEK's table is a different schedule that merely resembles DNEM's. Using DNEM with the same label would be wrong by up to 14 half-hours (queue 4.1). (Script `h5.mjs`; only the 2026-01-15 day was compared.)
- DNEM's `getHomeNum` also has a `cek` field per house (always `null` in our fixtures), and `DisconSchedule.ajax.getCekText`; not investigated further and not needed.

## 4. Option (b) check: YASNO region 3, DSO 303

All **[VERIFIED]** with plain Node `fetch` (no cookies; `X-CDN: Imperva` header present but no challenge, same as the kyiv.md finding).

- Base `https://app.yasno.ua/api/blackout-service/public/shutdowns`.
- `GET /addresses/v2/regions` → Dnipro: `{"hasCities":true,"dsos":[{"id":301,"name":"ДнЕМ"},{"id":303,"name":"ЦЕК"}],"id":3,"value":"Дніпро"}` (fixture `yasno-regions-2026-10-20.json`).
- `GET /addresses/v2/cities?regionId=3&dsoId=303&query=` → 11 cities: `[{"id":1,"value":"с. Дніпровське"},{"id":2,"value":"с. Зарічне"},{"id":3,"value":"с. Петриківка"},{"id":4,"value":"с. Черкаське"},{"id":6,"value":"Дніпро"},{"id":7,"value":"Павлоград"},{"id":8,"value":"Жовті Води"},{"id":9,"value":"Вільногірськ"},{"id":10,"value":"Кривий Ріг"},{"id":11,"value":"с. Орільське"},{"id":12,"value":"с. Обухівка"}]` (fewer than CEK's 14: no Radushne, Mar'yanivka, Myroliubivka, Poltavo-Boholiubivka; has Obukhivka).
- Streets `GET /addresses/v2/streets?regionId=3&cityId=6&dsoId=303&query=Татарська` → `[{"id":68,"value":"вул. Татарська"}]`; houses `GET /addresses/v2/houses?regionId=3&cityId=6&streetId=68&dsoId=303&query=` → 20 max; group `GET /addresses/v2/group?regionId=3&cityId=6&streetId=68&houseId=3814&dsoId=303` → `{"group":1,"subgroup":2}`. Needs `cityId` (without it: 404 «Street 68 not found»). Same search-only/cap-20 constraints as in kyiv.md §2.5.
- Schedule `GET /regions/3/dsos/303/planned-outages` → 2,569 B, `cache-control: max-age=300, public`, ETag `"2ce60c29"`: keys `1.1…6.2`, each `{today:{slots:[],date,status}, tomorrow:{…}, updatedOn}`. Today: all `NoOutages` with `slots: []`, tomorrow `WaitingForSchedule`, `updatedOn: "2026-10-20T00:00:00+00:00"` (a midnight sentinel on quiet days, not a real update time). Slots are minutes `{start,end,type}` (`Definite`/`NotPlanned`), see kyiv.md §2.2. `EmergencyShutdowns` is a [READ] status (ha-yasno-outages `api/const.py`, MIT).
- **`/dsos/303/planned-outages` is byte-identical to `/dsos/301/planned-outages`** (`cmp` equal, same ETag). Unknown dso → HTTP 500 `InvalidOperationException`; `regions/25/dsos/303` → 500. So YASNO publishes **one** Dnipro-region schedule for both DSOs; I could not find a day with outages to compare directly (YASNO has no history), but CEK's own table differs from DNEM's (§3), so YASNO's copy cannot be CEK's.
- **Address → group disagreement with CEK's map** (Dnipro sample, 30 streets × first matching house, + 11 more houses in Dnipro and 5 other cities; fixture `yasno-vs-cek-map-sample-2026-10-20.json`): total 33 houses in the 1st run: 22 agree, 11 disagree; the 2nd run of 30 Dnipro streets: `Черга 1.1 → 1.1` 14, `1.2 → 1.2` 3, **`3.2 → 1.2` 7, `5.2 → 1.2` 4, `6.2 → 1.2` 1**. Pavlohrad (2.2), Kryvyi Rih (2.2), Vilnohirsk (4.2, 2.2) agree. YASNO never returned a queue other than 1.1/1.2 for Dnipro city in the sample (3.x/5.x/6.x collapsed into 1.2). So for Dnipro city, YASNO's address→group is lossy relative to CEK's map.
- Also: YASNO doesn't list 4 of CEK's cities and 4/10 sampled Zhovti Vody/Pavlohrad/Kryvyi Rih/Vilnohirsk street names were not found by name match (`вул. Польова`, `вул. Саксаганська`, `вул. Братська`, `вул. Олександра Станкова`).
- `probable-outages?regionId=3&dsoId=303` → 200 weekly plan (not fetched in full).
- No per-house current outage; same limits as kyiv.md §2.7.

## 5. (c) Does CEK publish anything else?

- **Own schedule: yes**, the form above ("Графік погодинних відключень", created 2024-08-22) and its circular-graph view. **[VERIFIED]** The old page text (2023 news item 775) is only an announcement of the national schedules.
- **ГАВ** (аварійні відключення, "Графіки аварійного відключення електропостачання: як, коли і для чого"): `/index.php/cpojivaham/vidkliuchennia/2-uncategorised/961-gav.html` links static PDFs `/images/2025/GAV_Dnipro.pdf`, `GAV_Viln.pdf`, `GAV_PAVL.pdf` (created 2025-02-13): the emergency-shutdown *scheme*, not live data. **[VERIFIED]** (page read; PDFs not downloaded)
- **Current outages: no endpoint.** The site announces that operational info about "графіки погодинних і аварійних відключень" goes to Viber and Telegram channel `https://t.me/cek_info` ("ПрАТ «ПЕЕМ «ЦЕК» інформує", news item 757). **[VERIFIED]** (text only; the channel is not parsed). The Google-Maps-based "Геоінформаційна система" menu item exists; not investigated. A debtor-address list (xlsx, «CПИСКИ АДРЕС НА ВІДКЛЮЧЕННЯ») is personal-ish debt data: **do not use**.
- So `currentOutage` stays undefined for CEK; at most a static note: «Аварійні відключення: t.me/cek_info».
- Contact info on the site: call centre `0-800-30-00-15`, `kanc@cek.dp.ua`.

## 6. Agreement between sources on a day with outages

- Today (2026-10-20): all three agree "no outages today", tomorrow not yet published: CEK quiet, DNEM `fact.data=[]` (update 17.10.2026 09:55), YASNO `NoOutages`/`WaitingForSchedule`. **[VERIFIED]**
- 2026-10-17 (DNEM and B42 had a fact with 12 groups, update 14:33): CEK's own form answers **quiet** for 2026-10-17. So CEK's published schedule and DNEM's/YASNO's can disagree about whether the day had outages at all. **[VERIFIED]** (DNEM side from B42 snapshot; I cannot prove which was right for CEK customers, but it confirms CEK is a separate source.)
- 2026-01-15: CEK has a full 12-queue table; DNEM has 12 groups with a similar-but-different schedule (table in §3); CEK queue ids and DNEM ids don't carry over. **[VERIFIED]**
- No same-day three-way comparison with real outages is possible until the next outage day; **re-test then** (CEK form for that day vs DNEM `fact` vs YASNO 303).

## 7. Risks and open questions

1. **Scraping two HTML/inline-JS pages of a Joomla site** with sloppy markup; either page can change without notice. Mitigation: structural fail-closed checks (§1.5) and a `locations` object-shape check (`city → street → house → string`, ≥ 400 streets).
2. **Ambiguous queue values**: «Черга 2» (376 houses, whole queue), double queues (165 houses), DNEM-served houses (16 houses, 6 + 10), «Усі дома/будинки». Product decision needed (§2.3).
3. **No update time, no unpublished-vs-quiet distinction** (§1.4/1.5). Show «ЦЕК не опублікував графік…» not «відключень немає» if you want to be strict on today.
4. **Tomorrow's publication pattern unknown** (no outage days to observe): when a schedule exists, CEK may publish late evening, or after midnight; re-observe at the next wave.
5. **Joomla caching/site load**: `no-store`; `nginx 1.31.1`; no rate-limit seen at ~1 req/s. Keep ≥ 1 s between requests, ≤ 2 requests (today, tomorrow) per refresh, and the map once a day.
6. **CEK vs YASNO/DNEM disagreement** (§4/§6): do not mix sources; do not add a YASNO fallback for CEK, it would show a different, wrong schedule. If the CEK form is down, fail with an error.
7. DNEM `getHomeNum` was observed to never assign a CEK group; an address that is on DNEM (the 16 houses) must use the DNEM provider (or be refused).
8. CEK queue labels: the page says «Черга 1.1»; DNEM's sch_names say «ЦЕК 1.1». Use «Черга n.m» (CEK's own wording).
9. The data/terms of cek.dp.ua: public customer-service pages, no ToS found; `robots.txt` allows the path.

## 8. Recommended provider design

- **New `src/main/providers/cek/`**, plain HTTPS from the main process (Electron `net.fetch`, like `voe`), no hidden window, no Imperva.
- `listCities()`: keys of `locations` (14), `listStreets(city)`: keys, `listHouses(city, street)`: keys → `HouseInfo` with `lines` parsed from the value (§2.3): `groupId` = `"n.m"`, `label` = «Черга n.m», two lines for «X та Y», two lines for whole «Черга N» (flag), and for «Група n.m (АТ "ДТЕК ДЕМ")» a line `groupId: 'dnem:GPVn.m'` marked as served by DTEK (or exclude it with a message). Trim house keys. Cache the parsed map in memory for the session (fetch ~35 KB gzip).
- `fetchSnapshot(address)`: two `POST`s (`queue=all`, today and tomorrow in Kyiv dates), parse tables, convert each queue's intervals to 48 slots (overlap rule; 23:59 → 24:00), pick `address.groupId` (or both lines). `sourceUpdatedAt` absent. Tomorrow quiet → omit tomorrow. Today quiet → «світло є» with the note.
- **Fail closed** with the §1.5 checks. Unknown rows (unparseable time) → `ProviderError`, never `on`.
- `currentOutage`: none; static note pointing to `t.me/cek_info`.
- Fixtures to ship (in `cek-raw/`): `cek-locations-2026-10-20.json` (full map, 218 KB), `cek-gpv-post-all-2026-01-15.html.txt` (real outages, 12 queues), `cek-gpv-post-1.1-2026-01-15.html.txt` (single queue), `cek-gpv-post-all-2026-10-20-quiet.html.txt` (quiet), `yasno-303-planned-outages-2026-10-20-quiet.json` + `yasno-regions-2026-10-20.json` (to document why YASNO is not used), `b42-dnipro-fact-2026-01-15-2154.json` and `b42-dnipro-fact-2026-10-17.json` (DNEM fact without `GPV100x`), `yasno-vs-cek-map-sample-2026-10-20.json`. Write the parser tests against the HTML-fragment fixtures; also hand-craft negative cases (no form, no sentinel and no table, a table with an unparseable time).

## 9. Recommendation: which option for CEK

**Neither (a) nor (b): use (c), CEK's own form for the schedule and CEK's own `locations` map for the address.**

| Criterion | (a) CEK map + DNEM `fact` | (b) YASNO dso 303 | (c) CEK map + CEK form (recommended) |
|---|---|---|---|
| Correct schedule for CEK customers | **no**: `fact` has no `GPV100x`; same-label DNEM groups differ by up to 14 half-hours | **no**: dso 303 body is byte-identical to dso 301 (DNEM); group lookup lossy for Dnipro | **yes**: the operator's own data |
| Hidden window / WAF | yes (Imperva + captcha cycles) | none now (Imperva in front, not challenging) | none (plain HTTPS, 0.3 s) |
| Address coverage | 14 cities, 9,022 houses | 11 cities, search-only, cap 20 | 14 cities, 9,022 houses, full enumeration |
| Freshness | DNEM stamp | `updatedOn` is a midnight sentinel on quiet days | no stamp, poll every 5–10 min |
| Quiet-vs-broken | `fact.update` stamp rule | status `NoOutages` vs `WaitingForSchedule` (good) | structural checks only; cannot tell "not published" from "none" |
| Effort | smallest, but wrong | small, but wrong | medium (two HTML scrapers + queue-value rules) |

Residual: the §7 ambiguities need a product decision, and a real outage day should be used to re-verify CEK vs DNEM agreement and the tomorrow publication pattern.
