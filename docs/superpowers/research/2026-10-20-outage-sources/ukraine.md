# Outage-schedule sources in Ukraine (survey, 2026-10-20)

Scope: every place outside Kyiv city (DTEK KEM / YASNO) and Volyn (covered by other agents) where a program can read the
planned hourly outage schedule (ГПВ). Raw responses saved under `outage-sources/raw/` next to this file.

Context on the day of the survey: several regions had live schedules on 2026-10-20 (Kyiv oblast, Kharkiv, Poltava,
Cherkasy, Chernihiv, Rivne, Zhytomyr, Sumy); many others had **no outages**, so their sources showed the last schedule
(e.g. DTEK `fact.update = 17.10.2026 09:54`, `fact.data = []`). "No live slots" below means *shape verified, nothing to show
today*, not *broken*.

Two separate questions per region, because the widget's provider interface needs both:
1. **Schedule** — per-group (черга/підчерга) on/off/maybe for today (+ tomorrow).
2. **Address -> group** — `listCities -> listStreets -> listHouses -> group`. None of the aggregators below does this.

Difficulty scale used in the summary:
- **Easy** – direct JSON/HTML from the operator *and* an address lookup, no WAF (or a WAF the existing hidden-window approach already handles).
- **Hard** – needs a browser/WAF bypass, HTML/OCR scraping of images or Telegram, login, or an aggregator only (user picks the group by hand).
- **Impossible (today)** – occupied territory, Telegram images only with no parser, or no data published at all.

---

## 1. DTEK sites on the same engine as DTEK KREM

All four DTEK DSOs run the same Yii site. Same path `/ua/shutdowns`, same `DisconSchedule` global, same `POST /ua/ajax` with
`method=getHomeNum`, same Incapsula WAF.

| region | operator | source URL | machine-readable? | address lookup? | protection | verified-by-fetch | notes |
|---|---|---|---|---|---|---|---|
| Odesa oblast | DTEK Odeski elektromerezhi (OEM) | https://www.dtek-oem.com.ua/ua/shutdowns | HTML with inline JSON: `DisconSchedule.fact`, `.preset`, `.streets` (same as KREM) | yes: `DisconSchedule.streets` (953 settlements / 14,710 streets) + `POST /ua/ajax method=getHomeNum` (house -> `GPVx.y`) | Incapsula (`_Incapsula_Resource`), CSRF token, 7 `captcha` mentions in page | **y** – 1st curl 200, 931,779 B, full page, `DisconSchedule.fact = {"data":[],"update":"17.10.2026 09:54","today":1792443600}`; 2nd curl 30 s later got a 28 KB "технічні роботи" stub (Incapsula throttling) | Groups GPV1.1…GPV6.2 (12). **Drop-in**: KREM provider with a different URL. Same `time_type` vocabulary (yes/no/maybe/first/second/mfirst/msecond). |
| Dnipropetrovsk oblast (+ Dnipro city) | DTEK Dniprovski elektromerezhi (DNEM) | https://www.dtek-dnem.com.ua/ua/shutdowns | same inline JSON | yes: `DisconSchedule.streets` (1,137 settlements / 18,307 streets) + `getHomeNum` | Incapsula, CSRF | **y** – 200, 1,065,302 B, `DisconSchedule.fact = {"data":[],"update":"17.10.2026 09:55",...}` | 24 groups: GPV1.1…6.2 **plus GPV1001.1…GPV1006.2 named "ЦЕК 1.1"…"ЦЕК 6.2"** – the Dniprovska CEK (ПрАТ «ПЕЕМ ЦЕК») customers are already inside this object, so **no separate CEK provider is needed**. Also covered by YASNO API (Dnipro region id 3, DSO 301 = ДнЕМ, 303 = ЦЕК; verified 200, `status: NoOutages`). |
| Donetsk oblast (govt-controlled part) | DTEK Donetski elektromerezhi (DEM) | https://www.dtek-dem.com.ua/ua/shutdowns | presumably same engine (site template identical) | presumably `getHomeNum` | Incapsula: every curl got the 212-byte `_Incapsula_Resource` challenge or the 955-byte "Request unsuccessful. Incapsula incident ID" page; WebFetch got an empty page | **n** – blocked by the same Incapsula wall as KREM; engine not confirmed by fetch | Not in Baskerville42/outage-data-ua. svitlo.live's Donetsk entry has 6 groups (1…6), not 12, so do not assume the same group set. Frontline region – schedules are rare. Only a real browser session (the existing hidden-window approach) can confirm. |
| Kyiv oblast (reference) | DTEK Kyivski regionalni elektromerezhi (KREM) | https://www.dtek-krem.com.ua/ua/shutdowns | already implemented | already implemented | Incapsula: curl got the 212-byte challenge on 2026-10-20 | n (curl) | The existing provider. Shown for comparison only. |

Conclusion: OEM and DNEM (incl. CEK) are **easy** – parametrise the existing `dtek-krem` provider by base URL and group-name map
(`DisconSchedule.preset.sch_names`). DEM is probably the same, but it needs a browser run to confirm.

---

## 2. Oblenergos (non-DTEK DSOs)

"Aggregator" column = which open dataset already republishes the schedule (B42 = Baskerville42/outage-data-ua,
OE = yaroslav2901/OE_OUTAGE_DATA, SP-new / SP-old = svitlo-proxy workers, AE = alerts.energy live today).

