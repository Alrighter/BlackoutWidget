# Lviv oblast (ПрАТ «Львівобленерго», LOE) — outage sources

Research date: 2026-10-20 (Tuesday), from a Ukrainian residential connection, Node 24 `fetch` and curl, no cookies.

Legend: **[VERIFIED]** = fetched today and seen. **[READ]** = from third-party code or docs. **[INFERRED]** = my reasoning from verified facts, not seen live.

Fixtures: `docs/superpowers/research/2026-10-20-outage-sources-step2/lviv-raw/` (list at the end).

---

## TL;DR

1. **Schedule = JSON with HTML text, no image parsing.** There is no `a_gpv_g`-style half-hourly JSON on LOE. The only structured form is the `rawHtml` text in the Hydra API `https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic` (and the same fields on `…/api/menu_items/238` = Today and `…/menu_items/256` = Tomorrow). [VERIFIED]
   - 12 lines «Група N.M. Електроенергії немає з HH:MM до HH:MM[, з … до …].» or «Група N.M. Електроенергія є.». Half-hour resolution, up to 5 ranges per group, end can be `24:00`.
   - Header gives the target date (`Графік погодинних відключень на DD.MM.YYYY`) and the revision time (`Інформація станом на HH:MM DD.MM.YYYY`, already in the app's `sourceUpdatedAt` format).
2. **Address → queue = clean cascade** on `https://power-api.loe.lviv.ua/api`: `pw_cities` (2,034) → `pw_streets?city.id=` → `pw_accounts?city.id=&street.id=` (`chergGpv` = `"5.1"` or `"Не входить"`). **No personal data** in `pw_accounts`. [VERIFIED]
3. **Current outage exists:** `pw_accidents?city.id=&street.id=` lists active planned and emergency outages with a `buildingNames` list, start (`dateEvent`) and estimated restoration (`datePlanIn`). Its free-text `koment` can contain customer names: never read or store it. [VERIFIED]
4. **Access:** Cloudflare in front, no challenge for normal use, no key, no cookies, UTF-8. No CORS allow-origin for foreign origins, so use main-process `net.fetch`. One burst of ~12 requests in 20 s got a Cloudflare 429 «Just a moment» on `power-api` once (see risks). [VERIFIED]
5. **Quiet day vs broken source** is the hard part: today's `Today` and `Tomorrow` items are simply empty (`rawHtml: ""`), and the last real schedule is 17.10.2026. A design that fails closed is in §6.

Verdict: **medium**. The lookups and current-outage API are easy. The schedule is easy to parse but the day-rollover behaviour of the Today/Tomorrow items could not be observed live (no outages since 17.10).

---

## 1. Schedule

### 1a. Where the site gets it [VERIFIED]

`https://poweron.loe.lviv.ua/` is a React SPA («Чому немає світла?», bundle `/static/js/main.2e846209.js`, 495 KB). It is the page the main site embeds. Its bundle shows two axios bases:
- `https://api.loe.lviv.ua/api` (CMS, Hydra/API Platform): `menus?page=1&type=<x>`, `pages?page=1&synonym=<x>`, `options?option_key=…`.
- `https://power-api.loe.lviv.ua/api` (address lookup + accidents): `pw_otgs`, `pw_cities`, `pw_streets`, `pw_accounts`, `pw_accidents`, `options`.

It calls `menus?page=1&type=photo-grafic` and reads `menuItems[0]` (Today) and `menuItems[2]` (Tomorrow); `menuItems[1]` is the archive. It renders `description` (text) if present, otherwise the PNG `https://api.loe.lviv.ua<imageUrl>` (desktop) / `<slug>` (mobile). It does **not** render `rawHtml` itself. So the structured text is a by-product that the API serves (the same HTML as the PNG's text), and **I could not confirm what fills Today/Tomorrow's `rawHtml` live** (see §1d).

No other schedule API exists on LOE's hosts. I checked, from the bundle and by request: no `a_gpv_g`, no `archive_gpv_graphs`, no `api-loe-poweron.inneti.net` reference anywhere in the bundle. `power-api…/api/pw_address_queues` (Zakarpattia's endpoint) → **404**. [VERIFIED]

### 1b. Endpoints [VERIFIED]

| Purpose | Request | Size | Cache headers |
|---|---|---|---|
| Whole menu incl. archive | `GET https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic` | 1.99 MB raw, **~46–50 KB on the wire** (brotli/gzip) | `public, max-age=3600, s-maxage=7200`, `cf-cache-status: HIT`, `Age` seen 436–781 s. **Can be stale up to 2 h.** A cache-buster query (`&_=<ts>`) gave `MISS`. |
| Today item | `GET https://api.loe.lviv.ua/api/menu_items/238` | 253 B | `no-cache, private`, DYNAMIC |
| Tomorrow item | `GET https://api.loe.lviv.ua/api/menu_items/256` | 256 B | `no-cache, private`, DYNAMIC |

Headers needed: none. Sending `Accept: application/ld+json` is safest (Content-Type is `application/ld+json`). Plain Node `fetch` with the default UA works.

**Do not request `menu_items` as a collection** (`/api/menu_items?parent=…`): it answered 200 with **60 MB**. [VERIFIED]

Menu structure (menu id 9, «Чому немає світла (Зображення-графік)»):

```
menus.hydra:member[0].menuItems = [
  { id:238, name:"Today",   orders:0, imageUrl:"", description:"", rawHtml:"", rawMobileHtml:"" },
  { id:241, name:"Arhiv",   orders:2, children:[ 734 items ] },
  { id:256, name:"Tomorrow",orders:1, imageUrl:"", description:"", rawHtml:"", rawMobileHtml:"" } ]
```

(Today/Tomorrow full fixtures: `menu_item-238-today-2026-10-20.json`, `menu_item-256-tomorrow-2026-10-20.json`.) Both are **empty today** (20.10). Item ids 238 and 256 are stable CMS ids; the item objects carry `name` ("Today"/"Tomorrow") and `menu: "/api/menus/9"`, which the provider can assert.

### 1c. Sample of a real day (archive item 1108, last revision of 17.10.2026) [VERIFIED]

```json
{ "id":1108, "name":"Графік передано 18:06 17.10.2026",
  "slug":"/media/6ad39ab358863_GPV-mobile.png", "imageUrl":"/media/6ad39ab31c408_GPV.png", "description":"",
  "rawHtml":"<div><p><b>Графік погодинних відключень на 17.10.2026</b></p>\n<p><b>Інформація станом на 18:56 17.10.2026</b></p>\n<p>Група 1.1. Електроенергії немає з 20:00 до 22:00.</p>\n…<p>Група 6.2. Електроенергія є.</p>\n</div>",
  "rawMobileHtml":"(identical to rawHtml in all 526 items)" }
```

Fixture: `menus-photo-grafic-2026-10-20-trimmed.json` (menu with empty Today/Tomorrow plus 9 hand-picked archive items, full original shape).

### 1d. Phrasing variants across all 734 archive items [VERIFIED, parsed by script]

- **526 items have `rawHtml`** (all of 30.10.2025 → 17.10.2026). The 208 oldest (23.07.2024 → 30.12.2024) have **no rawHtml**, only an image; some of those carry a `description` text instead (see "cancellation" below).
- Every item with `rawHtml` has exactly **12 group lines** (1.1, 1.2, 2.1, 2.2, 3.1, 3.2, 4.1, 4.2, 5.1, 5.2, 6.1, 6.2) and exactly two bold header lines. No other markup. One item contains a `<br>` (nothing else) as spare content.
- Line grammar, **complete** (counts over all items; digits shown as `#`):

| Count | Form |
|---|---|
| 2139 | `Група #.#. Електроенергії немає з ##:## до ##:##.` |
| 1388 | `… немає з ##:## до ##:##, з ##:## до ##:##.` (2 ranges) |
| 1277 | 3 ranges |
| 337 | 4 ranges |
| 15 | 5 ranges |
| 1156 | `Група #.#. Електроенергія є.` (note: «Електроенергія», not «Електроенергії») |

- Minutes are only `:00` and `:30`. Range ends `24:00` occur 1262 times (e.g. item 1075, 10.04.2026: `з 23:00 до 24:00`); `00:00` is used as a **start** (`з 00:00 до 03:30`). Ranges within a line are ascending, never wrap past midnight.
- **Placeholder trap:** item 540 (name «Графік передано 07:07 30.10.2025», heading «на 12.08.2024», «станом на 00:00 12.08.2024») has lines like `з 00:00 до 00:00` (16 zero-length ranges, even `з 00:00 до 00:00, з 00:00 до 00:00, з 00:00 до 00:00`). A zero-length range (start == end) must make the whole item invalid, not «off all day».
- **Explicit all-on revisions:** 14 items have all 12 lines «Електроенергія є» (e.g. 563, 929, 1022). So LOE does publish «no outages» schedules sometimes.
- **Cancellation (2024 only):** items with `description`, empty `rawHtml`: «Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ на 20.11.2024 до окремого розпорядження НЕК «Укренерго». \nУ випадку нового розпорядження … Інформація станом на 18:32 20.11.2024». Not seen in 2025–2026. Treat non-empty `description` as a note and a "no schedule today" signal.

### 1e. Identifying today/tomorrow and revisions [VERIFIED for archive, INFERRED for Today/Tomorrow]

- **Target day** = the date in the heading «Графік погодинних відключень на DD.MM.YYYY». Never use the item `name` («Графік передано …»): it is a rounded upload time and is often **different** from the real «станом на» time (522 of 526 differ).
- **Revision time** = «Інформація станом на HH:MM DD.MM.YYYY» → copy straight into `sourceUpdatedAt` (format already matches `HH:MM DD.MM.YYYY`, Kyiv local time, no zone marker). Item ids rise with time.
- A tomorrow-schedule is published the evening before: its «станом на» date is the **previous** day. In the archive: 424 items same-day, 102 items next-day (e.g. item 1095: heading 01.07.2026, станом на 19:05 30.06.2026). Never a difference other than 0 or +1 day.
- **Several revisions per day:** 94 distinct target days, up to **14 revisions of one day**. The latest «станом на» for a target date is current.
- Archive items with a heading date are the only way I could verify the format. The Today/Tomorrow items are CMS slots that probably receive the same `rawHtml` (the CMS stores the same fields) — **[INFERRED]**. I could not observe them populated: since 17.10 18:56 no outage schedule exists, and Today/Tomorrow are empty.

### 1f. Mapping to `Slot` [INFERRED from the grammar]

- Slot `i` (0..47) covers `i*30 … (i+1)*30` min from 00:00. A range `з S до E` fills `[S/30, E/30)` with `'off'`, with `E = "24:00"` → 48. Everything else `'on'`. There is **no maybe/«possible» state** in the text (so `'maybe-off'` never appears from LOE). `'unknown'` only if the group line is missing or the item is invalid.
- «Електроенергія є» → all 48 `'on'`.

### 1g. Resolution and the PNG

The PNG (`/media/…_GPV.png`, mobile `…_GPV-mobile.png`) is the same data as an image. **Not needed.**

---

## 2. Address → queue (power-api)

All `GET`, no headers, base `https://power-api.loe.lviv.ua/api`. [VERIFIED]

### 2a. Settlements

- `pw_otgs?pagination=false` → 85 громади (10 KB): `{id, code, name}` e.g. `{id:28, code:"UA46060250000025047", name:"Львівська"}`. 12 of the 85 are not Lviv-oblast (code not starting with UA46: «невідомо», «Луцька», «Рогатинська», «Бережанська», «Зборівська», «Тернопільська», «Івано-Франківська», «Фастівська», …) — junk rows from other oblasts. Fixture: `pw_otgs-2026-10-20.json`.
- `pw_cities?pagination=false&otg.id=` (empty `otg.id` = all) → **2,034 cities, 409 KB raw / 33 KB wire**, 0.7 s. Shape: `{id, name, codeOtg, otg:{@id,name}}`; 84 distinct громади in use. Львів = id 693, otg «Львівська». Fixture: `pw_cities-all-2026-10-20-compact.json` (id, name, otg.name only).
- **Wizard level:** the wizard should list **settlement + громада**, because 139 names are duplicated (462 entries), e.g. «Новосілки» ×4, «Піски» ×3, «Підгірці» ×3, «Монастирок» ×3; «Винники» exists under Львівська and Бориславська. Label `"<name> (<otg> громада)"` or group by otg → the same shape as the site's two-step picker (громада → settlement; `otg.id` filter works). There is no district (район) level in the API.
- Junk: 20 cities carry a non-Lviv `codeOtg` (Київ, Тернопіль, Луцьк, Івано-Франківськ, Бережани, …); 6 have otg «невідомо». The site shows them too. Safe to keep, or drop cities whose `codeOtg` does not start with `UA46`.
- **Stale or empty cities:** `1046 Червоноград` returns **0 streets** (city renamed Шептицький; the live entry is `2686 Шептицький`, 111 streets). Of 25 evenly sampled cities, 2 had 0 streets (both «Вулька»). Handle "no streets" gracefully.
- Spelling: city names use **U+2019** (49 cities, e.g. «Кам’янка-Бузька»), no Latin look-alikes in cities.

### 2b. Streets

- `pw_streets?pagination=false&city.id=693` → Львів: **1,654 streets**, 209 KB raw. Other sizes: Дрогобич 269, Стрий 211, Самбір 172, Жовква 125, Пустомити 118, Борислав 118, village 1–31.
- Shape: `{id, city:"/api/pw_cities/693", name}`. **The response shape varies:** a plain JSON array (`Content-Type: application/json`) for some requests and Hydra (`{"hydra:member":[…]}`, `application/ld+json`) for others (same URL, different client/cache variant; `Vary: Accept`). The provider must accept **both**. Fixture (array form): `pw_streets-city693-lviv-first80-2026-10-20.json`.
- Names: LOE style, surname + initial («Хмельницького Б.», «Симоненка В.»), «Урочище"Голоско"». Apostrophes: U+0027 (20×), U+2019 (2×), U+0060 backtick (2×) in the 3 cities sampled; a trailing space in 2 names (`"Стрийська - Наукова "`). Normalise (trim, unify apostrophes to one form, case-fold) for any matching. No Latin look-alikes, no duplicate names within Lviv.

### 2c. Houses and queues: `pw_accounts` [VERIFIED]

- `pw_accounts?pagination=false&city.id=693&street.id=12448` (Кульпарківська) → **7,560 rows, 2.28 MB raw / 69 KB wire**, 0.5–2.5 s. One row per **customer account**, not per house. Typical village street: 20–46 rows, 7–14 KB.
- Row fields (every one of 7,560 rows has exactly these): `@id, @type, id, city, buildingName, chergGpv, chergGav, chergAchr, chergGvsp, chergSgav, disconnectionTask, planedReplaceCounter`. Example:

```json
{"id":43,"city":"/api/pw_cities/693","buildingName":"145","chergGpv":"5.1","chergGav":"20","chergAchr":"9 (48.3Гц)","chergGvsp":"Не входить","chergSgav":"Не входить","disconnectionTask":false,"planedReplaceCounter":false}
```

- **No personal data:** no name, address text, phone or account number. `id` is an internal row id. (The site's own «Знайти за особовим рахунком» form uses extra filters `acc=` and `name=`; I did **not** call those and the provider must not either.) Fixtures: `pw_accounts-city693-street12448-building95-2026-10-20.json` (small), `pw_accounts-city1174-street13439-2026-10-20.json` (Брюховичі, 20 rows).
- `chergGpv` values seen: `"1.1" "2.1" "3.1" "3.2" "4.2" "5.1" "5.2" "6.1"` and **`"Не входить"`** = the "not in the schedule" value (the other cher* fields use the same word). All schedule queues are `N.M` with N 1–6, M 1–2, matching the 12 group lines. `chergGpv` is never empty (0 of 7,560).
- **A house can have several queues:** building «95» has rows `Не входить`, `5.1`, `5.2`; «230-А» `5.1` and `6.1`; 8 of 182 buildings on this street have more than one distinct value (apartment buildings fed by several feeders). So `lines` = the set of distinct `chergGpv` values per house, minus `Не входить`. If only `Не входить` remains → the house is in no schedule.
- **Dedupe by `buildingName`** (7,560 rows → 182 houses). Group id = the string `"5.1"`; label e.g. `"5.1"` (same as the group line text «Група 5.1»).
- **`&buildingName=` filter** works and is an **exact** string match: `…&buildingName=95` → 6.8 KB; `32-%D0%90` (32-А, Cyrillic А) → 1 row; `9` returns 0 rows; `32%D0%B0` (32а) returns 0. Use it to refresh one saved house cheaply, with the stored exact `buildingName`.
- **House-name spellings:** `145`, `36-42`, `32-А` (hyphen, Cyrillic letter; 50 of 182), `222/2`, `59,61,63` (a comma list as one name), `226В,Г`, `64 - А` (spaces), and `""` (empty; rows with several queues). No Latin letters in 182 names. Normalise for display, but **keep the original `buildingName` as the key**.
- Per-feature `disconnectionTask` / `planedReplaceCounter` are booleans about the account; ignore.
- **Freshness:** `power-api…/options?option_key=successful_last_synk` → `date` **2026-10-20T17:35:03+03:00** (it ticked from 17:30 to 17:35 across my requests: a 5-minute sync heartbeat of the address DB). The same key on `api.loe.lviv.ua` is stale (2022/2023), ignore it.

---

## 3. Current outage: `pw_accidents` [VERIFIED]

`GET https://power-api.loe.lviv.ua/api/pw_accidents?page=1&city.id=<id>&street.id=<id>` (`otg.id` optional; `pagination=false` also accepted; `city.id` alone works). 30 items per page; unfiltered, 123 total at the first fetch (5 pages, count moves while you read). Filtered by a street in Жовква: 1 item, 2 KB. Shape:

```json
{"id":277080250,"code_otg":"UA46…","city":{"id":2062,"name":"Бишків"},"street":{"id":…,"name":"Центральна "},
 "otg":{"id":…,"name":"Добросинсько-Магерівська"},
 "dateEvent":"2026-10-20T14:02:30+03:00","datePlanIn":"2026-10-20T18:00:00+03:00",
 "buildingNames":"19-А, 25, 33","typeOff":0,"switchSubReason":0,"koment":"…"}
```

- `typeOff` labels, copied from the site bundle: `0` «Планове вимкнення», `1` «Аварійне вимкнення», `2` «Оперативні перемикання», `30` «Можливе аварійне вимкнення». Seen in 117 items: 105 × `1`, 9 × `0`, 3 × `30`. `switchSubReason` always 0.
- `dateEvent` = outage start, `datePlanIn` = estimated restoration (ISO with `+03:00`). Over all 117: starts 09:33–16:44 today, estimates 17:45–20:00 today; none in the past → **finished outages are removed**, the list is "active now".
- Mapping to `CurrentOutage`: `typeOff 0` → `planned`, `1` and `30` → `emergency` (30 is "possible"; say so in text), `2` → `other`; `start = dateEvent`, `end = datePlanIn`; `text` generated by the app (e.g. «Планове вимкнення до 18:00»). **Match the house:** split `buildingNames` on `/,\s*/` and compare to the house's `buildingName` (itself possibly a comma list: split both and intersect). Filter list ids from the wizard (`city.id`, `street.id`), so no name matching is needed.
- **Privacy: do not use `koment`.** In 8 of 117 items it holds free text like `…(електропостачання житлового будинку Костюк Ю.І.) Замовник: <full name> Адреса об’єкту: …`. 6 distinct texts overall; the generic ones («Пошкодження абонентського обладнання», «Інцидент», «Заміна на дерев`яні опори») are harmless but not worth reading. In the fixture every `koment` longer than 40 characters is replaced by `<redacted…>`. Fixture: `pw_accidents-page1-2026-10-20-koment-redacted.json`.
- Entire streets are listed with `buildingNames` of 5–60 houses each, so a one-street request is enough for a house.

---

## 4. Access

- `api.loe.lviv.ua` and `power-api.loe.lviv.ua`: Cloudflare (`server: cloudflare`). Plain `curl` and Node `fetch` with no custom headers, no cookies, no `Origin`/`Referer`: HTTP 200 on every endpoint above. [VERIFIED]
- **CORS:** `Vary: Origin`; a request with `Origin: https://example.com` got no `Access-Control-Allow-Origin`; preflight returns `Allow-Methods: GET, OPTIONS, POST`. Browser-style cross-origin use is not offered → main-process fetch (Electron `net.fetch`, like the VOE provider). [VERIFIED]
- **Rate limit / challenge:** after ~12 requests in about 20 s (with 1.2 s gaps, including a 2.3 MB one) `power-api/pw_accounts?page=1&…` and `pw_accounts?pagination=false` returned **HTTP 429 with a Cloudflare "Just a moment…" interactive challenge page**. 45 s later everything worked again, including the same `?page=1` request, so it was a transient burst limit, not a WAF block on the query. Treat HTTP 429 or `text/html` body as "source blocked": back off, show the cached address data, and fail closed on the schedule (see §6). Do not add a hidden-window challenge solver yet. [VERIFIED once; cause not pinned down]
- `robots.txt`: `poweron.loe.lviv.ua` and `loe.lviv.ua` → `User-agent: *` `Disallow:` (everything allowed); the two API hosts have no robots.txt (404). [VERIFIED]
- Encoding: UTF-8 (`charset=utf-8`), JSON `\u` escapes in the `application/json` variants. [VERIFIED]
- No API key; the site's bundle sends only `Content-Type: application/json`. [VERIFIED]

---

## 5. Cross-checks and context

- `yaroslav2901/OE_OUTAGE_DATA` has `Lvivoblenerho.json` with `fact.update` 17.10 (no outages since); consistent with the 17.10 18:56 last revision above. [READ, from the survey `ukraine.md`]
- The call centre form `https://services.asd.company/api/loe/callcentr-relations/asd_send_request_no_light.php` appears in the bundle: a form that **sends** requests; not touched. [VERIFIED in bundle only]

---

## 6. Quiet day vs broken source (recommended rule)

Facts: today and tomorrow are empty with `rawHtml:""`. That looks the same as a quiet day. [VERIFIED]

Recommended logic (**[INFERRED]**, built on verified structure):

1. Fetch `menu_items/238` (Today) and `menu_items/256` (Tomorrow). **Fail closed** (throw) when: HTTP not 200; not JSON; `@type !== "MenuItems"`; `name` not "Today"/"Tomorrow"; `menu !== "/api/menus/9"`; any of `rawHtml`, `description` missing or not strings. That proves "the CMS is up and the structure is unchanged" and a quiet day is the **only** reading of an empty item.
2. When `rawHtml` is non-empty: parse strictly. All 12 groups present, each line matches the grammar, ranges ascending and non-empty, heading date is a real date. **Any deviation = error**, not «light is on» (e.g. the zero-length placeholder in item 540). Heading date must equal today (Today item) or tomorrow (Tomorrow item); otherwise treat the item as stale: ignore it, use step 3 for today.
3. **Safety net via the archive** (`menus?page=1&type=photo-grafic`, ~48 KB wire, up to 2 h cached, add a cache-buster): for today's date, take the archive item with the latest «станом на» whose heading date is today. Use it if the Today item is empty (covers a CMS that publishes only to the archive during the day). If the archive also lacks today → quiet day. The archive is where the format is verified (526 items), so this path is the best-tested.
4. Quiet day: all 48 `'on'` (or `'unknown'`-free), `note` = «Графік відключень на сьогодні не опублікований» (plus `description` text if the operator wrote a cancellation).
5. Extra health signal for the address data: `power-api/options?option_key=successful_last_synk` `.date` within the last ~1 h (5-minute heartbeat) — fail the *address* path if older than a day. It says nothing about the schedule.
6. If the archive's newest "станом на" is more than a few days old **and** Ukrenergo-style GPV is expected (winter) the app cannot tell; accept it (summer 2026 had 2.5 months with no entry: last 01.07 then 17.10).

Open: I **could not verify** how the CMS fills Today/Tomorrow's `rawHtml` and what the editors do at midnight. The safest implementation reads Today + Tomorrow, then the archive, and picks the **latest revision by «станом на» per heading date**, ignoring where the item came from.

---

## 7. Risks and open questions

- **Today/Tomorrow `rawHtml` never seen populated** (no outages since 17.10). The parser is verified on the archive, which has the same fields. Mitigation: use archive as the source of truth when Today is empty (§6).
- `menus` is cached up to 2 h by Cloudflare. Use cache-buster, or rely on `menu_items/238|256` (no-cache). The archive grows (734 items, +2 MB raw over time; wire size 48 KB today).
- CMS ids 238/256 could change. Assert `name`, `menu`; fall back to `menus` and look up by `name`.
- Text format changes: pre-30.10.2025 items had no text at all (image only), showing the operator once changed the process. A strict parser plus a fail-closed error is the defence.
- `pw_accounts` is heavy for long streets (2.3 MB raw / 69 KB wire for Кульпарківська, 7,560 rows). Download once per street selection, dedupe, and cache; do not poll. One house refresh = `&buildingName=` (exact string).
- Cloudflare **429 challenge** seen once after a burst (§4). Space calls (≥ 1.5 s), cache aggressively, and surface a clear error instead of retry loops.
- `pw_streets` response shape varies (array vs Hydra). Accept both.
- House keys with commas/spaces/Cyrillic letters: keep the original `buildingName` as the identity; never rebuild it from user input.
- **Stale city rows** (Червоноград 1046 with no streets, «Вулька» ×2): the settlement list is not guaranteed to have streets; show "no streets" and let the user pick Шептицький.
- **Namesake settlements** (139 duplicate names): always include the громада in the label; the saved address must store `city.id`.
- `pw_accidents.koment` can contain customer names: never log, store or display it.
- Legal: official public site's own API, called with the same parameters as the site; no terms were found. `robots.txt` allows all.

---

## 8. Recommended provider design

- **`listCities()`**: one call `pw_cities?pagination=false&otg.id=`, map to `{id, label:"<name> (<otg> громада)"}`; keep `city.id` as the key; cache for days. Optionally drop `codeOtg` not starting with `UA46`.
- **`listStreets(city)`**: `pw_streets?pagination=false&city.id=`; accept array or Hydra; normalise name (trim, apostrophes) for search; keep `street.id`.
- **`listHouses(city, street)`**: `pw_accounts?pagination=false&city.id=&street.id=`; group by `buildingName`; lines = distinct `chergGpv` ≠ `"Не входить"` (`{index, groupId:"5.1", label:"5.1"}`); houses with no lines are "not in the schedule"; skip empty `buildingName`. Cache per street; do not expose any other field.
- **`fetchSnapshot(address)`**: Today + Tomorrow via `menu_items/238|256`, archive fallback, strict regex parser (grammar in §1d), pick the line of the house's group(s) (`Група N.M.`), build 48 slots, `sourceUpdatedAt` from «станом на». For a house on several queues, return one `DaySchedule` per queue (or let the app pick) as the types allow.
- **`currentOutage`**: `pw_accidents?page=1&city.id=&street.id=`, intersect `buildingNames` with the house, map `typeOff`, ignore `koment`.
- All through Electron `net.fetch`, `Accept: application/ld+json`, ≥ 1.5 s spacing, 429/HTML → error.

## 9. Fixtures (`docs/superpowers/research/2026-10-20-outage-sources-step2/lviv-raw/`)

- `menus-photo-grafic-2026-10-20-trimmed.json` — real `menus` response, Today/Tomorrow empty, archive trimmed to 9 items: 248 (2024 image only), 372 (2024 cancellation `description`), 540 (placeholder `00:00–00:00`), 563 (all «Електроенергія є»), 975 (5 ranges, 10.02.2026), 1075 (24:00 ends, half hours, 10.04.2026), 1095 (tomorrow schedule published the day before), 1104, 1108 (17.10.2026 real outage day, final revision).
- `menu_item-238-today-2026-10-20.json`, `menu_item-256-tomorrow-2026-10-20.json` — empty items (the quiet-day shape).
- `pw_otgs-2026-10-20.json` — all 85 громади.
- `pw_cities-all-2026-10-20-compact.json` — all 2,034 cities (`id`, `name`, `otg.name`), Hydra shape.
- `pw_streets-city693-lviv-first80-2026-10-20.json` — first 80 Lviv streets (plain array form).
- `pw_accounts-city693-street12448-building95-2026-10-20.json` — house with queues `Не входить`, `5.1`, `5.2`.
- `pw_accounts-city1174-street13439-2026-10-20.json` — Брюховичі street, 20 rows, queue 2.1.
- `pw_accidents-page1-2026-10-20-koment-redacted.json` — 30 active outages, long `koment` redacted.

Scripts (scratch, not kept in the repo): `…\scratchpad\step2\lviv\*.mjs`.
