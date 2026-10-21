# Multiple Locations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Up to five named addresses («Дім», «Батьки»), each with its own schedule, its own desktop widget and its own refresh timing, with EcoFlow on one of them.

**Architecture:**
- `Settings.address` becomes `Settings.locations`. The store migrates the old file to the location `home` and guards every location change with one synchronous read-modify-write.
- The main process keeps one `RefreshScheduler` and one `WidgetWindow` per location id. It reconciles both with the settings after every successful read.
- Windows get state composed per location. EcoFlow's status is attached only to `actualLocationId`, and a widget's IPC calls are routed by `event.sender`.

**Tech Stack:** Electron 44, electron-vite, TypeScript, React 19, vitest (jsdom for renderer tests), Git Bash on Windows.

**Spec:** `docs/superpowers/specs/2026-10-21-multiple-locations-design.md`. Read it before your task. It is the authority, and this plan argues from it.

## Global Constraints

- **UI strings.** User-facing strings are Ukrainian and verbatim from this plan or the spec. Never put Cyrillic in a shell command literal. Write files with Write/Edit, or with a `.mjs` script read from a file.
- **Limits.** At most 5 locations (`MAX_LOCATIONS = 5`). A name is trimmed, inner whitespace collapsed, 1–24 characters (`NAME_MAX = 24`), and unique ignoring case.
- **Migrated location.** It has id `'home'` and name `'Дім'`.
- **Fixed error texts.** These live in `src/shared/locations.ts` and nowhere else:
  - `'Вкажіть назву'`
  - `'Назва — до 24 символів'`
  - `'Така назва вже є'`
  - `'Можна додати до 5 адрес'`
  - `'Останню адресу видалити не можна'`
  - `'Цієї адреси вже немає'`
- **Logs.** New log lines name a location by its id only, never by its name or address.
- **Safety.**
  - Tests use temp directories (`mkdtempSync(join(tmpdir(), 'bw-'))`).
  - Never read or write `%APPDATA%\Blackout Widget` or `%APPDATA%\blackoutwidget`.
  - Never run the installed or packaged app, never run `npm run dev`, never capture the screen.
  - The UI capture rig (offscreen, Task 9) is allowed.
- **Tests and typecheck.**
  - Every task ends with its own tests, and every test file no later task rewrites, green under `npx vitest run`.
  - A test file that a later task rewrites may fail in the meantime. Examples are `tests/main/refresh.test.ts` after Task 1 and `tests/renderer/app.test.tsx` after Task 7. The report lists each such failure.
  - From the end of Task 8 on, `npx vitest run` and `npm run typecheck` are both fully green. Before that, a task may leave type errors only in files a later task owns, and its report lists them.
- **Commits.** Subject plus body only. No `Co-Authored-By` trailer, no «Generated with» line, no Claude attribution of any kind.
- **No new dependencies.**

## Review Focus

1. **A real pre-upgrade `settings.json`** has an address, the timeline style, a saved position, `autostart: false`, an EcoFlow `actualSource` and `ecoflowClientId`, plus a matching `snapshot.json`.
   - **Expected:** everything survives as location `home`, with no top-level `address`, `widgetStyle` or `widgetPosition` left on disk. Task 1 test «a real old settings file migrates whole».
2. **A position save lands between a rename's read and write.** This happens when two `AppStore` instances share one directory.
   - **Expected:** both changes stay. Task 1 test «updateLocation reads fresh: another writer's change survives».
3. **A location is deleted while its fetch is in flight.**
   - **Expected:**
     - no snapshot is written for the gone id;
     - its state disappears;
     - its widget is disposed and is not rebuilt by the `closed` handler.

   Task 2 test «a result for a deleted location is dropped», and Task 3 test «a disposed widget is never rebuilt».
4. **Two widgets after an explorer restart.**
   - **Expected:** each has its own pinner, so both get re-attached. `user32` is loaded once per process, because koffi refuses a second `RECT` struct of the same name. Task 3 test «each widget gets its own pinner; user32 loads once».
5. **The settings file is locked at login.**
   - **Expected:**
     - no first-setup wizard opens;
     - the main window shows the unreadable-settings note;
     - widgets and schedulers appear when the file reads.

   Task 1 test «unreadable at start: defaults for display, not loaded». Task 4 test «composeAppState carries settingsLoaded». Task 8 test «settings not loaded: a note, never the wizard».

---

### Task 1: Location model, migration and store

**Files:**
- Create: `src/shared/locations.ts`, `src/main/settings-migration.ts`
- Modify: `src/shared/types.ts`, `src/main/store.ts`
- Test: `tests/shared/locations.test.ts`, `tests/main/settings-migration.test.ts`, `tests/main/store.test.ts`