### 2.1 West

| region | operator | schedule source URL | machine-readable? | address lookup? | protection | verified-by-fetch | aggregator | notes |
|---|---|---|---|---|---|---|---|---|
| Lviv | Lvivoblenergo (LOE) | `https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic` | JSON (Hydra) carrying `rawHtml` text ("Група 1.1. Електроенергії немає з 20:00 до 22:00.") + PNG `imageUrl`; 12 groups 1.1–6.2, hour ranges, Today/Tomorrow items | **yes, JSON**: `https://power-api.loe.lviv.ua/api/pw_cities?pagination=false&otg.id=` (2,034 cities; Львів id 693) → `pw_streets?pagination=false&city.id=693` (1,654) → `pw_accounts?pagination=false&city.id=693&street.id=12448` (`{"buildingName":"145","chergGpv":"5.1","chergGav":"20"}`; one row per account – dedupe by building; add `&buildingName=` to shrink 2.4 MB responses) | none | y (200; ~2 MB; Today/Tomorrow empty on 20.10; 734 archive items) | OE (`Lvivoblenerho.json`), SP-new | Schedule is free text inside JSON → regex parse ("з HH:MM до HH:MM"). **Easy.** Vendor = inneti (same API family as Ternopil, Zakarpattia). |
| Ternopil | Ternopiloblenergo (TOE) | `https://api-poweron.toe.com.ua/api/a_gpv_g?after=…T00:00:00+03:00&before=…&group[]=1.2&time=<ms>` (mirror `api-toe-poweron.inneti.net/api`) | **JSON, half-hourly**: `{"hydra:member":[{"dateGraph":"2026-10-17T00:00:00Z","dataJson":{"1.2":{"times":{"10:30":"10","11:00":"1",…}}}}]}` with 0 = on, 1 = off, 10 = maybe | **yes, JSON**: `pw_cities?pagination=false&otg.id=` (1,301) → `pw_streets?pagination=false&city.id=1032` (299) → house is free text; call `a_gpv_g` with header `X-debug-key: base64("cityId/streetId/house")` and no group → server returns that address's group (e.g. 1.2) | header `Origin: https://poweron.toe.com.ua` + client-computed `X-debug-key` (base64, not a secret) | y (200; 20.10 empty, 17.10 had data) | OE, SP-new | **Easy.** The best-structured oblenergo source. yaroslav2901/TOE_PARSER (`toe_api_parser.py`) is a working reference. |
| Khmelnytskyi | Khmelnytskoblenergo (HOE) | Daily news posts, e.g. `https://hoe.com.ua/post/pogodinni-vidkljuchennja-na-17-zhovtnja.html` | **PNG** table (`/Content/Uploads/2026/10/file20261017164437203.png`) + free-text amendments ("підчерга 2.1 – з 16:00 до 17:00") | **yes**: `GET /settlements/?term=Хмельницький` (typeahead, id 26499) → `GET /streets/26499?term=…` → `GET /houses/280542` (`["1","2",…]`) → `POST /shutdown-queues streetId=280542&house=1` → HTML "…відноситься до підчерги: 1.1, 2.2, 3.1, 4.1, 5.1, 5.2" (can list several groups) + ГАВ queue | reCAPTCHA script on page, but the lookup works without a token | y (200) | OE, SP-new | Schedule needs **OCR** or post-text parsing → **Hard** (lookup easy). Address → queue XLSX also at `/Content/Uploads/GPV6/xls/`. |
| Rivne | Rivneoblenergo (ROE) | `https://www.roe.vsei.ua/disconnections` | **HTML table**: rows "Підчерга 1.1…6.2", time-range text per date, "Оновлено: 20.10.2026 10:00" | **no** – only PDFs (`wp-content/uploads/2026/10/GPV_cherga_misto_Rivne.pdf`, `GPV_cherga_Rivnenska_oblast.pdf`) | none (yaroslav2901 uses Playwright, but curl got 200) | y (200) | OE, SP-new, AE (12 queues), firefly | At 10:00 every 20.10 cell read "Очікується" while OE's 00:00 snapshot had outages – the page overwrites itself. **Hard** (scrape; user picks group). |
| Zhytomyr | Zhytomyroblenergo (ZTOE) | `https://www.ztoe.com.ua/unhooking-search.php` | **HTML table**, 12 groups × 48 half-hour cells; state = cell colour (`#ffffff` on, `#ff3333` off); cp1251 | **yes**, form POST cascade to the same URL with a cookie jar: `rem_id=5` (79 settlements) → `+naspunkt_id=16205` (streets) → `+vulica_id=168893` → row "Хорошівський \| с. Березівка \| вул. Вишнева \| 1, 11, 12… \| Черга 5 \| Підчерга 1" | none | y (200; live 20.10: 128 off, 448 on cells) | OE, SP-new, AE | **Easy** (HTML parse, but stable). Reference: yaroslav2901/ZTOE_PARSER. |
| Vinnytsia | Vinnytsiaoblenergo (VOE) | `https://www.voe.com.ua/disconnection/detailed` (per address) | HTML via Drupal AJAX: `POST /disconnection/detailed?ajax_form=1&_wrapper_format=drupal_ajax` with `city_id, street_id, house_id, form_build_id` (scraped), `form_id=disconnection_detailed_search_form`, `_triggering_element_name=search` → hourly table with DTEK-like legend (confirmed / possible / first / second 30 min) | **partial**: typeahead `GET /disconnection/detailed/autocomplete/read_city?q=Вінниця` (510100000) → `read_street/510100000?q=Соборна` (1652) → `read_house/1652?q=1` (26590); returns the **schedule for the address, but not the group number** | VOE site: none. e-svitlo: Cloudflare + login | y (200) | olnet93 / vn-progr `gpv-voe-vinnytsia` (JSON, DTEK-compatible, updated 07:10Z today); SP-old (0s today) | The group-level JSON aggregator logs into `https://vn.e-svitlo.com.ua/account_household/show_only_disconnections?eic=…` with one account holding 12 meters (one per group). Its day timestamps are 1 h off Kyiv midnight. **Hard**, though per-address scraping fits the widget's model (address in → slots out). |
| Chernivtsi | Chernivtsioblenergo | `https://oblenergo.cv.ua/shutdowns/` | **HTML**, 12 groups "1"–"12" (no subgroups), 48 half-hour cells: `<div id="inf1" data-id="1"><u>з</u>…` with В = off, З = on, МЗ = maybe | **yes**: `https://oblenergo.cv.ua/shutdowns-search/{district}/` returns every street/house/group of a district as HTML (`<div><p>Street</p><b>House</b><u>Group</u></div>`; 25,966 rows / 1.5 MB for the city) | none | y (200; latest table 18.10, all on) | SP-new, SP-old | **Easy.** Group numbering differs from everywhere else (1–12 instead of 1.1–6.2). Not in OE. |
| Ivano-Frankivsk | Prykarpattiaoblenergo | `https://be-svitlo.oe.if.ua/schedule-by-queue?queue=1.1` (+ `POST /gpv-queue-list` for the 12 groups) | **JSON**: `[{"eventDate":"17.10.2026","queues":{"1.1":[{"shutdownHours":"10:00-12:00","from":"10:00","to":"12:00","status":1}]},"scheduleApprovedSince":"17.10.2026 18:54"}]` | probably: `POST be-svitlo.oe.if.ua/schedule-by-search` (`accountNumber`, `userSearchChoice=pob`, `address="city,street,building"`, free text) – **403 for any Cyrillic address from curl** (ASCII → 404 JSON "not found") | 403 on root and on Cyrillic search **from curl** (WAF/UA filter); untested from the hidden browser window | y (200, `[]` today) | OE, SP-new, samokisha/outage-data-if (MIT, DTEK-compatible, every 10 min) | Schedule **easy**. The address lookup is probably fine from a real browser context like the widget's hidden window (not tested). |
| Zakarpattia | Zakarpattiaoblenergo | `https://api-outage-zakarpat-energy.inneti.net/api/options?option_key=pw_gpv_image_today` (embedded by `zakarpat.energy/customers/break-in-electricity-supply/schedule/` via `outage.zakarpat.energy/schedule_queues`) | **image only** (option `value` = image path; empty today) | **yes, JSON**: `pw_cities?pagination=false&otg.id=` (726; Ужгород 769) → `pw_streets?pagination=false&city.id=769` → `pw_address_queues?page=1&city.id=769&street.id=9345&buildingNames=` → `{"buildingNames":"20, 22, …","chergGpv":"3.1","chergGav":"9"}` | none (Cloudflare only for e-mail obfuscation) | y (200) | OE (fresh: `update 20.10.2026 00:02`; parser not public), SP-new | Schedule needs **OCR** → **Hard** unless using OE. Lookup easy. inneti vendor (like LOE/TOE). |
| Volyn | Volynoblenergo | — | covered by the other agent | — | — | — | SP-old | See the Volyn report. |

