# DTEK schedules without a kept-open page: YASNO, the mirror, and the page as fallback

Date: 2026-10-22. Status: design.

## Intent

The widget holds about 250–300 MB of RAM. Most of it is the hidden DTEK page, which stays loaded for the app's whole life so that every 15-minute refresh can ask DTEK in-page:
- the page itself: about 98 MB;
- its share of the GPU process.

The user wants that memory back and does not want more DTEK verifications. Their words, after the options were laid out:

> «давай варіант б з фолбеком на ДТЕК 30хв і ясно в Києві. Але звір спочатку чи там дані правильні»

So:

- **Kyiv city** (`dtek-kem`) refreshes from the YASNO public API.
- **Other DTEK sites** refresh from the outage-data-ua mirror on GitHub, a plain-HTTP copy of DTEK's own schedule objects.
- **The DTEK page is a fallback** for both, opened at most once per 30 minutes.

**Verified before this design** (`docs/superpowers/research/2026-10-22-yasno/mirror-check.md`, README.md and `../2026-10-20-outage-sources/kyiv.md` §2.3):
- **The mirror** is an exact copy of `DisconSchedule.fact` and `preset.sch_names` for all four DTEK sites. Over the last 7 days it carried every DTEK update within 6–11 minutes.
- **YASNO** matches DTEK-KEM for 60 of 60 groups, half-hour for half-hour.
- **Group ids** are interchangeable: `GPV20.1` on DTEK is `20.1` on YASNO.

Calls that were mine, not the user's, are marked *(my call)*.

## Goals

- **No DTEK page between refreshes.** The page window exists only while it is in use, plus a short linger. A routine refresh opens no page.
- **Sources per site** (the «feeds»), tried in this order:

  | Site | Feeds, in order | Then |
  |---|---|---|
  | `dtek-kem` (Київ) | YASNO `regions/25/dsos/902/planned-outages`; mirror `kyiv` *(my call: the mirror as a second feed)* | DTEK page |
  | `dtek-krem` (Київська обл.) | mirror `kyiv-region` | DTEK page |
  | `dtek-dnem` (Дніпропетровська обл.) | mirror `dnipro` *(my call: the mirror, as for the other non-Kyiv sites)* | DTEK page |
  | `dtek-oem` (Одеська обл.) | mirror `odesa` | DTEK page |

- **The DTEK page is still used for:**
  - the setup wizard: cities, streets, houses, lines and the line preview. Unchanged: the wizard needs the full lists, which no feed has.
  - the **house check**: DTEK's per-house answer (`getHomeNum`) gives the house's lines and any current outage. No feed has those.
  - the **fallback**: when no feed gave a usable answer.
  - the verification (captcha) window, unchanged.
- **Page budget (user).** An automatic refresh opens the page at most **once per 30 minutes per site**. Using a page that is already open costs nothing. A page opened by the wizard or the verification counts as an open for the budget.
- **What the user sees.** Today's banners, the line-change warning, the emergency banner, the captcha banner and the «оновлено» footer stay as they are. The schedule simply comes from a feed most of the time.

## Non-goals

- No YASNO address lookup. Its search caps results at 20 and needs at least 3 letters, so the wizard keeps using the DTEK page.
- No YASNO for Dnipro. The user named YASNO for Kyiv only.
- No new settings, switches or UI to pick a source.
- No change to the 15-minute refresh interval, the jitter, the backoff, or the 5-minute floor of `scheduler.ts`.
- The non-DTEK providers (voe, loe, toe, mkoe, ztoe, cvoe, cek) are untouched.

## Anti-goals (a failure even if it «works»)

- **The wrong queue's schedule, shown silently.** A feed is looked up by the saved `groupId`. If DTEK moves the house to another queue, the feed keeps answering for the old one, so the daily house check exists to catch that.
- **A feed answer that is stale or not about today, shown as current.** An old mirror file must never render as today's schedule; neither must YASNO's `WaitingForSchedule` or a date mismatch.
- **A verification prompt the user did not need.** If a house check hits a verification but a feed answered, the refresh is `ok` and no captcha banner appears.
- **More DTEK page loads than today.** Today the page loads at start and after failures. Under this design it loads at most once per 30 min per site, and normally a few times a day.

