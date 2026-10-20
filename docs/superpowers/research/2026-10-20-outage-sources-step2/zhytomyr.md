# Zhytomyroblenergo (ZTOE), Zhytomyr oblast: deep-dive (step 2)

Research date: 2026-10-20, all requests from a plain Node/curl client (no browser, no cookies). Tags: **[VERIFIED]** fetched today; **[READ]** third-party code or docs; **[INFERRED]** my reading of verified data.
Fixtures: `zhytomyr-raw/` (index at the end). Scratch scripts: `...\scratchpad\step2\zhytomyr\`.

## TL;DR

- **Verdict: easy-medium.** Schedule and address lookup are plain server-rendered HTML on `www.ztoe.com.ua`: no WAF, no cookies, no tokens, `net.fetch` is enough. The work is careful HTML parsing (cp1251, inline styles, paginated result tables) and fuzzy house matching. [VERIFIED]
- **Schedule** `GET https://www.ztoe.com.ua/unhooking-search.php`: one `<table>` per published date (1 table = today only; 2 tables = today + tomorrow). Each has 12 rows (queues 1.1..6.2) x 48 half-hour cells. State = cell `background`: `#ffffff` on, `#ff3333` off. **No "maybe" colour.** (`#ff0000` exists only in the legend box.) Updated time: `<h4>Дата оновлення інформації - 17:00 20.10.2026</h4>`, already in the `HH:MM DD.MM.YYYY` format the app wants. [VERIFIED]
- **The table is oblast-wide, not per REM**; the same 12 queues apply everywhere. [VERIFIED]
- **Address cascade works fully stateless** (no cookie jar; the server never sends `Set-Cookie`): `POST` form-urlencoded `rem_id` -> `+naspunkt_id` -> `+vulica_id` (+`all=1` to get every row instead of the first 10). 19 REMs, 1758 settlements. [VERIFIED]
- **A house can have several queues.** Rows are split by consumer type (household / legal entity) and the same house number can appear in several rows with different queues (e.g. Zhytomyr, vul. Kyivska, house 84: 1.1 household, 3.1 legal; another street has house 56 as 6.2 household and 3.1 household). Some houses have no queue: "В цей час не вимикається, за винятком випадків аварійних відключень". [VERIFIED]
- **Current outage:** a separate React SPA `https://ztoe-poweron.inneti.net/` over a public JSON API `https://api-ztoe-poweron.inneti.net/api/` (same inneti vendor as Zakarpattia/LOE/TOE; Cloudflare in front, plain GET works, `Accept: application/ld+json` optional). Emergency, "operational security" and planned outages per street with house lists. Its city/street ids are NOT ztoe.com.ua ids, so the join is by name. [VERIFIED]
- **Quiet day is distinguishable from a broken source**: on a quiet day the page still has today's table, all 12x48 cells white, and a banner "команди НЕК УКРЕНЕРГО ... не надходило". Broken = table for today missing, wrong row/cell count, unknown colour, missing updated stamp. [VERIFIED via Wayback snapshots]

## 1. Schedule

### 1.1 Request

`GET https://www.ztoe.com.ua/unhooking-search.php` [VERIFIED]
- HTTP 200, `Server: nginx`, `X-Powered-By: PHP/7.4.33`, `Content-Type: text/html; charset=cp1251`, chunked. No cookies, no special headers needed. ~242 KB (one day) to ~480 KB (two days). Decode with `new TextDecoder('windows-1251')`.
- `robots.txt` [VERIFIED]: `Disallow: /admin /test /my /scripts /links.php /pokaz.php /docs/ /mystat /galery *?delor= *search=`. The path `unhooking-search.php` does not contain `search=`, so it is not matched (the string "search=" appears nowhere in our URLs). No Crawl-delay. No rate limiting seen at 1 req/1.1 s (about 60 requests).
- The same table is also embedded in every POST response of the address form (below), so the cascade pages double as schedule pages.
- The page has a header banner (`<h3>УВАГА! ВАЖЛИВА ІНФОРМАЦІЯ!`) with the Ukrenergo command, for example (20.10, 17:28 Kyiv):
  "На 12:30 20.10.2026р. НЕК "Укренерго" змінив застосування кількості черг: з 13:00 до 18:00 - 1,5 черги; з 18:00 до 22:00 - 2,0 черги; з 22:00 до 24:00 - 1,0 черга". On a quiet day: "На 26.04.2026 команди НЕК УКРЕНЕРГО на застосування графіків погодинних відключень електроенергії на Житомирщині не надходило." Useful as a `note`.

