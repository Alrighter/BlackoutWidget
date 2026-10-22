# Volyn oblast (ПрАТ «Волиньобленерго») — outage schedule sources for Kovel

Research date: 2026-10-20. All live requests were made from a Ukrainian residential connection.

Legend:
- **[VERIFIED]** I fetched it today and saw the response myself.
- **[READ]** I only read about it in third-party code, docs or articles. Not confirmed live.

Raw responses are saved in `(research scratch, not kept) volyn-raw\`.

Helper scripts:
- `(research scratch, not kept) volyn-scripts\post.mjs`: a UTF-8 form POST.
- `(research scratch, not kept) volyn-scripts\parse_gpv.py`: a PNG grid sampler.

---

## TL;DR / recommendation

1. **Schedule (ГПВ).** It is published only as a PNG image: one oblast-wide picture per day, 6 queues × 2 subqueues = 12 rows, 48 half-hour columns, two colours. JSON metadata comes from an open API Platform backend at `https://api-voe-poweron.inneti.net/api/...`. That backend serves the iframe on energy.volyn.ua. The widget would:
   - list today's/tomorrow's images from JSON;
   - download the PNG;
   - pixel-sample the 12×48 grid.

   I verified this approach on today's image and on the 2026-10-17 image, which had real outages. The parsed result matches the image's own "total hours" header exactly.
2. **Address → queue.** An official HTML form, `POST energy.volyn.ua/.../cherga/` (`formCity`, `formStreet`), returns `Район | Нас. пункт | Вулиця | Будинок(list) | Черга у ГПВ (e.g. 6.1) | Черга у ГАВ`.
   - `formStreet=%` returns the whole city in one response. Kovel gives 1,848 rows and 300 streets.
   - Queue assignments are fixed from 1 October to 1 October, so cache them for a long time.
3. **Current outage notice.** `POST energy.volyn.ua/.../chomu-nemaie-elektropostachannia/` (`formCity`, `formStreet`) returns live planned and emergency outages per street and house list, with start time and estimated restoration time. Kovel had an emergency outage when I checked.
4. **No hidden browser window is needed.**
   - Cloudflare is in front, but no challenge was served. A plain HTTP client works, even with the default curl UA.
   - No CORS headers are sent, so do the fetches in the main process with Electron `net.fetch`.
   - Decode the PNG with `nativeImage.createFromBuffer(buf).toBitmap()`, so no `sharp` or other native dependency is needed.
5. **Kovel uses the oblast-wide subqueues.** Kovel addresses map to 1.1…6.2, with no 5.1 in the city, and all of them appear on the single oblast-wide image. There is no separate city schedule.

---

## 1. Where the schedules are published

### 1a. Official site page — hourly schedule (ГПВ) [VERIFIED]

`https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/` returned HTTP 200, 47 KB, PHP 7.2 behind Cloudflare. The page contains:
- An explanatory text:
  - Ukrenergo sets the restriction volumes for each hour.
  - Under NKREKP resolution №416 of 24.03.2026, the DSO publishes the forecast for the next day **by 10:00**.
  - The schedule can be corrected or cancelled during the day.
  - Actual switching times can differ by **20–30 minutes**.
- **An iframe** `https://voe-poweron.inneti.net/schedule_queues`. This is a React SPA titled «Чому немає світла?», built by inneti.net. The same codebase references `zakarpat.energy` and `oe-zoe-test.bot.asd.company`, so the vendor's platform is shared with other oblenergos. The iframe shows today's and tomorrow's schedule **as images**.
- **A per-address text search** for the GPV: `<form action="/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/pagephp.php" method="post">` with these fields:
  - `formGpvDate` (a select that offers only today and tomorrow, e.g. `2026-10-20`, `2026-10-21`);
  - `formCity` (required);
  - `formStreet` (optional);
  - `searchForm=searchFromForm` (hidden).

  The page says «актуалізується кожні 60 хвилин. Оновлено: 20-10-2026 09:00».
  - **Verified:** today and tomorrow return only "Повернутись до форми пошуку" with no table. Most likely this is because there are no GPV outages on 20.10 and the 21.10 schedule is not published yet.
  - **Verified:** a past date (`2026-10-17`, a real outage day) also returns nothing. That fits equally well with the endpoint holding only today and tomorrow.
  - **[READ]** In the old VolynEnergyBot code, the result table had at least 7 columns: district, settlement, street, …, date in column 5, and outage hours in column 6 separated by `<br/>`. I could not verify the current format because no GPV is active.
  - The submit button is disabled for about 3–4 s by JS. That is only a UI timer; the server does not enforce it, and POSTs without a prior GET worked.