## Behaviour

### A refresh: `DtekProvider.fetchSnapshot(address, previous)`

`previous` is the stored snapshot for the same address, or null. `RefreshService` passes it in. The interface gains the optional second parameter, and the other providers ignore it.

1. **House check due?** It is due when any of these holds:
   - there is no `previous`, or it has no `houseCheckedAt`;
   - `previous.houseCheckedAt` is not between 0 and 24 h ago *(my call: 24 h)*;
   - `previous.outageActive` is true. While the house has an outage, it is re-checked every refresh, which the budget limits to every 30 min.

   If it is due and the page is allowed, run today's page path. On success, the snapshot is exactly today's page snapshot plus `houseCheckedAt = now`. On any failure, including a verification, log it and go on to the feeds, without surfacing it yet. The one exception is a missing house past 48 h, which fails the refresh at once (see «Settled cases»).
2. **Feeds, in order.** The first usable answer wins. A feed that fails or is unusable is logged as a warning, and the next one is tried.
3. **YASNO says `EmergencyShutdowns` for today.** If the page has not been tried in this run and is allowed, use the page (step 1's path). That emergency is exactly when the per-house notice matters. If the page fails or is not allowed, go on to the next feed.
4. **No feed usable.** Three cases:
   - **The page was already tried in this run** (step 1 or 3) and failed: that page error is the refresh's error, as today. A verification gives the `captcha` phase.
   - **The page was not tried and is allowed:** use the page. Its errors surface the same way.
   - **The page was not tried and is not allowed:**
     - If `previous` exists and `now − previous.fetchedAt` lies in `[0, 30 min)` (the page budget), the refresh returns `previous` unchanged, with `fetchedAt` not renewed. It logs a warning: `<site>: no usable feed, the page is not due yet; keeping the last schedule`. The page's next turn comes before `previous` is 30 min old, so the schedule still refreshes from the page every 30 min, and no error banner shows in between.
     - Otherwise the refresh fails with **«Не вдалося отримати графік ДТЕК»**. It is a `NetworkError` (outcome `offline`) only when every feed failed for lack of a connection. Anything else is a `ProviderError` (outcome `failed`).

   With no feeds configured, every refresh is therefore exactly today's page refresh. The existing provider tests rely on that.

### A snapshot from a feed

- `days`, `sourceUpdatedAt`, `note` and `groupLabel` come from the feed.
- Carried unchanged from `previous`, when there is one: `lines`, `outageActive`, `currentOutage`, `houseCheckedAt`.
  - This keeps `lineChanged` true when the last house check found the saved queue gone.
  - It never invents a line change: with no `previous`, `lines` is `[{ index: address.lineIndex, groupId: address.groupId, label: groupLabel }]`.
  - A carried `currentOutage` must not outlive the house data behind it. The emergency banner ends at the outage's own `end` time. An outage without a readable `end` counts only while it is fresh, and `activeEmergency` measures that from `houseCheckedAt` when the snapshot has one, else from `fetchedAt`. A feed snapshot renews `fetchedAt` but not `houseCheckedAt`, so a house check that keeps failing cannot hold the widget at «Світла немає · час відновлення невідомий». Only the emergency uses `houseCheckedAt`; the widget's «stale» display stays keyed on `fetchedAt`.
- `fetchedAt` is now.
- `groupLabel` is the feed's own name for the queue (the mirror's `sch_names`), else `previous.groupLabel`, else `queueLabelFromId(groupId)`.

### The mirror feed

- **URL:** `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/<file>.json`.
- **Shape.** Required:
  - `lastUpdated` (ISO);
  - `fact.data` (object), `fact.update` (string), `fact.today` (number);
  - `preset.sch_names` (object).

  Anything else is unreadable.
- **Unusable** when:
  - `now − lastUpdated` exceeds **30 min**, or `lastUpdated` is in the future by more than 5 min *(my call; history: a run every 5 min, p99 gap 7 min, worst 18 min)*. On a failed run the mirror keeps its old data and does not move `lastUpdated`.
  - `kyivDateKey(fact.today × 1000)` is not today's Kyiv date. A file scraped before midnight is not today's answer.
  - the saved `groupId` is absent from a `fact.data` that has days. The queue may have been renamed, which the page reveals.
