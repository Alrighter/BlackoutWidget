# Android, first build: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the user installs an APK on the S25 and adds an address. The three widget styles then show its real schedule on the home screen, keep the countdown current, and refresh in the background.

**Architecture:**
- **Core.** The desktop's providers, store and refresh run in React Native (Hermes) behind small adapters. A phone `RendererApi` serves the existing React screens in a WebView over a message bridge.
- **Widget data.** After every refresh the core writes `widget-feed.json`: per address, the widget's view precomputed at each half-hour boundary for the next 24 h, with countdown tokens.
- **Native side.** Kotlin draws the three styles on a Canvas from that file, re-renders on every minute alarm, and maps widget ids to addresses. A JobScheduler job (react-native-background-fetch, headless) runs the refresh every ~15 min.

**Tech Stack:** React Native 0.87.1 (Hermes, new architecture), react-native-webview 14.0.1, react-native-background-fetch 4.4.2, @react-native-community/netinfo 12.0.1, react-native-url-polyfill, fflate, vite-plugin-singlefile; Kotlin, Android SDK 36, minSdk 29; vitest (TS), JUnit + Robolectric (Kotlin).

**Spec:** `docs/superpowers/specs/2026-10-27-android-design.md`

**This is plan 1 of 4.** The spec's «order of work» asks for a first build with a real schedule in a real widget. Later plans:
- **Plan 2:** DTEK's hidden page in the background job, and the actual-outage rows.
- **Plan 3:** EcoFlow in all three modes.
- **Plan 4:** updates on the phone, signing in CI, and the shared release.

## Global Constraints

- **Desktop doesn't regress.**
  - The desktop's vitest suite, typecheck and build stay green.
  - Desktop capture-rig images stay byte-identical (Task 6 proves it).
- **One source of truth:** shared modules are imported from `src/`, never copied into `mobile/`.
- **Package and SDK levels:** package `ua.blackoutwidget.app`, app name «Blackout Widget», minSdk 29, compileSdk/targetSdk 36. Release builds ship `arm64-v8a` only.
- **UI copy:** Ukrainian. The new copy is exactly:
  - «Щоб віджети оновлювалися вчасно, дозвольте застосунку працювати у фоні»
  - «Дозволити»
- **Secrets:** none in plan 1. The release keystore never enters the repo.
- **No telemetry.** The phone talks only to the hosts the desktop talks to.
- **No foreground service and no notification.**
- **Commits:** subject and body only, with no `Co-Authored-By` and no Claude attribution.
- **Running things:** Claude never runs the desktop's packaged or installed app. The Android emulator runs only headless (`-no-window`), and only with the user's go-ahead (asked at handoff). Without it, the S25 is the only device check.

## Review Focus

1. **The phone's runtime differs from Node** (Hermes Intl with `Europe/Kyiv`, `URL`, `AbortSignal.timeout`, `arrayBuffer`): every Kyiv time or request could be silently wrong on the device.
   - Expected: the app checks itself at start and logs every failure.
   - Tests: Task 1 (a guard against Node-only APIs in the shared graph); Task 3 (`runtimeSelfTest` on the emulator).
2. **The widget's countdown when nobody refreshes for hours** (the phone in Doze, the job deferred).
   - Expected: on screen-on the countdown and the state are right for the current minute, from the frames already stored, with no JS run.
   - Tests: Task 2 (frames span 24 h, including the state flip); Task 8 (frame pick and token fill at arbitrary times).
3. **An address deleted in the app while its widget is on the home screen.**
   - Expected: the widget shows the empty view («Немає даних»), and a tap opens the app; no crash.
   - Test: Task 8.
4. **No network during the background job** (outage, mobile data off).
   - Expected: the last schedule stays on the widget, marked stale after 45 min, and the job ends cleanly.
   - Test: Task 9.