- Links on the page:
  - «Визначити чергу за адресою на сайті» → `/spozhyvacham/perervy-u-elektropostachanni/cherga/` (see §2);
  - «Дізнатись чергу через Viber-бот» → `viber://pa?chatURI=botvoe`;
  - «Архів графіків погодинного відключення» (the inneti archive);
  - «Повідомити про розбіжності» (report a discrepancy).

### 1b. The inneti.net API behind the iframe [VERIFIED]

The bundle `https://voe-poweron.inneti.net/static/js/main.0e0fcca0.js` (640 KB) is configured with axios `baseURL: "https://api-voe-poweron.inneti.net/api"`. The backend is Symfony API Platform: Hydra JSON-LD, open, no auth, and `Content-Type: application/ld+json`. The bare `/api` root redirects to `/login`, but the collections are public.

| Endpoint | Status today | What it returns |
|---|---|---|
| `GET /api/options?option_key=pw_gpv_image_today` | 200 | `{"hydra:member":[{"option_key":"pw_gpv_image_today","value":"/media/2026/10/6ad66ecc04352_GPV.png","date":"2026-10-19T22:10:04+00:00"}]}` |
| `GET /api/options?option_key=pw_gpv_image_tomorrow` | 200 | `value: ""`, which means **nothing published**. That can be "not yet" or "no GPV"; the API cannot tell these apart. |
| `GET /api/options?option_key=pw_gpv_nek_comand` | 200 | empty (Ukrenergo command text, used by the SPA) |
| `GET /api/options?option_key=successful_last_synk` | 200 | `date: 2025-11-14T16:30:03`, so the address sync appears dead (see the next rows) |
| `GET /api/archive_gpv_graphs?page=N` (+ `dateGraph[after]=YYYY-MM-DD`, `dateGraph[before]=…`) | 200 | Every published image revision. 616 items, 30 per page, 21 pages, newest first. Each item has `id`, `dateCreate`, `dateGraph`, `imageUrl.contentUrl`, `imageUrl.uploadTimestamp` and `imageMobileUrl.contentUrl`, which is the same file. |
| `GET https://api-voe-poweron.inneti.net/media/2026/10/<hash>_GPV.png` | 200 | `image/png`, 1750×2250, about 125 KB, `Cache-Control: max-age=120`, ETag and Last-Modified, served through the Cloudflare cache |
| `GET /api/pw_cities?pagination=false&otg.id=`, `/api/pw_streets?…city.id=`, `/api/pw_otgs` | 200 | **empty collections** (`hydra:totalItems: 0`) |
| `GET /api/pw_accidents`, `/api/pw_accident_planeds`, `…_histories` | 200 | **empty**. The SPA's real-time and planned outage views have no data for VOE. |
| `GET /api/docs.jsonld`, `/api/otgs` | 404 | — |

Archive behaviour I observed (pages 1–2, ids 561–620):

- **Images are published only during GPV periods, and there are long gaps.** Here are the `dateGraph` values present:

  | Period | Images |
  |---|---|
  | 2026-04-08 … 04-21 | daily, then nothing until 06-29 |
  | 2026-06-30 … 07-02 | then nothing until 10-06 |
  | 2026-10-07 | one image |
  | 2026-10-08 … 10-16 | **none** |
  | 2026-10-17 … 10-20 | daily |

  So **a date with no image is the normal quiet-day state**. It does not mean "not published yet". In the gaps the operator publishes nothing at all.
- **Outage-day schedules are often first published the same morning and then revised many times:**
  - 2026-10-17: 7 revisions (09:49, 09:50, 10:47, 14:10, 16:21, 18:09, 18:47 Kyiv);
  - 2026-04-09: 13 revisions (08:19 … 21:25);
  - 2026-04-10: 7 revisions.

  Next-day images also appear the evening before (about 19:50–22:30), and sometimes the morning before. For example, the 07-01 image was uploaded on 06-30 at 08:48.