- **Days.** The exact code path of the page snapshot, so both read the same object the same way. Factor it out of `DtekProvider.fetchSnapshot` and share it:
  - `factToDays(fact, groupId)`;
  - a quiet today (`isQuietToday`) becomes 48 `on` slots plus `DTEK_QUIET_NOTE`;
  - unknown hour statuses are logged.
- `sourceUpdatedAt` is `fact.update`, as on the page.

### The YASNO feed (`dtek-kem`)

- **URL:** `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages`.
- **Key.** The response is keyed `"20.1"`. The saved `GPV20.1` maps to it by `/^GPV(\d+\.\d+)$/`. A groupId that does not match, or a key that is absent, makes the feed unusable.
- **Today.** `today.date` (ISO, local midnight with an offset) is read as an instant, and its Kyiv date must be today's. So `2026-10-21T21:00:00Z` is the 22nd. A date that is not an instant with its zone, or another day, makes the feed unusable.
- **Statuses:**
  - `ScheduleApplies`: the slots are converted.
  - `NoOutages`: 48 `on` slots plus `DTEK_QUIET_NOTE` *(my call: the same quiet-day rule the user chose for every source)*.
  - `EmergencyShutdowns`: unusable, flagged as emergency (step 3).
  - `WaitingForSchedule` or anything else: unusable.
- **Tomorrow:** included only when `tomorrow.status` is `ScheduleApplies` and `tomorrow.date`, read as an instant, is tomorrow's Kyiv date. Otherwise it is left out, as the page path leaves out a tomorrow with no schedule; an unreadable date leaves it out too.
- **Slot conversion.** Slots are minute ranges `[start, end)` within 0..1440. For each of the 48 half-hours:
  - `off` if any part of it is covered by a `Definite` range *(my call: when unsure, show the outage)*;
  - else `on` if it is covered by `NotPlanned`;
  - else `unknown`.

  A slot type other than those two counts as not covering its range. The conversion runs once per fetched body, when it is parsed and cached, and the body's unknown types are logged once as a count (`yasno: unknown slot types`, `{ count }`), never by name, since the names are response text.
- **`sourceUpdatedAt`:** that group's `updatedOn` in DTEK's own order, `dd.mm.yyyy HH:MM` in Kyiv time (`dtekStamp`), so the footer reads the same for every source. For example, `2026-10-21T17:45:03+00:00` becomes `21.10.2026 20:45`. It is omitted when `updatedOn` is not a valid date.
- **`groupLabel`:** none from YASNO, so the fallback chain above applies.

### Requests

- Feeds use the main-process `HttpFetch` (`electronHttp`) through `HttpSource`: a 20 s timeout, its offline / no-answer / HTTP-error texts, and one request at a time per feed.
- **Cache.** A feed keeps its last good parsed body for **2 minutes** *(my call)*, so two locations on one site, staggered 30 s, make one request. The cache is in memory only.
- **Failure texts.** A feed's own failure texts are only logged, never shown, so the user never sees «дзеркало» or «YASNO» in an error *(my call)*. The shown text is step 4's, or the page's own.
- **One log line per failed feed.** The feed's `HttpSource` logs nothing itself. The route logs the failure once, as a warning (`<site>: <feed> failed`), with `loggable`, which keeps the url and status cause.

### The page's life

- `PageSession` gains:
  - `isOpen(): boolean`: the window exists and is not destroyed;
  - `release(): void`: destroy the window but keep the session and its partition. The Imperva cookies persist in the partition, so the next load looks like a returning visitor. The session can open again afterwards, unlike with `dispose()`.

  `release()` does nothing while the verification window is showing.