5. **DTEK while the app is closed.**
   - Expected: the background job uses the feeds only and never tries the page; the wizard and «Оновити зараз» in the open app may use it.
   - Tests: Task 1 (`canOpenPage` false → feeds only); Task 7.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/main/store.ts` (modify), `src/main/store-files.ts` (new), `src/main/location-errors.ts` (new) | Store without Node imports; the desktop's fs port; `LocationError` and `DEFAULT_SETTINGS` moved out |
| `src/main/providers/toe/index.ts`, `voe/png.ts`, `ztoe/page.ts` (modify), `src/shared/bytes.ts` (new) | Pure base64, inflate via fflate, windows-1251 table |
| `src/main/providers/dtek/*` (modify) | `canOpenPage` option |
| `src/shared/widget-state.ts` (modify), `src/shared/widget-feed.ts` (new) | `countdownAt` on the view; the feed for native widgets |
| `scripts/gen-widget-assets.mjs` (new) | `mobile/android/app/src/main/assets/widget-tokens.json` and the countdown vectors |
| `mobile/` (new React Native app) | `index.js`, `App.tsx`, `src/core/*` (pure TS: adapters, phone API, refresh-all), `src/host/*` (React Native components: WebView, page host), `src/bridge/*` (protocol), `renderer/` (the WebView entry), `android/` (Gradle, Kotlin) |
| `mobile/android/app/src/main/java/ua/blackoutwidget/app/` | `BwNativeModule.kt` (storage, widgets, battery), `widget/*` (feed, frames, renderers, providers, configure, ticker) |
| `src/renderer/src/shell.ts` (new), `App.tsx`, `SetupWizard.tsx`, `SettingsView.tsx`, `ScheduleView.tsx`, `app.css` (modify) | Phone shell: hidden desktop-only parts, narrow layout, battery banner |
| `scripts/ui-capture/*` (modify) | `--shell phone` captures |
| `tests/mobile/*`, `mobile/android/app/src/test/*` | TS tests (vitest), Kotlin tests (JUnit/Robolectric) |

---

### Task 1: A Hermes-ready shared core

**Files:**
- Create: `src/main/store-files.ts`, `src/main/location-errors.ts`, `src/shared/bytes.ts`
- Modify:
  - `src/main/store.ts`
  - `src/main/location-actions.ts`, `src/main/settings-migration.ts`, `src/main/index.ts`
  - `src/main/providers/toe/index.ts`, `src/main/providers/voe/png.ts`, `src/main/providers/ztoe/page.ts`
  - `src/main/providers/dtek/index.ts` and `route.ts`
  - `src/main/providers/registry.ts`
  - root `package.json`: add `fflate` (exact latest) to `dependencies`
- Test: `tests/mobile/portable.test.ts`, `tests/shared/bytes.test.ts`, the existing store and provider tests, `tests/providers/dtek-routing.test.ts`

**Interfaces:**
- **Produces, in `src/main/location-errors.ts`:** `LocationError` (moved unchanged), re-exported from `store.ts` so imports keep working.
- **Produces, in `src/main/store.ts`:** `DEFAULT_SETTINGS`, still exported from `store.ts`. `store.ts` then has no `node:` import.
- **Produces, the store's file port:**
  - `export interface StoreFiles { read(name: string): string | null; write(name: string, text: string): void; remove(name: string): void }`. Names are bare (`settings.json`); `read` returns null for a missing file.
  - The constructor becomes `new AppStore(files: StoreFiles, deps: { newId?: () => string } = {})`.
- **Produces, in `src/main/store-files.ts`:** `nodeStoreFiles(dir: string): StoreFiles`, which keeps today's atomic tmp + rename write and the read retry (`sleepSync`).
- **Produces, in `src/shared/bytes.ts`:**
  - `base64ToBytes(s: string): Uint8Array`
  - `decodeWindows1251(bytes: Uint8Array): string`
  - `inflate(bytes: Uint8Array): Uint8Array` (fflate `unzlibSync`)
- **Produces, DTEK:** `createProviders(…, dtekOpts: { lingerMs?: number; canOpenPage?: () => boolean })`. When `canOpenPage()` is false, `pageAllowed` is false, so there is no house check and no page fallback.

- [ ] **Step 1: Write the failing tests**
  - `portable.test.ts`, «the code the phone bundles uses no Node or Electron API».
    - It follows relative imports from these entries: `src/main/store.ts`, `src/main/refresh.ts`, `src/main/location-actions.ts`, `src/main/settings-migration.ts`, `src/main/compose-state.ts`, `src/main/providers/registry.ts`, `src/shared/widget-feed.ts` (from Task 2; skip it while missing) and every `src/shared/*.ts`.
    - It follows value imports only, not `import type`.
    - It fails on an import of `node:*`, `fs`, `path`, `zlib`, `buffer` or `electron`, and on the identifiers `Buffer`, `TextDecoder(` and `Atomics`. Each failure names the file and line.
  - `bytes.test.ts`:
    - `base64ToBytes('0JDQkQ==')` equals the bytes of `'АБ'` in UTF-8;
    - `decodeWindows1251(new Uint8Array([0xc0, 0xe1, 0xb2, 0xb3, 0xaa, 0xba, 0xaf, 0xbf]))` is `'Аб²³ЄєЇї'`;
    - `inflate` of a zlib stream made with `node:zlib.deflateSync` round-trips (the test may use Node).
  - `dtek-routing.test.ts`: «canOpenPage false: no house check, feeds only, no page fallback».
    - With a due house check and no usable feed, the result is the previous snapshot under 30 min old, else the feeds-failed error. The fake session's `ensureReady` is never called.

- [ ] **Step 2: Run** `npx vitest run tests/mobile/portable.test.ts tests/shared/bytes.test.ts tests/providers/dtek-routing.test.ts`
  - Expected: FAIL. The guard lists `store.ts`, `toe`, `voe/png.ts` and `ztoe/page.ts`; `bytes` is missing.

- [ ] **Step 3: Implement**
  - Move the code as in Interfaces.
  - `toe`, `voe` and `ztoe` use `src/shared/bytes.ts`.
  - Desktop `index.ts` builds `new AppStore(nodeStoreFiles(userData))`.
  - The store tests switch to `nodeStoreFiles(tmp)`. A test that injected `readFile` gets a small `StoreFiles` fake.

- [ ] **Step 4: Run the whole suite** (`npx vitest run`), then `npm run typecheck` and `npm run build`. Expected: all PASS.

- [ ] **Step 5: Commit** «Shared core without Node APIs, ready for the phone».

---

### Task 2: The widget feed

**Files:**
- Modify: `src/shared/widget-state.ts`
- Create: `src/shared/widget-feed.ts`, `scripts/gen-widget-assets.mjs`
- Test: `tests/shared/widget-feed.test.ts`, `tests/shared/widget-state.test.ts`

**Interfaces:**
- **Produces:** `WidgetView` gains `countdownAt?: string`.
  - It is the ISO instant that `nextText` and `countdownShort` count down to: the schedule change `at`, or the emergency `end`.
  - It is set exactly when a duration was formatted, and dropped together with `countdownShort` in the mismatch branch.
- **Produces, in `src/shared/widget-feed.ts`:**
  ```ts
  export const FEED_VERSION = 1;
  export const FEED_HORIZON_MS = 24 * 3_600_000;
  export interface WidgetFrame {
    from: number;                  // epoch ms; the frame holds until the next one's `from`
    state: PowerState; title: string;
    nextText: string;              // {L} = formatDurationLong(minutes left to countdownAt)
    countdown?: string;            // '{S}' or '≈{S}'; {S} = formatDurationShort(…)
    countdownCaption?: string; countdownAt?: number;
    todayKey: string; lineLabel: string; updatedText: string; stale: boolean;
    outageBadge?: OutageBadgeText; emergency?: { startMin: number; endMin: number };
  }
  export interface FeedLocation {
    id: string; name: string; showName: boolean; providerName: string; lineChanged: boolean;
    days: DaySchedule[]; frames: WidgetFrame[];   // frames empty = no schedule yet (the empty view)
  }
  export interface WidgetFeed { version: 1; writtenAt: number; locations: FeedLocation[] }
  export function buildWidgetFeed(state: AppState, now: Date): WidgetFeed;
  ```
- **Frame instants:**
  - `now`;
  - every Kyiv half-hour boundary in `(now, now + FEED_HORIZON_MS]`;
  - `fetchedAt + STALE_AFTER_MIN`;
  - `houseCheckedAt + EMERGENCY_HOUSE_STALE_MIN`;
  - the emergency end.

  At each instant the frame is `computeWidgetView(snapshot, t)` made into tokens: in `nextText` and `countdownShort`, the durations for `countdownAt` are replaced by `{L}` and `{S}`. A frame equal to the one before it (all fields except `from`) is dropped.
- **Produces, from `scripts/gen-widget-assets.mjs`** (`npm run mobile:assets`):
  - `mobile/android/app/src/main/assets/widget-tokens.json`: `THEMES` light/dark from `design-tokens.ts`, `WIDGET_SIZES`, and the tint underlays `#eef1f7` / `#10131f`;
  - `mobile/android/app/src/test/resources/countdown-vectors.json`: `[minutes, long, short]` for 0–1500.

- [ ] **Step 1: Write the failing tests**
  - «countdownAt is the change instant»: the fixture at 11:50 Kyiv gives `countdownAt` = 15:00 Kyiv; an emergency with an end gives that end; a mismatch drops it.
  - «frames hold tokens, and filling them reproduces computeWidgetView».
    - At 20 random instants in the horizon, take the last frame with `from <= t`.
    - Fill `{L}` and `{S}` with `minutes = ceil((countdownAt - t) / 60000)`.
    - The result equals `computeWidgetView(snapshot, t)` in `state`, `title`, `nextText`, `countdownShort` (with the `≈` prefix rule of `countdownText`), `stale` and `outageBadge`.
  - «the state flips at the change»: a frame starts at 15:00 Kyiv with `state` `'off'`.
  - «stale after 45 min»: there is a frame at `fetchedAt` + 45 min with `stale: true`.
  - «a location without a snapshot has no frames; showName follows the count of locations».
  - «assets are current»: the generator's output equals the committed files (a drift guard).

- [ ] **Step 2: Run** `npx vitest run tests/shared/widget-feed.test.ts tests/shared/widget-state.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** the feed as above, then run the generator.

- [ ] **Step 4: Run** the whole suite and typecheck. Expected: PASS.

- [ ] **Step 5: Commit** «Widget feed: precomputed frames for native widgets».

---

### Task 3: The React Native app scaffold

**Files:**
- Create: `mobile/`, generated with `npx @react-native-community/cli@20.2.0 init BlackoutWidget --version 0.87.1 --directory mobile --skip-git-init --install-pods false --package-name ua.blackoutwidget.app`. Then:
  - delete `mobile/ios`;
  - set `app_name` to «Blackout Widget»;
  - add `mobile/metro.config.js`, `mobile/src/polyfills.ts`, `mobile/src/core/self-test.ts`;
  - add `BwNativeModule.kt`, a TurboModule with the spec in `mobile/src/native/NativeBw.ts`.
- Modify:
  - `scripts/gen-app-icon.cjs`: add `--android`, which writes the launcher mipmaps (mdpi to xxxhdpi, and an adaptive foreground and background) from the same design;
  - root `package.json` scripts: `mobile:assets`, `mobile:renderer` (Task 5), `mobile:apk`.
- Test: `tests/mobile/self-test.test.ts`

**Interfaces:**
- **`metro.config.js`:**
  - `watchFolders: [<repo>/src]`;
  - `resolver.sourceExts` with `ts`, `tsx` before `json` (voe `settlements.ts` vs `.json`);
  - `nodeModulesPaths: [<repo>/mobile/node_modules]`;
  - `fflate` is also a mobile dependency.
- **`polyfills.ts`**, imported first in `index.js`:
  - `react-native-url-polyfill/auto`;
  - `AbortSignal.timeout`, `structuredClone` (JSON) and `Object.hasOwn`, each only if missing.
- **`NativeBw`** (sync methods are fine):
  - `readFile(name: string): string | null`, `writeFile(name: string, text: string): void` (tmp + rename in `filesDir`), `removeFile(name: string): void`;
  - `updateWidgets(): void`;
  - `isIgnoringBatteryOptimizations(): boolean`, `openBatterySettings(): void`.
- **`runtimeSelfTest(): string[]`** (pure TS): the failures, empty when fine. It checks:
  - `kyivDateKey` and `kyivMinutesOfDay` at three fixed instants, across both DST switches of 2026;
  - `new URL('https://a.b/c?d=1').searchParams.get('d')`;
  - that `AbortSignal.timeout` exists;
  - `Intl.Collator('uk', { numeric: true })` ordering `['10', '2']` as `['2', '10']`.

  `index.js` logs each failure as a warning at start.
- **Versions:** Gradle reads the root `package.json` `version` as `versionName`. `versionCode` is `MAJOR*1000000 + MINOR*10000 + PATCH*100 + (n of -test.n, else 99)`.

- [ ] **Step 1: Write the failing test** `self-test.test.ts`: «runtimeSelfTest passes under Node», and «it reports a broken Kyiv clock» (with a stubbed `Intl.DateTimeFormat`, the result names `kyiv`).
- [ ] **Step 2: Run** it. Expected: FAIL (module missing).
- [ ] **Step 3: Implement**
  - Generate the app and wire the scaffold.
  - Bundle check: `cd mobile && npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output %TEMP%\bw.bundle` must succeed with the shared core imported from `index.js`, through a `core` import used by Task 4. In this task, `src/main/providers/registry.ts` is imported from `index.js`.
  - Then `cd mobile/android && gradlew assembleDebug`.
- [ ] **Step 4: Run** vitest and `npm run typecheck` (root), and `npx tsc -p mobile`. Expected: PASS.
  - **Emulator** (if allowed): install the debug APK. `adb logcat -s ReactNativeJS` must show no self-test warnings. Record what fails as a ruling.
- [ ] **Step 5: Commit** «Android app scaffold: React Native 0.87.1, shared core bundled».

---

### Task 4: The phone core

**Files:**
- Create in `mobile/src/core/`:
  - `files.ts`: `bwStoreFiles(native)`, a `StoreFiles` over `NativeBw`;
  - `http.ts`: `phoneHttp(fetch)`, an `HttpFetch` over the global `fetch`, adding the desktop's `Accept-Language: uk`, `Cache-Control: no-cache` and a Chrome Android User-Agent;
  - `phone-api.ts`;
  - `refresh-all.ts`;
  - `core.ts`.
- Test: `tests/mobile/phone-api.test.ts`, `tests/mobile/refresh-all.test.ts`

**Interfaces:**
- **Consumes:** `AppStore`, `StoreFiles` (Task 1), `buildWidgetFeed` (Task 2), `NativeBw` (Task 3), `RefreshService`, `createLocationActions`, `composeAppState`, `createProviders`.
- **Produces:**
  - `createCore(o: { native: BwNative; fetch: typeof fetch; makeSession: (opts: SessionOptions) => PageSession; canOpenPage(): boolean; isOnline(): boolean; openUrl(url: string): void; log: Logger }): Core`
  - `interface Core { api: RendererApi; phone: PhoneApi; refreshAll(reason: 'background' | 'start' | 'manual'): Promise<void>; onNavigate(nav: MainNav): void }`
- **`PhoneApi`**, added to `src/shared/ipc.ts`:
  ```ts
  /** The phone shell's extra calls; `window.phone` exists only in the Android app. */
  export interface PhoneApi { batteryUnrestricted(): Promise<boolean>; openBatterySettings(): void }
  declare global { interface Window { phone?: PhoneApi } }
  ```
- **The phone `RendererApi`** mirrors `src/main/ipc.ts` and `index.ts`:
  - **Locations:**
    - location calls go through `createLocationActions`;
    - `placeNew` returns `null` (no position on the phone);
    - `setWidgetStyle` stores the style as the desktop does; it is unused there.
  - **Captcha:** `solveCaptcha` calls the provider's `showVerification`.
  - **Settings and external pages:**
    - `setAutostart` resolves and does nothing;
    - `openProviderSite` and `openEcoflowHelp` call `openUrl`.
  - **Not on the phone yet:**
    - the EcoFlow calls reject with `Error('EcoFlow на телефоні буде в наступній версії')`;
    - `ecoflowScan` resolves `{ nearby: [], bluetooth: 'unsupported' }`;
    - `getActualLive` resolves null;
    - `installUpdate` resolves.
  - **Widget-only calls** are no-ops.
  - **State:**
    - `onState` gets every state change;
    - `getState()` uses `composeAppState(settings, states, null, loaded)`;
    - each change also writes `widget-feed.json` (`buildWidgetFeed`) and calls `native.updateWidgets()`.
- **`refreshAll`:**
  - refreshes every location in sequence through `RefreshService`;
  - writes the feed once, at the end;
  - never throws (failures are logged).

- [ ] **Step 1: Write the failing tests** (fakes for native, fetch and session):
  - «addLocation persists through NativeBw and the feed lists it»;
  - «refreshAll writes one feed with frames for each location and updates the widgets once»;
  - «an offline refreshAll keeps the last snapshot, and the feed's frames mark it stale after 45 min»;
  - «a captcha error reaches the renderer as CAPTCHA_REQUIRED»;
  - «EcoFlow calls reject with the phone message»;
  - «with canOpenPage false, a DTEK refresh never opens a session».
- [ ] **Step 2: Run** `npx vitest run tests/mobile`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite, both typechecks, and the Metro bundle. Expected: PASS.
- [ ] **Step 5: Commit** «Phone core: the RendererApi over the shared providers and store».

---

### Task 5: The WebView bridge and the phone renderer build

**Files:**
- Create:
  - `mobile/src/bridge/protocol.ts`, `mobile/src/bridge/client.ts`, `mobile/src/bridge/host.ts`;
  - `mobile/renderer/index.html`, `mobile/renderer/main.ts`, `mobile/renderer/vite.config.ts`;
  - `mobile/src/host/AppWebView.tsx`;
  - `mobile/App.tsx`, replacing the template's.
- Modify: root `package.json` gets `mobile:renderer` (`vite build -c mobile/renderer/vite.config.ts`).
- Test: `tests/mobile/bridge.test.ts`

**Interfaces:**
- **`protocol.ts`:**
  ```ts
  export type ToHost = { kind: 'call'; id: number; target: 'api' | 'phone'; method: string; args: unknown[] };
  export type ToPage =
    | { kind: 'result'; id: number; ok: true; value: unknown }
    | { kind: 'result'; id: number; ok: false; message: string }
    | { kind: 'event'; channel: 'state' | 'navigate'; payload: unknown };
  ```
- **`client.ts`**, used by the page: `installBridge(post: (json: string) => void): { receive(json: string): void }`.
  - It sets `window.api` (every `RendererApi` method) and `window.phone`.
  - Methods that return void send fire-and-forget calls.
  - `onState`/`onNavigate` subscribe to events.
  - A rejection carries the host's message unchanged, so `CAPTCHA_REQUIRED` survives.
- **`host.ts`**, used in React Native: `serveBridge(core: Core, send: (json: string) => void): { receive(json: string): void; dispose(): void }`.
- **Transport:**
  - Page → React Native: `window.ReactNativeWebView.postMessage`.
  - React Native → page: `webView.injectJavaScript('window.__bw.receive(' + JSON.stringify(json) + ')')`.
- **The renderer:**
  - `mobile/renderer/main.ts` imports `./install` (which calls `installBridge` and sets `window.__bw`) before `src/renderer/src/app/main`.
  - The build inlines everything into one `app.html` (vite-plugin-singlefile) at `mobile/android/app/src/main/assets/renderer/app.html`.
  - It is loaded from `file:///android_asset/renderer/app.html?view=schedule`.
  - Ruling if vite-plugin-singlefile doesn't support vite 8: a 20-line post-build step that inlines the one JS and CSS file.