- **All-clear images.**
  - I parsed 2026-10-07, 10-18 (one of its two revisions), 10-19 and 10-20. They contain **0 off cells**, so the operator sometimes publishes an explicit all-clear image after an outage day.
  - It does not do this for every quiet day: there is nothing for 10-08 to 10-16.
- `dateGraph[after]=2026-10-21` returns nothing. Tomorrow is either not published yet or will never be published, and the API cannot tell these apart.

**Timestamp quirk [VERIFIED].**
- `dateCreate`, `dateGraph` and the option's `date` are **Kyiv local time mislabelled as `+00:00`**. For example, `dateCreate 2026-10-19T22:26:04+00:00` matches the image text «Інформація станом на 22:26 19.10.2026».
- `imageUrl.uploadTimestamp` (`2026-10-19T19:26:04+00:00`) and the HTTP `Last-Modified` header are true UTC.
- Use `uploadTimestamp` for `sourceUpdatedAt`, or strip the `+00:00` and treat the value as Europe/Kyiv.

**Today/tomorrow labelling caveat. Never trust the option label alone.**
- The image for 2026-10-20 was uploaded at 22:26 on 19.10, yet the `pw_gpv_image_today` option already points to it, and the option's own `date` reads 22:10. So it is unclear when "tomorrow" becomes "today".
- In the long gaps (for example 10-08 … 10-16), `pw_gpv_image_today` most likely kept pointing at an **older date's** image (I did not observe this directly).
- Key everything by date instead:
  - query `archive_gpv_graphs?dateGraph[after]=<today Kyiv>` and take the newest `id` for each `dateGraph`;
  - if you use an option value at all, resolve its `contentUrl` to an archive entry first, to learn its `dateGraph`.

### 1c. The image format [VERIFIED]

You can view the two sample images I downloaded:
- `volyn-gpv-2026-10-20.png` (next to this file) (20.10, all on);
- `volyn-gpv-2026-10-17.png` (next to this file) (17.10, with outages).
- Title: «ГПВ на DD.MM.YYYY» / «Інформація станом на HH:MM DD.MM.YYYY».
- Header table: «Загальна тривалість відключень з 01.10.2026», in hours per subqueue.
- Two grids (00:00–12:00 and 12:00–24:00). Each has 12 rows (черга 1–6 × підчерга 1–2) and 24 half-hour columns.
- **Two colours only**:
  - light `#B8C8D8` (≈184,200,216) means «наявне електропостачання»;
  - dark `#446F9B` (≈68,111,155) means «відсутнє електропостачання».
  - There is **no "maybe-off" colour**.

On the 1750×2250 layout, the time columns span x = 176…1726 (24 columns, about 64.6 px each). Top-half rows span y = 417…1131 and bottom-half rows span y = 1304…2019 (12 rows each, about 59.5 px). Sampling a 3×3 patch at each cell centre gives this for 2026-10-17:

```
1.1 ....................XXXXXXXX....................   10:00-14:00
1.2 ............................XXXXXXX.............   14:00-17:30
2.1 ...................................XXXXXXX......   17:30-21:00
2.2 .............................XXXXXXX............   14:30-18:00
3.1 ......................XXXXXX....................   11:00-14:00
3.2 ......................XXXXXX....................   11:00-14:00
4.1 ............................XXXXXXX.............   14:00-17:30
4.2 ............................XXXXXXX.............   14:00-17:30
5.1 ...................................XX...........   17:30-18:30
5.2 ...................................XXX..........   17:30-19:00
6.1 ....................................XXXXXXXX....   18:00-22:00
6.2 ..........................................XX....   21:00-22:00
```

**Self-check.** Off-slots ÷ 2 per subqueue gives 4, 3.5, 3.5, 3.5, 3, 3, 3.5, 3.5, 1, 1.5, 4, 1. That is **identical** to the image's header row «Загальна тривалість з 01.10.2026». The header match implies that 17.10 was the only outage day since 01.10. The four other October images I parsed (07, 18, 19, 20) are all-light, which is consistent with that. This is good evidence that the geometry is right. Use this PNG as a test fixture.