- **Linger.** `DtekProvider` arms a **5-minute** linger timer *(my call: long enough for the wizard's steps)* after every page operation ends: a wizard list, a house check, a fallback or `showVerification`. The timer is cleared when a page operation starts and is never armed while one is still queued. When it fires, `release()` is called and the cached `fact` state is forgotten, so the next open reads it afresh.
- **Budget.** `DtekProvider` keeps `lastPageOpenAt` in memory per site. An automatic refresh may use the page when:
  - the page is open; or
  - `lastPageOpenAt` is null, or at least **30 min** ago.

  Opening the page records `lastPageOpenAt`. Wizard operations and `showVerification` open the page regardless and also record it.
  - The wizard's line preview calls `fetchSnapshot` with no `previous`, while the page is still open from the house list, so it gets the page's answer.
- `dispose()` at app quit is unchanged.

### Settled cases *(my calls, from the builder check)*

- **All refreshes obey the budget.** `fetchSnapshot` cannot tell a manual refresh («Оновити», the refresh after a verification) from an automatic one, and none is threaded through. This applies to the wizard's line preview too. A refresh that lands inside the budget window with the page closed is answered by a feed, which is at most about 11 minutes behind DTEK.
  - After a verification the page is still open, so the refresh that follows uses it for free.
  - In the wizard the page is normally still open from the house list. If the preview falls to a feed, it is still right: the feed holds every queue, and the queue id came from the page moments earlier.
- **A page open counts toward the budget whether or not it succeeds**, including a verification or a timeout. Otherwise a site behind a verification would reopen the page on every refresh.
- **A failed house check does not move `houseCheckedAt`.** The check stays due, and the budget limits it to one page open per 30 minutes per site. That is no more often than today's failing-captcha path, which reloads on every retry.
  - With no `previous`, for example the first refresh after the address was picked or changed, the check is due on every refresh until one succeeds. It is not 24 h away.
- **A house check that keeps failing while the feeds answer stays silent**, except for a missing house (next item). It is logged as a warning on every attempt, but there is no banner. Surfacing it would mean failing the refresh, and the schedule would then stop updating just to force a verification. The queue-change check is degraded until a page load succeeds. This is accepted.
- **A house check that finds the house missing** («Будинок не знайдено у відповіді ДТЕК»: the page answered, but DTEK renamed or removed the house) is an `AddressNotFoundError`. When `previous.houseCheckedAt` is missing, unreadable, or more than **48 h** old (`HOUSE_MISSING_SURFACE_MS`), the refresh fails with that error at once, without asking the feeds: the address needs re-picking. A stamp in the future (a clock set back) is none of these, so it stays silent. Otherwise it stays silent as above (a warning and the feed's answer), so a DTEK glitch shorter than two days shows no banner.
- **A feed outage between page opens shows no banner.** When no feed is usable and only the budget refuses the page, a `previous` fetched less than 30 min ago is returned unchanged (step 4). The page's error, once it is tried and fails, still surfaces, a verification included.
  - The cost: a feed outage hides for up to 30 min, and being offline is not surfaced while `previous` is fresh. The network banner never shows for a fresh snapshot anyway.
- **Several locations on one site** share the site's budget and its open page, while each location keeps its own `houseCheckedAt`. The boot stagger (30 s) is well inside the linger (5 min), so one page open serves all of them.

### Data

- `ScheduleSnapshot` gains the optional `houseCheckedAt?: string` (ISO). It is set only by the DTEK page path. `snapshots.json` needs no migration: a snapshot from the old build has no `houseCheckedAt`, so its first refresh does a house check.

## Constraints

- Electron 44, TypeScript, vitest. Follow the existing provider style: `HttpSource`, `ProviderError` / `NetworkError`, and log causes that never carry body text.
- The tests must not touch the network. Fixtures are trimmed copies of the samples in `docs/superpowers/research/2026-10-22-yasno/`, plus a mirror file built from today's live check.
- Live smoke checks run only in a hidden window with a throwaway profile, and never touch the user's app data.
  - `smoke-dtek` must show both paths: a snapshot from a feed, given a fresh `previous`, and one from the page.
  - It must also show that the page window is gone after the linger. The smoke may pass a short linger.

## Left to the builder

- File layout under `src/main/providers/dtek/`, for example `feeds.ts`, `yasno.ts` and `mirror.ts`. Also the names of the shared days helper and of the feed interface.
- How the linger timer and the clock are injected for tests.
- The log wording, in the style of the existing `dtek-…` log lines.

## Expected effect

Between refreshes there is no DTEK page renderer. The hidden page and most of its GPU share go, which is about 100 MB or more of the 250–300 MB. The page still appears for a minute or so:
- once a day per site, for the house check;
- in the wizard;
- for a fallback.