- **`App.tsx`:**
  - until Task 7, `makeSession` throws «page unavailable» and `canOpenPage` returns false, so DTEK runs on feeds only;
  - a full-screen `AppWebView`;
  - the status bar follows the system theme;
  - deep links `blackoutwidget://schedule?location=<id>` → `core.onNavigate({ view: 'schedule', locationId })`;
  - on resume it calls `refreshAll('start')`, throttled to once per 5 min.

- [ ] **Step 1: Write the failing tests** (client and host wired back to back in memory):
  - «a call round-trips»;
  - «a rejection keeps CAPTCHA_REQUIRED»;
  - «onState receives pushes and unsubscribes»;
  - «fire-and-forget calls send no reply»;
  - «window.phone exists».
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `npm run mobile:renderer` and check that one `app.html` is written with no external `<script src>`.
- [ ] **Step 4: Run** the tests, typechecks and `gradlew assembleDebug`. Expected: PASS.
  - **Emulator:** the app opens on the first-setup wizard; `adb exec-out screencap -p` is saved under `.superpowers/android/` and looked at.
- [ ] **Step 5: Commit** «WebView bridge: the desktop screens in the Android app».

---

### Task 6: The phone shell in the renderer

**Files:**
- Create: `src/renderer/src/shell.ts`: `export const isPhone = (): boolean => typeof window !== 'undefined' && !!window.phone`.
- Modify:
  - `src/renderer/src/app/SetupWizard.tsx`: no style step and no tray hint; no autostart on the last step;
  - `src/renderer/src/app/SettingsView.tsx`: no style card, no autostart, no EcoFlow card;
  - `src/renderer/src/app/ScheduleView.tsx`: no «Підключити EcoFlow» prompt;
  - `src/renderer/src/app/App.tsx`: the battery banner;
  - `src/renderer/src/app/app.css`.