Robustness:
- Assert the image is 1750×2250.
- Classify each cell by its distance to the two reference colours. Anything far from both becomes `'unknown'`.
- Fail closed (an error, not "all on") if more than a few cells are unknown or if the size changes.

The gzoreslav project (§5) samples by percentages of width and height with a tolerance of 45, which is the same idea.

### 1d. Current outages, the «Чому немає світла» list [VERIFIED]

`https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/chomu-nemaie-elektropostachannia/`, a `POST` to the same URL with `formCity`, `formStreet` (optional) and `searchForm=searchFromForm`. The page says it is «актуалізується кожні 30 хвилин» (Оновлено: 20-10-2026 10:00).

Response for `formCity=Ковель` (HTTP 200, 41 KB): a table `Район | Нас. пункт | Вулиця | Будинок | Тип | Причина | Дата та час відключення<hr>Дата орієнтовного відновлення`. Raw cell: `2026-10-20 09:50<hr class='m-0 p-0'>2026-10-20 11:51`. Today's rows:
- Kovel, вул. Андрія Малишка 1–12, Довженка 1А, Львівська 8–16, Підгірських 13, Самійла Величка 1…21: **«Аварійне вимкнення» / «Аварійний випадок в мережах»**, 2026-10-20 09:50 → 11:51.
- Воля-Ковельська (several streets): «Планове вимкнення» / «Планові ремонтні роботи», 09:36 → 19:00.

Notes:
- `formCity` is a substring match, so "Ковель" also matches Воля-Ковельська.
- The page text says the list covers «планова, аварійна, застосування графіків обмеження». I saw only the first two today.

Mapping to `CurrentOutage`: «Аварійне вимкнення» → `kind:'emergency'`; anything else → `'other'`. Use the two timestamps (Kyiv local) for `start` and `end`, and match the house against the comma list.

### 1e. Other channels

- **Viber bot `botvoe`** (`viber://pa?chatURI=botvoe`), the official bot linked from the site. **[READ]** According to the official PDF `energy.volyn.ua/spozhyvacham/servisy/!files/інструкція_вайбер_непобутові.pdf`, it has a «Графік ГПВ» button that shows the queue of a metering point plus today's or tomorrow's hours, and a «Планові вимкнення» button. It is not scrapable in practice because it needs a Viber account.
- **Official Viber channel**: an invite link on the homepage. Not fetched.
- **Telegram [VERIFIED]**:
  - `t.me/EnergyVolynBot` exists, but its description is «Тестового», and the site's link to it is commented out in the HTML.
  - `t.me/volynoblenergo` has 606 subscribers and its last post dates from 2023, so it is dormant and of unclear status.
  - There is no live official Telegram schedule feed.
- **Facebook** `facebook.com/volynoblenergo`. Not fetched.
- **Customer cabinet** `ok.prosvitlo.com` (login required) and `kabinet.prosvitlo.com`. Not fetched.
- **`echerg.prosvitlo.com/?key=…` [VERIFIED]**: its title is «Е-запис у ЦОК». It books service-centre appointments and is **not** the queue lookup.
- **News page** `/pro-tovarystvo/novyny/gpv-gav-sgav/` [VERIFIED]: stale, with the last regular entries dated 27.12.2024. Do not use it as a "GPV active?" signal.
- **Legacy image URLs** `energy.volyn.ua/.../hrafik-vidkliuchen/!img/<dd-mm-yy>[-N].jpg`, used by the 2024 projects, now return **404** [VERIFIED].

---

## 2. Address → queue lookup [VERIFIED]

`https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/`, method `POST` to the same URL (form `action="#move"`). Fields:
- `formCity` (required);
- `formStreet` (required on the form, but `%` works as a wildcard).

Page text:
- «Цифри 1-6 (ГПВ) та 1-10 (ГАВ) — номер черги… Номер черги за адресою є незмінним та діє з 1 жовтня поточного року до 1 жовтня наступного року».
- «Не залучено» means the address is excluded (critical infrastructure lines, АЧР and similar).

Response table (`<table class='table table-sm ...'>`, one `<tr>` per row):
```
Район | Нас. пункт | Вулиця | Будинок | Черга у ГПВ | Черга у ГАВ
Ковельський | Ковель | Незалежності | 101, 101А, 89 | 2.2 | Не залучено
Ковельський | Ковель | Незалежності | 25 | 4.2 | 3
Ковельський | Ковель | Незалежності | 25 | Не залучено | Не залучено
```