### 1.2 Structure (real excerpt, trimmed)

```html
<h4>Дата оновлення інформації - 17:00 20.10.2026</h4>
<table x:str border="0" ... style="...width:1300pt">
 <tr> <td ... rowspan="2"><b>Черга</b></td><td ... rowspan="2"><b ...>Підчерга</b></td><td style="width:3pt">&nbsp;</td>
      <td ... colspan="48"><b style="font-size:12pt;">20.10.2026</b></td> </tr>      <!-- the date of this table -->
 <tr> <td style="width:3pt">&nbsp;</td> <td ...>00:00-00:30</td> <td ...>00:30-01:00</td> ... 48 time labels </tr>
 <tr> <td ... rowspan="2"><b style="font-size:14pt;">1</b></td>                       <!-- queue number, rowspan=2 -->
      <td ...><a href="/unhooking-search.php?pidcherga_id=1"><b style="font-size:12pt;color:black;">1.1</b></a></td>
      <td style="width:3pt">&nbsp;</td>
      <td style="text-align:center;border-top:1pt solid black; ... background: #ffffff"><a href="...pidcherga_id=1">&nbsp;...</a></td>  x48
 </tr>
 <tr> <td ...>1.2 ...</td> ... 48 cells </tr>
 ... 12 sub-queue rows ...
</table>
<!-- then, for two-day pages, a second identical <table> for the next date; then the legend table "РОЗ'ЯСНЕННЯ" -->
```

- Tables in the page: the form table, one table per date, the legend table. [VERIFIED: 20.10 page has 5 `<table`, 2-day page 6.]
- Group row label = `<b style="font-size:12pt;color:black;">N.M</b>` (e.g. `1.1`); the link's `pidcherga_id=1..12` maps in order to 1.1, 1.2, 2.1, 2.2, ..., 6.2. The big "Черга" cell (`font-size:14pt`, rowspan=2) holds only the queue number; ignore it. Group id for the app: use the sub-queue label as is, `"5.1"`, for label ("Черга 5 Підчерга 1" -> `5.1`; the address result rows give queue and sub-queue in two separate cells, `5` and `1`, so `groupId = "{queue}.{subqueue}"`). [VERIFIED: address result "Черга 5 | Підчерга 1" for Berezivka; schedule rows 5.1/5.2.]
- Cell colour is in the inline style of the 48 `<td style="text-align:center;...background: #xxxxxx">` cells after the label cell. Cell k (0-based) = half hour [k*30 min, +30 min); the header row gives labels `00:00-00:30` ... `23:30-24:00` (no DST issues in the table; DST shift days not seen). The right-border pixels (`3pt`) every 2nd cell are just hour dividers.
- Cell colours seen across the live 20.10 page, the 13/14.10 two-day page, 04.2026 quiet day, 10.2026 pages: **`#ffffff` and `#ff3333` only** inside schedule tables. `#ff0000` and `background: white` appear only in the legend and header cells. [VERIFIED: 458 `#ffffff`, 118 `#ff3333`, 1 `#ff0000` (legend) on the live page.]
- Legend text (verbatim): red = "відключається при доведенні НЕК "Укренерго" обмежень"; white = "електроенергія гарантована при умові відсутності аварійних відключень або планових робіт". So red is conditional ("off when Ukrenergo applies the limits"); the page does not mark it as "maybe" and the banner states the actual number of queues per period. See risk R3.

Live sample (20.10.2026 17:00 revision; X = off, `.` = on, 48 cells per row, index 0 = 00:00):
```
1.1 ............................XXXXXX..........XXXX   (14:00-17:00, 22:00-24:00)
1.2 ............................................XXXX
2.1 ................XXXXXX............XXXXX.........
5.1 ....................................XXX.........
5.2 ..................................XXXXX.........
6.1 ................XXXXXX......XXXXXX..............
```
118 off cells at 17:00; the survey saw 128 earlier the same day, so the table is revised during the day.

### 1.3 Today and tomorrow, dating

