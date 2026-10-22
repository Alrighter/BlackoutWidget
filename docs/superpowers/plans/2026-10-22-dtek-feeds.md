# DTEK Feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DTEK schedules refresh from plain-HTTP feeds (YASNO for Kyiv city, the outage-data-ua mirror for the other sites). The DTEK page opens only for the wizard, a daily house check and the fallback (at most once per 30 min per site), and closes after a 5-minute linger.

**Architecture:**
- **Feeds.** A feed (`ScheduleFeed`) answers «the days of queue X» from one HTTP JSON file. It says unusable when the file is stale or not about today.
- **Routing.** `DtekProvider.fetchSnapshot(address, previous)` decides between the page (house check, fallback) and the feeds, from the stored snapshot's `houseCheckedAt`, a per-site page budget and the feeds' answers.
- **Page lifetime.** `BrowserSession` can `release()` its window without being disposed, and `DtekProvider` releases it after a linger.

**Tech Stack:** Electron 44, TypeScript, vitest (jsdom), electron-vite.

**Spec:** `docs/superpowers/specs/2026-10-22-dtek-feeds-design.md`. Research: `docs/superpowers/research/2026-10-22-yasno/` (README.md, mirror-check.md).

## Global Constraints

- Branch: `perf/memory` (it holds the other memory work). Commit after each task. Commit messages are a subject and a body only, with **no `Co-Authored-By` trailer and no Claude attribution line**.
- Tests never touch the network. Fixtures in `tests/fixtures/dtek-feeds/` (already committed):
  - `mirror-kyiv-region.json`: the live mirror file, trimmed. `lastUpdated` 2026-10-21T22:25:57.083Z, `fact.today` 1792616400 (2026-10-22 Kyiv), `fact.update` «21.10.2026 19:20», 12 groups.
  - `yasno-kyiv.json`: live YASNO planned-outages for groups `1.1`, `19.1`, `20.1`, `60.1`. Today is 2026-10-22, `ScheduleApplies`. Tomorrow is `WaitingForSchedule`. `updatedOn` 2026-10-21T17:45:03+00:00.
  - `dtek-kem-fact.json`: `{ readAt, fact, schNames }`, the live DTEK-KEM fact read at the same moment, for `GPV1.1`, `GPV19.1`, `GPV20.1` and `GPV60.1`.
- Exact values:
  - `PAGE_GAP_MS = 30 * 60_000`, `PAGE_LINGER_MS = 5 * 60_000`, `HOUSE_CHECK_MS = 24 * 60 * 60_000`;
  - `MIRROR_MAX_AGE_MS = 30 * 60_000`, `MIRROR_FUTURE_SLACK_MS = 5 * 60_000`, `FEED_CACHE_MS = 2 * 60_000`;
  - `FEEDS_FAILED_TEXT = 'Не вдалося отримати графік ДТЕК'`.
- URLs:
  - mirror `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/<file>.json`, where `<file>` is `kyiv`, `kyiv-region`, `dnipro` or `odesa`;
  - YASNO `https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages`.
- Feeds per site, in order:
  - `dtek-kem`: YASNO, then mirror `kyiv`;
  - `dtek-krem`: mirror `kyiv-region`;
  - `dtek-dnem`: mirror `dnipro`;
  - `dtek-oem`: mirror `odesa`.
- A quiet today reuses `DTEK_QUIET_NOTE` (`dtek/parse.ts`). Feed error texts are only logged and never shown: the user sees `FEEDS_FAILED_TEXT` or the page's own error.
- Log causes never carry a response body. Use `loggable()` and `ProviderError` causes with a url, a status or a fixed reason only.
- Live smokes:
  - only `out/main/smoke-dtek.js`, in its hidden window with its throwaway profile (`makeSmokeProfile`);
  - never the installed app, never `%APPDATA%\Blackout Widget`, never a visible window;
  - build with `npx electron-vite build` first;
  - no Cyrillic in shell command literals.
- Done means `npx vitest run` is all green and `npm run typecheck` is clean. The baseline on `perf/memory` is 1565 passing tests.

## Review Focus

