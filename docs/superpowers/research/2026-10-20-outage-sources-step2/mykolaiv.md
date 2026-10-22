# Mykolaivoblenergo (Mykolaiv oblast): deep dive, 2026-10-20

Tags: **[VERIFIED]** = fetched today; **[READ]** = third-party code, docs, or the site's own JS (read, not exercised against live data).

## TL;DR

- **Verdict: easy.** Plain HTTPS JSON, no WAF, no cookies, no headers, no auth. A bare Node `fetch` works. [VERIFIED]
- Host `https://off.energy.mk.ua` (Laravel behind Cloudflare). robots.txt is `Disallow:` (empty = allow all). Responses are cached ~22 s (`Cache-Control: private, max-age=22`, `cf-cache-status: HIT`, `last-modified` within the minute). [VERIFIED]
- Schedule = **three joined calls**: `GET /api/v2/schedule/active` (per-day `series`), `GET /api/schedule/time-series` (48 half-hour slots), `GET /api/outage-queue/by-type/3` (the 12 ГПВ sub-queues). Half-hour resolution. Types: `OFF`, `SURE_OFF`, `PROBABLY_OFF`, anything absent = on.
- **No past day with outages is available.** `active` is `[]` today. There is no history or by-date endpoint (see §1.6) and the Internet Archive was offline. The shape comes from the site's own JS plus three independent third-party clients. `mykolaiv-raw/SYNTHETIC-schedule-active-shape.json` is a **hand-built fixture, not a real response**.
- Address cascade is 5 JSON calls, all verified. 20 «дільниці» (filii) → 890 settlements → streets → houses → queues. One house can have **two ГПВ queues** (3 of 36 sampled houses), and many houses have **none**.
- «Current outage» exists only as a per-queue `enabled` flag (1/0), including ГАВ and СГАВ queues. It carries no time range and no text. Not exercised (all 0 today).

## 1. Schedule

### 1.1 Endpoints

All `GET`, no params, no auth. `Accept: application/json` is optional. [VERIFIED]

| call | purpose | today's size |
|---|---|---|
| `/api/v2/schedule/active` | published per-day schedules | `[]` (2 B) |
| `/api/schedule/active` | v1 of the same; same `[]` today, but **README says v1 does not return tomorrow** [READ gzoreslav]; its item shape was flat (`outage_queue_id`, `time_series_id`, `type`) in [READ wpmaxpro/gav2.1]. Don't use v1. | `[]` |
| `/api/schedule/time-series` | slot dictionary | 3.9 KB, 48 rows |
| `/api/outage-queue/by-type/3` | ГПВ sub-queues | 1.4 KB, 12 rows |
| `/api/outage-queue/by-type/1` and `/2` | ГАВ (20 rows) and СГАВ (3 rows) | 2.4 KB / 0.4 KB |

The front end (`/js/app.js`, 11 KB, fetched in full, the whole route list is in §5) loads queues, time-series, then `v2/schedule/active`. [VERIFIED]

### 1.2 Shapes

`time-series` (verified, fixture `time-series-2026-10-20.json`):
```json
{"id":1,"start":"00:00:00","end":"00:30:00","created_at":null,"updated_at":null} … {"id":48,"start":"23:30:00","end":"00:00:00",…}
```
Slot `id` N covers `(N-1)*30 min` from local midnight. The last `end` is `00:00:00`, meaning 24:00. [VERIFIED]

`by-type/3` (verified): `{"id":14,"name":"1.1","type_id":3,"enabled":0,"created_at":null,"updated_at":"2026-10-17T20:24:52.000000Z","deleted":0}`.
- ГПВ: ids 14 `1.1`, 15 `1.2`, 16 `2.1`, 17 `2.2`, 19 `3.1`, 20 `3.2`, 21 `4.1`, 22 `4.2`, 24 `5.1`, 25 `5.2`, 26 `6.1`, 27 `6.2`. Ids 18 and 23 are skipped. The API list never contains a `deleted:1` row today, but filter on `deleted == 0` anyway.
- ГАВ (type 1): ids 1–10 named `1`…`10`, ids 29–38 named `1(Р)`…`10(Р)`. СГАВ (type 2): ids 11–13 named `1`…`3`. [VERIFIED]