`formCity=Ковель&formStreet=%` returned one response of 355 KB:
- 1,908 rows: 1,848 for Ковель and 60 for Воля-Ковельська, because of the LIKE match.
- **300 streets** in Kovel.
- Kovel GPV queue distribution, in rows:

  | Queue | 1.1 | 1.2 | 2.1 | 2.2 | 3.1 | 3.2 | 4.1 | 4.2 | 5.2 | 6.1 | 6.2 | Не залучено |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|
  | Rows | 220 | 98 | 84 | 205 | 1 | 4 | 8 | 72 | 110 | 387 | 89 | 570 |

- ГАВ distribution: 1 (275), 10 (331), 3, 8, Не залучено (1,239).

Data quirks the provider must handle:
- **Settlement match is a substring match.** Filter rows on the exact `Нас. пункт`. Use `Район` to tell same-named villages apart. The source shows only the district, not the hromada.
- **House cells are comma-separated lists** with junk entries: `<>` (no number), «Адреса невідома», «біля буд. 122», «гараж 17», «р-н СШ №7», `142/`, `62А/гараж 47`. Split on `,`, trim, drop the empty and `<>` entries, and keep anything that looks like a house number.
- **The same house can appear in several rows with different queues.** For example, Незалежності 25 has `4.2` and also `Не залучено`, and 138 has `2.2` and `Не залучено`. These are different supply lines or metering points. This maps naturally onto `HouseInfo.lines: LineInfo[]`, which already exists for the DTEK multi-line case.
- **«Не залучено»** (about 31% of Kovel rows) has no GPV queue. I suggest a pseudo-group `groupId: 'none'`, labelled «Не залучено до ГПВ». Its schedule is always `'on'`, while the current-outage notice still applies.
- **Encoding:** the body must be UTF-8 URL-encoded. Git Bash `curl --data-urlencode` with Cyrillic arguments sent mangled bytes, and the server answered with `�` and a truncated page. Node `URLSearchParams` and `fetch` worked. Electron `net.fetch` with `URLSearchParams` will be fine.
- `robots.txt`: `User-agent: * / Allow: /` [VERIFIED].

Two things do not exist [VERIFIED]:
- **A settlement-list endpoint.** inneti's `pw_cities` and `pw_otgs` are empty.
- **A street autocomplete.**

`listCities` therefore needs one of these:
- a bundled list of Volyn settlement names, e.g. from the public state КАТОТТГ codifier;
- free-text input validated by a `cherga` query.

The third-party `Elvis129/prosvitlo-addresses-db` has a full `addresses_vl_v1.json` (255,785 addresses), but the repo has **no license** (GitHub API: 404 for the license). Do not bundle it.

---

## 3. Data model

| Aspect | Value | Source |
|---|---|---|
| Queues | 6 черг × 2 підчерги = 12 groups, written `1.1 … 6.2` | image + cherga [VERIFIED] |
| Resolution | **30 minutes**, 48 slots/day. This maps 1:1 to the widget's `Slot[48]`. | image [VERIFIED] |
| Days | Today + tomorrow, **only during GPV periods**. Tomorrow's forecast is due by 10:00 under NKREKP №416/2026. In the archive, next-day images appeared the evening before (about 19:50–22:30) or the morning before. Outage-day schedules (17.10, 09.04) were also first published or re-published **the same morning**. | page text + archive [VERIFIED] |
| Updates | Re-published intraday while GPV is active: 7 revisions on 17.10, 13 on 09.04. The site's text search says "every 60 min" and the outage list "every 30 min". | archive + page [VERIFIED] |
| Maybe-off | **Not represented.** There are only two colours, so `maybe-off` never appears. A published image with no dark cells → all `'on'`. | [VERIFIED] |
| Missing image | **This is an open design choice.** No image for a date is the normal state on quiet days (none for 10-08…10-16, or for months in summer). It can also mean "not published yet": the 17.10 schedule appeared at 09:49 that morning. The options are:<br>• **today missing** → all `'on'` with a label such as «ГПВ не застосовуються». This is honest for most days, but it can be wrong for a few morning hours on the first day of a new outage wave. Alternatively, use `'unknown'`, which would sit on the widget most of the year.<br>• **tomorrow missing** → omit the day or show `'unknown'`. | archive [VERIFIED]; policy is mine |
| Tolerance | Actual switching may differ by 20–30 min from the grid | page text [VERIFIED] |
| ГАВ (emergency schedule) | Separate queues 1–10 per address. Not published as a time grid; ГАВ is applied ad hoc by Ukrenergo command. | cherga page [VERIFIED] |
| Kovel | Uses the oblast-wide subqueues (it has 1.1–6.2, except 5.1). One oblast image covers it. | [VERIFIED] |
| Queue stability | Assignments are fixed 1 Oct → 1 Oct. Cache the address→queue map for days or weeks. | cherga page text [VERIFIED] |

