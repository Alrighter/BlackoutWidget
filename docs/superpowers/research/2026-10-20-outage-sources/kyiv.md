# Kyiv city: outage schedule sources

Research date: 2026-10-20 (all live probes were made between 06:58Z and 07:25Z that day).
Scope: how Blackout Widget can show the planned-outage schedule for an address in **Kyiv city**. Dnipro is checked briefly because YASNO serves it too.

Evidence labels used below:

- **[LIVE]**: I fetched it myself on 2026-10-20, and the response is quoted from that fetch.
- **[ARCHIVE]**: I verified it from a Wayback Machine capture of the real page (2026-10-06 capture), not live.
- **[READ]**: I only read about it, in another project's source code, a news article or a doc. Not fetched by me.

Raw evidence (responses, scripts, diffs) is in
`(research scratch, not kept) kyiv-raw\`.
The probe scripts are in `...\outage-sources\probe\`. They are outside the repo, which was not modified.

---

## 0. Background: Kyiv now uses 60 groups, not 12 queues

- **[LIVE]** Both DTEK-KEM (`DisconSchedule.fact`) and YASNO (`planned-outages`) publish **60 groups** for Kyiv today: `GPV1.1` … `GPV60.1` (YASNO uses the same ids without the prefix: `"1.1"` … `"60.1"`). Every subgroup is `.1`. DTEK's `preset.sch_names` still lists 120 names (`GPV1.1`, `GPV1.2`, …, `GPV60.2`), all labelled `"Черга N.M"`.
- **[LIVE]** Today the 60 groups collapse to **12 distinct schedules**: groups n, n+12, n+24, n+36 and n+48 have identical slots (for example 1.1 = 13.1 = 25.1 = 37.1 = 49.1 → off 06:30–10:00 and 15:30–19:00). Do not rely on this. It is just how today's schedule turned out.
- **[READ]** News items from Jan–Feb 2026 ([vikna.tv](https://vikna.tv/dlia-tebe/novyny-ukrayiny/grafiky-vidklyuchennya-svitla-u-kyyevi-29-sichnya-2026-novyj-rozklad/), [glavred](https://glavred.net/ukraine/kiev-vozvrashchaetsya-k-vremennym-grafikam-kogda-zhdat-otklyucheniy-elektroenergii-10737191.html), [forbes.ua](https://forbes.ua/news/povernennya-do-postiynikh-grafikiv-vidklyuchennya-svitla-u-kievi-mozhlive-ne-ranishe-kvitnya-gendirektor-yasno-25022026-36630)) say this: from 29 Jan 2026 Kyiv runs "temporary schedules" with **60 groups**, assigned per building, and "the familiar queues are no longer relevant; check by address on the DTEK or YASNO site".
- **Consequence for the app:** a user cannot be asked "which queue are you in". Kyiv has to be **address → group**. Any group picker must accept ids like `GPV37.1`. The existing `queueLabelFromId` already handles that (`/(\d+(?:\.\d+)*)$/`).

---

## 1. DTEK Kyiv Electric Networks (DTEK-KEM): `https://www.dtek-kem.com.ua/ua/shutdowns`

### 1.1 Is it the same engine as dtek-krem? Yes, minus the city level.