- Modify: `scripts/ui-capture/capture.cjs` and `preload.cjs`: `--shell phone` (sets `window.phone`, viewport 412×915, scale 2).
- Test: `tests/renderer/phone-shell.test.tsx`

**Interfaces:**
- **CSS:**
  - Every phone rule sits under `html.bw-phone`, set by `main.tsx` when `isPhone()`. A max-width query isn't used, so the desktop can never match.
  - The phone gets a solid `body` background: the main window's fallback colours `#eef0f5` / `#1e2028`.
  - The wizard rail stacks above the content.
  - Grids drop to one column: `.st`, the outages list, the style cards.
  - The house grid has 4 columns.
  - The hour grid keeps 24 columns with 40 px labels.
- **The battery banner:**
  - It shows when `window.phone.batteryUnrestricted()` resolves false.
  - It has the exact copy from Global Constraints and a «Дозволити» button that calls `openBatterySettings()`.
  - It isn't shown again after a click in that session.

- [ ] **Step 1: Write the failing tests** (jsdom, with `window.phone` stubbed):
  - «the phone wizard has no style step»: the step list lacks «Стиль віджета»;
  - «the phone settings have no autostart and no style and EcoFlow cards»;
  - «the battery banner appears when restricted; its button calls openBatterySettings»;
  - «without window.phone, everything is as before»: the existing renderer tests run unchanged.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Before any CSS change, capture the desktop baseline: `npm run ui:capture -- --target app --view schedule,settings,setup --theme dark,light --out .superpowers/android/desktop-before`.