1. **Midnight.** A mirror file scraped before midnight and read after it has yesterday's `fact.today`, so it is unusable and the refresh falls back. It must never render as today. (Task 2 test «mirror scraped before midnight».)
2. **The DST change on 2026-10-25.** YASNO's tomorrow on 25.10 is dated `2026-10-26T00:00:00+02:00`. Dates are compared by their first 10 characters against the Kyiv date key, so it still counts as tomorrow. (Task 2 test «DST tomorrow».)
3. **An Imperva or HTML body instead of JSON** from a feed is an unreadable `ProviderError`, not a crash and not `NetworkError`, and the next feed is tried. (Task 2 test «HTML body».)
4. **The house moved to another queue.** A house check whose lines lack the saved queue leaves `lineChanged` true. Later feed snapshots carry those lines, so the warning stays. (Task 4 test «carried lines keep a line change».)
5. **Two locations on one site.** The second location's house check reuses the page that the first one opened, inside the linger, without a second open and without hitting the budget. (Task 4 test «two locations, one open».)

---

### Task 1: Shared fact-to-days helper, `houseCheckedAt`, and `previous` through the refresh

**Files:**
- Modify: `src/main/providers/dtek/parse.ts` (add `factDays`)
- Modify: `src/main/providers/dtek/index.ts:68-80` (use `factDays`)
- Modify: `src/shared/types.ts:15-23` (`ScheduleSnapshot.houseCheckedAt?: string`)
- Modify: `src/main/providers/types.ts` (`fetchSnapshot(address: Address, previous?: ScheduleSnapshot | null)`)
- Modify: `src/main/refresh.ts:84` (pass `previous`)
- Test: `tests/providers/dtek-parse.test.ts`, `tests/main/refresh.test.ts`

**Interfaces:**
- Produces:
  - `factDays(fact: DtekFact, groupId: string, todayKey: string, onUnknownStatus?: (status: string) => void): { days: DaySchedule[]; note?: string }`. It does what `DtekProvider.fetchSnapshot` does today: `factToDays`, and a quiet today (`isQuietToday`) becomes 48 `'on'` slots for `todayKey`, sorted in with the other days, plus `note: DTEK_QUIET_NOTE`.
  - `ScheduleProvider.fetchSnapshot(address, previous?)`.
  - `ScheduleSnapshot.houseCheckedAt?: string`.
- `RefreshService` passes the stored snapshot as `previous` when `sameAddress(stored.address, address)`, else `null`.

- [ ] **Step 1: Write the failing tests**
  - `dtek-parse.test.ts` «factDays: a quiet today is 48 on slots plus the quiet note». Use the fact `{ data: {}, update: '17.10.2026 09:55', today: 1792616400 }`, group `GPV1.1`, today `2026-10-22`. Expect `days` to be `[{ date: '2026-10-22', slots: Array(48).fill('on') }]` and `note` to be `DTEK_QUIET_NOTE`.
  - `dtek-parse.test.ts` «factDays: a published today is factToDays as is». Use the `mirror-kyiv-region.json` fact, group `GPV1.1`, today `2026-10-22`. Expect `days` to equal `factToDays(fact, 'GPV1.1')` and `note` to be undefined.
  - `refresh.test.ts` «passes the stored snapshot of the same address as previous». Store a snapshot for the location's address, refresh, and expect `fetchSnapshot` to have been called with `(address, storedSnapshot)`.
  - `refresh.test.ts` «passes null when the stored snapshot is another address's». The stored snapshot has a different `house`. Expect the second argument to be `null`.
- [ ] **Step 2: Run them to verify they fail.** Run `npx vitest run tests/providers/dtek-parse.test.ts tests/main/refresh.test.ts`. Expected: the new tests FAIL (`factDays` is not exported; `fetchSnapshot` is called with one argument).
- [ ] **Step 3: Implement.** Add `factDays` and make `DtekProvider.fetchSnapshot` use it. Behaviour is unchanged: every existing `dtek-provider.test.ts` test passes untouched. Add the optional field and the parameter, and pass `previous` in `RefreshService.doRefresh`.
- [ ] **Step 4: Run the whole suite.** Run `npx vitest run`, then typecheck. Expected: all PASS.
- [ ] **Step 5: Commit.** Message: «DTEK: a shared fact-to-days helper; the refresh hands the provider its previous snapshot».

### Task 2: The feeds — the mirror and YASNO

**Files:**
- Create: `src/main/providers/dtek/feeds.ts` (the interface, the result type, the cache, `mirrorFeed`, `yasnoFeed`). The builder may split it into `mirror.ts` and `yasno.ts`.
- Test: `tests/providers/dtek-feeds.test.ts`