`v2/schedule/active` **[READ]**, from `app.js`, the Go model `InstantRemedy/off-energy-mk-ua-go/models.go`, and the test in `mrkaktuz/outages-data` (all three agree):
```json
[{"id":501,"from":"2026-10-19T21:00:00.000000Z","to":"2026-10-20T20:59:00.000000Z",
  "series":[{"id":1000,"outage_schedule_id":501,"time_series_id":21,"outage_queue_id":17,
             "type":"OFF","created_at":"…Z","updated_at":"…Z"}, …]}]
```
- `from` is a UTC instant equal to 00:00 **Kyiv** of the schedule's day. `to` is `from + 23:59` (from the test fixture; not confirmed live).
- `series` is optional in the front end (`item.series ? … : []`). Treat a missing `series` as empty.

### 1.3 Today vs tomorrow

The site buckets by `formatDate(new Date(item.from))` (browser-local date), sorts by date, and appends `series` when two rows share a date. It then shows one radio button per date and defaults to today's. If today has no row it fabricates an empty today. [READ app.js]
- So the response can hold several days and several rows per day. [READ]
- Do the bucketing in **Kyiv** time: `Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv'})` over `new Date(from)`. Don't add `(id-1)*30 min` to `from` (as the HA integration does): on the 25 Oct 2026 DST fall-back day that is off by an hour. Index the 48 slots by `time_series_id - 1`.
- DST: Kyiv's day on 2026-10-25 has 25 hours but the API still has 48 slots, so the slot→wall-clock mapping on that one day is whatever the operator means. Unknown; ignore it.

### 1.4 States → `Slot`

`type` values, from the site's legend and CSS classes [READ app.js / index.html]:

| API `type` | site legend | `Slot` |
|---|---|---|
| `OFF` | «Заплановане відключення» | `off` |
| `SURE_OFF` | «Актуальне відключення» (actual/confirmed) | `off` |
| `PROBABLY_OFF` | «Електропостачання можливе» | `maybe-off` |
| absent (no series row) | «Є світло» (`ENABLE`) | `on` |

- `SURE_OFF` appears in the site code and the Go model but **no third-party parser handles it** (they only read `OFF` and `PROBABLY_OFF`). Treat unknown types as `unknown`-safe: map `OFF`/`SURE_OFF` → `off`, `PROBABLY_OFF` → `maybe-off`, `ON`/`ENABLE` → `on`, anything else → `unknown` rather than silently on.
- **Duplicate (queue, slot) rows:** the site's `initTable` makes the last row win unless a `SURE_OFF` was already seen. The HA integration prefers `OFF` over `PROBABLY_OFF`. The two rules differ. Recommend the site's rule (it is what the user sees), with the severity order `SURE_OFF` > `OFF` > `PROBABLY_OFF` as a tiebreak if you want determinism. No real duplicates were observable. [READ; unverified]

### 1.5 Update time

- Each series row has `updated_at` (UTC ISO). `mrkaktuz/outages-data` takes the max over all rows and formats it in Kyiv time as `DD.MM.YYYY HH:mm` [READ]. Use that for `sourceUpdatedAt`; convert to the app's `HH:MM DD.MM.YYYY` format.
- Schedule rows (`from`/`to`/`id`) may also carry `updated_at`; the Go model doesn't list it, the synthetic fixture includes it as a guess. Prefer the series max, fall back to the schedule row if present.
- The queue rows' `updated_at` is `2026-10-17T20:24:52Z` (= 23:24 Kyiv on 17.10) on **every** queue in all three types, so it is a bulk reset of `enabled` flags at the end of the last outage. [VERIFIED value; interpretation inferred]
- Revisions: the operator can publish several versions during a day, but the API only exposes "active" rows. No revision ids or history. [READ]

### 1.6 A past day with outages (not found)