- Each date has its own table, headed by `<b style="font-size:12pt;">DD.MM.YYYY</b>`. **Identify the day by that date string, not by position.** [VERIFIED: 13.10.2026 page (snapshot 22:56 Kyiv, 13.10) contains tables `13.10.2026` and `14.10.2026`; 20.10 17:28 contains only `20.10.2026`; 16.10 02:11 contains only `16.10.2026`.]
- Tomorrow appears in the evening after Ukrenergo publishes the next-day command (seen: updated 22:30). The table for today stays while tomorrow is added. At midnight the old today disappears (snapshot 02:11 on 16.10 showed only 16.10). [VERIFIED via Wayback; the exact moments are not known.] ZTOE_PARSER does the same: it looks for tables dated today and today+1 and treats a missing date as "no schedule". [READ]
- Dates are Kyiv local; there are no timestamps or timezone fields in the schedule.
- Update time: the single `<h4>Дата оновлення інформації - HH:MM DD.MM.YYYY</h4>` above the tables (one stamp for the whole page, not per date). Observed values: 17:00 20.10, 22:30 13.10, 02:00 16.10, 13:30 10.10, 12:00 07.10, 23:30 01.10; always :00 or :30, set by hand/at publication. It can lag the real edit. The page re-publishes several times per day (same day 20.10: 128 -> 118 off cells). Use the string as `sourceUpdatedAt` as it is. ZTOE_PARSER uses the same regex `Дата оновлення інформації[^0-9]*(\d{2}):(\d{2})\s*(\d{2})\.(\d{2})\.(\d{4})`. [READ]
- On a quiet day the stamp's date equals today's date as well (snapshots 25.07, 09.08, 07.06, 26.04: "Дата оновлення ... 10:30 26.04.2026"), so it is a "page regenerated today" signal.

### 1.4 Quiet day vs broken source

| state | what the page looks like | what the provider does |
|---|---|---|
| Outages today | table dated today, some `#ff3333` cells; banner "по команді НЕК ... буде застосовано" | slots from cells |
| **Quiet day** | table dated today still present, **all 576 cells `#ffffff`**, banner "команди ... не надходило" [VERIFIED: 26.04, 07.06, 25.07, 09.08.2026 snapshots, 0 red cells, date header present] | all `on`, note "світло є" + banner text |
| Today's date not in page (but page loads) | e.g. page stale or redesigned | **error** (fail closed) |
| Page loads but != 12 rows x 48 cells, or a cell colour other than `#ffffff`/`#ff3333`, or no updated stamp, or no `rem_id` select | markup change | **error** |
| HTTP error / non-cp1251 mojibake / empty body | outage of site | error |

A rule that is safe: require the table with today's Kyiv date, 12 labelled rows `1.1..6.2` in order, exactly 48 coloured cells each, and the updated stamp. If today's table is missing, error, not "quiet". Tomorrow missing is normal (just no second day).
Edge: right after midnight Kyiv the site might still show yesterday's table for some minutes (not observed; 02:11 was fine). Treat as error/stale and retry.

### 1.5 Mapping to Slot

`#ffffff` -> `'on'`, `#ff3333` -> `'off'`, anything else -> throw. Never `'maybe-off'` and never `'unknown'` from this source (a day without a table = not published). 48 cells -> 48 slots one to one.

### 1.6 Past day with real outages (fixtures)

ZTOE has no archive endpoint. Wayback Machine snapshots (`http://web.archive.org/web/<ts>id_/https://www.ztoe.com.ua/unhooking-search.php`, gzip, cp1251) give real pages [VERIFIED]:
- 2026-10-13 22:56 Kyiv: two days 13.10 + 14.10, updated 22:30 13.10, 230 red cells. (fixture)
- 2026-04-26 (and 07.06/25.07/09.08): quiet day, 0 red cells. (fixture)
- 2026-10-20 17:28 live. (fixture)
Also seen: 2026-02-12 two days with 628 red cells; 2026-10-16 02:11 one day, 116 red cells; 2026-10-10 110; 2026-10-07 96.

## 2. Address -> queue (ztoe.com.ua form cascade)

### 2.1 Endpoint and statefulness

`POST https://www.ztoe.com.ua/unhooking-search.php`, `Content-Type: application/x-www-form-urlencoded`. Response is the full page (~250 KB) with the selects filled in and the result table. [VERIFIED]