**Interfaces:**
- Consumes: `factDays` (Task 1); `HttpSource` and `sourceTexts` (`../http-source`); `HttpFetch`; `Logger`; `kyivDateKey`, `addDays` and `kyivStamp` (`src/shared/time.ts`); `isObj` and `instant` (`../shape`).
- Produces:
  ```ts
  export interface FeedAnswer { days: DaySchedule[]; sourceUpdatedAt?: string; note?: string; groupLabel?: string }
  export type FeedResult = { usable: true; answer: FeedAnswer } | { usable: false; reason: string; emergency?: boolean };
  /** One HTTP JSON copy of a DTEK site's schedule for every queue. Request or shape failures throw ProviderError / NetworkError. */
  export interface ScheduleFeed { readonly tag: string; read(groupId: string, now: Date): Promise<FeedResult> }
  export interface FeedDeps { fetch: HttpFetch; isOnline: () => boolean; log: Logger; clock?: () => number }
  export function mirrorFeed(file: 'kyiv' | 'kyiv-region' | 'dnipro' | 'odesa', deps: FeedDeps): ScheduleFeed; // tag `mirror ${file}`
  export function yasnoFeed(deps: FeedDeps): ScheduleFeed; // tag 'yasno'
  ```
  The constants from Global Constraints are exported from this file.
- **Cache.** Each feed keeps its last successfully parsed body for `FEED_CACHE_MS`, measured by `clock` (default `Date.now`). A failed request or an unreadable body is not cached. Usability is judged on every `read` with that call's `now`.

- [ ] **Step 1: Write the failing tests.** Each one names its assertion. `now` is passed explicitly. The fetch is a `vi.fn` returning `{ ok, status, text, arrayBuffer }`.

  *Mirror* (fixture `mirror-kyiv-region.json`, `now = 2026-10-21T22:35:00Z`):
  - «mirror: usable copy». `read('GPV1.1', now)` is usable. `answer.days` equals `factDays(fixture.fact, 'GPV1.1', '2026-10-22').days`, `sourceUpdatedAt` is `'21.10.2026 19:20'` and `groupLabel` is `fixture.preset.sch_names['GPV1.1']`. The fetch was called once, with the `kyiv-region` URL and `method: 'GET'`.
  - «mirror: stale after 30 min». At `lastUpdated + 31 min` (with `fact.today` still the 22nd) the result is `usable: false`. At `lastUpdated + 29 min` it is usable.
  - «mirror: lastUpdated in the future». At `lastUpdated − 6 min` the result is unusable. At `lastUpdated − 4 min` it is usable.
  - «mirror scraped before midnight». Use a copy with `fact.today = 1792530000` (2026-10-21) and `lastUpdated = now − 5 min`. The result is unusable.
  - «mirror: queue absent». `read('GPV9.9', now)` is unusable.
  - «mirror: quiet day». A copy with `fact.data = {}` is usable, with 48 `'on'` slots for 2026-10-22 and `note === DTEK_QUIET_NOTE`.
  - «mirror: unreadable shapes». Three copies: no `lastUpdated`; `fact.data` an array; no `preset.sch_names`. Each rejects with `ProviderError`, not `NetworkError`.
  - «HTML body». The text is `'<html>Incapsula</html>'`. It rejects with `ProviderError`, not `NetworkError`.
  - «HTTP 500». It rejects with `ProviderError`.
  - «fetch throws while offline». With `isOnline` returning false, it rejects with `NetworkError`.
  - «cache». Two reads 60 s apart (by `clock`) make one fetch. A read 121 s later makes a second fetch. A failed fetch followed by a read makes a new fetch.

  *YASNO* (fixtures `yasno-kyiv.json` and `dtek-kem-fact.json`, `now = 2026-10-21T22:36:00Z`):
  - «yasno equals DTEK-KEM». For each of `1.1`, `19.1`, `20.1` and `60.1`, `read('GPV' + k, now)` is usable. `answer.days` equals `factToDays(kemFact, 'GPV' + k)`, which is one day: tomorrow is `WaitingForSchedule` and so is left out. `sourceUpdatedAt` is `'20:45 21.10.2026'`.
  - «yasno: groupId mapping». `read('20.1', now)`, `read('none', now)` and `read('GPV99.1', now)` are unusable.
  - «yasno: statuses». Today `NoOutages` with empty slots gives 48 `'on'` plus `DTEK_QUIET_NOTE`. Today `EmergencyShutdowns` gives `{ usable: false, emergency: true }`. Today `WaitingForSchedule` is unusable.
  - «yasno: today's date must be today». `today.date '2026-10-21T00:00:00+03:00'` is unusable.
  - «yasno: tomorrow». Tomorrow `ScheduleApplies` dated `2026-10-23T00:00:00+03:00` is included as the second day. Dated `2026-10-24…` it is left out.
  - «DST tomorrow». Now is `2026-10-25T09:00:00Z`, today is dated `2026-10-25T00:00:00+03:00` and tomorrow `2026-10-26T00:00:00+02:00` (`ScheduleApplies`). Both days are present, with keys `2026-10-25` and `2026-10-26`.
  - «yasno: slot conversion»:
    - `Definite 0–45` and `NotPlanned 45–1440` give `off` for slots 0–1 and `on` for slots 2–47;
    - a gap at 600–660 (no slot covers it) gives `unknown` for slots 20–21;
    - a slot typed `'Possible'` gives `unknown` over its range, and `log.warn` was called.
  - «yasno: unreadable». A body of `[]`, and an entry whose `today.slots` is not an array, each reject with `ProviderError`.