- [ ] **Step 4: Run** the suite.
  - Capture again into `desktop-after`. Byte-compare the PNGs: all identical.
  - Capture `--shell phone` for the same views, and look at them for overflow and clipping at 412 px.
- [ ] **Step 5: Commit** «Phone shell: narrow layout, desktop-only parts hidden, battery hint».

---

### Task 7: DTEK's page while the app is open

**Files:**
- Create:
  - `mobile/src/host/PageHost.tsx`: a React Native host for hidden WebViews;
  - `mobile/src/core/webview-session.ts`: a `PageSession` over a transport.
- Test: `tests/mobile/webview-session.test.ts`

**Interfaces:**
- **`createWebViewSession(opts: SessionOptions, t: PageTransport): PageSession`**, where:
  ```ts
  export interface PageTransport {
    open(url: string, allowedHosts: string[]): void; close(): void; show(visible: boolean): void;
    evaluate(js: string): Promise<unknown>;              // awaits promises in the page (postMessage round trip)
    onLoad(cb: (r: { ok: true } | { ok: false; code: string }) => void): () => void;
  }
  ```
- **Semantics** (as `browser-session.ts`):
  - **`ensureReady`:**
    - it polls `readyCheck` until `readyTimeoutMs`;
    - a load error maps to the desktop's net-error messages (`ERROR_HOST_LOOKUP` → name-not-resolved);
    - a captcha page throws `CaptchaRequiredError`;
    - `afterReady` runs once per load.
  - **`showForUser`** makes the WebView a full-screen overlay with a «Готово» close button.
  - **`isOnline`** reads a cached NetInfo value.
  - **`blockRequest`** isn't supported on Android (no request bodies). `NEUTRALIZE_TIMERS` in `afterReady` remains the defence. This is a ruling, stated in the code.