---

## 4. Bot protection, rate limits, stability

- **Cloudflare** is in front of both `energy.volyn.ua` and `api-voe-poweron.inneti.net` (`Server: cloudflare`, a `__cf_bm` cookie on the PHP site). From a UA residential IP there was **no JS challenge and no captcha** [VERIFIED]:
  - the default curl UA, an empty UA and a browser UA all returned 200;
  - a POST without a prior GET or cookie also worked.
- **[READ]** The `prosvitlo-addresses-db` README says the site **blocks foreign and datacenter IPs** ("з Fly — 403"), so its author crawled from a home Ukrainian connection. gzoreslav's project also routes requests through a Ukrainian proxy, which fits. This does not matter for a desktop widget running in Ukraine, but it would break any cloud relay.
- **CORS** [VERIFIED]: there is no `Access-Control-Allow-Origin` for foreign origins, so fetch from the Electron main process, not the renderer.
- **Rate limits:** none observed. I made about 25 requests in roughly 10 minutes. No documented limits were found.
  - The PNG is CDN-cached with `max-age=120`.
  - Polling `options` or `archive?dateGraph[after]=today` every 10–15 min is about 1 KB per call. Download the PNG only when `contentUrl` changes.
- **Stability:**
  - The inneti API is a vendor SaaS, and some of its sync jobs are already dead (`successful_last_synk` 2025-11-14, empty `pw_*` tables).
  - The image path, the PHP forms and the archive have worked since at least winter 2025/26: the archive has 616 entries, and gzoreslav's January 2026 code uses the same option keys.
  - The PHP site switched from `!img/*.jpg` (2024) to the inneti iframe, which broke every 2024 scraper. Expect similar breaks in the future.
  - The image layout is the main fragility. Guard it with size and colour checks.

---

## 5. Third-party projects and aggregators