| Aspect | dtek-krem (current provider) | dtek-kem (Kyiv) | Evidence |
|---|---|---|---|
| Page URL | `https://www.dtek-krem.com.ua/ua/shutdowns` | `https://www.dtek-kem.com.ua/ua/shutdowns` | [LIVE] |
| Global object | `DisconSchedule` (bare lexical binding) | same, same keys (`streets, preset, fact, showCurOutage, …, ajax`) | [LIVE] hidden Electron probe |
| Schedule script | `/src/js/static/discon-schedule.js` | same file name, near-identical code; the diff is only the city handling and `cek` logic | [ARCHIVE] supporting detail only: KEM capture 2026-10-06, KREM capture 2026-08-31; diff in `kyiv-raw/discon-schedule-krem-vs-kem.diff`. The "same engine" claim rests on the [LIVE] rows (globals, ajax methods, form fields, getHomeNum shape) |
| `DisconSchedule.ajax` methods | `getStreetsInvisibly, getHomeNumInvisibly, checkDisconUpdate, formSubmit, …` | `url, obj, send, getStreetsInvisibly, getHomeNumInvisibly, checkDisconUpdate, getCekText, formSubmit` | [LIVE] |
| **`DisconSchedule.streets`** | **map** `{ "<city>": ["<street>", …] }` | **flat array** `["пров. Петрівський", "просп. Берестейський", …]`: **2507 streets** live (2527 in the 2026-10-06 capture) | [LIVE] + [ARCHIVE] |
| Form fields | `city`, `street`, `house_num`, hidden `updateFact` | **`street`, `house_num`**, hidden `updateFact` (**no `city` input**) | [LIVE] + [ARCHIVE] |
| `fact` shape | `{ data: { "<unix ts Kyiv midnight>": { "GPV1.2": { "1": "yes" … "24": … } } }, update: "dd.mm.yyyy HH:MM", today: <ts> }` | identical. Live: `update: "19.10.2026 20:20"`, `today: 1792443600` (= 2026-10-20 00:00 Kyiv), one day present (tomorrow not yet published) | [LIVE] |
| Hour statuses (`preset.time_type`) | `yes, no, first, second, maybe, mfirst, msecond` | identical keys and texts ("Світло є", "Світла немає", "Світла не буде перші 30 хв." …) | [LIVE] |
| Group ids | `GPV1.1 … GPV6.2` (12) | **`GPV1.1 … GPV60.1` (60 in `fact`)**, 120 in `sch_names`, 66 in `preset.data` (weekly plan, `showTablePlan = false`) | [LIVE] |
| `preset` keys | `days, days_mini, sch_names, time_zone, time_type, data` | same + `updateFact` | [LIVE] |
| AJAX endpoint | `POST /ua/ajax`, `method=getHomeNum`, CSRF meta `csrf-token`, header `X-CSRF-Token` | identical. CSRF param name `_csrf-dtek-kem` | [LIVE] |
| `getHomeNum` response | `{ result, data: { "<house>": { sub_type, start_date, end_date, type, sub_type_reason: ["GPV…"], voluntarily, cek } }, showCurOutageParam, …, updateTimestamp [, fact, preset when updateFact is stale] }` | identical shape | [LIVE] |
| Imperva site id | 2398465 | **2224657** (separate site, separate cookies) | [LIVE] `visid_incap_*` cookie names |

### 1.2 `getHomeNum` without a city: verified