- [ ] **Step 2: Run them to verify they fail.** Run `npx vitest run tests/providers/dtek-feeds.test.ts`. Expected: FAIL (the module does not exist).
- [ ] **Step 3: Implement `feeds.ts`.**
  - Each feed owns one `HttpSource`. Its tag is the feed tag and its texts are `sourceTexts('джерела графіків ДТЕК')`. Those texts are only logged.
  - Shape checks throw `source.unreadable({ what, reason })`.
  - For the YASNO half-hours: half-hour `i` covers `[30i, 30i+30)`. It is `off` if any `Definite` range overlaps it, else `on` if a `NotPlanned` range covers it fully, else `unknown`.
- [ ] **Step 4: Run them to verify they pass.** Run `npx vitest run tests/providers/dtek-feeds.test.ts`, then the whole suite and the typecheck. Expected: all PASS.
- [ ] **Step 5: Commit.** Message: «DTEK feeds: the outage-data-ua mirror and YASNO, with their own staleness rules».

### Task 3: A page session that can close its window and open again

**Files:**
- Modify: `src/main/providers/types.ts` (`PageSession` gains `isOpen(): boolean` and `release(): void`)
- Modify: `src/main/providers/browser-session.ts`
- Modify: the test fakes that implement `PageSession`:
  - `tests/providers/dtek-provider.test.ts` `fakeSession` gets `isOpen: vi.fn(() => true)` and `release: vi.fn()`. «Always open» keeps every existing provider test on today's page path once Task 4 adds the budget.
  - `tests/providers/registry.test.ts` `setup` gets `isOpen: vi.fn(() => false)` and `release: vi.fn()`.
- Test: `tests/providers/browser-session.test.ts` (new; `vi.mock('electron')` in the style of `tests/main/main-window.test.ts`)

**Interfaces:**
- Produces:
  - `isOpen()`: a window exists and is not destroyed.
  - `release()`:
    - a no-op while showing (verification) or after `dispose()`;
    - otherwise it removes the window's `close` listeners, destroys the window, sets `win = null` and `loaded = false`;
    - the next `ensureReady()` builds a new window on the same partition.

- [ ] **Step 1: Write the failing tests** in `browser-session.test.ts`. The fake `BrowserWindow` records `destroy()` calls and `webContents.loadURL`, and its `executeJavaScript` resolves `true` for the ready check. The fake `session.fromPartition` has `setPermissionRequestHandler`, `setPermissionCheckHandler` and `webRequest.onBeforeRequest`.
  - «isOpen is false before use and true after ensureReady».
  - «release destroys the window, and the next ensureReady builds a new one». Two `BrowserWindow` constructions, the first destroyed, `isOpen()` true again.
  - «release while showForUser is pending does nothing». The window is not destroyed.
  - «release after dispose does nothing» (no throw, no second destroy).
- [ ] **Step 2: Run them to verify they fail.** Run `npx vitest run tests/providers/browser-session.test.ts`. Expected: FAIL (`release` / `isOpen` do not exist).
- [ ] **Step 3: Implement** in `BrowserSession`.
- [ ] **Step 4: Run the suite and the typecheck.** Expected: all PASS.
- [ ] **Step 5: Commit.** Message: «Page session: release() closes the window and keeps the session for the next load».

### Task 4: Routing in `DtekProvider` — house check, feeds, budget, linger

**Files:**
- Modify: `src/main/providers/dtek/index.ts`
- Test: `tests/providers/dtek-routing.test.ts` (new). `tests/providers/dtek-provider.test.ts` must keep passing as is: no feeds means today's behaviour.