**Interfaces:**
- Consumes: none.
- Produces:
  - In `src/shared/types.ts`, the old top-level `address`, `widgetStyle` and `widgetPosition` are removed from `Settings`:
    ```ts
    export interface Location { id: string; name: string; address: Address; widgetStyle: WidgetStyle; widgetPosition: WidgetPosition | null }
    export interface Settings {
      locations: Location[]; actualLocationId: string | null;
      autostart: boolean; actualSource: ActualSourceConfig | null; ecoflowClientId?: string; ecoflowAppClientUuid?: string;
    }
    export interface LocationState {
      location: Location; snapshot: ScheduleSnapshot | null; phase: RefreshPhase; lastError?: string; lineChanged: boolean;
      /** Only on the EcoFlow location (settings.actualLocationId). */
      actual?: ActualStatus | null;
    }
    export interface AppState {
      settings: Settings; locations: LocationState[];
      /** The station's own status, for the EcoFlow card only; views read LocationState.actual. */
      actual?: ActualStatus | null;
      /** False until a read of settings.json has succeeded: the settings shown are then only a display fallback. */
      settingsLoaded: boolean;
    }
    export interface WidgetState { location: LocationState; showName: boolean }
    ```
  - `src/shared/locations.ts`:
    ```ts
    export const MAX_LOCATIONS = 5, NAME_MAX = 24, HOME_ID = 'home', HOME_NAME = 'Дім';
    export const NAME_EMPTY = 'Вкажіть назву', NAME_LONG = 'Назва — до 24 символів', NAME_TAKEN = 'Така назва вже є';
    export const LIMIT_TEXT = 'Можна додати до 5 адрес', LAST_LOCATION = 'Останню адресу видалити не можна', UNKNOWN_LOCATION = 'Цієї адреси вже немає';
    export interface LocationInput { name: string; address: Address; widgetStyle: WidgetStyle }
    export function normalizeName(name: string): string;              // trim + collapse inner whitespace
    export function nameProblem(name: string, taken: string[]): string | null; // checks normalizeName(name); taken compared normalized + lower-cased
    export function sameAddress(a: Address | null | undefined, b: Address): boolean; // same six fields (moved from refresh.ts)
    export function isAddress(v: unknown): v is Address;            // strings + integer lineIndex
    ```
  - `src/main/settings-migration.ts`: `export function migrateSettings(raw: Record<string, unknown>): { settings: Settings; migrated: boolean }`.
  - `src/main/store.ts`:
    ```ts
    export const DEFAULT_SETTINGS: Settings = { locations: [], actualLocationId: null, autostart: true, actualSource: null };
    export class LocationError extends Error {}
    export class AppStore {
      constructor(dir: string, deps?: { readFile?: ReadFile; writeFile?: (path: string, text: string) => void; newId?: () => string });
      getSettings(): Settings;                      // never throws (as today)
      get settingsLoaded(): boolean;                // true once a read succeeded (a missing file counts)
      updateSettings(patch: Partial<Omit<Settings, 'locations'>>): Settings;
      getLocation(id: string): Location | null;
      addLocation(input: Omit<Location, 'id'>): Location;
      updateLocation(id: string, fn: (l: Location) => Location): Location;
      removeLocation(id: string): void;
      getSnapshot(id: string): ScheduleSnapshot | null;
      setSnapshot(id: string, s: ScheduleSnapshot | null): void;
    }
    ```
    `newId` defaults to `crypto.randomUUID()`. `writeFile` defaults to today's tmp-plus-rename write.

- [ ] **Step 1: Write the failing tests**

`tests/shared/locations.test.ts`:
```ts
test('name rules', () => {
  expect(nameProblem('   ', [])).toBe('Вкажіть назву');
  expect(nameProblem('я'.repeat(25), [])).toBe('Назва — до 24 символів');
  expect(nameProblem('я'.repeat(24), [])).toBeNull();
  expect(nameProblem('  дім ', ['Дім'])).toBe('Така назва вже є');
  expect(nameProblem('Батьки', ['Дім'])).toBeNull();
  expect(normalizeName('  Мамин   дім ')).toBe('Мамин дім');
});
test('isAddress', () => {
  expect(isAddress(fixtureSnapshot().address)).toBe(true);
  expect(isAddress({ ...fixtureSnapshot().address, lineIndex: '1' })).toBe(false);
});
```
`tests/main/settings-migration.test.ts`:
- **«an old address becomes location home»:**
  - Input `{ address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 }, autostart: false, actualSource: CONFIG, ecoflowClientId: 'c1' }`.
  - Expect `settings.locations` to equal `[{ id: 'home', name: 'Дім', address, widgetStyle: 'timeline', widgetPosition: { x: 10, y: 20, displayId: 1 } }]`.
  - Expect `actualLocationId: 'home'`, `autostart: false`, `actualSource: CONFIG`, `ecoflowClientId: 'c1'`.
  - Expect `'address' in settings`, `'widgetStyle' in settings` and `'widgetPosition' in settings` all false, and `migrated: true`.
- **«no style → compact»** gives `widgetStyle: 'compact'` and `widgetPosition: null`.
- **«address null → no locations»** gives `{ locations: [], actualLocationId: null }` and `migrated: true`.
- **«the new shape is left alone»** returns the same `locations` and `migrated: false`.

`tests/main/store.test.ts`: reshape the existing tests to the new API (`updateSettings({ autostart })`, `setSnapshot(id, …)`), and add:
- **«a real old settings file migrates whole»:**
  - Write the legacy file from Review Focus 1, plus `snapshot.json` = `fixtureSnapshot()`.
  - `new AppStore(dir).getSettings()` has location `home`.
  - `JSON.parse(readFileSync(settings.json))` has `locations`, and has no `address`, `widgetStyle` or `widgetPosition`.
  - `getSnapshot('home')` equals the fixture, and `snapshot.json` no longer exists.
- **«a legacy snapshot for another address is not carried»:** `getSnapshot('home')` is null.
- **«a migration that cannot be written keeps the same id»:**
  - `writeFile` throws.
  - Two `getSettings()` calls both give id `'home'`.
  - The file on disk is unchanged.
- **«unreadable at start: defaults for display, not loaded»:**
  - `lockable` with `failures = Infinity`. `getSettings()` equals `DEFAULT_SETTINGS`, `settingsLoaded` is false, and nothing is written.
  - Then `failures = 0`: the real settings come back and `settingsLoaded` is true.
- **«addLocation»:**
  - The first add sets `actualLocationId` to its id. The second leaves it.
  - A duplicate name throws `LocationError` `'Така назва вже є'`.
  - A sixth add throws `'Можна додати до 5 адрес'`.
  - Ids come from `newId`.
