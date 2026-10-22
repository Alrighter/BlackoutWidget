# YASNO public API as a replacement for the hidden DTEK Kyiv page

Research date: 2026-10-22 (about 01:20 Kyiv time). Plain HTTP only, about 35 requests, at least 1.2 s apart, one public address (вул. Хрещатик).

Legend: **[LIVE]** fetched today by me. **[READ]** only read about (source code or GitHub issues, not re-checked live).

All endpoints are under `https://app.yasno.ua/api/blackout-service/public/shutdowns` (called `$B` below). The URL list comes from the constants file of the Home Assistant integration `denysdovhan/ha-yasno-outages` [READ]. Every URL below was then called by me [LIVE], except where stated.

## 1. Endpoints

All are `GET`, JSON, no auth. Samples sit next to this file.

| # | Purpose | URL | Params |
|---|---|---|---|
| 1 | Regions and DSOs | `$B/addresses/v2/regions` | none |
| 2 | Cities (only regions with `hasCities:true`, e.g. Dnipro) | `$B/addresses/v2/cities` | `regionId`, `dsoId`, `query` |
| 3 | Streets | `$B/addresses/v2/streets` | `regionId`, `dsoId`, `query` (substring, Cyrillic, URL-encoded). A city id parameter for Dnipro was not tested. |
| 4 | Houses | `$B/addresses/v2/houses` | `regionId`, `dsoId`, `streetId`, `query` (house number prefix) |
| 5 | House to group | `$B/addresses/v2/group` | `regionId`, `dsoId`, `streetId`, `houseId` |
| 6 | Planned schedule, today and tomorrow, all groups at once | `$B/regions/{regionId}/dsos/{dsoId}/planned-outages` | path params only |
| 7 | Typical (probable) weekly schedule | `$B/probable-outages` | `regionId`, `dsoId` |

Details and examples (a Kyiv house is region 25, DSO 902):