**Interfaces:**
- Consumes: `ScheduleFeed`, `FeedResult` and the constants (Task 2); `PageSession.isOpen()` and `release()` (Task 3); `factDays` (Task 1).
- Produces:
  - `new DtekProvider(site, session, log?, opts?: { feeds?: ScheduleFeed[]; lingerMs?: number; pageGapMs?: number; houseCheckMs?: number })`. The defaults are `[]` and the Global Constraints constants. The current clock is `new Date()`, so tests drive it with fake timers.
  - Exports `FEEDS_FAILED_TEXT`.
- **Behaviour: spec §Behaviour, steps 1–4, and §Settled cases.** In short:
  - **House check due** when there is no `previous`, no `previous.houseCheckedAt`, an age outside `[0, houseCheckMs)`, or `previous.outageActive`.
  - **Page allowed** when `session.isOpen()` is true, or `lastPageOpenAt` is null or at least `pageGapMs` ago.
  - **Every page use** (wizard lists, the page path of `fetchSnapshot`, `showVerification`) goes through one wrapper. The wrapper:
    - clears the linger timer;
    - sets `lastPageOpenAt = now` when the page was not open;
    - runs the operation;
    - in `finally`, when no other page use is running, arms `setTimeout(lingerMs)`. When that fires it calls `session.release()` and sets `state = null`.
  - **The page path** returns today's snapshot plus `houseCheckedAt: new Date().toISOString()`.
  - **A feed snapshot:**
    - carries `lines`, `outageActive`, `currentOutage` and `houseCheckedAt` from `previous`;
    - with no `previous`, `lines` is `[{ index: address.lineIndex, groupId: address.groupId, label: groupLabel }]`;
    - `groupLabel` is the feed's own, else `previous.groupLabel`, else `queueLabelFromId(groupId)`;
    - `fetchedAt` is now;
    - optional keys are present only when set.
  - Log lines are `${id}: …`:
    - info when the page is used, with the reason (`house check` / `emergency` / `fallback`);
    - warn for each failed or unusable feed (tag and reason) and for a house check that failed while a feed answered.

- [ ] **Step 1: Write the failing tests** in `dtek-routing.test.ts`.
  - **Setup.** `vi.useFakeTimers()` with the system time `2026-10-21T22:35:00Z`.
  - **A fake session** with `isOpen` and `release` on top of the `fakeSession` shape. `isOpen` turns true after `ensureReady` and false after `release`. Replies to `READ_FACT` / `getHomeNumScript` come from `tests/fixtures/dtek/getHomeNum-*.json`, as in `dtek-provider.test.ts`; set the system time to that fixture's day where the page path's days are asserted.
  - **Fake feeds:** `{ tag, read: vi.fn() }`, resolving to `FeedResult`s or rejecting with `ProviderError` / `NetworkError`.
  - `previous` helper: `snap({ houseCheckedAt, lines, outageActive, currentOutage })`.

  The tests:
  - «no previous → the page path, with houseCheckedAt now». The feeds are not called.
  - «a fresh house check → the feed, the page untouched». With `houseCheckedAt` 1 h ago, `ensureReady` and `evaluate` are not called. The snapshot:
    - has the feed's `days` and `sourceUpdatedAt`;
    - carries `lines`, `outageActive`, `currentOutage` and `houseCheckedAt`;
    - has `fetchedAt` now.
  - «a house check 25 h old → the page».
  - «an outage at the last check → the page, every refresh within the budget». With `outageActive: true`, the second call within 30 min uses the page only while it is still open (`isOpen` true). After a release and with 10 min elapsed, it uses the feed.
  - «a house check that hits a verification, while the feed answers → the feed's snapshot, no throw». `log.warn` was called and `houseCheckedAt` is unchanged.
  - «the first feed unusable → the second feed». Both were called once, in order.
  - «yasno emergency → the page». The first feed returns `{ usable: false, emergency: true }`, and the page path answers. When the page fails, the second feed's answer is used.
  - «no usable feed, the page not tried and allowed → the page; its CaptchaRequiredError propagates».
  - «the house check failed with a verification and no feed is usable → CaptchaRequiredError».
  - «no usable feed, the page closed and opened 10 min ago → FEEDS_FAILED_TEXT». The page was opened by an earlier `listStreets` and released after the linger. The error is a `ProviderError`, not a `NetworkError`. When every feed rejected with `NetworkError`, it is a `NetworkError` with the same message.
  - «no previous and the page not allowed → the feed's answer with the synthesized line, no houseCheckedAt».
  - «carried lines keep a line change». The page path's house lines lack the saved `groupId`. The next call, a feed snapshot with that page snapshot as `previous`, has the same `lines`, so `RefreshService`'s rule gives `lineChanged`.
  - «two locations, one open». Two addresses on the same site, both without `previous`, fetched 30 s apart. `ensureReady` builds the page once (`isOpen` stays true in between), and the second fetch is not refused by the budget.
  - «linger». After a page use, `release` is called once after `PAGE_LINGER_MS`. A page use 4 min in clears the timer: `release` is not called at 5 min, but is called 5 min after the second use. After a release, the next page use evaluates `READ_FACT` again.
  - «showVerification arms the linger». After `showForUser` resolves and 5 min pass, `release` is called.