| step | body | response |
|---|---|---|
| 0 | GET page (or any POST) | `<select name="rem_id">` with 19 REMs |
| 1 | `rem_id=5` | `<select name="naspunkt_id" onchange=...>` with 78 settlements; `vulica_id` still disabled |
| 2 | `rem_id=5&naspunkt_id=16205` | `<select name="vulica_id">` with the streets (Berezivka: 4: Vyshneva 168893, Sadova 168894, Tsentralna 168895, "КТП-2" 169498) |
| 3 | `rem_id=5&naspunkt_id=16205&vulica_id=168893` | table "За Вашим запитом знайдено записів: 2" + rows |
| 3b | same + `all=1` (any value) | all rows; without it only the first 10 rows are shown with a button "показати ще N записів" (hidden form with `all`) |

- **Cookie jar not needed.** Every step above was done as a fresh stateless POST with all ids so far; no `Set-Cookie` header was ever returned (checked on every response). `rem_id` only is enough for the settlement list; ids of the previous levels must be re-sent. [VERIFIED]
- Option values are numeric ids; settlement id 16205 is global (not per REM). `naspunkt_id` and `vulica_id` options exclude value `0` ("Оберіть ..."). HTML parse: `<option value="(\d+)"[^>]*>([^<]*)`.
- Labels contain HTML entities (`&#039;` x32 in settlements, x20 in the Zhytomyr street list): decode them. After decoding there are two apostrophe forms: `'` (from the entity) and U+2019 (27 settlements, 3 Zhytomyr streets) [VERIFIED]. Normalize both.

### 2.2 REMs (wizard step "district") and sizes