- **`canOpenPage`:** true while `PageHost` is mounted and the app is in the foreground (`AppState` `active`), else false. The headless job never mounts it.

- [ ] **Step 1: Write the failing tests** with a fake transport:
  - «ensureReady resolves after readyCheck turns true»;
  - «a load error rejects with the mapped message»;
  - «a captcha page rejects with CaptchaRequiredError»;
  - «evaluate passes the awaited value and the thrown message»;
  - «release closes the WebView after the linger time».
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite and `assembleDebug`.
  - **Emulator:** in the wizard, pick a DTEK oblast company, then a town and a street. The houses list loads.
- [ ] **Step 5: Commit** «DTEK's page on the phone while the app is open».

---

### Task 8: The home-screen widgets

**Files**, under `mobile/android/app/src/main/java/ua/blackoutwidget/app/widget/`:
- Create:
  - `Feed.kt`: parse `widget-feed.json` and `widget-tokens.json`;
  - `Frames.kt`: `pickFrame`, `fill`, `formatLong`, `formatShort`, `kyivMinutes`;
  - `WidgetRenderer.kt` and `CompactRenderer.kt`, `RingRenderer.kt`, `TimelineRenderer.kt`;
  - `BwWidgetProvider.kt`, plus subclasses `CompactWidget`, `RingWidget`, `TimelineWidget`;
  - `WidgetTable.kt`: SharedPreferences, widget id → location id;
  - `ConfigureActivity.kt`;
  - `MinuteTicker.kt`;
  - `res/xml/widget_{compact,ring,timeline}.xml`;
  - preview PNGs in `res/drawable-nodpi`, from the capture rig.