### 2.2 East, centre, south

| region | operator | schedule source URL | machine-readable? | address lookup? | protection | verified-by-fetch | aggregator | notes |
|---|---|---|---|---|---|---|---|---|
| Mykolaiv | Mykolaivoblenergo | `https://off.energy.mk.ua/api/v2/schedule/active` (+ `/api/schedule/time-series`, `/api/outage-queue/by-type/{1,2,3}`; 3 = ГПВ, sub-queues 1.1–6.2) | **JSON API** | **yes, JSON**: `/api/addr/filii` → `/filii/{id}/ns` → `/ns/{id}/street` → `/street/{id}/dom` → `/dom/{iddom}/outage-queue` → `[{"outage":{"id":17,"name":"2.2","type_id":3},"outageType":{"id":3,"name":"ГПВ"}}]` | none | y (all 200; `active` = `[]` today) | SP-old (all "on") | **Easy** – cleanest source in the east. Not in OE or SP-new, so no open dataset covers it with data. |
| Kirovohrad | Kirovohradoblenergo | `POST https://kiroe.com.ua/electricity-blackout/actual-gpv-graphs` (`ajax=1&token=<ajaxToken>`) | JSON (shape unknown: `data:[]` today) | **yes**: `/city/{office}` → `/street/{city}` → `/house/{street}`; house rows carry `chergGpv` (`{"HouseId":"308786","HouseName":"6","chergGpv":"2.1"}`) | session cookie + per-page `ajaxToken` (fetch page first); Cloudflare front, no challenge | y (200) | SP-old (0s) | Lookup verified. Schedule shape **unverified** (no outages, so `data:[]`). **Provisionally Hard**; it may become Easy once a live response is seen. |
| Dnipro (CEK) | ПрАТ «ПЕЕМ ЦЕК» | via DTEK DNEM `DisconSchedule` (GPV1001.x–1006.x = "ЦЕК n.n"); also YASNO DSO 303, SP-new `dnipro-cek` | via DNEM | **yes, static**: `const locations={city:{street:{house:"Черга 5.2"}}}` embedded in `https://cek.dp.ua/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html` (14 cities / 441 streets / 9,022 houses); also YASNO address API | none | y | B42 (`dnipro.json`), SP-new, YASNO | **Easy**: DNEM provider + CEK's map ("Черга X.Y" → `GPV100X.Y`; some values like "Черга 2" or "Черга 2.1 та 6.1" need normalising). |
| Cherkasy | Cherkasyoblenergo | Telegram `t.me/s/pat_cherkasyoblenergo`; site news `/media/hrafik-pohodynnykh-vidklyuchen-hpv-na-DD-zhovtnya` | **text posts** ("1.1 12:00 - 14:00, 16:00 - 18:00…") | **yes, JSON**: `https://cabinet.cherkasyoblenergo.com/api_new/disconn.php?op=department_list` → `city_list&dept_id` → `street_list&city_id` → `house_list&street_id` → `ls_list_by_addr&street_id&house` → `disconn_by_ls&abon_ls&disconn_selector=2&n_date&k_date` → `{"DISCONN_QUEUQ":[{"QUEUE_INFO":"Графік погодинних відключень - 3 черга 1 підчерга"}]}` | none | y | OE, SP-new, AE (24 queues) | Lookup goes through **resident account numbers** (privacy smell). Schedule = text parsing of TG/news. **Hard** (or OE for the schedule). Podmor/cherkasy-power-outages-calendar also reads the TG channel. |
| Sumy | Sumyoblenergo (SOE) | `GET https://www.soe.com.ua/api/vidkluchenya/get_all_data_disconnections_api` | **JSON**, today only: `{"cherga_n":"1.1","no_data":false,"last_update":"Оновлено: 19.10.2026 19:04","lst_time_disc":[{"start_time":"08:00","end_time":"12:00"}]}` | **yes (unproven)**: `/readCity?input=` → `/readStreet?input=&cityId=` → `/readHouse?input=&streetid=` → `/readHouseAndQnum?streetid=&houseid=` (GPV = index 3 of the queue array – empty for every central-Sumy house sampled) | nginx 403 **for curl** unless browser `Sec-Fetch-*` / `sec-ch-ua` headers are sent (+ `X-Source: soe-website`). A real browser context (the hidden window) sends them anyway; untested there. `robots.txt Disallow: /api/` | y (200 with headers) | AE (11 queues), SP-old; Svitlo Yeah (soe.com.ua + e-svitlo) | Schedule easy from a browser context. Lookup unproven. E-Svitlo `sm.e-svitlo.com.ua` gives the group per personal account (needs the user's login). **Hard** (lookup unproven, robots disallows the API). |
| Poltava | Poltavaoblenergo | `GET https://www.poe.pl.ua/customs/dynamicgpv-info.php` | **HTML table**, 12 groups × 48 half-hour cells (`light_1` on / `light_2` off / `light_3` switching); live 20.10 ("з 10:00 по 22:00 запроваджений ГПВ в обсязі 2 черг"; 1.1 = `111111111111112223111111112222311111112222311111`) | **yes, but unreliable**: `POST /customs/search-disconnection-cabinet.php` `disconn={"operation_type":"city|street|building",…}` → `POST /customs/disconnectinforesult-cabinet.php` → `gp_qnum_1/2` – null/empty in all 4 houses sampled ("several connections → use account search") | none | y (live data) | OE, SP-new, AE (24 queues) | Schedule **easy** (HTML parse). Lookup weak → probably "pick your group" + link. |
| Kharkiv | Kharkivoblenergo | Telegram `t.me/s/kharkivenergy`; site news `https://oblenergo.kharkiv.ua/uk/node/13883413` | **text** ("1.1 10:00-12:00; 19:00-22:00") | captcha-gated: `pa.oblenergo.kharkiv.ua/…/disconnection-by-address` (Cloudflare Turnstile + CSRF); offline PDF "Адреси та черги 26-27.pdf" | Turnstile on the lookup | y (TG + node 200) | OE (updated 20.10 00:02), SP-new, AE (24 queues) | **Hard**: text parsing; lookup needs the user to solve Turnstile in a visible window (the existing `showVerification()` flow could host it). yaroslav2901/KHARKIV_PARSER parses the TG text. |
| Zaporizhzhia | Zaporizhzhiaoblenergo (ZOE) | `https://www.zoe.com.ua/outage/` | **free-text posts** ("1.1: 10:30 – 13:30, 17:00 – 18:30") | city only: a Google Apps Script web app (`script.google.com/macros/s/AKfycbwFgBo9…/exec`) + per-queue address pages + a Google Sheet | none for curl (parsers use Playwright) | y | OE, SP-new, milkmann/gpv-zoe-zaporizhzhia (both last 17–18.10) | **Hard** (text parsing, weak lookup). Reference: yaroslav2901/ZOE_PARSER. |
| Chernihiv | Chernihivoblenergo | `https://interruptions.energy.cn.ua/api/info_schedule_part` (iframe on `chernihivoblenergo.com.ua/blackouts`) | JSON | yes, but every call needs a Turnstile token | **Cloudflare Turnstile** ("No captcha", 400) | y (blocked) | OE (has 20.10 data; parser not public), SP-new, AE (24 queues) | TG posts are images. **Hard**: only via a visible-window Turnstile solve, or the aggregators. |
| Kherson | Khersonoblenergo | none found (`ksoe.com.ua/disconnection/schedule/` = empty body) | — | none | — | y | SP-old `null` | **Impossible** (frontline; no ГПВ published). |
| Donetsk | DTEK DEM | see §1 | DisconSchedule (third-party code `eSvitlo/ical` uses the same DisconSchedule base class for DEM) | `getHomeNum` (same engine) | Incapsula | n | SP-old (6 groups "1"–"6", all on) | Same browser approach as KREM. No scraper repo publishes DEM data. (`dtek-zem.com.ua` seen in some scrapers does not resolve.) |
| Luhansk | — | — | — | — | — | — | SP-old `null` | Occupied. Impossible. |
| Crimea / Sevastopol | — | — | — | — | — | — | SP-old `null` | Occupied. Impossible. |
| Kyiv city | DTEK KEM / YASNO | — | — | — | — | — | B42, SP-new (60 groups), AE (72 queues) | Covered by the other agent. |

---

## 2.3 Verdict per region

| bucket | regions | why |
|---|---|---|
| **Easy** (operator gives schedule + address lookup, no blocking WAF beyond what the widget already handles) | **DTEK Odesa, DTEK Dnipro (+ CEK)**, Ternopil, Lviv, Zhytomyr, Chernivtsi, Mykolaiv (7 oblasts) | DTEK ones are a URL swap on the existing provider. Ternopil, Lviv and Mykolaiv are clean JSON APIs with cascaded address endpoints (LOE, TOE and Zakarpattia share one vendor, inneti). Zhytomyr and Chernivtsi are stable HTML. |
| **Hard** (OCR/text/Telegram, captcha, header spoofing, login, or no usable address lookup) | DTEK Donetsk (Incapsula, unconfirmed), Kirovohrad (lookup verified, schedule shape unverified, provisional), Ivano-Frankivsk (schedule easy, lookup 403 from curl, untested in a browser), Poltava (schedule easy, lookup empty), Sumy (403 from curl without browser headers, robots-disallowed, lookup unproven), Rivne (HTML, lookup PDF only), Vinnytsia (per-address HTML, no group; JSON needs e-svitlo login), Khmelnytskyi and Zakarpattia (image schedules; lookups fine), Cherkasy, Kharkiv, Zaporizhzhia (text/Telegram schedules), Chernihiv (Turnstile everywhere) (13 oblasts) | Each needs one of: OCR, free-text parsing, a visible captcha step, or "pick your group by hand". |
| **Impossible (today)** | Kherson, Luhansk, Crimea/Sevastopol (3) | Nothing published (Kherson) or occupied. |
| out of scope here | Kyiv oblast (already implemented), Kyiv city and Volyn (other agents) | 7 + 13 + 3 + Kyiv obl. + Volyn = 24 oblasts + Crimea; Kyiv city separate. |

---

## 3. Aggregators and open data

### 3.1 How they depend on each other

For the oblenergo and DTEK schedules there are really only **two open upstreams**, Baskerville42 and yaroslav2901. svitlo.live and alerts.energy run their own closed scrapers. Everything else re-publishes one of these:

```
operator sites / Telegram ─┬─> Baskerville42/outage-data-ua (DTEK: Kyiv, Kyiv obl., Dnipro, Odesa) ─┐
                           ├─> yaroslav2901 parsers ─> yaroslav2901/OE_OUTAGE_DATA (12 oblenergos) ───┼─> svitlo-proxy "new" worker (chaichuk) ─> HA "Svitlo.live"
                           │                                                                          ├─> HA "Svitlo Yeah" (ALERTua)
                           │                                                                          └─> blackout (macOS menu bar, olegarutin)
                           ├─> (own Chernivtsi parser) ─> svitlo-proxy "new" worker   [Chernivtsi is in neither OE nor B42]
                           ├─> svitlo.live (own scraping, HTML only) ─> svitlo-proxy "old" worker
                           └─> alerts.energy (own scraping, internal API)
YASNO app API (Kyiv city + Dnipro DnEM/CEK) ─> ha-yasno-outages, Svitlo Yeah, svitlo-proxy
```

### 3.2 Table

| aggregator | regions | endpoint(s) (verified) | format | freshness | address -> group? | licence / terms | can a desktop app rely on it? |
|---|---|---|---|---|---|---|---|
| **Baskerville42/outage-data-ua** (GitHub, 62★) | 4: `kyiv`, `kyiv-region`, `dnipro` (DNEM incl. CEK groups 1001.x), `odesa` | `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/{kyiv,kyiv-region,dnipro,odesa}.json` – 200, odesa 54,803 B | DTEK's own `fact` + `preset` objects stored as-is (same keys as `DisconSchedule.fact/preset`), plus `lastUpdated`, `lastUpdateStatus {status, ok, code, attempt}`, `meta.contentHash`. PNG per group in `images/<region>/gpv-x-x.png`. | GitHub Actions + Playwright **every ~5 min** (commits 06:13…06:57 UTC on 2026-10-20). On WAF failure it keeps the old data and sets `lastUpdateStatus.code=422`. | **No** – no streets/houses | Code MIT; data scraped from DTEK ("дотримуйтеся умов використання сайтів"). | Reasonable as a **fallback** for the schedule (raw.githubusercontent is a CDN; `factToDays()` reads `fact` unchanged, and `preset.sch_names` is present here). Single maintainer; the region list is fixed by a private secret `REGION_SOURCES_JSON`. Does **not** cover DEM. |
| **yaroslav2901/OE_OUTAGE_DATA** (GitHub, 30★) | 12 oblenergos: Cherkasy, Chernihiv, Khmelnytskyi, Kharkiv, Lviv, Prykarpattia (Ivano-Frankivsk), Poltava, Rivne, Ternopil, Zakarpattia, Zaporizhzhia, Zhytomyr | `https://raw.githubusercontent.com/yaroslav2901/OE_OUTAGE_DATA/main/data/<Name>.json`, e.g. `Poltavaoblenergo.json` – 200; names: Cherkasyoblenergo, Chernihivoblenergo, Kharkivoblenerho, Khmelnytskoblenerho, Lvivoblenerho, Poltavaoblenergo, Prykarpattiaoblenerho, Rivneoblenergo, Ternopiloblenerho, Zakarpattiaoblenerho, Zaporizhzhiaoblenergo, Zhytomyroblenergo | **DTEK-compatible**: `fact.data[<unix day>]["GPV1.1"]["1".."24"] = yes/no/first/second/mfirst/msecond`, `fact.update`, `fact.today`, `preset.time_type`. Poltava 2026-10-20: `GPV1.1 = {"8":"no","9":"msecond","14":"no","15":"no","16":"mfirst",…}`. | Parsers run "every 5 min"; commits only on change (last 2026-10-19 21:04 UTC). All 12 files checked on 2026-10-20: `fact.update` is 20.10 00:00–00:02 for Cherkasy, Chernihiv, Kharkiv, IF, Rivne, Zakarpattia and Zhytomyr; 19.10 18:58 for Poltava (day 20.10 present); 17.10 for Khmelnytskyi, Lviv, Ternopil and Zaporizhzhia (no outages since then). None is months old today. The `blackout` app README said 6 of 12 had been stale since July, which was an earlier state. Cherkasy's file has an empty `preset`. | **No** | **No licence file** (`gh api …/contents/LICENSE` → 404, `license: null`), so no granted reuse rights. Upstream parsers are separate repos (ZOE, TOE, KHARKIV, ROE, ZTOE, CHERKASY); Kharkiv and Cherkasy are parsed from `t.me/s/…` Telegram previews, TOE uses an API plus image recognition. | Technically easy (same parser as DTEK). Legally grey (no licence); ask the author. Single maintainer on free hosting. |
| **svitlo-proxy "new" worker** (by chaichuk, used by HA "Svitlo.live" 71★) | 17: kiivska-oblast, lvivska, poltavska, cherkaska, chernihivska, kharkivska, khmelnytska, ivano-frankivska, rivnenska, ternopilska, zakarpatska, zaporizka, zhytomyrska, kyiv (60 groups), dnipro-dnem, dnipro-cek, chernivetska (groups 1…12) | `https://dtek-api.svitlo-proxy.workers.dev/` – 200, 155,420 B, `{"body":"<JSON string>","timestamp":1792479638263}` (body is double-encoded) | `regions[].schedule[group][YYYY-MM-DD]["HH:MM"] = 1 (on) / 2 (off)` in 48 half-hour slots, plus `emergency: bool`. **No "maybe" state.** Stale regions keep their last date (Lviv, Ternopil, Khmelnytskyi, Zakarpattia, Zaporizhzhia, Chernivtsi = 2026-10-17). | README: client cache 10–15 min; ETag / If-Modified-Since supported. | **No** | Integration code MIT. The worker is one person's free-tier Cloudflare Worker; README: "the free server is reaching its limits". Data credited to yaroslav2901's parser. | **Not without the maintainer's permission** – a distributed app would add load to a donated free tier. It adds Chernivtsi beyond OE_OUTAGE_DATA. |
| **svitlo-proxy "old" worker** (same author) | 26 svitlo.live slugs; data present for 24, `schedule: null` for Crimea, Luhansk, **Kherson** | `https://svitlo-proxy.svitlo-proxy.workers.dev` – 200, 320,890 B | `regions[].schedule[group][date]["HH:MM"] = 0/1/2` (0 = no info). Today (2026-10-20): Vinnytsia, Volyn, Dnipropetrovsk, Zakarpattia, Zaporizhzhia, IF, Kirovohrad, Lviv, Odesa, Ternopil, Khmelnytskyi all **0** (no info); **Mykolaiv all 1**; Donetsk 6 groups all 1. | Mirrors svitlo.live. | **No** | Same as above. | Same as above. Its upstream (svitlo.live) is an ad-funded site with no API and no terms. |
| **svitlo.live** (website) | 26 region pages (`/poltavska-oblast`, `/kyiv`, …) | `https://svitlo.live/<slug>` – 200, 273,681 B, Cloudflare | Server-rendered HTML only: per group, today and tomorrow, 24 hourly cells with ● / ✕ / ± / "%" (half-hour) / "-". Lists settlements but links to the oblenergo site for the group. | "Updated daily and when new data arrives". | **No** | No API, no terms page (only `/contact`); AdSense. | **No** – HTML scraping of a third-party ad site. |
| **alerts.energy** | 26 areas. Live schedules today for 9: kyiv (72 queues, 2 suppliers), zhytomyrska, kyivska, poltavska, kharkivska, cherkaska, chernigivska (24 each), rivnenska (12), sumska (11); dnipropetrovska "available" with 0 queues; the other 16 `dataState: unknown` | `https://alerts.energy/api/v1/source-registry/areas/overview` (200, 6,357 B); `https://alerts.energy/api/v1/source-registry/areas/<slug>/shutdowns` (poltavska 200, 13,117 B); also `/api/v1/notices`, `/api/v1/emergencies` | Clean JSON: `{initiator, queue:"1.1", updated, today:[24 ints], tomorrow:[], todayStatus:"ScheduleApplies"|"NoShutdowns"|"EmergencyShutdowns"|"WaitingForSchedule", todayPossible:[24 ints], todaySourceSlug:"poltavska_oblast_oblenergo_web", todayCheckedAt}`. Hour codes: 0 = on, 1 = whole hour off, 2 and 3 = one half of the hour (which half is which is not confirmed; the Poltava sample does not map 1:1 onto OE_OUTAGE_DATA's `msecond`/`mfirst`). A separate `todayPossible` array uses the same codes. | `todayCheckedAt` a few minutes old. Its own status vocabulary is the best of all aggregators (explicit "emergency, schedule void"). | **No** | **Explicitly not public**: `llms.txt` says "Внутрішні API не є публічним інтерфейсом для збору даних"; `robots.txt` has `Disallow: /api/`. | **No**, unless you get written permission (`/contacts`). |
| **YASNO app API** (Kyiv agent covers it in depth) | Kyiv city (region 25, DSO 902) and Dnipro (region 3, DSO 301 ДнЕМ, 303 ЦЕК, `hasCities: true`) | `https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/regions` (200, 257 B); `…/regions/3/dsos/301/planned-outages` (200, 2,569 B: `{"1.1":{"today":{"slots":[],"status":"NoOutages"},"tomorrow":{"status":"WaitingForSchedule"},…}}`) | JSON | live | **Yes** – `…/addresses/v2/streets?regionId&dsoId&query`, `…/houses?…&streetId`, `…/group?…&houseId` | DTEK's own consumer app API, undocumented | Best non-HTML option for **Dnipro** (DNEM + CEK) incl. address lookup; ha-yasno-outages (MIT, 194★) and Svitlo Yeah already depend on it. |
| **HA "Svitlo Yeah"** (ALERTua/ha-svitlo-yeah, GPL-3.0, 52★) | Kyiv, Dnipro DnEM + CEK (YASNO); Kyiv obl., Dnipro obl., Odesa (Baskerville42); Khmelnytskyi, IF, Zakarpattia, Lviv, Ternopil, Chernihiv, Zaporizhzhia, Zhytomyr, Poltava, Rivne (OE_OUTAGE_DATA); **Vinnytsia** (olnet93/gpv-voe-vinnytsia, vn-progr/gpv-voe-vinnytsia); **Sumy** (sm.e-svitlo.com.ua with login, or soe.com.ua) | consumes the sources above | — | — | Only E-Svitlo (Sumy, by personal-account login) | GPL-3.0 (matters only if code is copied) | Useful as a **map of working sources**, not a data source itself. |
| **HA "Svitlo.live"** (chaichuk/svitlo_live, MIT, 71★) | all 24 + Kyiv via the two workers above | the two svitlo-proxy workers | — | — | No – user picks region + queue | MIT | Same caveats as the workers. |
| **ha-yasno-outages** (denysdovhan, MIT, 194★) | Kyiv, Dnipro | YASNO API | — | — | Yes (YASNO) | MIT | Reference implementation of the YASNO API. |
| **blackout** (olegarutin, macOS SwiftBar plugin, MIT) | 26 areas | alerts.energy + OE_OUTAGE_DATA + Baskerville42 | — | polls every 170 s, takes whichever source published later | No | MIT | Precedent: a desktop app already ships on these sources. Its README (15 Oct 2026): 9 regions with a working schedule, 1 emergency, 10 no data, 6 months stale — "roughly one region in three". |
| aernjdz/firefly (MIT) | 1: **Rivne** (scrapes `https://www.roe.vsei.ua/disconnections`, per `index.js`) | `https://raw.githubusercontent.com/aernjdz/firefly/refs/heads/main/outages/latest/data_v2.json` – 200, `date: 2026-10-16` | `{queues:{"1":[{subQueue:"1.1",intervals:[{startTime,endTime,status}]}]}}` | stale (4 days) | No | MIT | Minor. |
| tsdaemon/ha-lviv-poweroff (MIT) | Lviv via `lviv.energy-ua.info` | — | — | last push 2024-12-05 | No | MIT | Abandoned. |
| Svitlobot (svitlobot.in.ua) | crowd-sourced *actual* on/off per location | — | — | — | — | — | Not a schedule; out of scope. |

### 3.3 Notes

- **Reliability is visible in the data.** At 07:06 UTC on 2026-10-20, Baskerville42's `dnipro.json` had
  `lastUpdateStatus = {status:"error", code:422, message:"Marker DisconSchedule.fact = not found …"}`, which means DTEK's WAF
  or maintenance page beat its Playwright run. It kept the 17.10 data. `kyiv-region.json` parsed fine in the same run
  (`fact.update 19.10.2026 23:20`, today's day present). Any consumer must read `lastUpdateStatus` and `fact.update`, not `lastUpdated`.
- **Format compatibility.** Baskerville42 and OE_OUTAGE_DATA both keep DTEK's `fact` shape
  (`data[<unix day>]["GPVx.y"]["1".."24"] = yes|no|first|second|mfirst|msecond`, plus `maybe` in `preset`).
  In the widget, `factToDays()` / `hourToSlots()` in `src/main/providers/dtek-krem/parse.ts` already know all 7 codes and read
  `fact` unchanged. One minor adaptation: OE files have **no `preset.sch_names`** (Cherkasy has no `preset` at all), and
  `deriveLines()` filters on `key in schNames`. So build `schNames` from the `GPVx.y` keys with the existing
  `queueLabelFromId()` ("Черга 1.2"). The svitlo-proxy workers flatten this to 1/2 (or 0/1/2) per
  half-hour and **lose "maybe"**. alerts.energy keeps "possible" in a separate array.
- **Address lookup is the gap.** No aggregator maps an address to a group. For an aggregator-backed region the widget
  would show "pick your черга" (with a link to the operator's lookup page) instead of city -> street -> house.
- **Single-maintainer risk.** Baskerville42 (1 person, GitHub Actions), yaroslav2901 (1 person, "free services, limited"),
  chaichuk workers (1 person, free Cloudflare tier). Both GitHub repos are on raw.githubusercontent.com, which a desktop
  app can poll politely (ETag / If-None-Match, every 5–10 min). That is the least burdensome option, and the `blackout`
  macOS app already does it.
- **Terms.** Only Baskerville42 has a licence (MIT, for code). OE_OUTAGE_DATA has none. alerts.energy forbids API scraping.
  svitlo.live has no terms and no API. Operator data itself is public information, but site ToS vary. Asking yaroslav2901
  (Telegram group `t.me/OUTAGE_CHAT` is linked from his README) is cheap and advisable before shipping.

---

## 4. Recommendation: which aggregator, and how to combine

**Most regions, reliably: `yaroslav2901/OE_OUTAGE_DATA` + `Baskerville42/outage-data-ua` together.**
- They cover 16 schedules: 12 oblenergos + Kyiv city, Kyiv oblast, Dnipro (with CEK), Odesa.
- Both serve static JSON on raw.githubusercontent.com, so a desktop app can poll them politely with ETag every 5–10 min.
- Both use DTEK's own `fact` format, so `factToDays()` reads them as-is, including the half-hour and "maybe" states. The only adaptation is group labels via `queueLabelFromId()`, because OE has no `sch_names`.
- `svitlo-proxy` "new" adds Chernivtsi, but it drops "maybe" and runs on one person's free tier.
- `alerts.energy` has the best status model but says its API is not public.

Caveats:
- Neither repo gives address → group.
- OE_OUTAGE_DATA has **no licence**: ask the author before shipping.
- Both have one maintainer. Always show `fact.update`, and treat Baskerville42's `lastUpdateStatus.ok=false` as stale.

**Suggested shape for the widget:**
1. **Same engine, URL swap:** DTEK OEM and DNEM (+CEK) via the existing hidden-window provider. DEM can come later, after a browser check.
2. **Native providers where the operator has JSON + address APIs:**
   - Ternopil (TOE `a_gpv_g`, address → group in one call).
   - Lviv (LOE `power-api` lookup + `menus` text).
   - Mykolaiv (`off.energy.mk.ua`).

   Zhytomyr and Chernivtsi (HTML, but stable, with lookups) come next.
3. **Hybrid, operator lookup + OE schedule:**
   - Zakarpattia (inneti `pw_address_queues`).
   - Khmelnytskyi (`/shutdown-queues`).
   - Cherkasy (cabinet API; it exposes account numbers).
4. **Group picker + OE/B42 schedule** (no usable lookup): Kharkiv, Chernihiv, Zaporizhzhia, Rivne, Poltava, Ivano-Frankivsk. Add a link to the operator's own lookup page.
5. **Skip for now:**
   - Vinnytsia: per-address HTML works but gives no group, and the JSON needs an e-svitlo login.
   - Sumy: the API is robots-disallowed and the lookup unproven. Its 403 is only for curl; a browser context passes.
   - Kirovohrad: the lookup is verified, but the schedule shape stays unknown until outages resume. It is provisionally Hard; re-check then.
   - Kherson, Luhansk, Crimea.