- [ ] **Step 2: Run them to verify they fail.** Run `npx vitest run tests/providers/dtek-routing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the routing** in `DtekProvider`.
  - Keep `serial()`: page and feed work for one provider stay one at a time.
  - Release only when no page use is running.
- [ ] **Step 4: Run the whole suite and the typecheck.** Expected: all PASS, including the untouched `dtek-provider.test.ts`.
- [ ] **Step 5: Commit.** Message: «DTEK: routine refreshes from the feeds; the page for the wizard, a daily house check and the fallback».

### Task 5: Wiring, and the live smoke

**Files:**
- Modify: `src/main/providers/registry.ts` (feeds per site; an optional `dtek?: { lingerMs?: number }` options argument on `createProviders`)
- Modify: `src/main/smoke-dtek.ts`
- Test: `tests/providers/registry.test.ts`

**Interfaces:**
- Consumes: `mirrorFeed` and `yasnoFeed` (Task 2); the `DtekProvider` opts (Task 4).
- Produces: `createProviders(makeSession, log, http, dtek?: { lingerMs?: number })`. Each DTEK provider gets its feeds as listed in Global Constraints, built from `http` (`fetch`, `isOnline`) and `log`.

- [ ] **Step 1: Write the failing test.** In `registry.test.ts`, «each DTEK site reads its feeds in order». For each of the four sites, call `fetchSnapshot(addr, previous)` with a `previous` whose `houseCheckedAt` is 1 h ago. `http.fetch` rejects every call. Expect:
  - the fetched URLs, in order: `dtek-kem` gives the YASNO URL then the mirror `kyiv` URL; `dtek-krem` gives `kyiv-region`; `dtek-dnem` gives `dnipro`; `dtek-oem` gives `odesa`;
  - the session's `ensureReady` to be called afterwards, because the fallback is allowed: no page has been opened yet.
- [ ] **Step 2: Run it to verify it fails.** Run `npx vitest run tests/providers/registry.test.ts`. Expected: FAIL (no fetches).
- [ ] **Step 3: Implement the wiring.** Then extend `smoke-dtek.ts`:
  - pass `{ lingerMs: 3000 }`;
  - after today's page snapshot (`snapPage`), call `fetchSnapshot(address, snapPage)` (`snapFeed`);
  - print:
    - `pageHouseCheckedAt`;
    - `feedHouseCheckedAt`, which must equal it;
    - `feedSourceUpdatedAt`;
    - `sameDays`: `JSON.stringify(snapFeed.days) === JSON.stringify(snapPage.days)`. A mismatch is printed, not fatal, because DTEK may publish between the two reads;
  - wait 4 s and print `windowsAfterLinger: BrowserWindow.getAllWindows().length`, expected 0.
  - The exit code is non-zero when `feedHouseCheckedAt !== pageHouseCheckedAt` or `windowsAfterLinger !== 0`.
- [ ] **Step 4: Verify.**
  - Run `npx vitest run` and the typecheck. Expected: all PASS.
  - Then run `npx electron-vite build` followed by `npx electron out/main/smoke-dtek.js --provider dtek-krem` and `npx electron out/main/smoke-dtek.js --provider dtek-kem`.
  - Expected: exit 0, `feedHouseCheckedAt` equal to `pageHouseCheckedAt`, `windowsAfterLinger: 0`, and `sameDays: true` unless DTEK published in between.
  - Paste the two JSON outputs in the report.
- [ ] **Step 5: Commit.** Message: «DTEK feeds wired per site; smoke-dtek checks the feed path and the page release».