- Test: `mobile/android/app/src/test/java/…/FramesTest.kt`, `RendererTest.kt` (Robolectric, `@GraphicsMode(NATIVE)`)

**Interfaces and behaviour:**
- **`pickFrame(frames, nowMs)`:** the last frame with `from <= now`, or null.
- **`fill(frame, nowMs)`** replaces `{L}` and `{S}` with `minutes = ceil((countdownAt - now) / 60000)`, clamped at 0.
- **`kyivMinutes`** uses `ZoneId.of("Europe/Kyiv")`, falling back to `Europe/Kiev`.
- **Renderers** draw one Bitmap at the widget's size in px:
  - sizes come from the `AppWidgetManager` options (dp × density);
  - the light/dark tokens follow `Configuration.UI_MODE_NIGHT`;
  - the background is the desktop's `tint` card: underlay plus glass tint, corner radius scaled from `WIDGET_SIZES`;
  - each style follows its desktop component (`CompactWidget.tsx`, `RingWidget.tsx`, `TimelineWidget.tsx`, `parts.tsx`, `DayBar.tsx`, `widget.css`): title, countdown and caption, line label, badge, the past cells dimmed, the now marker;
  - the content scales to fit the widget's size, keeping the desktop proportions;
  - the empty view is «Немає даних» / «Графік ще не отримано»;
  - an address gone from the feed gets the empty view;
  - with no addresses at all, the widget shows «Налаштуйте адресу».
- **Picker entries:**
  - `CompactWidget`, `RingWidget`, `TimelineWidget`: one entry each, with a preview;
  - target cells 3×2, 3×3, 4×2, resizable.
- **`ConfigureActivity`:**
  - one address: binds it and finishes;
  - several: a list of names (an `AlertDialog`);
  - none: binds nothing, opens the app's setup and finishes.
- **A tap** opens `blackoutwidget://schedule?location=<id>`.
- **`MinuteTicker`:**
  - a chain of `AlarmManager.set(RTC, nextMinuteBoundary)` (inexact, non-wakeup, no exact-alarm permission);
  - each alarm re-renders every widget from the stored feed and schedules the next;
  - it starts on `onEnabled`/`onUpdate`, `BOOT_COMPLETED`, `TIME_SET` and `TIMEZONE_CHANGED`, and stops on `onDisabled`;
  - **In Doze**, a pending RTC alarm is delivered when the device wakes, so the first look after screen-on is current. This statement goes into the class comment.