| Project | What it uses | Status |
|---|---|---|
| [gzoreslav/electricityoff-api-voloe](https://github.com/gzoreslav/electricityoff-api-voloe) ("Volyn GPV", last push 2026-01-19) | `api-voe-poweron.inneti.net/api/options?option_key=pw_gpv_image_today` / `_tomorrow`. It downloads the PNG and pixel-parses it with `sharp` into 12×48 `on/off` (DARK 68,111,155 / LIGHT 184,200,216, tolerance 45). Requests go through a UA proxy `185.67.1.123:3000/provider`, whose API key is hard-coded in the repo. | **The only one matching the current setup** [VERIFIED code] |
| [Elvis129/prosvitlo-addresses-db](https://github.com/Elvis129/prosvitlo-addresses-db) (ProСвітло app, pushed 2026-10-19) | Crawled `POST …/cherga/` with `formStreet=%` into `addresses_vl_v1.json` (1,045 settlements, 10,620 streets, 255,785 addresses, plus a ГАВ map). It also documents the sibling PowerOn platforms of other oblenergos (`api-poweron.toe.com.ua/api/pw_address_queues`, `power-api.loe.lviv.ua`). | Address DB only. Volyn is "not connected yet" in their app. **No license.** [VERIFIED README] |
| [Nazoferon/VolynEnergyBot](https://github.com/Nazoferon/VolynEnergyBot) (2026-05) | `POST hrafik-vidkliuchen/` with `formCity/formStreet` and parses `table.gsc-results-table` (7+ columns: date, hours). | Probably stale selector. [READ code] |
| [hzswdef/light-thing](https://github.com/hzswdef/light-thing) (abandoned 2025-07), [darksidecat/VolynOblEnergoWidget](https://github.com/darksidecat/VolynOblEnergoWidget) (Android, 2024), sierradx/dotfiles `blackout-sched.sh`, archibaldkami/ArchDiscordBots | Legacy `…/hrafik-vidkliuchen/!img/<date>[-N].jpg` (6 queues × 24 h) | **Dead.** The URLs are 404 [VERIFIED] |
| [Baskerville42/outage-data-ua](https://github.com/Baskerville42/outage-data-ua) | Has only `data/{kyiv,kyiv-region,dnipro,odesa}.json` (DTEK) | **No Volyn** [VERIFIED tree] |
| svitlo.live, Home Assistant integrations | Web search found nothing Volyn-specific | not found |
| News sites (uapress.info, netfreedom.org.ua guide) | Re-post the images and text | not machine-usable |

---

## 6. Proposed mapping to `ScheduleProvider` (`src/main/providers/types.ts`)

Provider id `voe`, display name «Волиньобленерго».

- **`listCities()`** → a bundled static list of Volyn settlements, or free text plus validation via `cherga`. There is no remote endpoint.
- **`listStreets(city)`**:
  - Make one `POST cherga/` with `formCity=<city>&formStreet=%`.
  - Keep only rows where `Нас. пункт === city` (and the district, if it is ambiguous).
  - Return the unique `Вулиця` values, sorted.
  - Cache the parsed table for days.
- **`listHouses(city, street)`**:
  - Read from the same cached table.
  - Split the house lists and drop the junk.
  - Group by house, collecting the distinct `Черга у ГПВ` values.
  - Produce `HouseInfo { house, lines: [{ index, groupId: '6.1', label: 'Підчерга 6.1' }, …], outageActive: false }`.
  - `Не залучено` → `groupId: 'none'`.
- **`fetchSnapshot(address)`**:
  1. Fetch `GET archive_gpv_graphs?dateGraph[after]=<today Kyiv>` and pick the newest `id` for each `dateGraph`.
     - Do **not** fall back to the bare `pw_gpv_image_today` option. In gaps it can point to an older date's image.
     - Use options only as a cheap change detector, resolving any `contentUrl` against the archive.
  2. For each date, download the PNG if its `contentUrl` changed, then decode it with `nativeImage.createFromBuffer(buf).toBitmap()`. Note that the result is BGRA on Windows.
  3. Sample the 12×48 grid, take the row for the address's `groupId`, and map dark → `'off'`, light → `'on'`, anything else → `'unknown'`.
  4. Produce `days`:
     - Today comes from the image if one exists. If not, apply the missing-image policy from §3: all `'on'` labelled «ГПВ не застосовуються», or `'unknown'`.
     - Include tomorrow only if it is published.
     - Use `sourceUpdatedAt = uploadTimestamp` (real UTC).
  5. Optionally `POST chomu-nemaie…` with `formCity` and `formStreet`, match the house, and set `currentOutage` to `{ kind: 'emergency' | 'other', text: Причина, start, end }`.
- **`showVerification()`**: a no-op. There is no captcha.
- **`dispose()`**: trivial.
- `OFFLINE_MESSAGE` currently says «…сайтом ДТЕК», so it should become per-provider.

---

## 7. Open / unverified items

- The output format of the per-address GPV text search (`hrafik-vidkliuchen/pagephp.php`) when GPV is active. It returned nothing today because no GPV is scheduled. It might give per-address hours as text, which would avoid the image, but I could not confirm that. Re-test on an outage day.
- The exact moment `pw_gpv_image_today` and `_tomorrow` flip around midnight. Keying by `dateGraph` avoids depending on it.
- What `pw_gpv_image_today` points to on quiet days with no image. Probably the last published image of an older date. Not observed directly.
- There is no explicit "GPV is / is not in effect today" flag. The missing-image policy is a product decision (§3).
- Whether «застосування графіків обмеження» rows ever appear in the `chomu-nemaie` list during GPV, and how they look.
- Behaviour from foreign or datacenter IPs (403 per the prosvitlo README). Not tested.
- Viber bot, Viber channel and Facebook content: not inspected.