**[LIVE]** Called from inside the loaded page (exactly like the app's `getHomeNumScript`) with street `вул. Хрещатик`, in three variants. All returned **HTTP 200, `result: true`, the same 42 houses, house `1` → `["GPV19.1"]`**:

1. `city` field omitted: `data[0]=street, data[1]=updateFact`
2. `city = ""` (this is what [ha-dtek-monitor](https://github.com/groove-max/ha-dtek-monitor) sends for KEM)
3. `city = "м. Київ"`

So the app's existing request builder works unchanged if it passes `city = ""` or `"м. Київ"`. Real trimmed response (2026-10-20, `updateFact` current, so there are no `fact`/`preset` in the reply):

```json
{
 "result": true,
 "showCurOutageParam": true, "showCurSchedule": true, "showTableSchedule": true,
 "showTablePlan": false, "showTableFact": true, "showUserGroup": false,
 "updateTimestamp": "10:03 20.10.2026",
 "data": {
  "1":         {"sub_type": "", "start_date": "", "end_date": "", "type": "", "sub_type_reason": ["GPV19.1"], "voluntarily": null, "cek": null},
  "4":         {"sub_type": "", "start_date": "", "end_date": "", "type": "", "sub_type_reason": ["GPV20.1"], "voluntarily": null, "cek": null},
  "8/Б":       {"sub_type": "", "start_date": "", "end_date": "", "type": "", "sub_type_reason": ["GPV20.1"], "voluntarily": null, "cek": null},
  "32  ПРИМ.": {"sub_type": "", "start_date": "", "end_date": "", "type": "", "sub_type_reason": ["GPV19.1"], "voluntarily": null, "cek": null}
 }
}
```

Live `fact.data["1792443600"]["GPV19.1"]`: `{"1":"yes", …, "11":"yes", "12":"second", "13":"no", "14":"no", "15":"no", "16":"yes", …, "20":"yes", "21":"second", "22":"no", "23":"no", "24":"no"}`. That is off 11:30–15:00 and 20:30–24:00.

The house keys on Khreshchatyk include oddities, the same way KREM has them: `"27/Б"`, `"10,12"`, `"20-22П/П-С"`, `"32  ПРИМ."` (double space). Show them as they are.

None of the 42 houses had an active outage (`type`/`sub_type` empty), and none had more than one group in `sub_type_reason` today. In the 2026-10-06 capture the KEM script still has the "2 separate lines" (`discon-multigroup`) message, so multi-line houses can exist.

### 1.3 Bot protection

- **[LIVE]** plain `curl` (browser UA): 212-byte Imperva JS stub (`/_Incapsula_Resource?SWJIYLWA=…`), the same as KREM. Repeated requests got the 953-byte "Request unsuccessful. Incapsula incident ID …" block iframe.
- **[LIVE]** headless Chrome 155 (`--headless=new --dump-dom`): blocked (incident iframe).
- **[LIVE]** hidden Electron 44.9 `BrowserWindow` (the same technique the app uses, default UA, fresh partition): **2 of 3 attempts passed**. The first attempt (right after my curl and headless-Chrome probes from the same IP) got the incident page (`edet=12`). The next two loaded `DisconSchedule` within a few seconds, and `getHomeNum` then worked.
- **[LIVE]** Wayback CDX for the page: of the 15 most recent captures, only 5 are the real ~110 KB page. The other 10 are ~1 KB challenge or block pages. So Imperva challenges a lot of automated traffic here.
- Practical meaning: the same Imperva risk the KREM provider already lives with (the captcha path through `showVerification()`), on a separate Imperva site, so cookies are separate too.

### 1.4 Data model summary

- 24 hourly cells per group per day, each with 7 statuses, so the result maps onto 48 half-hour slots with the existing `hourToSlots`. Today and tomorrow (tomorrow appears when published). The `fact` keys are unix timestamps of Kyiv midnight.
- Planned versus emergency: `fact` is the planned "графік погодинних відключень". A current or emergency outage for a house shows in `getHomeNum` `data[house].type/sub_type/start_date/end_date` (the existing `parseCurrentOutage` / `hasActiveOutage` logic applies).
- Weekly "probable" plan: `preset.data`, hidden (`showTablePlan = false`). Same as KREM.

### 1.5 Fit with the existing provider interface: very good, with small changes

The Kyiv provider can be a near-copy of `DtekKremProvider` / `page-scripts.ts`. The required differences:

1. **Cities.** `READ_CITIES = 'Object.keys(DisconSchedule.streets)'` would return `"0" … "2506"` on KEM. Use a fixed city instead: `listCities()` returns `['м. Київ']` (ha-dtek-monitor does the same with `fixed_city="м. Київ"`, wrapping the array as `{ "м. Київ": [...] }`).
2. **Streets.** `readStreetsScript(city)` would return a single string (`streets["м. Київ"]` is undefined, or `streets[0]` if called with "0"). Use `DisconSchedule.streets.slice()`.
3. **getHomeNum.** Keep `getHomeNumScript` as is and pass `city = ''` (verified), or drop the field.
4. **Session options.** `url: 'https://www.dtek-kem.com.ua/ua/shutdowns'`, its own `partition` (for example `persist:dtek-kem`), `allowedHosts: ['dtek-kem.com.ua']`. `READY_CHECK`, `NEUTRALIZE_TIMERS` and `isPagePollRequest` work unchanged (same ajax method names, same `/ua/ajax`).
5. **`browser-session.ts` `REAL_PAGE_CHECK`** tests `/ДТЕК|dtek-krem/i`. "ДТЕК" is in the KEM title, so it already works, but the `dtek-krem` literal is KREM-specific.
5a. **Registration points:**
   - a `createProviders` entry in `src/main/providers/registry.ts`;
   - `'dtek-kem'` in `PROVIDER_NAMES` (for example "ДТЕК Київські електромережі") and in `PROVIDER_REGIONS` ("м. Київ") in `src/shared/providers.ts`. `providerDisplayName(this.id)` reads these.
   - The log and error prefixes in `DtekKremProvider` are hard-coded `dtek-krem …`. Parameterise them or copy the class.
   - `src/main/index.ts:159` opens the KREM `DTEK_URL` for the user ("open the DTEK site"). That should become per-provider.
6. Strings that say "ДТЕК" stay correct. `OFFLINE_MESSAGE` is shared.
7. `deriveLines` / `factToDays` / `parseHouses` need no changes. 60 groups are handled as long as nothing assumes `GPV1–6`.
8. The address list is complete and enumerable (all 2507 streets in the page, all houses of a street in one `getHomeNum`). This matches the wizard, which loads full lists once and filters client-side (`SetupWizard.tsx` → `Autocomplete options={list}`, house grid with a client filter).

### 1.6 Risks

- Imperva. This is the main operational risk, as with KREM: more captchas, and possible hard blocks after bursts. A refresh needs a live page (one `getHomeNum` per refresh, the same as KREM today).
- [ARCHIVE] In the 2026-10-06 capture, `streets` contains about 115 non-standard entries (garden plots, "Дніпровський р-н, вул. Садова 31,", "Без вулиці"). They are harmless and shown as they are.
- The site layout could diverge from KREM later. Today the two scripts are near-identical.

---

## 2. YASNO: `app.yasno.ua` blackout-service (public JSON API)

YASNO is DTEK's retail supplier for Kyiv and Dnipro. Its new public API has **no auth, plain JSON, and no bot challenge today**. It is the API the YASNO website and mobile app use.

### 2.1 Endpoints

Base: `https://app.yasno.ua/api/blackout-service/public/shutdowns`

| Purpose | Request | Status | Notes |
|---|---|---|---|
| Regions and DSOs | `GET /addresses/v2/regions` | **[LIVE]** 200 | `[{"hasCities":false,"dsos":[{"id":902,"name":"ПРАТ «ДТЕК КИЇВСЬКІ ЕЛЕКТРОМЕРЕЖІ»"}],"id":25,"value":"Київ"},{"hasCities":true,"dsos":[{"id":301,"name":"ДнЕМ"},{"id":303,"name":"ЦЕК"}],"id":3,"value":"Дніпро"}]` |
| **Schedule (today and tomorrow), all groups** | `GET /regions/25/dsos/902/planned-outages` | **[LIVE]** 200, 25.6 KB, `Cache-Control: max-age=300, public`, `ETag` | sample below |
| Weekly probable plan | `GET /probable-outages?regionId=25&dsoId=902` | **[LIVE]** 200 | `{"25":{"dsos":{"902":{"groups":{"1.1":{"slots":{"0":[…],…,"6":[…]}}}}}}}`. Weekday keys 0–6. Today it is all `NotPlanned` 0–1440 |
| Street search | `GET /addresses/v2/streets?regionId=25&query=<text>&dsoId=902` | **[LIVE]** 200 | `query=Хрещатик` → `[{"id":947,"value":"вул. Хрещатик"}]` |
| House search | `GET /addresses/v2/houses?regionId=25&streetId=947&query=<text>&dsoId=902` | **[LIVE]** 200 | `query=1` → `[{"id":40373,"value":"1"},{"id":40374,"value":"1/2"},{"id":40375,"value":"10"},…]` |
| House → group | `GET /addresses/v2/group?regionId=25&streetId=947&houseId=40373&dsoId=902` | **[LIVE]** 200 | `{"group":19,"subgroup":1}`, so the key is `"19.1"` (`GPV19.1`). An unknown id gives 404 RFC 9110 problem JSON: `{"title":"EntryNotFoundException","status":404,"detail":"House 1 not found in RegionId 25 and DsoId 902 and StreetId 947",…}` |
| Cities (Dnipro only) | `GET /addresses/v2/cities?regionId=3&query=Дніпро&dsoId=301` | **[LIVE]** 200 | `[{"id":4,"value":"м. Верхньодніпровськ"},{"id":6,"value":"м. Дніпро"},…]`. Kyiv has `hasCities:false` |

Real `planned-outages` sample, group 1.1 **[LIVE]**:

```json
{"1.1":{"today":{"slots":[{"start":0,"end":390,"type":"NotPlanned"},{"start":390,"end":600,"type":"Definite"},
{"start":600,"end":930,"type":"NotPlanned"},{"start":930,"end":1140,"type":"Definite"},{"start":1140,"end":1440,"type":"NotPlanned"}],
"date":"2026-10-20T00:00:00+03:00","status":"ScheduleApplies"},
"tomorrow":{"slots":[],"date":"2026-10-21T00:00:00+03:00","status":"WaitingForSchedule"},
"updatedOn":"2026-10-19T17:30:02+00:00"}, "2.1": {…}, … "60.1": {…}}
```

### 2.2 Data model

- Keys `"<group>.<subgroup>"` (Kyiv today: `1.1` … `60.1`; Dnipro: `1.1` … `6.2`).
- Per group: `today`, `tomorrow`, `updatedOn` (ISO, UTC). Per day: `date` (ISO with +03:00 / +02:00), `status`, `slots`.
- `slots`: **minute ranges** `start`/`end` (0–1440), `type`.
  - **[LIVE]** seen: `NotPlanned` (power on) and `Definite` (power off).
  - Every boundary seen today is a multiple of 30. The format allows any minute, so the 48-slot converter must handle that: snap or round, or mark a partial half-hour as off.
  - There is **no "maybe" type** in planned outages, so `maybe-off` never appears. Probable outages use the same slot format.
- Day `status`:
  - **[LIVE]** `ScheduleApplies` (Kyiv today), `WaitingForSchedule` (Kyiv and Dnipro tomorrow, `slots: []`), `NoOutages` (Dnipro today, `slots: []`).
  - **[READ]** `EmergencyShutdowns`: listed in ha-yasno-outages `const.py` as `API_STATUS_EMERGENCY_SHUTDOWNS`. Not observed by me.
  - **Mapping trap:** `WaitingForSchedule` with empty slots must become "no day yet" or `unknown`, **never all-`on`**. `NoOutages` is legitimately all-`on`. `EmergencyShutdowns` means the schedule is suspended; show it as an emergency notice, not as a schedule.
- No per-house current-outage information: no equivalent of DTEK's `type/sub_type/start_date/end_date`. `outageActive` / `currentOutage` would always be absent.
- Group lookup returns **one** group. There is no equivalent of DTEK's `sub_type_reason` list for houses fed by two lines.

### 2.3 Verified equivalence with DTEK-KEM

- **[LIVE] Schedule level:** I converted YASNO `today` for all 60 groups to 48 half-hour slots and compared them with the live DTEK-KEM `fact` (taken from the page in the hidden Electron window, same day `1792443600`, DTEK `update 19.10.2026 20:20`). **60/60 groups are identical, half-hour for half-hour.** The same holds against the outage-data-ua mirror.
- **[LIVE] Address level:** Khreshchatyk houses (YASNO name ↔ DTEK key) `1`↔`1`, `1/2`↔`1/2`, `4`↔`4`, `5В`↔`5В`, `6`↔`6`, `8`↔`8`, `8А`↔`8А`, `8Б`↔`8/Б` → YASNO `/group` = 19.1 / 19.1 / 20.1 / 19.1 / 20.1 / 20.1 / 20.1 / 20.1. DTEK `getHomeNum` gives exactly `GPV19.1` / `GPV20.1` for the same houses. **Group ids are interchangeable: `GPV{n}.{m}` ↔ `"{n}.{m}"`.**
- Freshness: YASNO `updatedOn` is 17:30Z = 20:30 Kyiv, and DTEK `update` is 20:20. Same publication.
- **But the names differ.** House strings: DTEK `8/Б`, `10/Б`, `27/Б`, `32  ПРИМ.` versus YASNO `8Б`, `10Б`, `32 ПРИМ`. Street names: 11 of 16 random KEM names match a YASNO street exactly. The misses are whitespace (`пл.  Арсенальна` in KEM, `пл. Арсенальна` in YASNO) and "вул. Садова NN" garden plots that YASNO's 20-result cap hides. **A saved address cannot be moved between the two sources by its strings.** Only the `groupId` carries over.

### 2.4 Bot protection

- **[LIVE]** `app.yasno.ua` sits behind Imperva (`X-CDN: Imperva`, sets `visid_incap_3019004`/`incap_ses_*` cookies). Plain `curl` and Node `fetch` without cookies or JS **were served real JSON every time** (about 60 requests over ~25 minutes, never rate-limited). No challenge today.
- Risk: Imperva could start challenging this host too. Then a hidden-browser fallback would be needed, like DTEK.
- The **old** endpoint `https://api.yasno.com.ua/api/v1/pages/home/schedule-turn-off-electricity` returned **[LIVE] HTTP 503 with an Imperva block iframe**. It is dead for programmatic use. ha-yasno-outages moved to the v2 API on 2025-10-23 (commit "Support Yasno v2 API (#59)").

### 2.5 Address lookup: search only, capped

**[LIVE]**, measured:

- Streets: the query needs **at least 3 characters**. `""`, `"в"`, `"а"` and `"Ле"` return `[]`; `"вул"` returns 20; `"Лес"` returns 10.
- Streets and houses: **at most 20 results**. Khreshchatyk has 42 houses in DTEK, but YASNO returns 20 for `query=""`. Not every house is reachable without typing.
- Kyiv needs no city. Dnipro (`hasCities:true`) needs `cityId` for `/group`: without it, 404 `"Street 1639 not found in Region 3 and Dso 301"`; with `cityId=6` → `{"group":5,"subgroup":2}`.
- **[READ]** The numeric ids can change. ha-yasno-outages added "Ask to reconfigure when street/house id changes (#126)" on 2026-02-23. So store the **groupId**, not YASNO's street and house ids, as the refresh key.
- **Gotcha for the implementer:** in Git Bash, `curl --data-urlencode "query=Хрещатик"` sent bytes that YASNO didn't match (every query returned `[]`). Node `fetch` + `URLSearchParams` (UTF-8) works. This was a shell encoding problem, not an API problem.

### 2.6 Fit with the existing provider interface

- `listCities()` → `['м. Київ']` (fixed; region 25 has no cities).
- `listStreets(city)` **does not fit**: the API cannot enumerate streets (min 3 chars, cap 20). Options:
  1. change the contract to a search (`searchStreets(city, query)`), with an async-search Autocomplete in the wizard;
  2. take the street list from somewhere else (KEM), then resolve the chosen street with a YASNO search (works for most names after whitespace normalisation, not for all).
- `listHouses(city, street)` has the same problem (cap 20). `HouseInfo.lines` would be built from one `/group` call per chosen house, not for all houses at once (one request per house, so do it lazily on pick).
- `fetchSnapshot(address)` **fits perfectly**: one GET of `planned-outages` for all groups. Pick `address.groupId` (strip `GPV`), convert minute slots to 48 slots, map day statuses as in 2.2. No browser, no captcha, 5-minute public cache, about 26 KB.
- `showVerification()` becomes a no-op. `outageActive` / `currentOutage` are absent.

### 2.7 Risks

- An undocumented API (it is the website and app backend). It has been stable for a year in public projects (HA integration since 2025-10, address lookup since 2026-01).
- Imperva in front, currently not challenging.
- No current-outage or emergency per house. `EmergencyShutdowns` is a day-level status only (not observed by me).
- No "maybe" state. No multi-line houses.
- Street and house ids may change (see 2.5).

### 2.8 Open-source consumers (evidence of the endpoints and their stability)

- [denysdovhan/ha-yasno-outages](https://github.com/denysdovhan/ha-yasno-outages): Home Assistant, 194★, pushed 2026-10-01. `api/const.py` lists exactly the endpoints above. The planned, probable and address→group flows are in `api/base.py`, `planned.py` and `probable.py`.
- [aisaiev/shutdown-calendar](https://github.com/aisaiev/shutdown-calendar) `src/services/yasno-address.ts`: the same streets/houses/group URLs, with `regionId=25`, `dsoId=902` hard-coded.
- [vokilam-d/brama-bot](https://github.com/vokilam-d/brama-bot) `docs/yasno-provider-implementation-plan.md` (+ a Postman collection): the same chain, the `GPV36.1` ↔ `"36.1"` mapping, and `WaitingForSchedule` handling.
- Others: [djumpen/gridlogger](https://github.com/djumpen/gridlogger) `docs/yasno_api_spec.md`, [vld/yasno-outages](https://github.com/vld/yasno-outages), [Make-Kyiv-Great-Again/DTEK-Parser](https://github.com/Make-Kyiv-Great-Again/DTEK-Parser) `app/yasno/client.py`, [aavdberg/ha-yasno](https://github.com/aavdberg/ha-yasno).

---

## 3. outage-data-ua: a GitHub mirror of DTEK `fact`/`preset` (no address lookup)

- `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json` **[LIVE]** 200, 307 KB. Repo [Baskerville42/outage-data-ua](https://github.com/Baskerville42/outage-data-ua), 62★, commits about every 5 min (the last five on 2026-10-20 were 06:42Z–07:03Z).
- Shape: `{ regionId:"kyiv", lastUpdated:"2026-10-20T06:56:02.259Z", lastUpdateStatus:{status:"parsed", ok:true, code:200, attempt:46938}, fact:{data,update,today}, preset:{…}, meta:{schemaVersion:"1.0.0", contentHash}, regionAffiliation }`. `fact`/`preset` are DTEK-KEM's own objects (60 groups, `update 19.10.2026 20:20`), scraped with Playwright in GitHub Actions (`.github/workflows/scheduled.yml`). The source URLs sit in a repo secret. Also `kyiv-region.json` (KREM), `dnipro.json`, `odesa.json`.
- No streets and no `getHomeNum`, so it cannot do address → group. Useful only as a no-captcha **schedule** fallback keyed by the `GPV` id. It is a third-party dependency on one person's Actions pipeline, with the GitHub raw CDN in between (adds up to ~5 min of delay).

---

## 4. Other Kyiv sources

- **Київ Цифровий (Kyiv Digital) app**, [READ] from KMDA news:
  - "Стан енергосистеми" service (29 Aug 2024): the Ukrenergo grid state, a forecast and links to the DTEK schedule by address.
  - Home-screen widget (21 May 2025): shows whether there is power at a chosen address. It "синхронізується з графіком і сповіщеннями сервісу ДТЕК Світло", and "графік … відображатиметься, тільки якщо користувач … авторизувався в застосунку" ([kyivcity.gov.ua](https://kyivcity.gov.ua/news/noviy_vidzhet_u_kiv_tsifrovomu_grafik_vidklyuchen_svitla_teper_mozhna_pereviryati_bez_zastosunku/), [kyivcity.gov.ua](https://kyivcity.gov.ua/news/u_miskomu_zastosunku_kiv_tsifroviy_zyavivsya_noviy_servis__stan_energosistemi/)).
  - It sits behind a login, has no public API, and GitHub code search for `api.kyiv.digital` found nothing. The data is DTEK's anyway. **Not worth integrating.**
- **KMDA (kyivcity.gov.ua)**: publishes news only, not machine-readable schedules. It points to the DTEK-KEM site, the DTEK chatbots and Kyiv Digital. Not a source.
- **DTEK chatbots** (Telegram `@DTEKKyivskielectromerezhibot`, Viber), linked from the KEM page: not an API.
- **"ДТЕК Світло" / DTEK account API**: [READ] ha-dtek-monitor ships a large `account_*` module set (personal-account API). It needs the user's DTEK login. That is out of scope for a public-schedule widget, but it is the only source of per-account "current outage" details beyond the site.

---

## 5. Recommendation for Kyiv city

Two constraints decide it:

- **(A)** the periodic refresh must survive unattended, without a captcha;
- **(B)** the one-time setup wants complete, enumerable street and house lists, because the wizard filters client-side.

| Option | (A) refresh | (B) setup | Current outage / multi-line | Effort |
|---|---|---|---|---|
| **1. DTEK-KEM only** (clone the KREM provider, fixed city) | same model as KREM today. A routine refresh is one in-page `getHomeNum` POST on the kept-loaded page. A captcha can hit only when the page must (re)load: first start, `incap_ses` expiry, or the reload-and-retry in `homeNum()`. 2/3 hidden-Electron loads passed, and Wayback shows heavy challenging | ✔ full lists, same wizard | ✔ same as KREM (`type/sub_type`, `sub_type_reason` lines) | **small** (the script/session diffs plus the registration points in 1.5) |
| **2. YASNO only** | ✔ one plain JSON GET, no browser | ✘ search-only (min 3 chars, max 20): needs a search-style wizard or interface change | ✘ none (`EmergencyShutdowns` day status only) | medium (new provider + wizard change) |
| **3. Split: KEM for setup, YASNO for refresh** | ✔ refresh = YASNO `planned-outages[groupId]`; the KEM page is never needed again | ✔ full lists from KEM (a captcha at setup is acceptable, it runs once) | partial: lines come from KEM at setup time; no live current-outage from YASNO | medium (two sources in one provider; DTEK fallback logic if YASNO fails) |

**My recommendation:**

1. **Ship option 1 first.** A `dtek-kem` provider is almost a copy of `dtek-krem`: `listCities → ['м. Київ']`, `listStreets → DisconSchedule.streets`, `getHomeNum` with `city=''`, its own partition and allowed host. It reuses all parsing, the line logic and the current-outage logic, and the wizard does not change. Every piece of that was verified live today.
2. **Then make refresh captcha-free with YASNO** (option 3). The gain is removing the page-reload captchas (after a restart or session expiry), not a per-refresh one. `fetchSnapshot` for Kyiv reads `planned-outages` and picks `groupId` (`GPV19.1` → `"19.1"`). The DTEK page is used only for setup, and as a fallback when YASNO fails or returns `EmergencyShutdowns` (DTEK's per-house `type/sub_type` notice). This is safe because the group ids and the schedules matched 60/60 and address-for-address today.
3. Treat outage-data-ua only as an emergency fallback, if at all.
4. Do not pursue Kyiv Digital or KMDA.

Implementation gotchas: map YASNO `WaitingForSchedule` to no day or `unknown`, never all-`on`. Convert minute slots defensively, because boundaries may not be on the half hour. Group labels go up to `Черга 60.1`. Store `groupId`, never YASNO's numeric ids. House strings differ between sources, so don't cross-match houses by name.