- **«updateLocation reads fresh: another writer's change survives»:**
  - Stores A and B share a dir.
  - `A.updateLocation('home', l => ({ ...l, widgetPosition: P }))`, then `B.updateLocation('home', l => ({ ...l, name: 'Хата' }))`.
  - The file has both P and «Хата».
  - An unknown id throws `'Цієї адреси вже немає'`. An `fn` that changes `id` still writes the old id.
- **«removeLocation»:**
  - Removing the last location throws `'Останню адресу видалити не можна'`.
  - Removing another drops its snapshot entry.
  - `actualLocationId` becomes null only when it pointed at the removed location.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/shared/locations.test.ts tests/main/settings-migration.test.ts tests/main/store.test.ts`
Expected: FAIL (missing modules and exports).

- [ ] **Step 3: Implement**

- **Migration.** `migrateSettings` runs when `raw.locations` is not an array. It returns `{ ...DEFAULT_SETTINGS, ...rest }` with the three legacy keys removed.
- **Reading.** `AppStore` reads the raw object, migrates it, and sets `settingsLoaded = true`.
- **When the read migrated something:**
  1. If `snapshots.json` has no `home` entry, and `snapshot.json` parses with `sameAddress` to the migrated address, write `snapshots.json` with `{ home: … }`.
  2. Write `settings.json`. A failed write is swallowed, so the in-memory result is used and the next write carries it.
  3. Remove `snapshot.json` only after both writes succeeded.
- **Location operations.** Every add, update and remove is a read-validate-write in one synchronous call, through `nameProblem` and the limit. `fn`'s result keeps the original `id`.
- **The snapshot cache** is `snapshots.json`, of the form `{ [id]: ScheduleSnapshot }`. `setSnapshot(id, null)` deletes the entry.
- **`getSettings()`** falls back to `lastSettings ?? DEFAULT_SETTINGS`, both in the new shape.

- [ ] **Step 4: Run the tests and the suite**

Run: `npx vitest run`
Expected: the three files PASS. Any other failure is only in `tests/main/refresh.test.ts`, which Task 2 rewrites.

Expected type errors in later tasks' files: `refresh.ts`, `ipc.ts`, `index.ts`, `tray-menu.ts`, `widget-window.ts`, and the renderer. List them in the report.

- [ ] **Step 5: Commit**

```bash
git add src/shared/locations.ts src/shared/types.ts src/main/settings-migration.ts src/main/store.ts tests/shared/locations.test.ts tests/main/settings-migration.test.ts tests/main/store.test.ts
git commit -m "Locations: the settings model, its migration and the store" -m "<one paragraph body>"
```

---

### Task 2: Per-location refresh, schedulers and location actions

**Files:**
- Modify: `src/main/refresh.ts`, `src/main/scheduler.ts`
- Create: `src/main/keyed.ts`, `src/main/location-actions.ts`
- Test: `tests/main/refresh.test.ts`, `tests/main/scheduler.test.ts`, `tests/main/keyed.test.ts`, `tests/main/location-actions.test.ts`

**Interfaces:**
- Consumes: Task 1's `AppStore`, `LocationError`, `sameAddress`, `isAddress`, `LocationInput`, `normalizeName` and `UNKNOWN_LOCATION`.
- Produces:
  ```ts
  // refresh.ts
  export class RefreshService {
    constructor(deps: { store: AppStore; getProvider(id: string): ScheduleProvider });
    getStates(): LocationState[];                 // settings.locations order, `actual` never set here
    onState(cb: () => void): () => void;          // any location's state changed
    refresh(id: string): Promise<RunOutcome>;     // one run per id at a time; unknown id → 'ok'
    addressChanged(id: string): Promise<void>;    // drops the id's snapshot and last error, then refresh(id)
    forget(id: string): void;                     // drops the id's phase/error
  }
  // scheduler.ts
  export const STAGGER_MS = 30_000;
  RefreshScheduler.start(delayMs = 0): void
  export function startDelays(locations: Location[], step = STAGGER_MS): Map<string, number>;
  // keyed.ts
  export class Keyed<T> {
    constructor(create: (id: string) => T, dispose: (item: T, id: string) => void);
    sync(ids: string[]): void; get(id: string): T | undefined; ids(): string[]; values(): T[]; clear(): void;
  }
  // location-actions.ts
  export interface LocationActions {
    add(input: unknown): Location; edit(id: unknown, input: unknown): Promise<void>; rename(id: unknown, name: unknown): void;
    remove(id: unknown): void; setStyle(id: unknown, style: unknown): void; setActualLocation(id: unknown): void;
  }
  export function createLocationActions(deps: {
    store: AppStore; service: Pick<RefreshService, 'addressChanged' | 'forget'>;
    isProvider(id: string): boolean; placeNew(style: WidgetStyle): WidgetPosition; changed(): void;
  }): LocationActions;
  ```

- [ ] **Step 1: Write the failing tests**

`refresh.test.ts`: reshape to two locations added through the store, and add:
- **«one location's failure leaves the other alone»:** A's provider throws `ProviderError` and B's resolves. Expect A `{ phase: 'error' }`, B `{ phase: 'ok' }`, and B's snapshot stored under B's id.
- **«a result for a deleted location is dropped»:**
  - A's fetch is a deferred promise.
  - `refresh(A)` starts. `store.removeLocation(A)` and `forget(A)` run, then the promise resolves.
  - Outcome is `'ok'`, `store.getSnapshot(A)` is null, and `getStates()` has no A.
- **«an address changed mid-fetch refetches with the new one»:** the provider is called twice, and the second call has the new `house`.
- **«a cached snapshot for another address is not shown»** keeps the existing behaviour, per location.
- **«addressChanged drops the snapshot and the error».**

`scheduler.test.ts`:
- **«start(delay)»:** with fake timers, the first run happens at `delay` and not before.
- **«startDelays»:** for `[A dtek-krem, B dtek-krem, C voe, D dtek-krem]`, expect `A 0, B 30000, C 0, D 60000`.

`keyed.test.ts`:
- `sync(['a','b'])` creates a and b in order.
- `sync(['b','c'])` disposes a, keeps the same b object, and creates c.
- `clear()` disposes b and c.

`location-actions.test.ts`:
- **`add`:**
  - Validates: a bad style throws, a provider unknown to `isProvider` throws, and the store's name rules apply.
  - Stores `normalizeName(name)` with `widgetPosition = placeNew(style)`.
  - Calls `changed()` once.
- **`edit` with the same address** never calls `addressChanged`. **With a new house** it calls it once, after the store write.
- **`remove`** calls the store, then `forget(id)`, then `changed()`.
- **`setActualLocation`** throws `'Цієї адреси вже немає'` for an unknown id.
- **Any non-string id** throws the same text.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/main/refresh.test.ts tests/main/scheduler.test.ts tests/main/keyed.test.ts tests/main/location-actions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **The refresh loop.** It is today's loop keyed by id, with `inFlight` and phases held in `Map`s:
  - `doRefresh` reads `store.getLocation(id)`. With no location it returns `'ok'` without emitting.
  - After the fetch, a location that is gone returns `'ok'` without writing.
  - A location whose address changed returns `'stale'`.
- **`lineChanged`** is computed per location as today.
- **`startDelays`** counts the earlier locations with the same `address.providerId`.
- **Location actions validate their inputs:** `isAddress`, `isProvider`, and the style in `['compact','ring','timeline']`. Invalid input throws `LocationError`. Store errors pass through.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/main/refresh.ts src/main/scheduler.ts src/main/keyed.ts src/main/location-actions.ts tests/main/refresh.test.ts tests/main/scheduler.test.ts tests/main/keyed.test.ts tests/main/location-actions.test.ts
git commit -m "Locations: per-location refresh, staggered schedulers, location actions" -m "<body>"
```