From the `rem_id` select (values are ztoe.com.ua `rem_id`; note they differ from the inneti API's otg ids). Settlement counts [VERIFIED]:

| rem_id | REM | settlements | rem_id | REM | settlements |
|---|---|---|---|---|---|
| 1 | Андрушівський | 41 | 17 | Овруцький | 286 |
| 2 | Баранівський | 60 | 18 | Олевський | 60 |
| 3 | Бердичівський | 66 | 19 | Попільнянський | 101 |
| 4 | Брусилівський | 36 | 23 | Пулинський | 68 |
| 7 | Житомирський | 103 | 20 | Радомишльський | 84 |
| 16 | Звягельський | 224 | 21 | Романівський | 63 |
| 9 | Коростенський | 150 | 5 | Хорошівський | 78 |
| 11 | Коростишівський | 64 | 24 | Черняхівський | 58 |
| 13 | Любарський | 46 | 25 | Чуднівський | 60 |
| 14 | Малинський | 110 | | **total** | **1758** |

(The "79" in the survey counted the `0` placeholder option.) Settlement label prefixes: "с." 1529, "Село" 149, "селище" 58, "місто" 11, "с/рада" 8 (e.g. "с/рада Оліївська станція Світин", "с/рада Березівська": rural-council areas), "м. Звягель", "Місто Овруч", "Селище Бондарі". 140 label strings occur in more than one REM (e.g. "місто Андрушівка" appears under rem 1 and rem 19, "селище Іванопіль" under 3 and 25), so the wizard needs REM + settlement and the stored address must keep `rem_id` and `naspunkt_id`.
Cities: Zhytomyr = `rem_id=7`, `naspunkt_id=16657` "місто Житомир" (966 streets); Berdychiv `3/16758`; Korosten `9/17062`. [VERIFIED]

Design choice for `listCities()`: the label should be e.g. "місто Житомир (Житомирський РЕМ)" or two wizard levels; total fetch cost for the full bundled list is 19 POSTs (about 20 s at 1 req/s) and 62 KB JSON, so **bundling the 1758-entry list as a static asset and refreshing it rarely** is reasonable, but the live per-REM POST is also cheap (one request, ~250 KB). Streets need 1 POST per settlement chosen.

### 2.3 Result rows and house format

Real rows (Berezivka, vul. Vyshneva) [VERIFIED]:
```
Хорошівський | с. Березівка | вул. Вишнева | 1, 11, 12, 14, 15, 16, 17, 1А, 1Б, 2, 20, 21, 23, 24, 25, 27, 3, 34, 3А, 4, 5, 6, 7, 8, 9 | 5 | 1 | побутові споживачі
Хорошівський | с. Березівка | вул. Вишнева | 18                                                                                       | 5 | 1 | непобутові (юридичні) споживачі
```
Seven columns: REM, settlement, street, houses (comma-separated list), queue (`Черга`), sub-queue (`Підчерга`), note (`Примітка`). HTML: `<tr><td align="center">..</td> x7</tr>`; the pager is a `<form id="mainform2">` inside the same table.

- The `Примітка` column is one of: `побутові споживачі` (household) or `непобутові (юридичні) споживачі` (legal entities). The widget is for homes: **use household rows**; use legal rows only as a fallback when a house has no household row (note it).
- Houses: one cell with comma + space separated tokens. Tokens seen: `1`, `1А`, `1Б`, `74/А`, `74/А`, `15/15`, `17/18`, `16-А` and `16А` (both spellings, different rows, same street), `108/56`, `108/56А`, `108/56-а` (lowercase Cyrillic), `55Г`, `31/28`, `35/21Б`, `ТП-334` (a transformer sub-station as a "house"), `н/б`, `0` (inneti side). A house number can appear more than once in the same street across rows (see 2.4). A typical big street has many rows (Zhytomyr vul. Kyivska: 77 rows, 127 distinct house tokens; Perem. 47 rows).
- Normalization for matching: uppercase, strip spaces, drop `-` between number and letter (`16-А` == `16А`), map Latin look-alikes to Cyrillic (А В С Е Н І К М О Р Т Х), decode entities. Latin look-alikes are present in street labels already: `вул. I.Франка` (Latin `I`), `вул. ВОРОНИЧIВ`, `вул. Святого Йоана Павла II`. [VERIFIED: 2 mixed-script street labels in Zhytomyr's 966; none in the 1758 settlements.]
- "Not in schedule" value: the queue and sub-queue cells contain the text **"В цей час не вимикається, за винятком випадків аварійних відключень"** instead of numbers (both cells). Map to "no GPV queue for this house": `lines = []` and a note. A house missing from all rows = unknown; report "не знайдено" (do not guess a queue).

### 2.4 One house, several queues

Yes. [VERIFIED] Zhytomyr, vul. Kyivska, the full list (77 rows): house `84` is `1.1` (household row), `1.1` (legal) and `3.1` (legal "84, 40"); house `77` is `3.2` and `1.1` (both legal); on another street house `56` is `6.2` (household) and `3.1` (household) in different rows. Large buildings are split by entrance/feeder in practice. So `listHouses()` must return, per house, `lines` = distinct `{queue.sub}` over its household rows (index 0..n), and the provider should show a house with several lines per `LineInfo`. Sort deterministically.
Pagination consequence: always request with `all=1`, otherwise a house list is incomplete (first 10 of 77 rows).

### 2.5 Sizes and cost

Per settlement: one POST for streets (~250 KB response; the page includes the full schedule each time). Per street: one POST with `all=1` (Zhytomyr Kyivska: 79 `<tr>`, 22 KB of result table). Zhytomyr city has 966 streets; `<select>` is not paginated. The wizard needs 3 sequential POSTs at most, so no crawling is needed. Alternative bulk path (not used): `GET unhooking-search.php?pidcherga_id=N` returns one 1.4 MB page listing all addresses of that sub-queue [VERIFIED for N=9: HTML table, same 7 columns]. Do not use it in the app.

## 3. Current outage

`https://www.ztoe.com.ua/` links "Діючі відключення в електромережі на поточний час" -> `https://ztoe-poweron.inneti.net/` and "Планові відключення електроенергії" -> `.../planovi_vidkluchenna`; also `/unhooking.php` "Планові та аварійні відключення електроенергії". [VERIFIED] The SPA (React; bundle `static/js/main.690ab3b0.js`) calls the public API **`https://api-ztoe-poweron.inneti.net/api`** (API Platform, JSON-LD/Hydra, 30 items per page, `hydra:totalItems`, `hydra:view` with first/last/next). No auth, no key, no Origin/Referer needed, no CORS needed (main process). Cloudflare in front, but plain curl and Node `fetch` get 200. `robots.txt` of the SPA: `Disallow:` (empty = allow). `Cache-Control: max-age=60, public, s-maxage=120` on accidents, `max-age=3600` on dictionaries. [VERIFIED]

### 3.1 Endpoints (extracted from the bundle, then verified by GET)

| endpoint | purpose |
|---|---|
| `pw_otgs?pagination=false` | 19+ REMs: `{id:1..., name:"Андрушівський РЕМ"}` (ids differ from `rem_id`: here 5 = Хорошівський, 6 = Житомирський, 7 = Коростенський, 11 = Звягельський) |
| `pw_cities?pagination=false&otg.id=5` (also `&name=Березівка`, works as exact filter; without `otg.id` 22,694 rows) | cities: `{id, name:"Березівка", otg:{id,name}}`. Names carry no "с."/"місто" prefix; duplicates exist (3 Березівка in otg 5: ids 1636 (0 streets), 2622 (5 streets), 17707) |
| `pw_streets?pagination=false&city.id=2622` | streets `{id, name:"вул. Вишнева"}` (city 214 Хорошів: 111) |
| `pw_accidents?page=1&otg.id=&city.id=&street.id=&typeOff=1&switchSubReason=0` | current outages (emergency etc.), paged by 30 |
| `pw_accident_planeds?page=1&otg.id=&city.id=&street.id=` plus `datePlanIn[after]` / `datePlanIn[before]` (as used by the site; filter semantics not tested) | planned works |
| `pw_accident_histories`, `pw_accident_planed_histories` | history (not fetched) |
| `pw_address_queues?page=1&city.id=&street.id=&buildingNames=` | address -> queue; **returns `[]`** for ZTOE (tried two streets), unlike Zakarpattia where it is populated |
| `options?option_key=pw_gpv_image_today` / `_tomorrow` / `pw_gpv_nek_comand` | schedule images (empty `value` today) / NEK command text (empty today) |

Filters `city.name=` and `street.name=` on `pw_accidents` are ignored (return all rows); `city.id`, `street.id`, `otg.id`, `typeOff`, `switchSubReason` work. [VERIFIED]

### 3.2 Record shape (real, `pw_accidents`)

```json
{"@id":"/api/pw_accidents/316895799","@type":"PwAccident","id":316895799,"code_otg":"5",
 "city":{"id":2622,"name":"Березівка","codeOtg":""},
 "street":{"id":72590,"name":"вул. Вишнева","city":{...}},
 "dateEvent":"2026-10-20T11:15:42+00:00","datePlanIn":"2026-10-20T17:00:00+00:00",
 "koment":"","switchSubReason":0,
 "otg":{"id":5,"code":"5","name":"Хорошівський РЕМ"},
 "buildingNames":"1, 11, 12, 14, 15, 16, 17, 18, 1А, 1Б, 2, 20, 21, 23, 24, 25, 27, 3, 34, 3А, 4, 5, 6, 7, 8, 9","typeOff":1}
```
- One record per (street, outage); `buildingNames` is the house list in the same style as ztoe.com.ua (`1А`, `13-а`, `0` and `н/б` also occur).
- `switchSubReason` [VERIFIED counts, meanings INFERRED from the site's filter code and samples]: `0` = emergency/unscheduled (7263 rows today, `koment` empty); `1` = "По операційній безпеці" (53 rows); `2` = **a schedule (GPV) outage, `koment` = the queue, e.g. "3.1"** (4611 rows). The site's "emergency" tab is `typeOff=1&switchSubReason=0` + `typeOff=2`; `typeOff=2` returned 0 rows.
- `pw_accident_planeds` records have `typeOff:3`, no `switchSubReason`, `koment:""`; 9085 rows; **dated far into the future too** (page 303 had 2027-09-02 entries), so a client must filter by date.
- **Timestamps are Kyiv wall-clock labelled `+00:00`** [INFERRED, strong]: the GPV rows `koment:"3.1"` have `dateEvent 11:00:34` and `datePlanIn 14:00:00`, which equals queue 3.1's red block 11:00-14:00 in today's table. Parse as local time, ignore the offset. (Verify again before relying on it; if the vendor ever fixes the suffix this breaks.)
- Mapping to `CurrentOutage`: `switchSubReason 0` -> `kind:'emergency'` (start = `dateEvent`, end = `datePlanIn`, text "Аварійне відключення"); `1` -> `'other'` ("Відключення за операційною безпекою"); `pw_accident_planeds` active now -> `'planned'`; `2` -> **ignore** (it just repeats the schedule).
- Matching an address: the ids are inneti ids, not ztoe.com.ua ids. Join by names: `pw_cities?otg.id=<inneti otg>&name=<name without the "с."/"місто" prefix>` (several hits possible; try each), then `pw_streets?city.id=` match the street string (normalized), then `pw_accidents?...&city.id&street.id`, then check the house in `buildingNames` (normalized split). The street label matched exactly in my probe (Berezivka "вул. Вишнева" in both systems) and the house list was identical to the ztoe.com.ua one. Needs a REM-id map `ztoe rem_id -> inneti otg.id` (by name; "Житомирський" is 7 vs 6, so do not reuse numbers).
- Real example today: Berezivka (otg 5, city 2622) had 5 emergency rows with `dateEvent 11:15:42`, `datePlanIn 17:00` for vul. Tsentralna, Sadova, Vyshneva, "Невизначено" and Komarova, while the schedule table for 5.1 showed only 18:00-19:30; so the "emergency" list is a real separate signal. (It looks like a whole-area outage record; I did not check the cause.)

## 4. Access summary

| | www.ztoe.com.ua | api-ztoe-poweron.inneti.net |
|---|---|---|
| WAF / Cloudflare | none (nginx, PHP 7.4) | Cloudflare, no challenge for plain GET |
| required headers | none (default UA works) | none (`Accept: application/ld+json` optional) |
| cookies | none | none |
| rate limit | none seen (~60 requests at 1 per 1.1 s) | none seen (~35 requests) |
| encoding | **cp1251** (HTML, POST body is sent as UTF-8 form data and was accepted for ASCII ids; Cyrillic values were never needed) | UTF-8 JSON |
| robots | `*search=` not matched by our paths | allow all |
| size | 242-480 KB per page | 2-25 KB |

`net.fetch` in the Electron main process is enough for both. For the HTML POST: `new URLSearchParams({...})`, header `content-type: application/x-www-form-urlencoded`.

## 5. Risks and open questions

- **R1 Markup drift.** Inline-style table, PHP, hand-published banner. Mitigation: strict structural validation (section 1.4), fail closed, fixtures for 1-day, 2-day, quiet-day.
- **R2 Date semantic.** The schedule has no machine date other than the `<b>DD.MM.YYYY</b>` header; the first table is not always "today" in principle. Select by date.
- **R3 "Red" is conditional.** Legend: red means off *when Ukrenergo brings the limits*; the banner gives how many queues are active per time window ("1,5 черги" etc.). The table seems to be already the applied schedule (aggregators map it to plain `no`), but the page does not say so; consider showing the banner as `note`. Mapping red to `'off'` matches OE_OUTAGE_DATA. Open question for the user: `off` or `maybe-off`.
- **R4 Multiple queues / legal-entity rows.** Household vs legal rows differ in the same street; a house may have several household queues. UI must handle `lines.length > 1` and `0`.
- **R5 Name join for current outage** (inneti). Duplicate city names, the label difference (no "с." prefix), `н/б`/`0` house tokens, and the unconfirmed timezone convention. Treat the current-outage lookup as best-effort: failure must not break the schedule snapshot (omit `currentOutage`, add a degraded note), but the schedule itself fails closed.
- **R6 inneti `pw_accidents` returns 7263 street-level "emergency" rows right now**, so Ukrenergo-driven outages may also be represented there. Not examined which fraction is real emergencies. Also the `pw_accident_planeds` future dates (2027) look like noise.
- **R7 Wizard data size.** 1758 settlements and up to 966 streets per settlement: fine, but labels need entity decoding, apostrophe folding and Latin/Cyrillic folding for search.
- **R8 Wayback only for history.** No official archive; keep the fixtures.
- Not verified: the exact time tomorrow's table appears/disappears; behaviour when `rem_id` is invalid; gzip support of ztoe.com.ua (I did not send `Accept-Encoding` explicitly beyond Node/curl defaults; Electron's `net.fetch` handles it).

## 6. Recommended provider design

1. **Schedule:** `GET unhooking-search.php`, decode cp1251, run `parseSchedule(html, todayKyiv)`: updated stamp regex; split on `<table` segments; per segment find `<b style="font-size:12pt;">(\d\d\.\d\d\.\d{4})</b>`; for each of the 12 rows read the label `color:black;">(\d\.\d)</b>` and collect `background:\s*(#[0-9a-fA-F]{6})` of the 48 cells in the same `<tr>` (skip the label cell, which uses `background: white`); colour map `#ffffff`/`#ff3333` only. Produce `DaySchedule` for today and, if present, tomorrow; **throw** if today's table, any of the 12 labels, 48 cells, or the stamp is missing. `sourceUpdatedAt` = stamp string. `note` = the `<h3>` banner text (strip tags) when present.
2. **Quiet day** = all cells `on` in today's valid table; set `note` "світло є" + banner. Never infer quiet from a missing table.
3. **Address:** stateless `POST` cascade, no cookie jar; `listCities` = bundled/live REM + settlement (label "місто Житомир, Житомирський РЕМ"; keep `rem_id`+`naspunkt_id` in the saved address); `listStreets` = one POST; `listHouses` = POST with `all=1`, parse rows, keep household rows (fallback legal), split house tokens, normalize, group by house; `lines` = distinct `N.M`; "В цей час не вимикається..." -> no lines + note.
4. **Current outage (optional layer):** inneti API by name join; `switchSubReason 0/1` -> emergency/other, planned works from `pw_accident_planeds` filtered to now; ignore `switchSubReason 2`; cache 60 s; errors here do not fail the snapshot.
5. **Rate:** 1 schedule GET per refresh (cache >= 5 min, the page updates a few times a day), address POSTs only in the wizard.
6. **Spelling:** shared normalizer for streets/houses/settlements: decode HTML entities, fold `'`/U+2019/U+02BC, fold Latin look-alikes to Cyrillic, lowercase, drop spaces/hyphens in house tokens, `ё` not relevant.

Reference [READ]: `yaroslav2901/ZTOE_PARSER` (`src/ztoe_parser.py`, pushed 2026-02-11, no licence file seen): uses Playwright (unnecessary, plain GET works), picks tables by today/tomorrow date string, takes all `background:\s*#hex` of the row, `is_blackout_color` = r>200 and g<80 and b<80 (so `#ff3333` and `#ff0000` both count as off), collapses 2 half-hours to hour states `no/first/second/yes`, uses the `Дата оновлення інформації` stamp, and treats a missing date table as "no schedule". It does not do the address lookup. Its output is OE_OUTAGE_DATA's `Zhytomyroblenergo.json`.

## 7. Fixtures (`docs/superpowers/research/2026-10-20-outage-sources-step2/zhytomyr-raw/`)

| file | content |
|---|---|
| `unhooking-search-2026-10-20-1728-live-cp1251.html` | live page, 20.10 (updated 17:00), 1 day, 118 red cells, cp1251 bytes unchanged (242 KB) |
| `unhooking-search-2026-10-13-two-days-wayback-cp1251.html` | Wayback 13.10 22:56: today 13.10 + tomorrow 14.10, updated 22:30; anchors emptied and cell borders shortened to fit size (274 KB); structure otherwise intact |
| `unhooking-search-2026-04-26-quiet-day-wayback-cp1251.html` | Wayback quiet day, all white, banner "не надходило" (139 KB, same trimming) |
| `settlements-by-rem-2026-10-20.json` | `byRem[rem_id] = [[naspunkt_id, label], ...]`, 1758 entries, entities as served |
| `streets-berezivka-16205.json`, `streets-zhytomyr-city-2026-10-20.json` | street option lists (4 and 966) |
| `address-result-berezivka-vyshneva-cp1251.html` | result fragment, 2 rows (household + legal) |
| `address-result-zhytomyr-kyivska-first10-cp1251.html`, `...-all-cp1251.html` | result fragments without and with `all=1` (10 / 77 rows; multi-queue houses, "не вимикається" rows, `16-А`/`16А`) |
| `inneti-pw_otgs.json`, `inneti-pw_streets-city2622.json` | dictionaries |
| `inneti-pw_accidents-city2622-berezivka.json` | 5 emergency rows for one village |
| `inneti-pw_accidents-sub0-emergency-first5.json`, `-sub1-opsecurity-first3.json`, `-sub2-gpv-queue-first3.json` | the three `switchSubReason` kinds (trimmed lists, `hydra:totalItems` kept) |
| `inneti-pw_accident_planeds-first5.json` | planned works sample |

No personal data was returned by any endpoint used (addresses and house lists only).