- **`BwNative.updateWidgets()`** broadcasts `ACTION_APPWIDGET_UPDATE` to the three providers.

- [ ] **Step 1: Write the failing tests:**
  - **`FramesTest`:**
    - `formatLong` and `formatShort` match every line of `countdown-vectors.json`;
    - `pickFrame` at, before and after a boundary;
    - `fill` with «Вимкнення о 15:00 · через {L}» at 11:50 Kyiv gives «… · через 3 год 10 хв»;
    - an address id missing from the feed gives null.
  - **`RendererTest`:**
    - each style renders the fixture feed, dark and light, to `build/widget-previews/*.png` without throwing;
    - the bitmap matches the requested size.
- [ ] **Step 2: Run** `gradlew testDebugUnitTest`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Look at the rendered PNGs next to the rig's desktop captures (`npm run ui:capture -- --target widget --style compact,ring,timeline --theme dark,light`).
  - Copy them into `res/drawable-nodpi` as previews.
- [ ] **Step 4: Run** `testDebugUnitTest` and `assembleDebug`. Expected: PASS.
  - **Emulator:** add each widget through the picker (`adb shell am`, or the AppWidget host test intent), then take screenshots.
- [ ] **Step 5: Commit** «Home-screen widgets: three styles drawn from the feed, current to the minute».

---

### Task 9: The background refresh

**Files:**
- Create: `mobile/src/core/background.ts`; register in `index.js`.
- Modify:
  - `AndroidManifest.xml`: `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `INTERNET`, `ACCESS_NETWORK_STATE`;
  - `BwNativeModule.kt`: the battery calls.
- Test: `tests/mobile/background.test.ts`

**Interfaces:**
- `configureBackground(bf: BackgroundFetchLike, run: () => Promise<void>, log: Logger): Promise<void>`. It calls `bf.configure` with:
  - `minimumFetchInterval: 15`, `stopOnTerminate: false`, `startOnBoot: true`, `enableHeadless: true`;
  - `requiredNetworkType: NETWORK_TYPE_ANY` (the job runs offline too, and keeps the stale schedule).
- `headlessTask(event)` builds a core with `canOpenPage: () => false` and calls `refreshAll('background')`. It always calls `finish(taskId)`, also on error. A timeout event finishes at once.
- **Ruling:** react-native-background-fetch (JobScheduler) stands in for a hand-written WorkManager worker. The minimum is the same 15 minutes, and its headless start is maintained for the new architecture.

- [ ] **Step 1: Write the failing tests:**
  - «configure is called with the 15-min interval and headless on»;
  - «a fetch event runs refreshAll and finishes the task»;
  - «a throwing refreshAll still finishes the task»;
  - «a timeout event finishes at once».
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the suite and `assembleDebug`.
  - **Emulator:** with the app swiped away, run `adb shell cmd jobscheduler run -f ua.blackoutwidget.app <jobId>`. `logcat` shows a refresh and the widgets update.
- [ ] **Step 5: Commit** «Background refresh every ~15 min, headless».

---

### Task 10: The release APK and docs

**Files:**
- Modify:
  - `mobile/android/app/build.gradle`:
    - release signing from `%USERPROFILE%\.blackoutwidget\android-signing.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`); without that file, release builds fall back to debug signing and say so;
    - `abiFilters "arm64-v8a"` for release.
  - `README.md`: an «Android» section covering install from the APK, the battery permission, the three widgets, and what plan 1 doesn't have yet (EcoFlow, the background DTEK page, updates).
  - Root `package.json`: `mobile:apk` (assets, renderer, `gradlew assembleRelease`).
- Create, outside the repo:
  - the keystore `%USERPROFILE%\.blackoutwidget\android-release.jks` (RSA 4096, validity 10000 days, alias `blackoutwidget`);
  - a 32-character random password in the properties file.

  Tell the user to back up both files; losing them means users can't update without reinstalling.
- [ ] **Step 1:** create the keystore (`keytool -genkeypair …`) and the properties file. Check that `git status` shows neither.
- [ ] **Step 2:** `npm run mobile:apk`. Expected:
  - `mobile/android/app/build/outputs/apk/release/app-release.apk`;
  - `apksigner verify --print-certs` shows the `blackoutwidget` certificate;
  - the APK is under 40 MB.
- [ ] **Step 3: Emulator** (if allowed): a fresh install of the release APK, add an address, add the three widgets, run the job. Then take screenshots.
- [ ] **Step 4:** run the whole vitest suite, both typechecks and `testDebugUnitTest`. Then commit «Android release build and README».
- [ ] **Step 5:** hand the APK to the user: `SendUserFile` if it fits, else a GitHub Actions artifact or a draft pre-release, and only with the user's go-ahead.