1. **Regions** [LIVE]. `GET $B/addresses/v2/regions` returns an array: `[{"hasCities":false,"dsos":[{"id":902,"name":"ПРАТ «ДТЕК КИЇВСЬКІ ЕЛЕКТРОМЕРЕЖІ»"}],"id":25,"value":"Київ"}, ...]`. Sample: `regions.json`. Cache-Control is `max-age=300, public`.
2. **Cities** [LIVE, my guess at the path, it worked]. `GET $B/addresses/v2/cities?regionId=3&dsoId=301&query=<Дніпро>` returns `[{"id":6,"value":"м. Дніпро"}, ...]`. I did not find out how a city id is passed to the street search. The Kyiv street search works without one.
3. **Streets** [LIVE]. `GET $B/addresses/v2/streets?regionId=25&dsoId=902&query=%D0%A5%D1%80%D0%B5%D1%89%D0%B0%D1%82%D0%B8%D0%BA` returns `[{"id":947,"value":"вул. Хрещатик"}]`. Sample: `streets-kyiv-khreshchatyk.json`. With no match the result is `[]`. A missing `query` also gave `[]`.
4. **Houses** [LIVE]. `GET $B/addresses/v2/houses?regionId=25&dsoId=902&streetId=947&query=22` returns `[{"id":48858,"value":"20-22"},{"id":45227,"value":"20-22П/П-С"},{"id":46625,"value":"22"}]`. Sample: `houses-kyiv-khreshchatyk-22.json`.
5. **Group** [LIVE]. `GET $B/addresses/v2/group?regionId=25&dsoId=902&streetId=947&houseId=46625` returns `{"group":20,"subgroup":1}`. The queue name is `"{group}.{subgroup}"`, here `20.1`. Sample: `group-kyiv-khreshchatyk-22.json`. A stale id gives `404 {"title":"EntryNotFoundException","code":"EntryNotFound","detail":"House … not found in RegionId 25 and DsoId 902 and StreetId …"}` [READ, GitHub issues #165 and #166].
6. **Planned outages** [LIVE]. `GET $B/regions/25/dsos/902/planned-outages` returns an object keyed by group name, 60 keys `"1.1"`..`"60.1"` for Kyiv, 26 KB in total:
   ```json
   {"20.1":{
     "today":{"slots":[{"start":0,"end":540,"type":"NotPlanned"},{"start":540,"end":750,"type":"Definite"}, ...],
              "date":"2026-10-22T00:00:00+03:00","status":"ScheduleApplies"},
     "tomorrow":{"slots":[],"date":"2026-10-23T00:00:00+03:00","status":"WaitingForSchedule"},
     "updatedOn":"2026-10-21T17:45:03+00:00"}}
   ```
   Samples: `planned-outages-kyiv-902.sample.json` (3 of 60 groups), `planned-outages-dnipro-301.sample.json`. A wrong region/DSO pair (26/1) returned a `500 InvalidOperationException` (`code:"UnknownError"`).
7. **Probable outages** [LIVE]. `GET $B/probable-outages?regionId=25&dsoId=902` returns `{"25":{"dsos":{"902":{"groups":{"20.1":{"slots":{"0":[{"start":0,"end":1440,"type":"NotPlanned"}], ...,"6":[...]}}}}}}}`. The keys `0`..`6` are weekdays, 0 = Monday (per the integration's code [READ]). **Today every one of the 60 Kyiv groups is `NotPlanned` all day, every weekday**, so this endpoint carries no useful data for Kyiv right now. Sample: `probable-outages-kyiv.sample.json`.

**Current or emergency outage info.** There is no separate endpoint that I could find. The only signal is the per-day `status` field in endpoint 6. The integration's constants list the values `ScheduleApplies`, `NoOutages`, `WaitingForSchedule` and `EmergencyShutdowns` [READ]. I saw the first three live. I never saw `EmergencyShutdowns`, so what `slots` contains in that state is unverified. There is no live "outage at this address now" data, no restoration ETA, and no per-house outage list.

## 2. Coverage [LIVE]

The regions endpoint returns exactly two regions today:

| Region | id | DSOs |
|---|---|---|
| Київ | 25 | 902 ПРАТ «ДТЕК КИЇВСЬКІ ЕЛЕКТРОМЕРЕЖІ» |
| Дніпро | 3 | 301 ДнЕМ, 303 ЦЕК |

- **Kyiv city: yes**, DSO 902 is DTEK Kyiv Electric Networks (the `dtek-kem` provider).
- **Kyiv oblast (DTEK KREM, `dtek-krem`): no.** There is no such region or DSO. A community project, `NetZhizni/ha-dtek-krem-outages`, exists separately for that provider [READ].
- **Dnipro: yes**, two DSOs (ДнЕМ 301 and ЦЕК 303). The integration's own doc and the repo's `dnipro` / `dniprocek` proxies suggest YASNO is the supplier there too [READ].
- **Odesa: no.** It is not in the list. It was not probed in any other way.
- Street search with DSO 303 and a Kyiv street returned `[]`, so the DSO id is required to match the address.

Dnipro: the planned-outages payload for 301 and 303 is byte-identical today (12 groups `1.1, 1.2 ... 6.2`, all `NoOutages`). It is probably one shared Dnipro schedule, or both are currently empty. This is not proven.

## 3. Groups

- **Naming.** YASNO uses `"<group>.<subgroup>"`, e.g. `20.1`. Dnipro has 12 groups: 1..6 with subgroups 1 and 2. [LIVE]
- **Kyiv has 60 groups, `1.1`..`60.1`, all with subgroup `1`.** [LIVE] This matches the reported 60-group Kyiv scheme since 29 Jan 2026 (GPV1.1..GPV60.1). The naming looks 1:1 with DTEK's `GPV<n>.1` ids, so `GPV20.1` would be `20.1`. **This was NOT compared against DTEK**, see below.
- **Real addresses, YASNO side only** [LIVE]:

  | Address | houseId | YASNO group |
  |---|---|---|
  | вул. Хрещатик, 1 | 47477 | 19.1 |
  | вул. Хрещатик, 1/2 | 46232 | 19.1 |
  | вул. Хрещатик, 10 | 17595 | 20.1 |
  | вул. Хрещатик, 20-22 | 48858 | 20.1 |
  | вул. Хрещатик, 22 | 46625 | 20.1 |

  The results are plausible (neighbouring buildings fall into the same or adjacent queues), but nothing verifies them.
- **Already verified on 2026-10-20** (`../2026-10-20-outage-sources/kyiv.md` §2.3, found after this note was written): YASNO `today` matched the live DTEK-KEM `fact` for 60/60 groups, half-hour for half-hour, and 8 Khreshchatyk houses gave the same group on both sides (`GPV{n}.{m}` ↔ `"{n}.{m}"`). House and street strings differ between the two sources, so only the group id carries over. The rest of this bullet is what this run could check on its own.
- **Could not compare with DTEK.** The DTEK page needs a browser and its Imperva wall, which I was told not to beat. So there is no live DTEK `GPV` for these houses. I also found no stored DTEK Chrome output in the repo that names Khreshchatyk. **Mapping YASNO group n to DTEK `GPVn.1` is an unverified assumption.** It must be checked before switching, using the app's existing hidden page on a handful of addresses (suggestion: 5 to 10 houses, and compare both the group id and today's slots).
- **Schedule structure is tiled.** Today the 60 Kyiv groups collapse into 14 distinct "today" patterns. Groups `n`, `n+12`, `n+24`, `n+36`, `n+48` have the same slots for n = 1..12, apart from a few that differ in the 00:00-00:30 or 23:30-24:00 edge slots (15.1 and 27.1, 17.1 and 29.1). That is consistent with a rotation scheme. DTEK's own data may be finer. This is a good thing to compare with DTEK's today and tomorrow slots.
- **House ids are unstable** [READ, GitHub issues #124, #165, #166 of `ha-yasno-outages`]. A user reports that YASNO renumbers its internal street and house ids "every few days", after which the saved `houseId` returns 404. The group itself did not change. So: store the group (and the address text), not the ids, and re-resolve through street then house lookup when needed.

## 4. Schedule format [LIVE unless marked]

- **Slots** are ranges in **minutes from local midnight**, `start` inclusive, `end` exclusive, `0..1440`. In practice the values are multiples of 30 (half-hour grid), but nothing in the format forces it.
- `type` is `Definite` (a planned outage) or `NotPlanned` (power expected). I saw no other types; a third type for "possible" outage was not seen in today's data (the integration's enum only has these two [READ]). A day's slots tile the whole day: `NotPlanned` ranges are given explicitly, not implied. Example, group 20.1: `0-540 NotPlanned, 540-750 Definite, 750-1080 NotPlanned, 1080-1290 Definite, 1290-1440 NotPlanned` i.e. outages 09:00-12:30 and 18:00-21:30.
- **Timezone.** `date` is an ISO string with the `+03:00` offset (Europe/Kyiv in summer time), at local midnight. Minutes are local wall-clock minutes of that date. On a DST change day a day is 23 or 25 hours long, but the slots still use 0..1440 (not tested; the next change is 2026-10-25).
- **Statuses per day** (`today.status`, `tomorrow.status`):
  - Kyiv today: `ScheduleApplies` for all 60 groups.
  - Kyiv tomorrow: `WaitingForSchedule` for all 60, with `slots: []`. This is the state before the evening publication.
  - Dnipro today: `NoOutages` with `slots: []`. This is how a quiet day looks (no slots at all, not a single `NotPlanned` range).
- **"Tomorrow"** is the key `tomorrow`, with `date` being the next calendar day. Do not assume it is filled: until it is published it is `WaitingForSchedule` and empty. No evening publication time was observed (I looked once, at about 01:20).
- **`updatedOn`** is one timestamp per group, ISO with offset `+00:00`. Kyiv: `2026-10-21T17:45:03+00:00` (20:45 Kyiv time, the same for all 60 groups). Dnipro: `2026-10-22T00:00:00+00:00`, which looks like a midnight reset, not a real publish time. Note that it is a UTC-offset string while `date` is `+03:00`.
- Cache: `Cache-Control: max-age=300, public`, so the data can be at most about 5 minutes stale at the CDN, plus the time until YASNO's backend updates.

## 5. Access

- **Auth: none.** No key, no cookie needed. [LIVE]
- **Headers.** It worked with `User-Agent: Mozilla/5.0`, with an empty User-Agent (`curl -A ""`), and with Node's built-in `fetch` default headers. So no UA requirement was seen. `Accept: application/json` is harmless.
- **CORS.** A request with `Origin: https://example.com` returned 200, but I saw no `Access-Control-Allow-Origin` header in any response. That does not matter for the Electron main process (node fetch), but a renderer-side `fetch` would be blocked. Use the main process.
- **Bot protection.** The host is behind **Imperva** (`X-CDN: Imperva`, `incap_ses_*` and `visid_incap_*` cookies, `_Incapsula_Resource` script on the 404 page). Unlike DTEK's page, it **did not challenge plain HTTP clients** (curl, node fetch, no cookies kept) in about 35 requests. This could change at any time, e.g. if Imperva rules tighten; a JS challenge would break this approach just as it does for DTEK.
- **Rate limits.** None hit at 1.2 s spacing. No `Retry-After` or rate-limit headers were seen. Not stress-tested. The 5-minute public cache means polling more often than every 5 minutes gains nothing. 15 minutes is reasonable.
- **Terms and licence.** I did not find any API terms, licence, or developer documentation. The API is undocumented: it is the backend of the YASNO web app and mobile apps. `https://yasno.ua/robots.txt` says `Disallow: /api/` (that is the main site, the API lives on `app.yasno.ua`, whose `robots.txt` returns 404). Treat it as "tolerated, not granted". The response headers expose `Ios-Target-Version`, `Android-Target-Version` and a `backend-version` git hash: it is a private app backend.
- **Errors** use `application/problem+json`, with `title`, `status`, `detail`, `code`, `traceId`. Missing path gives `404 EntryNotFound`, bad region/DSO pair for planned-outages gives a `500`.

## 6. Prior art

[READ] via GitHub API and raw sources.

- **`denysdovhan/ha-yasno-outages`**, MIT, 194 stars, last push 2026-10-01, latest release v3.1.4 (2026-08-18), not archived. The reference client. Uses exactly the endpoints above, no auth, no special headers (plain aiohttp). Open issues: **#165 and #166 (Oct 2026): address-based entries break repeatedly because YASNO changes street and house ids**; it also had to add `NoOutages` handling in March 2026 (#127, #133, #134, "unknown" state when the schedule is empty) and a "Sumy fix" PR (#164). Takeaway: the field values have evolved (new statuses appeared) and ids are not stable, but the planned-outages shape has stayed stable over at least 8 months of history.
- `fastiuk/ukraine-energy-monitor` (MIT, pushed 2026-10-21): Home Assistant integration for all oblasts; `fastiuk/ukraine-energy-monitor-status` publishes an hourly check of the sources. Not read in detail.
- `gzoreslav/electricityoff-api-kem`, `-dnipro`, `-dniprocek` (no licence, 2026-10-07): proxies for Kyiv (KEM) and Dnipro "via Yasno". Not read in detail.
- `playsi/Yasno-telegram-bot` (MIT, 2026-10-20), `jenkokov/yasno-bot` (Apache-2.0, 2025-11), `ayaromenok/PowerGridKiev_Monitor` (MIT, 2026-10-20), `akrava/outage-stats` (Kyiv heatmaps by group). Names and descriptions only; not read.
- I found nothing official from YASNO about stability, versioning, or a deprecation policy.

## Recommendation

**Can YASNO replace the hidden DTEK page for Kyiv city?** Technically yes, as the data source for the schedule, and subject to one check I could not do.

- **Use for:** `dtek-kem`. One call (`planned-outages` for 25/902) returns all 60 groups for today and tomorrow in 26 KB, no browser, no cookies, no UA tricks. That would free the 70-100 MB hidden page for Kyiv city. Dnipro (regions 3, DSOs 301 and 303) could become a new source for free, using the same code with 12 groups `n.1`/`n.2`.
- **Not a replacement for:** `dtek-krem` (Kyiv oblast) and Odesa, which are not covered. Any DTEK page still needed for them keeps the hidden-browser cost.
- **Before switching, verify (not done here):** (a) YASNO `n.1` equals DTEK `GPVn.1` for 5 to 10 real addresses, and the slots match DTEK's for the same day; (b) the same group is returned for a house that the user picked in the DTEK UI; (c) what `EmergencyShutdowns` looks like; (d) when tomorrow is published and whether its slots ever carry a "possible" type.

**Risks**
1. **Undocumented private API**, no terms, no licence, no stability promise. It can change shape or disappear. Keep strict parsing with a fallback to the old hidden page (kept optional, off by default) for a release or two.
2. **Imperva** fronts the host. Plain HTTP passes today; a stricter rule would block it like DTEK's page. Cache the last snapshot and degrade gracefully.
3. **House/street ids are unstable** (the main problem found by the community). Store the resolved group `n.1` and the address text. Re-resolve by text only when the user edits the address, and never fail hard on a 404 from `/group`.
4. **Group mapping with DTEK is unverified**, and YASNO appears to publish tiled patterns. If YASNO's slots are rounded or simplified relative to DTEK's, the widget would show slightly different times than DTEK's site. Also YASNO has no live outage / emergency / ETA data, so any "outage right now" feature that DTEK's page provides will be lost for Kyiv.
5. **Latency of updates.** The 5-minute CDN cache plus YASNO's own publication delay. Tomorrow stays empty until published (`WaitingForSchedule`), which the UI must handle as "not published yet", not as "no outages".
