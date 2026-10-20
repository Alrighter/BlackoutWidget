# Ternopil oblast (Тернопільобленерго, TOE): outage schedule sources

Research date: 2026-10-20 (about 17:30 Kyiv). Requests were made from a Ukrainian residential connection, at least 1 s apart.

Legend:
- **[VERIFIED]** I fetched it today and saw the response myself.
- **[READ]** third-party code, the operator's own front-end bundle, or docs. Not confirmed live.

Fixtures: `docs/superpowers/research/2026-10-20-outage-sources-step2/ternopil-raw/` (list at the end).
Scratch scripts: `C:\Users\roman\AppData\Local\Temp\claude\C--Users-roman-source-repos-BlackoutWidget\cca11217-ee57-4ad5-8ca6-1ed7e3708675\scratchpad\step2\ternopil\` (`probe1..8.mjs`, `main.js` = the site's bundle `https://poweron.toe.com.ua/static/js/main.c63cd454.js`, `parser.py` = TOE_PARSER).

---

## TL;DR

**Verdict: easy-to-medium.** One clean JSON API (API Platform / Hydra, Cloudflare in front, no WAF challenge). It has everything the provider needs: cities, streets, **a real house list with the queue per house**, the half-hourly schedule, and current emergency and planned outages. The traps are all about the schedule call:

1. **Schedule** = `GET https://api-poweron.toe.com.ua/api/a_gpv_g?after=…&before=…&time=<unique>` with header `X-debug-key: base64("cityId/streetId/house")`. **The key picks the queue.** The `group[]` parameter is ignored when a key is present. The response holds only the queue(s) of that house, one `dataJson["<queue>"].times` map of 48 half-hour keys (`"00:00"`..`"23:30"`) with `"0"` on, `"1"` off, `"10"` maybe. A key is the slot **start** [VERIFIED by the 3-hour pattern, and by the site's own renderer, see 1.3]. One call cannot return all 12 queues (a call returns the queue(s) of one address); but the app only ever needs one address.
2. **Address cascade, all JSON, no personal data.** `pw_cities?pagination=false&otg.id=` (1,301 rows) → `pw_streets?pagination=false&city.id=` (Ternopil: 299) → **`pw-accounts/building-names?cityId=&streetId=`** (house list with `chergGpv`, e.g. `"1.2"`, `"Не входить"` = not in the schedule). This is the endpoint the site's own house dropdown uses (found in its bundle). Houses are NOT free text for the wizard; the free text in the survey was wrong.
3. **Fail-open hazard (important).** A wrong key, a missing key, a house that does not exist and a real quiet day all return **HTTP 200 with zero members** (`hydra:member` is `null` or `[]`). Fail-closed therefore needs a separate check that the house exists and has a numeric queue (`building-groups`, 1 cheap call) plus strict response-shape validation. See section 1.6.
4. **Caching trap.** Cloudflare caches `a_gpv_g` by URL only (`s-maxage=7200`), **ignoring `X-debug-key`**. With a constant `time` value, a request for address B can return the cached answer for address A. `time` must be unique per request (e.g. `Date.now()` plus the key). [VERIFIED]
5. **Current outage: yes.** `pw_accidents` (emergency) and `pw_accident_planeds` (planned works, about 10 days ahead), filterable by `city.id` and `street.id`, with a comma list of houses (`buildingNames`), start (`dateEvent`) and estimated end (`datePlanIn`) and a free-text reason (`koment`). All timestamps are Kyiv wall-clock labelled `+00:00` (treat the clock digits as Kyiv time, see 3.3). Verified live, with real rows today.
6. **Access.** Plain `fetch` works. `Origin` is NOT required, but a wrong, `null` or `file://` Origin gets **403**. Do not set `Origin`, or set exactly `https://poweron.toe.com.ua`. The mirror `api-toe-poweron.inneti.net` is dead (404).

Past day with real outages: **2026-10-17** (the only one the API still holds; record id 46). Saved as a fixture for two addresses (one with two queues).

---

## 1. Schedule (ГПВ)

### 1.1 Endpoint [VERIFIED]

```
GET https://api-poweron.toe.com.ua/api/a_gpv_g
    ?before=2026-10-21T00:00:00%2B00:00
    &after=2026-10-16T12:00:00%2B00:00
    &time=<unique string>
Headers:  X-debug-key: base64(utf8("<cityId>/<streetId>/<house>"))
          (Origin: optional. Omit it, or send exactly https://poweron.toe.com.ua)
```

- Response: `Content-Type: application/ld+json`, UTF-8, `Cache-Control: public, max-age=900, s-maxage=7200`, behind Cloudflare. No cookies needed.
- `group[]=…` is accepted but **ignored when `X-debug-key` is sent**: with key `1032/47931` (queue 1.2) and `group[]=2.1`, or three groups, the answer was still only `1.2`. [VERIFIED]
- Without the key (even with `group[]`) the answer is empty. [VERIFIED]
- Key variants [VERIFIED]:
  - `cityId/streetId/house` (exact house text from `building-names`): returns the queue(s) of that house. This is what the site sends (the site's bundle builds the key from the dropdown values, `btoa(unescape(encodeURIComponent(key)))`; and `time` = key with the slashes removed) [READ+VERIFIED].
  - `cityId/streetId` (no house): returns **all queues present on the street** (e.g. `3.2` and `5.2` together). On a mixed street, e.g. Ob'izna (`31848`, queues 1.2, 4.1, 2.2 plus "not in schedule"), it returned nothing. Do not use it.
  - `cityId` alone: nothing.
  - The key does not need the `/house` part to be valid for the cascade, but a **non-existent house** (`1032/47931/999`) returns nothing.
  - The house text must match exactly: `1-А` (Cyrillic А) works; `1-A` (Latin), `1А`, `1-а` and `" 1 "` all return nothing. So the provider must pass the house string **exactly as listed by `building-names`** (do not normalise).
- `before` and `after` filter on `dateGraph` as dates. The site's window is `after = (today-1) 12:00:00+00:00`, `before = (tomorrow) 00:00:00+00:00` [READ from the bundle]. Windows `2026-10-17T00:00+03:00..23:59:59+03:00`, `…16T00:00+03..17T00:00+03`, `…17T00:00+00..17T00:00+00` and `…16T21:00+00..17T20:59:59+00` all returned the 17.10 record, and `18..19.10` returned none, so it is an inclusive date-range check. **Recommended: copy the site's window** (`after` = Kyiv yesterday `T12:00:00+00:00`, `before` = Kyiv tomorrow `T00:00:00+00:00`), so a half-day offset can never drop today.

### 1.2 Response shape, real sample (17.10, house `1032/47931/1`) [VERIFIED]

```json
{"@context":"/api/contexts/ActualGpvGraph","@id":"/api/actual_gpv_graphs/custom","@type":"hydra:Collection",
 "hydra:member":[{"@id":"/api/actual_gpv_graphs/46","@type":"ActualGpvGraph","id":46,
   "dateCreate":"2026-10-17T18:52:36Z","dateGraph":"2026-10-17T00:00:00Z",
   "dataJson":{"1.2":{"times":{"00:00":"0", … "10:00":"0","10:30":"10","11:00":"1","11:30":"1","12:00":"1",
     "12:30":"1","13:00":"1","13:30":"1","14:00":"10","14:30":"0", … "23:30":"0"}}}}],
 "hydra:totalItems":1}
```

- `dataJson` keys are queue ids (`"1.2"`). The site strips a `#suffix` (`e.split("#")[0]`) so a key can carry a suffix [READ]. Handle it: take the part before `#`.
- A house on two queues gets **two keys** in one member. House `1032/31848/29` returned `2.2` (off 16:00-19:00, maybe 15:30 and 19:00) and `4.1` (off 11:00-14:00, maybe 10:30 and 14:00). Fixture saved.
- All values are strings.

### 1.3 Time keys [VERIFIED + READ]

`"10:30"` is the **slot that starts at 10:30** (10:30 to 11:00):
- The site draws each hour row with `s00 = times["HH:00"]` and `s30 = times["HH:30"]` for hour `HH`, and a missing key counts as `"0"` [READ from the bundle]. So the first half of hour 10 is `"10:00"`, the second half `"10:30"`.
- The data fits a standard 3-hour outage with 30-min "maybe" margins on both sides: `10:30=10, 11:00..13:30=1 (six slots), 14:00=10`. As start-keys that is off 11:00-14:00 with maybe 10:30-11:00 and 14:00-14:30. The second queue (`2.2`) shows the same shape (off 16:00-19:00). If keys were slot ends, the off period would be 10:30-14:00 (3.5 h), which does not fit.
- Slot index = `hour*2 + (minute===30 ? 1 : 0)`. `"24:00"` does not occur.

### 1.4 States → `Slot` [READ the site colours + VERIFIED the values]

| value | meaning (site colour) | `Slot` |
|---|---|---|
| `"0"` | power on (white) | `on` |
| `"1"` | off (dark blue) | `off` |
| `"10"` | maybe off (grey) | `maybe-off` |
| anything else, or a missing key | the site treats it as on | `unknown` (safer than `on`) |

TOE_PARSER also folds the same three values (0/1/10). No other values seen.

### 1.5 Today, tomorrow, time zone, revisions

- **Date = `dateGraph`'s date part, taken as a Kyiv date.** `dateGraph` is `YYYY-MM-DDT00:00:00Z`. The `Z` is a lie: the site prints it with `moment.utc(...)` as `DD.MM.YYYY`, and TOE_PARSER parses the date part and attaches `Europe/Kyiv`. So `"2026-10-17T00:00:00Z"` means Kyiv date 17.10. **Do not convert it with a time zone**, just `slice(0,10)`. [READ both; consistent with the 17.10 record being the one for the day it was created]
- **`dateCreate`** (`2026-10-17T18:52:36Z`) is the source update time. The site prints it with `moment.utc(...).format("DD.MM.YYYY HH:mm:ss")` under the label «Інформація станом на», so the digits are shown as-is, i.e. **Kyiv wall clock**. Use `18:52 17.10.2026` as `sourceUpdatedAt` (format `HH:MM DD.MM.YYYY`). [READ from the bundle; could not cross-check with another source]
- **Tomorrow**: the site expects up to **2 members** in one response and decides which is "today" by comparing the two `dateGraph` values (`isAfter` → later one = tomorrow) [READ]. With one member it is shown as the current day only. **I could not observe a real tomorrow record today** (the API holds only the 17.10 record), so this is [READ], not verified. Implementation: group members by `dateGraph.slice(0,10)`; take the Kyiv today and today+1 dates from the provider's own clock; ignore other dates.
- **Several revisions per day**: not observed. The whole table showed one record, `id 46`, for one date; querying a 7-week window returned only it for every address. It looks like one record per date, updated in place with `dateCreate` as the last change, but I have no sample of an update. Defensive rule: if two members have the same date, use the one with the larger `dateCreate`, then larger `id`.
- **Retention**: the 17.10 record was still returned on 20.10 (3 days later) and the `archive_gpv_graphs` endpoint (`?page=1&dateGraph[before]=…&dateGraph[after]=…`, found in the bundle) returned `hydra:totalItems 0` for October. Nothing older than id 46 is exposed. So a fixture of "a day with outages" cannot be re-fetched later; use the saved one.
- Whether all 12 queues come in one call: **no**, and it is not needed. A call answers for the queue(s) of the key's address. TOE_PARSER does 12 calls with 12 representative keys (its key table is stale: for example key `604/5580` now returns `2.1`, not `1.1`).

### 1.6 Quiet day versus a broken source (fail-closed) [VERIFIED facts, design is a recommendation]

All of these return **HTTP 200** with `@type: hydra:Collection`, `hydra:totalItems: 0`:

| situation | `hydra:member` |
|---|---|
| valid key, no schedule for the window (today, 20.10) | `null` |
| non-existent house `1032/47931/999` | `[]` |
| no `X-debug-key`, wrong key (`1032/1`), garbage key | `[]` |
| house with `chergGpv = "Не входить"` | `[]` |
| house with `chergGpv = ""` (empty) | **one member with `dataJson: {}`** (the day exists, no queue for this house) |

Cloudflare/HTTP failures are visible (403 for a bad Origin, 404 for the dead mirror, HTML pages). So the quiet-day test cannot be "empty means quiet". Recommended rule:
1. At wizard time, store `groupId` from `building-names`/`building-groups` (numeric queue).
2. On every refresh, **first** call `pw-accounts/building-groups?cityId=&streetId=&buildingNames=<house>` (39-byte answer). Require `buildingGroups` to be a non-empty array of queue ids; otherwise raise an error («адреса зникла з довідника / не входить у графіки»). If the queue set differs from the saved one, report `lineChanged` as the app already does.
3. Then call `a_gpv_g`. Require status 200, JSON, `@type === 'hydra:Collection'`, `hydra:totalItems` a number, and `hydra:member` an array or `null`. Anything else → error.
4. Members present: require that `dataJson` contains the saved queue (compare after stripping `#…`) and that its `times` has 48 keys; otherwise error. Empty/`null` members with the checks above passed → **quiet day** (note «світло є», no outages published).
5. Residual risk: if TOE changes how the key works while still answering 200/empty, step 2 still passes and the day looks quiet. Mitigation: show `sourceUpdatedAt` only when there is data, and add a canary only if a better one appears (none exists today because the API holds a single old record). Say this in the spec as an accepted risk.

---

## 2. Address → queue

### 2.1 Cascade [VERIFIED]

| step | call | size |
|---|---|---|
| settlements | `GET /api/pw_cities?pagination=false&otg.id=` | **1,301** rows, 239 KB. `{id, name, codeOtg, otg:{name}}` |
| streets | `GET /api/pw_streets?pagination=false&city.id=<id>` | Ternopil (1032): 299 rows, 43 KB; Kremenets (604): 151 |
| houses | `GET /api/pw-accounts/building-names?cityId=<id>&streetId=<id>` | e.g. 28 rows, 8 KB; 21 rows on the mixed street |

- `building-names` row: `{"id":259168,"buildingName":"1","chergGpv":"1.2","chergGav":"Не входить","chergAchr":"Не входить","chergGvsp":"Не входить","chergSgav":"","disconnectionTask":null}`. `id` is a row id (not an account number or a name); no personal data. Drop it.
- Without `streetId`, `building-names?cityId=604` returns the whole town (273 KB). Not needed.
- Queue format: `"N.M"`, N in 1..6, M in 1..2 (12 queues: 1.1 … 6.2). Label for `LineInfo`: «Черга 1.2» (the site prints «Черга 1.2»). Group id: `"1.2"`.
- **"Not in the schedule" values**: `chergGpv = "Не входить"` (not in the hourly schedules; ~10% of houses on the streets sampled) or `""` (empty). Filter these out of the wizard, or show them disabled.
- **City list quirks** (matter for the wizard):
  - **225 of 1,301 cities have an empty `name`** (only `otg.name` is set). Skip them, they are unusable. [VERIFIED]
  - **Namesakes**: 74 name groups occur in several communities (e.g. `Ланівці`: Лановецька and Борщівська; `Заліщики`, `Підгайці`). Label settlements as `name (otg.name + " ОТГ")` or similar to disambiguate; `listCities()` should return the city id in a hidden value.
  - Street names carry a type prefix (`вул. `, `пров. `, `вул. ` + blanks); some are junk like `вул. ` followed by nothing (Рогачин `вул. ` in the accident list).
  - **Apostrophes**: both U+2019 (`Об’їзна`) and U+0027 appear in names. Because we always pass back ids and the house text from the API, no normalisation is needed for the calls; normalise (to U+2019 and Cyrillic-only) only for the wizard's search box.
- **House text**: `1`, `1-А`, `13/1`, `9-Б`, `дорога`, `37-А`. Cyrillic suffix letters, hyphen. The API match is exact (see 1.1), so the wizard's house list must come from `building-names`, not typed text. Do not normalise `12-А` vs `12А`: the API treats them as different strings.

### 2.2 One house, several queues [VERIFIED]

- `building-names` shows **one queue per name** (deduplicated; it hid a second queue for house `29` on Ob'izna).
- `building-groups?cityId=1032&streetId=31848&buildingNames=29` returned **`[{"chergGpv":"2.2"},{"chergGpv":"4.1"}]`**, and the schedule call for key `1032/31848/29` returned **both** `2.2` and `4.1` in one member. On that one street 1 house of 21 had two queues.
- So: for the `lines` of `HouseInfo`, build them from `building-groups` for the chosen house (cascade: after the user picks a house, call it; or call it for every house in `listHouses`, which is 1 call per house, too many; **do it lazily** and fall back to the `building-names` queue). `LineInfo.index` = position in `buildingGroups`; `groupId` = `chergGpv`; label «Черга N.M».
- For `Не входить` houses, `building-groups` returns `{"buildingGroups":[]}`.
- The schedule for a two-queue house contains both queues; the provider picks the saved `groupId` (if the user picked 4.1, read `dataJson["4.1"]`).

### 2.3 What is `building-groups` exactly [READ + VERIFIED]

Used by the site (bundle): `GET /pw-accounts/building-groups?cityId=&streetId=&buildingNames=<house label>` → `{"buildingGroups":[{"chergGpv":"1.2"}]}`; the dropdown also uses it to colour the grid. A non-existent house gives `[]`. Same host, no key header needed.

### 2.4 Settlement list source

One oblast-wide call (`pw_cities?pagination=false&otg.id=`, 239 KB, `hydra:member`, no paging). It can be fetched per wizard open and cached for days; it only changes when the operator edits the directory. No need to bundle. Optionally bundle a fallback (it is 239 KB; trim to `{id, name, otg.name}` ≈ 100 KB).

---

## 3. Current outage

### 3.1 Endpoints [VERIFIED live, 20.10]

| kind | endpoint | note |
|---|---|---|
| emergency | `GET /api/pw_accidents?page=1&city.id=<id>&street.id=<id>` | 495 rows in total today (17 pages of 30); filtered by street gives 0-2 rows |
| planned | `GET /api/pw_accident_planeds?page=1&city.id=<id>&street.id=<id>` | 4,567 rows in total (153 pages); about 10 days ahead (latest 29.10); a street can have one row per day |
| history | `pw_accident_histories`, `pw_accident_planed_histories` (`dateFilter=YYYY-MM-DD`) | the site's «історія» tabs; not needed |

The site also passes `otg.id`, `typeOff=1`, `switchSubReason=0`, `datePlanIn[after]/[before]`; none of these is needed. Filtering by `city.id` alone works too (e.g. Zbarazh 383: 1 row).

Row (emergency), real sample: 
```json
{"id":113794368,"city":{"id":383,"name":"Збараж"},"street":{"id":3752,"name":"вул. Івана Франка"},
 "dateEvent":"2026-10-20T03:31:35+00:00","datePlanIn":"2026-10-20T13:00:00+00:00",
 "koment":"Пошкодження на ПЛ","switchSubReason":0,"buildingNames":"10","typeOff":1,"otg":{"name":"Збаразька"}}
```
Row (planned): same fields, no `switchSubReason`; `koment` e.g. «Ремонт лінійного роз’єднувача з заземлюючими ножами», `dateEvent` = `2026-10-20T08:00:00+00:00`, `datePlanIn` = `2026-10-20T17:00:00+00:00`, `buildingNames:"1"`.

### 3.2 Matching a house

`buildingNames` is a **comma+space separated string of house labels** (`"11, 13, 15, 18-А, 22, 24, 7"`), same spelling as `building-names`. It is sometimes cut or odd (`", 1, 1-Б, 10, …"` with a leading empty item; `"базова станція"`; `"Вул. освітлення"`). Split on `,`, `trim()`, compare exactly with the house label. If the list ends without a closing item (the row text looked cut at about 40 chars only in my printout; the fixture has full strings) there is no truncation flag. Treat a row as applying to the address if the street matches and the house is in the list.

`switchSubReason` (emergency table, from the site's labels [READ]): `0` = ordinary emergency, `1` = «Графік аварійних відключень», `2` = «Графік погодинних відключень», `3` = «Спеціальний графік…». Only `0` seen today. Map `0` → `kind:'emergency'`, rows from `pw_accident_planeds` → `kind:'planned'`, `1..3` → `other` (the text says what it is). `typeOff` was always `1`.

### 3.3 Time zone [READ + consistency check]

The site formats `dateEvent` and `datePlanIn` with `toLocale…("uk-UA", {timeZone:"UTC"})`, i.e. it prints the digits as written. So the `+00:00` is a label; the digits are **Kyiv wall clock**. Evidence: planned works run `08:00`-`17:00` (a normal working day in Kyiv; real UTC would make it 11:00-20:00) and an emergency started `13:39` while it was 17:30 Kyiv. Use `start = dateEvent` digits, `end = datePlanIn` digits (estimated restoration). Format for `CurrentOutage.start/end`: as the app does for other providers.

### 3.4 When is a row "current"?

Emergency rows stay while the outage is open (the listing had rows from 16.10 with an end of 17.10; so **stale rows exist**: `Рогачин, dateEvent 2026-10-16T14:01, datePlanIn 2026-10-17T12:00`). Planned rows for today stay listed after their end (`403`, ended 17:00, still listed at 17:30). So the provider must compare against Kyiv `now`: show a planned row only if `dateEvent <= now <= datePlanIn`; for emergency show if `dateEvent <= now` and (`datePlanIn` is null or `now <= datePlanIn + a grace period`); a stale row (end long past) is hidden. For "planned later today/tomorrow" optionally put it in `note`.

No personal data in these endpoints (street and house only).

---

## 4. Access

| item | result |
|---|---|
| Protection | Cloudflare (CF-RAY headers), **no challenge**; plain `fetch`/curl with any UA works. [VERIFIED] |
| Encoding | UTF-8 (`application/ld+json; charset=utf-8`), Cyrillic is `\uXXXX`-escaped in some endpoints (`building-names`), plain in others; `JSON.parse` handles both. |
| `robots.txt` | `https://poweron.toe.com.ua/robots.txt`: `User-agent: *` and `Disallow:` (allow all). The API host is not a website. |
| CORS | `access-control-allow-origin` echoes the request Origin (even `http://localhost:3000` and the dead inneti host) when an Origin is sent. Irrelevant for the main process. |
| `Origin` | **Not required.** No Origin → 200. `https://poweron.toe.com.ua`, `https://toe-poweron.inneti.net`, `http://localhost:3000` → 200. **`Origin: null` and `Origin: file://` → 403** (Cloudflare rule, `cf-cache-status: BYPASS`). A wrong host like `https://evil.example` → 403 (tested with a valid key). |
| `Referer` | Not needed (a Referer alone is fine). |
| `X-debug-key` | **Needed only for `a_gpv_g`.** Without it the call returns an empty collection (not an error). `pw_cities`, `pw_streets`, `pw-accounts/building-names`, `building-groups`, `pw_accidents`, `pw_accident_planeds`, `options` all work with no custom header. [VERIFIED] |
| Electron `net.fetch` | A GET issued from the main process carries no `Origin` header by default, which is the working case. I did not run Electron (instruction: do not run the app). If the Chromium stack ever sends `Origin: null`, the call would be 403; in that case set `Origin: https://poweron.toe.com.ua` (Chromium may refuse to override it in `net.fetch`; fall back to `net.request`, or `require('https')`/`undici` in the main process, which do not touch Origin). Tell the implementer to log the status and test this once in the real app. |
| Rate limits | None hit with ~100 calls at 1.1 s spacing. |
| Caching | `a_gpv_g`: `Cache-Control: public, max-age=900, s-maxage=7200`. The Cloudflare cache key is the URL **only** (`X-debug-key` is not in `Vary`; `vary: Authorization, Accept-Language`). Verified: same URL, different keys → `cf-cache-status: HIT` with the first key's answer. Always make `time` unique (`Date.now()` + a random suffix) so every refresh reaches the origin (MISS). Do the same for `pw_accidents*`? Those URLs carry `page` and filters; they were `MISS` for my varied URLs, but add `&_=<ts>` if staleness appears. |
| Mirror | `https://api-toe-poweron.inneti.net/api/...` → **404** (19 bytes) for `a_gpv_g` and `pw_cities`. Dead, do not use. [VERIFIED] |
| Image fallback | `options?option_key=pw_gpv_image_today` / `…_tomorrow` return `value: ""` (unused today); the site shows them only when set. Ignore. `pw_gpv_nek_comand` (Ukrenergo commands HTML) is empty. |

---

## 5. Risks and open questions

1. **Tomorrow and multi-revision behaviour are not verified** (no live record). Two-member responses are [READ] from the site code. Re-check the day after the first real schedule is published (the operator publishes by 10:00 the day before according to NKREKP).
2. **Silent empty answers** (see 1.6). Needs the `building-groups` precheck and strict shape checks. Accepted residual risk if the key scheme changes.
3. **Cache poisoning/staleness** from the URL-only edge cache. Unique `time` is mandatory.
4. **Queue changes**: the directory changes (TOE_PARSER's hard-coded keys are already stale). Re-read the queue for the saved address on each refresh (1.6 step 2) and flag `lineChanged`.
5. **Multi-queue houses** exist (1 of 21 on one street). `building-names` hides the second queue. Needs the `building-groups` call to list them.
6. **City list quality**: 225 empty names, 74 namesake groups, junk street names.
7. **`Origin`/Electron**: untested in Electron itself (see 4).
8. `dateCreate` and `dateEvent` time zone is inferred (Kyiv wall clock with a wrong `Z`/`+00:00`), consistent with the site's own display; one independent confirmation (a real TOE notification time) would settle it.
9. TOE publishes `dateGraph` per day with a Kyiv date but marks it `Z`; do not "fix" it.

## 6. Recommended provider design

- **`listCities()`**: one `pw_cities` call, drop empty names, label `name` + ` (` + `otg.name` + ` ОТГ)` only when the name repeats; cache for days.
- **`listStreets(city)`**: `pw_streets?pagination=false&city.id=`; keep `id` + `name`.
- **`listHouses(city, street)`**: `pw-accounts/building-names`; keep rows whose `chergGpv` is `^\d\.\d$`; `lines` = a single line from `chergGpv`; fill extra queues from `building-groups` when the house is chosen (and for `fetchSnapshot`). Keep the house text byte-for-byte.
- **`fetchSnapshot(address)`**:
  1. `building-groups` precheck (fail-closed, 1.6).
  2. `a_gpv_g` with the window of 1.1, key `base64(cityId/streetId/house)`, unique `time`; strict shape validation; group by `dateGraph.slice(0,10)`; take today and tomorrow (Kyiv dates); read `dataJson[groupId]` (strip `#…` from keys); 48 slots from `times` (`"0"→on, "1"→off, "10"→maybe-off`, else `unknown`); `sourceUpdatedAt` = `dateCreate` digits as `HH:MM DD.MM.YYYY`.
  3. Current outage: `pw_accidents` and `pw_accident_planeds` for `city.id` + `street.id`, house in `buildingNames`, time-filtered against Kyiv now (3.4). Failure of this call must not fail the schedule (log, set no `currentOutage`); a schedule failure is an error.
  4. Quiet day = valid precheck + valid empty response → `days` with 48 `on` slots and a `note` («Тернопільобленерго не публікувало графік на сьогодні»).
- Use `net.fetch` in the main process, no `Origin`, sequential calls, ~15-30 min refresh.

## 7. Fixtures (`ternopil-raw/`)

| file | content |
|---|---|
| `a_gpv_g_2026-10-17_house-1032-47931-1_group1.2.json` | real outage day, queue 1.2 (off 11:00-14:00, maybe 10:30 and 14:00) |
| `a_gpv_g_2026-10-17_house-1032-31848-29_groups2.2+4.1.json` | the same day, a house on two queues |
| `a_gpv_g_quiet-2026-10-20_valid-key.json` | quiet day: `hydra:member: null` |
| `a_gpv_g_quiet-2026-10-20_nonexistent-house.json`, `…_no-key.json` | what an unknown house / missing key looks like (`[]`) |
| `pw_cities_all.json` | all 1,301 cities (239 KB) |
| `pw_streets_city1032.json` | 299 streets of Ternopil |
| `building-names_city1032_street47931.json` | house list, single queue street |
| `building-names_city1032_street31848_mixed-groups.json` | mixed street (1.2, 4.1, 2.2, «Не входить», `дорога`) |
| `building-groups_1032_47931_1-A.json` | `building-groups` answer |
| `pw_accidents_page1_2026-10-20.json` | page 1 of the emergency list (30 rows) |
| `pw_accidents_city383_street3752_2026-10-20.json` | filtered emergency row (Zbarazh) |
| `pw_accident_planeds_city22085_street41475_2026-10-20.json` | filtered planned works (one row per day) |