---

### Task 3: One widget window per location

**Files:**
- Modify: `src/main/widget/widget-window.ts`, `src/main/widget/position.ts`, `src/main/widget/pin-win32.ts`, `src/main/widget/glass-updater.ts`
- Test: `tests/main/position.test.ts`, `tests/main/widget-window.test.ts` (new; `vi.mock('electron')` with a fake `BrowserWindow`, `screen` and `app`), `tests/main/pin-win32.test.ts` (new; `vi.mock('koffi')`)

**Interfaces:**
- Consumes: Task 1's `AppStore.getLocation` and `AppStore.updateLocation`.
- Produces:
  ```ts
  // position.ts (placeWidget keeps today's behaviour for a saved position on a live display)
  export const GAP = 16;
  export interface Rect { x: number; y: number; width: number; height: number }
  export function findFreeSpot(area: Rect, size: { width: number; height: number }, others: Rect[]): { x: number; y: number } | null;
  export function placeWidget(pos: WidgetPosition | null, size, displays: DisplayLike[], primaryId: number, others?: Rect[]): WidgetPosition;
  export function placeNewWidget(size, displays: DisplayLike[], primaryId: number, anchorDisplayId: number | undefined, others: Rect[]): WidgetPosition;
  // widget-window.ts
  export interface WidgetWindowDeps {
    locationId: string; store: AppStore; pinner: DesktopPinner; preload: string; log?: Logger;
    /** The other widgets' bounds (DIP). */
    otherBounds(): Rectangle[];
    /** True once the app is quitting. */
    quitting(): boolean;
  }
  export class WidgetWindow {
    readonly locationId: string;
    show(): void; sync(): void; refit(): void; owns(contents: WebContents): boolean; dispose(): void;
    send(channel: string, payload: unknown): void; setBackground(b: WidgetBackground): void;
    drag(phase, x, y): void; beginMoveMode(): void; endMoveMode(): void; popupMenu(t): void; getBoundsDip(): Rectangle;
    onMoved(cb: () => void): () => void;
  }
  // glass-updater.ts: startGlassUpdater(widget) unsubscribes its onMoved in the returned disposer.
  ```
  - `sync()` re-reads the location's style and applies a change the way `setStyle` does today.
  - `setStyle` itself is removed, and so are the constructor's `app` and `screen` listeners. `index.ts` calls `refit()` on display events (Task 5).

- [ ] **Step 1: Write the failing tests**

`position.test.ts`, existing tests unchanged, plus:
- **«findFreeSpot: the corner when free»:** gives `{ x: 1920-290-24, y: 24 }` on the primary area.
- **«findFreeSpot: below a widget in the corner, 16 apart»:** `others = [{ x: 1606, y: 24, width: 290, height: 150 }]` gives `{ x: 1606, y: 24+150+16 }`.
- **«findFreeSpot: next column when the column is full»:** a widget column that fills the height gives an x with `x + 290 + 16 <= 1606`.
- **«findFreeSpot: null when full».**
- **«placeWidget: a gone display takes a free spot»:** a saved position on display 9 with `others` in the corner gives a spot below it, not the corner.
- **«placeNewWidget: anchor display, else primary».**