- No history or by-date endpoint. Probed (404 HTML, all [VERIFIED]): `/api/v2/schedule`, `/api/schedule`, `/api/v2/schedule/all`, `/api/v2/schedule/history`, `/api/v1/schedule/active`, `/api/v2/schedule/2026-10-17`, `/api/outage-queue`, `/api/v2/outage/active`, `/api/outages`, `/api/v2/schedule/list`. `/api/v2/schedule/active?date=2026-10-17` is accepted but ignored (still `[]`).
- Web.archive.org CDX returned "Temporarily Offline".
- GitHub code search for `outage_queue_id` / `SURE_OFF` found only code, not data. The sibling repos' CI data branches may hold dumps (`mrkaktuz/outages-data` data branch) but I did not fetch them: they are third-party normalised data, not raw API.
- The 17.10 last outage can't be recovered. Use `SYNTHETIC-schedule-active-shape.json` for unit tests of the join/merge logic, and capture a real file the next time `active` is non-empty (poll once; save it).

### 1.7 Quiet day vs broken source

A quiet day is `HTTP 200`, `Content-Type: application/json`, body `[]` (today's real answer). Failure signals that must throw instead:
- HTTP != 200, or a non-JSON content type. Unknown routes and some bad ids return **HTML** (404, or **500 HTML** for a non-numeric id: `/api/addr/ns/abc/street`). [VERIFIED]
- Body not an array (or a row without `from`).
- The dictionaries fail validation: `time-series` must have exactly 48 rows with ids 1–48, and `by-type/3` must have ≥ 12 rows (the 12 expected names). Fetch these together with `active` every refresh (the browser does). A moved or reshaped API almost certainly breaks one of them even if `active` still says `[]`.
- It can't detect a back end that is up but whose `active` table was emptied. Accept that. A cheap extra guard: `Last-Modified` or the queue `updated_at` going years stale is not useful; skip it.
- If `active` has rows but none for today's Kyiv date, treat today as quiet (the site does the same) and show tomorrow if present.

### 1.8 Do ГАВ and СГАВ matter?

- **ГПВ (type 3)** is the hourly schedule the widget shows. **ГАВ (type 1, "графіки аварійних відключень") and СГАВ (type 2, "спеціальні ГАВ")** are emergency queues without a time-series. The site shows them as a row of lit/unlit chips (`enabled`==1 → red "Актуальне"), nothing else. [READ app.js]
- Relevance: only for `currentOutage` (§3). Most houses sit on ГПВ plus one ГАВ and one СГАВ (the usual response has 2 rows each). A pure-ГАВ/СГАВ house with no ГПВ row exists (4+5 of 36 sampled).

## 2. Address → queue

### 2.1 Cascade (all `GET`, JSON, UTF-8, `\uXXXX`-escaped Cyrillic) [VERIFIED]

| step | URL | row shape | sizes |
|---|---|---|---|
| filii | `/api/addr/filii` | `{"idfilial":2,"fullname":"Арбузинська дільниця"}` | 20 rows, 1.6 KB |
| ns | `/api/addr/filii/{idfilial}/ns` | `{"idnaspunkt":7,"naznaspunkt":"Костянтинівка"}` | 25–63 per filii (2–6 KB; escaped); 890 in all. Unknown filii → `[]` |
| street | `/api/addr/ns/{idnaspunkt}/street` | `{"idstreet":2968,"nazstreet":"вул. Шевченка"}` | м. Миколаїв (171): 736 streets, 84 KB escaped; others 80–169 |
| house | `/api/addr/street/{idstreet}/dom` | `{"iddom":124212,"nazdom":"1"}` | 30–161 houses, 1–5 KB. Some streets 0 (`[]`, e.g. СВТ Лазурне) |
| queues | `/api/addr/dom/{iddom}/outage-queue` | see below | ~0.9 KB |

Non-numeric ids cause a 500 HTML page; unknown numeric ids → `[]`. Ids are globally unique (890 distinct `idnaspunkt`).

`outage-queue` row (fixture `dom115392-outage-queue-2026-10-20.json`):
```json
[{"outage":{"id":12,"name":"2","type_id":2,"enabled":0,"updated_at":"…","deleted":0},"outageType":{"id":2,"name":"СГАВ"}},
 {"outage":{"id":17,"name":"2.2","type_id":3,"enabled":0,…},"outageType":{"id":3,"name":"ГПВ"}},
 {"outage":{"id":36,"name":"8(Р)","type_id":1,…},"outageType":{"id":1,"name":"ГАВ"}}]
```
Order is not fixed (ГПВ appears first or second). Filter by `outage.type_id === 3` for lines.

### 2.2 Queues per house (sample of 36 houses over 6 streets in 4 settlements + 30 more in the first pass) [VERIFIED]

- ГПВ rows per house: 0 → 9 houses, 1 → 24, **2 → 3** (e.g. `2.2` + `5.2`; `4.1` + `5.2`). Never more than 2 seen. So **yes, a house can have several ГПВ queues**: expose each as a `LineInfo`.
- "Not in the schedule" = the response has **no type-3 row** (`[]` or only ГАВ/СГАВ). The site prints «Адреса відсутня в графіках» only when the whole response is empty, so a ГАВ-only house shows queues but no ГПВ. For the widget: no ГПВ line → the house can't be selected (or selectable with a clear "not in ГПВ" message).
- `LineInfo`: `index` = position in the filtered ГПВ list, `groupId` = `String(outage.id)` (the numeric queue id, join key to `series.outage_queue_id`; **or** the name, but the id is what `series` carries), `label` = `"Черга " + outage.name` e.g. `Черга 2.2`. Keep a `name → id` map from `by-type/3` as a cross-check.

### 2.3 The wizard's «city» list

- The site's order is: **дільниця (20) → населений пункт (890) → вулиця → будинок**. No oblast-wide search endpoint.
- `listCities()` therefore needs the 20 filii and 20 ns calls (≈ 21 requests at ≥ 1 s apart, ≈ 87 KB). Do it once and cache (disk, TTL days). A bundled static ns list (fixture `ns-by-filii-all-2026-10-20.json`, 87 KB) is a reasonable seed that you refresh lazily.
- **Mykolaiv city is not a single ns.** Three entries exist:
  - filii 15 «Миколаївський РЕМ» → `171 м. Миколаїв` (736 streets; the main city);
  - filii 7 «Варварівська дільниця» → `764 м. Миколаїв (Варварівка)` (80 streets, СВТ/садові товариства, houses may be empty);
  - filii 20 «Корабельна дільниця» → `696 м. Миколаїв (Корабельний)` (169 streets).
  Present all three as separate cities (the labels already differ).
- **110 settlement names repeat across дільниці** (e.g. Костянтинівка in filii 2, 3, 16, 20; Благодатне in 2, 18, 20). No repeats within one filii (checked on all 20). So the label must be unique: use `"<ns trimmed>"` when the name is unique and `"<ns trimmed> (<fullname without ' дільниця'>)"` when it isn't. Keep a label → `idnaspunkt` map in the provider (the interface only passes the label back to `listStreets`).
- Street labels are `"<type> <name>"` (`вул.`, `пров.`, `пр.`, also `СВТ`, `смт.`, `пл.`, `кут`, `В/ч` …) in non-alphabetical (id) order: sort client-side. One duplicate street label inside ns 171 → append the id on collisions. A junk street named `TEST` exists (the only Latin one).

### 2.4 Spelling [VERIFIED over 890 ns, 1,073 streets, 506 houses sampled]

- Apostrophe is always **U+0027** (35 ns, 11 streets). Normalise U+2019/U+02BC to `'` on user input anyway.
- No Latin look-alike letters in ns or house names (the only Latin is `TEST`). House letters are **Cyrillic upper-case** (`1А`, `11Б`, `58Б`); no lower-case suffixes seen; no «12-А» dash variant. Fractions use `/` (`13/4`, `42/7`, `10/1`).
- **Trailing and double spaces** exist: 26 ns names (`"Костувате "`, `"Велика Солона "`), 6 streets, 1 house (`"52А "`). Trim for display and matching, but send the original id (ids are the keys, so no issue).
- House names unique within a street in the sample.

## 3. Current outage

No dedicated endpoint (all probes in §1.6 → 404). What exists, **[READ app.js]**:
- Every queue row (`by-type/1|2|3`, and `outage` inside `/dom/{id}/outage-queue`) has `enabled` 0/1. The site tells a user: «За вашою адресою відбулося знеструмлення через застосування {ГАВ|СГАВ|ГПВ}» for each of the house's queues with `enabled` truthy, and the schedule grid highlights the current slot for `enabled` ГПВ queues («Поточне відключення»). So `enabled == 1` means "this queue is switched off right now".
- All rows are `enabled:0` today. [VERIFIED] I could not see a live `enabled:1`, so the exact semantics (who flips it, how fast) are inferred.
- No start/end time and no text. Suggested mapping: `enabled` ГАВ/СГАВ → `currentOutage {kind:'emergency', text:'Знеструмлення за ГАВ 8(Р)'}`; enabled ГПВ → `kind:'planned'`; set `groups` to the enabled queue names; `outageActive: true`. `start`/`end` unknown (omit). For the house you only need the single `/dom/{iddom}/outage-queue` call (refresh together with the schedule); no need to poll the three `by-type` lists.
- The queue `updated_at` is the nearest thing to "since when" (it changes when `enabled` flips, judging by the identical bulk value at 23:24 on 17.10). Unverified; don't surface it as the outage start.

## 4. Access

- Cloudflare in front (`Server: cloudflare`), but no challenge, no cookie, no JS gate. A bare Node `fetch` (no headers) returned 200 JSON. Electron `net.fetch` in the main process is fine. [VERIFIED]
- CORS: `Access-Control-Allow-Origin: *` plus a second `energy.mk.ua` on the API (duplicate header). Irrelevant to the main process. [VERIFIED]
- No auth, no API key, no rate limit hit at 1 s spacing (~110 requests today). Response caching at the edge is ~22 s, so polling more often than 1/min is pointless; suggest 5–10 min, like the other providers.
- Encoding: UTF-8 JSON with `\u` escapes. HTML (error pages) is UTF-8. No cp1251. [VERIFIED]
- Third parties already hit it with a browser-like UA and rotating UAs (`vvcodeweb/PowerOut` assumes Cloudflare blocks; I saw none). If a WAF rule ever appears, `net.fetch` carries Chromium's UA already. [READ]

## 5. Other routes in the bundle

The complete list, from `/js/app.js` (the page loads only that script): `v2/schedule/active`, `schedule/time-series`, `outage-queue/by-type/{1,2,3}`, `addr/filii`, `addr/filii/{id}/ns`, `addr/ns/{id}/street`, `addr/street/{id}/dom`, `addr/dom/{iddom}/outage-queue`. Nothing else (no analytics, no hidden admin routes). Static PDFs: `/Chergi_GPV.pdf` and `/Chergi_GAV.pdf` (full queue lists, offline). [VERIFIED]
- Other hostnames seen in a bug-bounty subdomain list (`devoff.`, `devpma-off.energy.mk.ua`) are dev hosts: not used. [READ]
- Third-party open-source clients (all independent confirmations of the shape): `mrkaktuz/outages-data` (`src/sources/mykolaiv/`), `InstantRemedy/off-energy-mk-ua-go`, `oleksiimelnichenko/energy_mk` (HA, MIT), `gzoreslav/electricityoff-api-mykoe`. Not copying code; the logic is trivial.
- `Elvis129/prosvitlo-addresses-db` has `addresses_mk_v1.json` (4.1 MB) = an offline address dump for this oblast. Possible bundle seed, but unverified freshness; the live cascade is cheap enough.

## 6. Risks and open questions

1. **No real outage-day sample.** The `from`/`to`/`series` shape is three-times corroborated by third-party code, but never seen live by me. Mitigation: parse defensively (`Array.isArray`, optional `series`), fail closed on unknown shapes, and capture a real response the first time `active` is non-empty.
2. `SURE_OFF` semantics, the duplicate-row rule, and whether schedule rows revise in place are unconfirmed.
3. `enabled` flag semantics (inferred) and the lack of start/end for emergency queues.
4. `[]` from a restarted/empty back end is indistinguishable from a quiet day; only the dictionary checks (§1.7) guard against that.
5. Name collisions: 110 ns names across filii, trailing spaces, an ns-171 duplicate street label, and houses that exist in two ГПВ queues (two lines, user picks one; the app stores `groupId`).
6. The `outage-queue` call returns `[]` for an unknown house id, same as a house outside the schedule.
7. DST fall-back day 2026-10-25: slot→hour mapping not confirmed.

## 7. Recommended provider design

- **Plain `net.fetch` provider in the main process** (like `voe`): no hidden window, no cookies. Base `https://off.energy.mk.ua/api`, 15–20 s timeout, require `content-type` JSON and `Array.isArray`.
- **`listCities()`**: fetch `filii` + each `ns` once (≈ 21 calls, 1 s apart; cache on disk with TTL, or seed from the bundled snapshot). Labels `ns` or `ns (Назва дільниці)` for the 110 namesakes; trim; keep a label → `idnaspunkt` map. `listStreets`: `/ns/{id}/street`, sort, label = `nazstreet` (dedupe collisions). `listHouses`: `/street/{id}/dom` then `/dom/{iddom}/outage-queue` **lazily per house** (736 streets × ≤160 houses is too many to prefetch). Resolve lines on house selection, or fetch queues for the visible page only. Keep `iddom` in the saved address (e.g. in `house` label → `groupId`).
- **`fetchSnapshot()`**: `Promise.all` of `active`, `time-series`, `by-type/3`, plus the house's `outage-queue` (for `currentOutage`). Validate dictionaries (48 slots, 12 queues) → else throw. Bucket schedules by Kyiv date; build 48-slot arrays from `time_series_id-1`; filter `outage_queue_id === Number(groupId)`; map types per §1.4.
- **Quiet day**: `active` valid and no schedule for today → all `on` for today with the standard «світло є» note; tomorrow absent. Anything malformed → error.
- **`sourceUpdatedAt`** = max `series[].updated_at` across the days used, formatted in Kyiv time.
- **`currentOutage`** from the house's `outage-queue` `enabled` flags (§3); note "ГАВ/СГАВ" in text. Don't poll faster than ~1/min; the edge cache is 22 s.

## 8. Fixtures (`mykolaiv-raw/`, all dated 2026-10-20 unless noted)

| file | content |
|---|---|
| `schedule-active-2026-10-20.json` | the quiet-day answer, `[]` |
| `SYNTHETIC-schedule-active-shape.json` | **synthetic**, hand-built per the documented model: 2 days (today + tomorrow), `OFF`/`SURE_OFF`/`PROBABLY_OFF`, queues 14 and 17, with `updated_at`. Not real data. |
| `time-series-2026-10-20.json` | 48 slots (real) |
| `queues-type1-…`, `queues-type2-…`, `queues-type3-2026-10-20.json` | ГАВ (20), СГАВ (3), ГПВ (12) |
| `filii-2026-10-20.json` | 20 дільниці |
| `ns-by-filii-all-2026-10-20.json` | `{idfilial: [ns…]}` for all 20 (890 ns, 87 KB) |
| `ns171-streets-2026-10-20.json` | 736 streets of м. Миколаїв (45 KB) |
| `street2968-houses-2026-10-20.json` | 133 houses of вул. Шевченка (has `1А`) |
| `dom115392-outage-queue-2026-10-20.json` | house with ГПВ `2.2`, ГАВ `8(Р)`, СГАВ `2` |
| `house-queue-summary-36-sampled-2026-10-20.json` | 36 sampled houses → their ГПВ names and other types (0/1/2 ГПВ examples) |

No personal data anywhere in the API responses.