`widget-window.test.ts`:
- **«commit saves to its own location only»:** drag start, move, end, then `updateLocation` is called with this id. The other location's position is unchanged.
- **«sync applies a stored style change»:** `pinner.setBounds` is called with the new size.
- **«a disposed widget is never rebuilt»:**
  - After `dispose()`, firing the fake window's `closed` and advancing timers by 1100 ms creates no new `BrowserWindow`.
  - `pinner.dispose` is called.
  - Not-quitting and not-disposed (today's case) still rebuilds after 1000 ms.
- **«owns»:** true for its `webContents` and false for another.

`pin-win32.test.ts`, «each widget gets its own pinner; user32 loads once»:
- Two `new Win32DesktopPinner()` give `koffi.load` called once and `koffi.struct` called once.
- `dispose()` clears each one's timer.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/main/position.test.ts tests/main/widget-window.test.ts tests/main/pin-win32.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **`findFreeSpot`** scans columns from x = `area.x + area.width - w - 24` down to `area.x + 24`, in steps of 16. Within each column it scans y from `area.y + 24` to `area.y + area.height - h - 24`, also in steps of 16. It returns the first rect that does not intersect any `other` inflated by `GAP`.
- **`placeWidget`'s fallback** for a missing display uses `findFreeSpot` on the primary display, else today's corner.
- **`loadUser32`** is memoized at module level.
- **The window's position and style** come from `store.getLocation(locationId)`. Writes go through `updateLocation(locationId, l => ({ ...l, widgetPosition }))`.
- **The rebuild guard** on `closed` is `!deps.quitting() && !this.disposed`.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/main/widget tests/main/position.test.ts tests/main/widget-window.test.ts tests/main/pin-win32.test.ts
git commit -m "Locations: one widget window per location, free-spot placement, a pinner each" -m "<body>"
```

---

### Task 4: State composition and the tray

**Files:**
- Create: `src/main/compose-state.ts`
- Modify: `src/main/tray-menu.ts`, `src/main/tray.ts`
- Test: `tests/main/compose-state.test.ts`, `tests/main/tray-menu.test.ts`

**Interfaces:**
- Consumes: Task 1's types, and Task 2's `LocationState[]` from `RefreshService.getStates()`.
- Produces:
  ```ts
  export function composeAppState(settings: Settings, locations: LocationState[], actual: ActualStatus | null | undefined, settingsLoaded: boolean): AppState;
  export function widgetStateOf(state: AppState, id: string): WidgetState | null; // showName = state.locations.length > 1
  // tray-menu.ts
  export interface TrayActions {
    showWindow(): void; showSchedule(): void; refreshAll(): void;
    setStyle(locationId: string, s: WidgetStyle): void; moveWidget(locationId: string): void;
    openSettings(): void; toggleAutostart(): void; solveCaptcha(): void; quit(): void;
  }
  export const TOOLTIP_MAX = 127;
  export function trayView(state: AppState, now: Date): WidgetView | null;      // locations[0], with its own actual
  export function trayTooltip(state: AppState, now: Date): string;
  export function buildTrayMenu(state: AppState, a: TrayActions, platform: NodeJS.Platform, now: Date): MenuItemConstructorOptions[];
  export function buildWidgetMenu(style: WidgetStyle, a: { setStyle(s: WidgetStyle): void; refreshNow(): void; openSettings(): void; quit(): void }): MenuItemConstructorOptions[];
  ```
  `AppTray.update(state, now?)` calls these.

- [ ] **Step 1: Write the failing tests**

`compose-state.test.ts`:
- `actual` is attached only to the location whose id is `settings.actualLocationId`. `AppState.actual` is the station's status.
- With `actualLocationId: null`, no location carries `actual`.
- `settingsLoaded` is passed through.
- `widgetStateOf` gives `showName` false with one location and true with two, returns null for an unknown id, and never includes another location's snapshot.

`tray-menu.test.ts`, the existing tests reshaped to one location with the same labels as today, plus:
- **«two locations: style and move are submenus of names»:**
  - «Стиль віджета» has the submenu `['Дім', 'Батьки']`, and each of those has the three radio styles, checked from that location.
  - «Перемістити віджет» has the submenu `['Дім', 'Батьки']`. Clicking «Батьки» calls `moveWidget('b')`.
- **«two locations: tooltip lines»:** `'Дім: Світло є · Вимкнення о 15:00 · через 3 год 10 хв\nБатьки: Немає даних'`.
- **«tooltip cut to 127»:** five long-named locations give `length === 127`, ending in `'…'`.
- **«macOS: one disabled line per location»** with 2+ locations. One location keeps today's two lines.
- **«captcha on the second location shows Пройти перевірку».**
- **«no locations»:** tooltip `'Графік відключень — налаштуйте адресу'`, macOS line `'Налаштуйте адресу'`.
- **«the icon follows the first location»:** `trayView` uses `locations[0]`'s snapshot.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/main/compose-state.test.ts tests/main/tray-menu.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **A tooltip line** is `` `${name}: ${view.title} · ${view.nextText}` ``, or `` `${name}: Немає даних` `` without a view.
- **The joined lines** are cut to 126 characters plus `'…'` when they are longer than `TOOLTIP_MAX`.
- **With one location** the menu and tooltip are exactly today's.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/main/compose-state.ts src/main/tray-menu.ts src/main/tray.ts tests/main/compose-state.test.ts tests/main/tray-menu.test.ts
git commit -m "Locations: state per location, EcoFlow on its own location, the tray for several" -m "<body>"
```

---

### Task 5: IPC and the main-process wiring

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/main-window.ts`, `src/main/index.ts`
- Test: `tests/main/ipc-locations.test.ts` (new), `tests/main/actual/ipc-actual.test.ts` (deps reshaped only)

**Interfaces:**
- Consumes:
  - Task 1's `LocationInput`.
  - Task 2's `RefreshService`, `RefreshScheduler.start(delay)`, `startDelays`, `Keyed` and `createLocationActions`.
  - Task 3's `WidgetWindow` and `placeNewWidget`.
  - Task 4's `composeAppState`, `widgetStateOf`, `TrayActions` and `buildWidgetMenu`.
- Produces:
  - **Channels:**
    - removed: `saveAddress`;
    - added: `widgetGetState: 'widget:get-state'`, `widgetState: 'widget:state'`, `addLocation: 'loc:add'`, `editLocation: 'loc:edit'`, `renameLocation: 'loc:rename'`, `deleteLocation: 'loc:delete'`, `setActualLocation: 'loc:actual'`;
    - changed: `setWidgetStyle: 'loc:style'` now takes `(id, style)`, and `refreshNow` now takes `(id?)`.
  - **`MainNav`.** `export interface MainNav { view: MainView; locationId?: string }`. `navigate` now carries a `MainNav`.
  - **`RendererApi` changes:**
    ```ts
    getWidgetState(): Promise<WidgetState | null>; onWidgetState(cb: (s: WidgetState) => void): () => void;
    addLocation(input: LocationInput): Promise<void>; editLocation(id: string, input: LocationInput): Promise<void>;
    renameLocation(id: string, name: string): Promise<void>; deleteLocation(id: string): Promise<void>;
    setWidgetStyle(id: string, s: WidgetStyle): Promise<void>; refreshNow(id?: string): Promise<void>;
    setActualLocation(id: string): Promise<void>; onNavigate(cb: (nav: MainNav) => void): () => void;
    ```
    `saveAddress` is removed.
  - **`MainWindow.open(view?: MainView, locationId?: string)`.** The first load gets the query `view` and `location`. Later calls send a `MainNav`.
  - **`IpcDeps`.**
    - Removed: `service.setAddress`, `widgetDrag`, `widgetContextMenu`, `endMoveMode` and `scheduler`.
    - Added:
      ```ts
      locations: LocationActions;
      refresh(id?: string): void;            // manual trigger: one location's scheduler, or every one
      widgets: { find(sender: WebContents): { locationId: string; drag(p: DragPhase, x: number, y: number): void; contextMenu(): void; endMoveMode(): void } | undefined };
      getWidgetState(locationId: string): WidgetState | null;
      openMainWindow(view?: MainView, locationId?: string): void;
      ```

- [ ] **Step 1: Write the failing tests**

`ipc-locations.test.ts`, using `vi.mock('electron')` as in `ipc-lines.test.ts`. Call the registered handlers with fake events `{ sender }`:
- **`widget:get-state`** from widget A's sender gives `getWidgetState('a')`. An unknown sender gives `null`.
- **`widget:drag`** from an unknown sender does nothing. From A's sender it calls A's `drag` with the phase and coordinates. Bad coordinates are ignored, as today.
- **`window:open-main`** from A's sender calls `openMainWindow('schedule', 'a')`. From the main window, meaning a non-widget sender, it calls `openMainWindow('settings', undefined)`.
- **`loc:add`, `loc:edit`, `loc:rename`, `loc:delete`, `loc:style` and `loc:actual`** pass their arguments to `locations.*` unchanged.
- **`refresh:now`** with `'b'` calls `refresh('b')`. Without an argument it calls `refresh(undefined)`.

`ipc-actual.test.ts`: change only the deps object it builds, with no behaviour change.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/main/ipc-locations.test.ts tests/main/actual/ipc-actual.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **`ipc.ts`.** Widget channels get handlers that keep the event (`ipcMain.handle(channel, (e, ...a) => …)`) and route by `deps.widgets.find(e.sender)`.
- **`index.ts`:**
  - **Two `Keyed` sets.**
    - The schedulers are `new RefreshScheduler(() => service.refresh(id))`, started with the boot `startDelays` value for that id, used once, else 0.
    - The widgets get their own `createDesktopPinner(log)`. On win32 they also get their own `startGlassUpdater`, stopped in `dispose`.
  - **Reconcile in `publish()`** whenever `store.settingsLoaded`: `sync(settings.locations.map(l => l.id))` on both sets, then `widget.sync()` and `show()` for each.
  - **Display events** (`display-added`, `display-removed`, `display-metrics-changed`) call `refit()` on every widget in location order.
  - **`before-quit`** sets the `quitting` flag the widgets read.
  - **`publish()`** sends the `AppState` to the tray and the main window, and `widgetStateOf(state, id)` to each widget on `IPC.widgetState`.
  - **`placeNew(style)`** is `placeNewWidget(WIDGET_SIZES[style], screen.getAllDisplays(), primaryId, displayIdOf(locations[0]), widgets.values().map(w => w.getBoundsDip()))`.
  - **`solveCaptcha(providerId?)`:**
    - The provider is the argument, else the first captcha location's, else `locations[0]`'s.
    - After `showVerification`, every location on that provider gets `trigger('manual')`.
  - **Tray actions.** `refreshAll` triggers every scheduler. Each widget's right-click menu is `buildWidgetMenu` bound to that widget's id: its style, its own refresh, and its own settings (`openMainWindow('settings', id)`).
  - **`resume` and `online`** reach every scheduler.
  - **At boot**, the setup wizard opens only `if (store.settingsLoaded && settings.locations.length === 0)`.

- [ ] **Step 4: Run the suite and the node typecheck**

Run: `npx vitest run`, then `npx tsc --noEmit -p tsconfig.node.json`
Expected: vitest green, and the node project is free of type errors. Web project errors are left to Tasks 6–8.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/ipc.ts src/main/main-window.ts src/main/index.ts tests/main/ipc-locations.test.ts tests/main/actual/ipc-actual.test.ts
git commit -m "Locations: IPC routed by sender, one scheduler and widget per location in main" -m "<body>"
```

---

### Task 6: The widget renderer

**Files:**
- Modify: `src/renderer/src/widget/WidgetRoot.tsx`, `src/renderer/src/widget/Widget.tsx`, `src/renderer/src/widget/parts.tsx`, `src/renderer/src/widget/TimelineWidget.tsx`
- Test: `tests/renderer/widget.test.tsx`, `tests/renderer/widget-root.test.tsx`

**Interfaces:**
- Consumes: Task 1's `WidgetState`, and Task 5's `getWidgetState` and `onWidgetState`.
- Produces:
  - `Widget({ state: WidgetState; now: Date; background: WidgetBackground; children?: ReactNode })`.
  - The style is `state.location.location.widgetStyle`.
  - The «Налаштуйте адресу» body is gone, because a widget only exists for a location.

- [ ] **Step 1: Write the failing tests**

`widget.test.tsx`: reshape `st()` to build a `WidgetState`, and add:
- **«one location: the caption is today's»:** `.w-cap` is `'Лінія 1 · черга 1.2 · оновлено 11:48'`.
- **«several: the caption leads with the name»** (`test.each` over the three styles):
  - `.w-cap` starts with `'Батьки · Лінія 1 · черга 1.2'`.
  - Its `title` starts with `'Батьки · '`.
  - The name sits inside the ellipsized part (`.w-ellipsis`), never in `.w-fixed`.
- **«the name shows before the first schedule»:** the snapshot is null, `showName` is true, and `.w-cap` has the text `'Батьки'`.
- **«a widget never shows another location's actual»:** a location state without `actual` has no EcoFlow chip.

`widget-root.test.tsx`: switch it to `getWidgetState` and `onWidgetState`. A pushed state is never overwritten by the initial fetch, as today.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/renderer/widget.test.tsx tests/renderer/widget-root.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **The caption label** is `[showName ? name : '', lineLabel]` joined with `' · '`. For the timeline it is `[name, lineLabel, provider]`.
- **`Caption`** renders when `updated` is set or the label is not empty.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/widget tests/renderer/widget.test.tsx tests/renderer/widget-root.test.tsx
git commit -m "Locations: the widget shows its own location and, among several, its name" -m "<body>"
```

---

### Task 7: The setup wizard: first, add, edit

**Files:**
- Modify: `src/renderer/src/app/SetupWizard.tsx`, `src/renderer/src/app/app.css`
- Test: `tests/renderer/setup-wizard.test.tsx`

**Interfaces:**
- Consumes: Task 1's `nameProblem`, `HOME_NAME` and `LocationInput`, and Task 5's `addLocation` and `editLocation`.
- Produces:
  ```ts
  export type WizardMode =
    | { kind: 'first' }
    | { kind: 'add'; taken: string[]; style: WidgetStyle }          // style = locations[0]'s
    | { kind: 'edit'; location: Location; taken: string[] };        // taken excludes its own name
  export function SetupWizard(props: { api: RendererApi; autostart: boolean; mode: WizardMode; onDone(): void; onCancel?(): void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

Reshape the existing wizard tests to `mode: { kind: 'first' }`, and add:
- **«first: Дім is filled in and one addLocation call saves everything»:**
  - On the «Готово» step, the field labelled «Назва» has the value «Дім».
  - «Завершити» calls `addLocation({ name: 'Дім', address, widgetStyle })` once.
  - No separate style call is made.
- **«add: empty name with the placeholder, Завершити disabled until named»:**
  - The placeholder is «Наприклад, Батьки».
  - Typing «Батьки» enables «Завершити».
  - Typing «дім» with `taken: ['Дім']` shows «Така назва вже є» and keeps it disabled.
- **«add: the style step starts from mode.style».**
- **«edit: name and style from the location; saving calls editLocation(id, …)».**
- **«a failed save shows the error and saves nothing else»:** `addLocation` rejects, and the text is shown as today's `saveError` is.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/renderer/setup-wizard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **The name field** sits on the «Готово» step, above the autostart card. Its label is «Назва» and its `maxLength` is 24.
- **The problem text** from `nameProblem` shows after the first edit. On the first view only the button stays disabled.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app/SetupWizard.tsx src/renderer/src/app/app.css tests/renderer/setup-wizard.test.tsx
git commit -m "Locations: the wizard names the location and saves it in one call" -m "<body>"
```

---

### Task 8: The main window: switcher, per-location schedule and settings, EcoFlow picker

**Files:**
- Modify: `src/renderer/src/app/App.tsx`, `src/renderer/src/app/ScheduleView.tsx`, `src/renderer/src/app/SettingsView.tsx`, `src/renderer/src/app/ActualSettings.tsx`, `src/renderer/src/app/main.tsx` (reads the `location` query), `src/renderer/src/app/app.css`
- Test: `tests/renderer/app.test.tsx`, `tests/renderer/schedule-view.test.tsx`, `tests/renderer/settings-view.test.tsx`, `tests/renderer/actual-settings.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 5 and 7.
- Produces:
  ```ts
  App({ api, view, locationId }: { api: RendererApi; view: MainView; locationId?: string })
  ScheduleView({ loc, settings, now, api, onConnectEcoflow, onChangeAddress }: { loc: LocationState; settings: Settings; now: Date; api: RendererApi; onConnectEcoflow(): void; onChangeAddress(): void })
  SettingsView({ state, loc, api, ecoflowFormOpen, onChangeAddress, onAdd }: { state: AppState; loc: LocationState; api: RendererApi; ecoflowFormOpen?: boolean; onChangeAddress(): void; onAdd(): void })
  ActualSettings({ state, api, initiallyOpen })   // reads AppState.actual and settings.actualLocationId
  ```

- [ ] **Step 1: Write the failing tests**

`app.test.tsx`, with the existing tests reshaped:
- **«settings not loaded: a note, never the wizard»:**
  - `settingsLoaded: false` shows «Не вдалося прочитати налаштування. Спробую ще раз за хвилину.» and no wizard.
  - `settingsLoaded: true` with no locations shows the wizard, with no «Скасувати».
- **«one location: no switcher»:** no `tablist` named «Адреси».
- **«two locations: the switcher picks the schedule»:**
  - The tablist «Адреси» has «Дім» and «Батьки».
  - Clicking «Батьки» shows Батьки's status.
  - The refresh button calls `refreshNow('b')`.
- **«a navigate with a locationId selects it».**
- **«Додати адресу opens the add wizard; Скасувати returns without saving».**

`schedule-view.test.tsx`:
- **«EcoFlow only on its location»:** a location state with `actual` shows the actual row. The other location shows neither the row nor «Підключити EcoFlow».
- **«not connected: the prompt only on actualLocationId».**
- **«the line-changed banner's Змінити адресу calls onChangeAddress».**
- **«captcha action solves this location's provider».**

`settings-view.test.tsx`:
- **«the address card shows the selected location's name and address».**
- **«Перейменувати edits inline»:**
  - «Зберегти» calls `renameLocation(id, 'Хата')`.
  - «Скасувати» calls nothing.
  - A taken name shows «Така назва вже є».
- **«Видалити asks first»:**
  - The text is «Видалити локацію «Батьки»? Її віджет зникне з робочого столу.»
  - Confirming calls `deleteLocation('b')`. «Скасувати» does not.
  - There is no «Видалити» with one location.
- **«Додати адресу disabled at 5 with Можна додати до 5 адрес».**
- **«the style card sets the selected location's style»:** `setWidgetStyle('b', 'ring')`.

`actual-settings.test.tsx`:
- **«two locations: Станція стоїть у: picks the location»:** `setActualLocation('b')`.
- **«one location: no picker».**
- **«actualLocationId null: Оберіть, де стоїть станція and the picker, even with one location».**

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/renderer`
Expected: FAIL.

- [ ] **Step 3: Implement**

- **The selection** starts on `locationId` if it exists, else `locations[0]`. It follows `onNavigate`'s `locationId`. If the selected id disappears, it falls back to `locations[0]`.
- **The switcher** is a `role="tablist"` named «Адреси», one `role="tab"` pill per name, placed next to the section tabs, with names ellipsized by CSS. Use the existing tokens in `ui/tokens.css`.
- **The wizard modes:**
  - no locations → `first`;
  - «Додати адресу» → `add` with `taken` = every name and `style` = `locations[0]`'s;
  - «Змінити адресу» and the line-changed banner → `edit` for the selected location;
  - `view: 'setup'` → `edit` for the selected location, or `first` with no locations.

- [ ] **Step 4: Run the suite and the full typecheck**

Run: `npx vitest run`, then `npm run typecheck`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app tests/renderer
git commit -m "Locations: the main window switches between locations; EcoFlow picks its own" -m "<body>"
```

---

### Task 9: The UI capture rig for several locations, and a visual check

**Files:**
- Modify: `scripts/ui-capture/scenarios.cjs`, `scripts/ui-capture/preload.cjs`, `scripts/ui-capture/capture.cjs` (only where it builds or patches the state), `scripts/ui-capture/README.md`
- Test: `tests/ui-capture/scenarios.test.ts`

**Interfaces:**
- Consumes: the `AppState` and `WidgetState` shapes from Task 1, and the renderer API from Task 5.
- Produces:
  - `buildScenario(name, opts)` returns `{ nowMs, state: AppState, widget: WidgetState, stubs }`.
  - A new option, `--locations 2`, adds a second location, «Батьки», with the same snapshot.
  - The fake `window.api` adds `getWidgetState`, `onWidgetState` and every Task 5 method, as resolved no-ops.

- [ ] **Step 1: Update the test**

`scenarios.test.ts` reads `state.locations[0].snapshot`, `.lineChanged` and `.actual` where it read the top-level fields. Add:
- **«--locations 2»** gives `state.locations.map(l => l.location.name)` equal to `['Дім', 'Батьки']`, and `widget.showName === true`.

- [ ] **Step 2: Run it to see it fail, then implement, then see it pass**

Run: `npx vitest run tests/ui-capture/scenarios.test.ts`

- [ ] **Step 3: Build and capture for the review**

Run:
- `npm run build`
- `npm run ui:capture -- --target widget --style all --scenario on --theme light,dark --locations 2 --out .superpowers/sdd/captures/locations`
- `npm run ui:capture -- --target app --view schedule,settings --scenario on,ecoMatch --theme light,dark --locations 2 --out .superpowers/sdd/captures/locations`

Expected:
- Every JSON has `errors: []`.
- In the widget captures, the `caption` element has `outside: false`.
- In the app captures, `document.scrollWidth` is at most the viewport width.

Look at the PNGs:
- The name sits in the caption.
- The switcher pills fit next to the tabs.

Write what you saw in the report.

- [ ] **Step 4: Run the suite**

Run: `npx vitest run`, then `npm run typecheck`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add scripts/ui-capture tests/ui-capture
git commit -m "UI capture rig: the location shapes and a second location" -m "<body>"
```
