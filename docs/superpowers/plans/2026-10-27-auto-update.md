# Auto-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a down-arrow button (and a tray item) appears when a newer GitHub release exists. One click downloads it,
installs it and restarts the app, on Windows and on macOS.

**Architecture:**
- **Controller.** A pure `UpdateController` owns the state machine and the schedule: first check 2 min after start,
  then every 6 h. Its status joins `AppState`, so the window and the tray see it.
- **Backends.**
  - **Windows** wraps electron-updater's NSIS updater.
  - **macOS** uses electron-updater only to check. Its own code downloads and verifies the zip, unpacks it, and hands
    a small shell helper the job of swapping the `.app` after the app quits.
- **Feed.** A build-time constant can point the feed at a hidden test pre-release.

**Tech Stack:** Electron 44, electron-updater 6.8.11, electron-builder 26, React 19, vitest 5, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-27-auto-update-design.md`

**Checked while planning:** the spec's macOS Keychain point («a refused prompt must behave as unreadable secrets, not crash») already holds. `SecretStore.load` returns null on a decrypt failure (`src/main/actual/secrets.ts`, covered by `tests/main/actual/secrets.test.ts` «undecryptable or missing → null»). No task is needed; runbook step 2 confirms it on the Mac.

## Global Constraints

- Download only after the click. Never in the background, never on quit (`autoDownload = false`,
  `autoInstallOnAppQuit = false`).
- Any failure (check, download, verify, unpack, swap) leaves the running version working. A check failure is logged and
  shows nothing.
- UI copy is Ukrainian and exactly:
  - `Оновити застосунок до <v>`;
  - `Завантаження оновлення… <p> %`;
  - `Встановлення…`;
  - `Не вдалося оновити. Натисніть, щоб спробувати ще раз`.
- The feed is the repo `Alrighter/BlackoutWidget`: GitHub provider, latest full release only. The test override is the
  build-time constant `__UPDATE_FEED__`, from env `BW_UPDATE_FEED` at build time; empty in normal builds; no UI or
  settings key.
- Never call `setAlwaysOnTop`/`setVisibleOnAllWorkspaces` (macOS pinning). Quitting for an install goes through
  `app.quit()`, so `before-quit` and `will-quit` run.
- The updater runs only when `app.isPackaged`. Claude never runs the packaged or installed app.
- Commits: subject and body only, no `Co-Authored-By`, no Claude attribution.
- No new runtime dependency besides `electron-updater` (exact `6.8.11`, in `dependencies`).

## Review Focus

1. A download that dies halfway (outage, mobile data): the error state appears, the partial file is gone, and a click
   retries from zero. Tests: Task 3 (`fetch` stream errors mid-body); Task 1 (download rejects → `error`, retry →
   `downloading`).
2. Two quick clicks, or a scheduled check during a download: one download, no restart of it, no status jump. Test:
   Task 1.
3. A newer release appears while an older one is `available`: the button offers the newest. Test: Task 1.
4. macOS: the old process doesn't exit in time: the helper gives up without touching either bundle, and the reason
   reaches the app log on the next start. Tests: Task 3 (helper with a live pid, `BW_WAIT_S=1`; run on macOS CI) and
   Task 4 (log pickup).
5. The feed lists a file that 404s, or whose hash differs: error, nothing unpacked, the old app untouched. Test: Task 3.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | `UpdateStatus`; `AppState.update?` |
| `src/shared/update-text.ts` | The Ukrainian copy for the button and the tray item |
| `src/main/update/backend.ts` | `UpdateBackend` interface |
| `src/main/update/controller.ts` | State machine, schedule, status events |
| `src/main/update/feed.ts` | `UPDATE_FEED`, feed config, download base, release page |
| `src/main/update/updater.ts` | Configures electron-updater; `checkNewer()` |
| `src/main/update/win-backend.ts` | NSIS backend |
| `src/main/update/mac-backend.ts` | macOS backend: download, verify, unpack, helper, fallback |
| `src/main/update/mac-helper.ts` | The helper shell script text and its arguments |
| `src/main/update/helper-log.ts` | Moves the helper's log into the app log at start |
| `src/main/update/index.ts` | `createUpdates()`: the controller with the platform backend |
| `src/main/compose-state.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/main/tray-menu.ts`, `src/preload/index.ts`, `src/shared/ipc.ts` | Wiring |
| `src/renderer/src/app/App.tsx`, `UpdateButton.tsx`, `app.css` | The header button |
| `electron-builder.yml`, `electron.vite.config.ts`, `package.json`, `.github/workflows/build-mac.yml`, `README.md` | Build and release |

---

### Task 1: Update status, copy and controller

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/shared/update-text.ts`, `src/main/update/backend.ts`, `src/main/update/controller.ts`
- Test: `tests/shared/update-text.test.ts`, `tests/main/update/controller.test.ts`

**Interfaces:**
- Produces, in `src/shared/types.ts`:
  ```ts
  export type UpdateStatus =
    | { phase: 'idle' }
    | { phase: 'available'; version: string }
    | { phase: 'downloading'; version: string; percent: number }
    | { phase: 'installing'; version: string }
    | { phase: 'error'; version: string };
  // AppState gains:  update?: UpdateStatus   (absent = idle)
  ```
- Produces, in `src/shared/update-text.ts`:
  - `updateTooltip(s: UpdateStatus | undefined): string | null` (null when idle or absent);
  - `trayUpdateItem(s: UpdateStatus | undefined): { label: string; enabled: boolean } | null`.
- Produces, in `src/main/update/backend.ts`:
  ```ts
  export interface UpdateBackend {
    /** The newer version on the feed, or null. Never downloads. */
    check(): Promise<string | null>;
    /** False when this installation can't replace itself (macOS outside a writable folder). */
    canInstall(): boolean;
    /** The manual way: opens the release page of `version` in the browser. */
    openManual(version: string): void;
    /** Downloads (and on macOS verifies and unpacks) `version`; percent 0–100. Rejects on any failure. */
    download(version: string, onProgress: (percent: number) => void): Promise<void>;
    /** Quits the app and installs. Rejects if it could not start; then the app keeps running. */
    install(): Promise<void>;
  }
  ```
- Produces, in `src/main/update/controller.ts`:
  - `export const FIRST_CHECK_DELAY_MS = 120_000`;
  - `export const CHECK_INTERVAL_MS = 21_600_000`;
  - `class UpdateController`:
    - `constructor(deps: { backend: UpdateBackend; log: Logger; onChange(s: UpdateStatus): void })`;
    - `start(): void`;
    - `stop(): void`;
    - `status(): UpdateStatus`;
    - `check(): Promise<void>`;
    - `install(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`tests/shared/update-text.test.ts`:
```ts
test('tooltips', () => {
  expect(updateTooltip(undefined)).toBeNull();
  expect(updateTooltip({ phase: 'idle' })).toBeNull();
  expect(updateTooltip({ phase: 'available', version: '1.0.2' })).toBe('Оновити застосунок до 1.0.2');
  expect(updateTooltip({ phase: 'downloading', version: '1.0.2', percent: 42 })).toBe('Завантаження оновлення… 42 %');
  expect(updateTooltip({ phase: 'installing', version: '1.0.2' })).toBe('Встановлення…');
  expect(updateTooltip({ phase: 'error', version: '1.0.2' })).toBe('Не вдалося оновити. Натисніть, щоб спробувати ще раз');
});
test('tray item: clickable when available or after an error, disabled while working', () => {
  expect(trayUpdateItem({ phase: 'idle' })).toBeNull();
  expect(trayUpdateItem({ phase: 'available', version: '1.0.2' })).toEqual({ label: 'Оновити застосунок до 1.0.2', enabled: true });
  expect(trayUpdateItem({ phase: 'error', version: '1.0.2' })).toEqual({ label: 'Оновити застосунок до 1.0.2', enabled: true });
  expect(trayUpdateItem({ phase: 'downloading', version: '1.0.2', percent: 7 })).toEqual({ label: 'Завантаження оновлення… 7 %', enabled: false });
  expect(trayUpdateItem({ phase: 'installing', version: '1.0.2' })).toEqual({ label: 'Встановлення…', enabled: false });
});
```

`tests/main/update/controller.test.ts` uses `vi.useFakeTimers()` and a fake backend whose methods are `vi.fn`s with
controllable promises. It records every status `onChange` emits. Tests:
- `first check after FIRST_CHECK_DELAY_MS, then every CHECK_INTERVAL_MS`: count `backend.check` calls at
  119 999 ms (0), 120 000 ms (1), +21 600 000 ms (2). `stop()` stops further calls.
- `a newer version makes it available; none keeps it idle; a later newer version replaces the offered one`:
  - `'1.0.2'` → `{ phase: 'available', version: '1.0.2' }`;
  - then `'1.0.3'` → `{ ..., version: '1.0.3' }`;
  - then `null` → `{ phase: 'idle' }`.
- `a failed check logs one warning, shows nothing and the next interval checks again`: `check` rejects. Status stays
  `idle`, `log.warn` is called once, `onChange` is not called. The next tick calls `check` again.
- `install: available → downloading (integer percents, emitted only on change) → installing → backend.install()`:
  - progress `0.4, 0.9, 41.6, 41.9, 100` gives emitted percents `[0, 1, 42, 100]`;
  - then `{ phase: 'installing' }`;
  - `backend.install` is called once.
- `two clicks start one download; a scheduled check during the download does nothing`: `install()` twice →
  `download` once. Advancing past an interval while downloading → `check` not called.
- `download fails → error with the same version, one error log; a click retries the download`: after a rejection the
  status is `{ phase: 'error', version: '1.0.2' }`. `install()` again → `download` called a second time, status
  `downloading`.
- `install() fails to start → error`: `backend.install` rejects → `error`, logged.
- `idle install does nothing`: `install()` with status idle → no backend call.
- `a backend that can't install opens the release page and stays available`: `canInstall` returns false →
  `openManual('1.0.2')` is called, there is no download, the status stays `available`.

- [ ] **Step 2: Run them, expect FAIL**

Run: `npx vitest run tests/shared/update-text.test.ts tests/main/update/controller.test.ts`.
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the types, `update-text.ts`, `backend.ts`, `controller.ts`**
- `percent` is `Math.round(p)`, clamped to 0–100.
- A check only runs from `idle`, `available` or `error`; in `error` a newer version replaces the error with
  `available`.

- [ ] **Step 4: Run them, expect PASS; run `npm run typecheck`**

- [ ] **Step 5: Commit** `Update status, copy and the update controller`

---

### Task 2: electron-updater, the feed constant and the Windows backend

**Files:**
- Modify: `package.json` (dependency `"electron-updater": "6.8.11"`; `dist:win` gains `--publish never`),
  `electron.vite.config.ts` (`main.define`), `electron-builder.yml`
- Create: `src/main/update/feed.ts`, `src/main/update/updater.ts`, `src/main/update/win-backend.ts`
- Test: `tests/main/update/feed.test.ts`, `tests/main/update/win-backend.test.ts`

**Interfaces:**
- Produces, in `feed.ts`:
  - `declare const __UPDATE_FEED__: string`;
  - `export const UPDATE_FEED: string`: the constant, `''` when undefined (vitest);
  - `export function feedConfig(feed: string)`: `{ provider: 'generic', url: feed }` when `feed`, else
    `{ provider: 'github', owner: 'Alrighter', repo: 'BlackoutWidget' }`;
  - `export function downloadBase(feed: string, version: string): string`: `feed + '/'` when `feed`, else
    `https://github.com/Alrighter/BlackoutWidget/releases/download/v<version>/`;
  - `export function releasePage(version: string): string`:
    `https://github.com/Alrighter/BlackoutWidget/releases/tag/v<version>`.
- Produces, in `updater.ts`:
  ```ts
  /** What both backends use of electron-updater's AppUpdater (tests pass a fake). */
  export interface UpdaterLike {
    autoDownload: boolean; autoInstallOnAppQuit: boolean; allowDowngrade: boolean; logger: unknown;
    setFeedURL(options: object): void;
    checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfo } | null>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
    on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown;
    off(event: 'download-progress', cb: (p: { percent: number }) => void): unknown;
  }
  export function configureUpdater(u: UpdaterLike, log: Logger, feed: string): void;
  /** The update info when the feed has a newer version, else null. */
  export async function checkNewer(u: UpdaterLike): Promise<UpdateInfo | null>;
  ```
  `UpdateInfo` is electron-updater's type. Confirm `isUpdateAvailable` on `UpdateCheckResult` in
  `node_modules/electron-updater/out/*.d.ts`. If it is missing in 6.8.11, compare `updateInfo.version` with
  `app.getVersion()` using electron-updater's bundled semver comparison and note it in the report.
- Produces: `class WinBackend implements UpdateBackend`, built with `(u: UpdaterLike, openExternal: (url: string) => void)`.

- [ ] **Step 1: Write the failing tests**

`feed.test.ts`:
- the three functions with `''` and with `'https://github.com/Alrighter/BlackoutWidget/releases/download/update-test'`;
- `UPDATE_FEED === ''` under vitest.

`win-backend.test.ts`, with a fake `UpdaterLike` built on `EventEmitter`:
- `configureUpdater sets no auto download, no install on quit, no downgrade, the feed, and a logger that writes to log`:
  - the three flags are `false`;
  - `setFeedURL` gets `{ provider: 'github', owner: 'Alrighter', repo: 'BlackoutWidget' }`, and the generic config when
    a feed is given;
  - `logger.warn('x')` reaches `log.warn`.
- `check returns the newer version or null; a rejection propagates`.
- `download forwards download-progress percents and removes its listener afterwards`.
- `install calls quitAndInstall(true, true)`.
- `canInstall is true; openManual opens releasePage(version)`.

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement**
- `npm i electron-updater@6.8.11 --save-exact`.
- `electron.vite.config.ts` → `main.define: { __UPDATE_FEED__: JSON.stringify(process.env.BW_UPDATE_FEED ?? '') }`.
- `electron-builder.yml`:
  - add `publish: { provider: github, owner: Alrighter, repo: BlackoutWidget }`;
  - add `nsis.artifactName: Blackout-Widget-Setup-${version}.${ext}`.

- [ ] **Step 4: Run the tests, `npm run typecheck`, then `npm run dist:win`.**

Expected: PASS, and `dist/` holds `Blackout-Widget-Setup-1.0.0.exe`, its `.blockmap` and `latest.yml`. In `latest.yml`,
`path:` names that exe. `dist/win-unpacked/resources/app-update.yml` exists; NsisUpdater reads `publisherName` from it.
Do not run the built app.

- [ ] **Step 5: Commit** `electron-updater, the update feed and the Windows backend`

---

### Task 3: macOS backend and the swap helper

**Files:**
- Create: `src/main/update/mac-backend.ts`, `src/main/update/mac-helper.ts`
- Test: `tests/main/update/mac-backend.test.ts`, `tests/main/update/mac-helper.test.ts`

**Interfaces:**
- Consumes: `UpdaterLike`, `checkNewer`, `downloadBase`, `releasePage` (Task 2), `UpdateBackend` (Task 1).
- Produces, in `mac-helper.ts`:
  - `export const HELPER_SCRIPT: string`: the `/bin/sh` script;
  - `export function helperArgs(o: { pid: number; bundle: string; staged: string; log: string }): string[]`, returning
    `[pid, bundle, staged, log]` as strings.

  The script's environment knobs: `BW_OPEN` (default `open`) and `BW_WAIT_S` (default `60`).
- Produces, in `mac-backend.ts`:
  ```ts
  export interface MacBackendDeps {
    updater: UpdaterLike; feed: string; exePath: string; tempDir: string; helperLog: string; pid: number;
    fetch(url: string): Promise<Response>;
    exec(cmd: string, args: string[]): Promise<string>;      // stdout; rejects on non-zero exit
    spawnDetached(cmd: string, args: string[]): void;
    quit(): void; openExternal(url: string): void; log: Logger;
  }
  export class MacBackend implements UpdateBackend { constructor(deps: MacBackendDeps) }
  ```

**Behaviour** (from the spec):
- **`check`** keeps the last `UpdateInfo`.
- **`download(version)`:**
  1. Find the info's zip file (`files[]` entry ending `.zip`) and fetch `downloadBase(feed, version) + url`. Stream it
     into `<tempDir>/blackout-widget-update/<version>/<file>`, reporting percent of the `size` in the yml.
  2. Check the size and the base64 sha512.
  3. Wipe and recreate `<…>/<version>/app`, then run `exec('ditto', ['-x', '-k', zip, appDir])`.
  4. Require exactly one entry, `Blackout Widget.app`.
  5. `exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '<app>/Contents/Info.plist'])` must equal
     `version`.
  6. `exec('xattr', ['-dr', 'com.apple.quarantine', app])`; a failure here is only logged.

  Any other failure removes the version folder and rejects.
- **`canInstall()`:** the bundle is `path.resolve(exePath, '../../..')`. It must end in `.app`, and its parent must be
  writable (`fs.accessSync(parent, W_OK)`).
- **`install()`:**
  - write `HELPER_SCRIPT` to `<tempDir>/blackout-widget-update/swap.sh`;
  - `spawnDetached('/bin/sh', [script, ...helperArgs({ pid, bundle, staged: <app>, log: helperLog })])`;
  - `quit()`.
- **`openManual(v)`:** `openExternal(releasePage(v))`.

**Ruling (deviation from the spec, which said «download and open the dmg» when the bundle can't be replaced):** open
the release page instead. The manual step is the same (get the dmg, drag the app). It saves a second 130 MB download
and a dmg-mounting path for a rare case. Flag it to the user at handoff.

**Helper script.** An algorithm the tests don't fully determine:
```sh
pid="$1"; old="$2"; new="$3"; log="$4"; wait_s="${BW_WAIT_S:-60}"; opener="${BW_OPEN:-open}"
i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ "$i" -gt $((wait_s*5)) ] && { echo "the app did not quit" >>"$log"; exit 1; }; sleep 0.2; done
backup="$old.old-$$"
if mv "$old" "$backup" 2>>"$log"; then
  if mv "$new" "$old" 2>>"$log"; then rm -rf "$backup"; "$opener" "$old"; exit 0; fi
  mv "$backup" "$old" 2>>"$log"; echo "the new version could not be moved in; the old one is back" >>"$log"
else echo "the old version could not be moved aside" >>"$log"; fi
"$opener" "$old"; exit 1
```

- [ ] **Step 1: Write the failing tests**

`mac-backend.test.ts`: real temp dirs (`mkdtempSync`), a fake `fetch` returning `new Response(stream)`, and a fake
`exec`:
- `ditto` creates `<dest>/Blackout Widget.app/Contents/Info.plist`;
- `plutil` returns the version given to the fake;
- every command is recorded.

Tests:
- `download streams the zip, reports percent, verifies, unpacks, checks the plist version, clears quarantine`:
  - the commands are, in order, `ditto -x -k <zip> <appDir>`, `plutil …`, `xattr -dr com.apple.quarantine <app>`;
  - the progress ends at 100.
- `a wrong sha512 rejects before unpacking and removes the download`: no `ditto` call; the version folder is gone.
- `a 404 rejects; a stream that errors mid-body rejects and leaves no partial file`.
- `a zip with another app name, or a plist version that differs, rejects`.
- `canInstall: false outside a .app or when the parent folder is not writable`: use a read-only temp dir on POSIX;
  on Windows, check only the `.app` rule (`skipIf`).
- `install writes the helper, spawns /bin/sh with pid, bundle, staged app and log, then quits`.
- `openManual opens the release page`.

`mac-helper.test.ts` runs the script with `sh`. Skip when `spawnSync('sh', ['-c', 'exit 0']).status !== 0`. Make a fake
bundle dir `Old.app/v1`, a staged dir `New.app/v2`, `BW_OPEN=true`, and a dead pid (`999999`). Tests:
- `swaps the bundles and opens the new one`: `Old.app/v2` exists, no `.old-` dirs left, exit 0.
- `when the new bundle can't be moved in, puts the old one back`: the staged path is missing → `Old.app/v1` is back,
  exit 1, the log names the failure.
- `gives up without touching anything when the app doesn't quit`: `skipIf(process.platform === 'win32')`. A live pid
  of a child `sleep 5`, `BW_WAIT_S=1` → exit 1, `Old.app/v1` untouched, the log says «the app did not quit».

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement `mac-helper.ts` and `mac-backend.ts`**

- [ ] **Step 4: Run them, expect PASS (POSIX-only cases skipped on Windows); `npm run typecheck`**

- [ ] **Step 5: Commit** `macOS update backend: verified zip, unpack and the swap helper`

---

### Task 4: Wiring in main, IPC, tray and the helper log

**Files:**
- Create: `src/main/update/index.ts`, `src/main/update/helper-log.ts`
- Modify: `src/main/compose-state.ts`, `src/main/index.ts`, `src/main/ipc.ts`, `src/main/tray-menu.ts`,
  `src/shared/ipc.ts`, `src/preload/index.ts`
- Test: `tests/main/update/helper-log.test.ts`, `tests/main/update/create.test.ts`, `tests/main/tray-menu.test.ts`,
  `tests/main/compose-state.test.ts`, and the IPC test file that covers `registerIpc` handlers

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `createUpdates(o: { platform: NodeJS.Platform; log: Logger; onChange(s: UpdateStatus): void; updater: UpdaterLike; mac: Omit<MacBackendDeps, 'updater' | 'feed' | 'log'>; openExternal(url: string): void }): UpdateController | null`.
    It calls `configureUpdater(updater, log, UPDATE_FEED)`, then:
    - `win32` → `WinBackend`;
    - `darwin` → `MacBackend`;
    - other platforms → `null`.
  - `drainHelperLog(file: string, log: Logger): void`: each non-empty line → `log.warn('update helper: ' + line)`, then
    the file is deleted; a missing file does nothing; never throws.
  - `composeAppState(settings, locations, actual, settingsLoaded, update?: UpdateStatus)`: the state carries `update`
    only when it is given.
  - `IPC.installUpdate = 'update:install'`.
  - `RendererApi.installUpdate(): Promise<void>`.
  - `IpcDeps.installUpdate(): Promise<void>`.
  - `TrayActions.installUpdate(): void`.

- [ ] **Step 1: Write the failing tests**
- **`tray-menu.test.ts`.**
  - Add `installUpdate: noop` to `actions`.
  - `an available update puts «Оновити застосунок до 1.0.2» first, then a separator; it calls installUpdate`. On
    macOS it goes after the status header.
  - `while downloading the item is disabled and shows the percent`.
  - `idle adds nothing`: the existing order test still passes unchanged.
- **`compose-state.test.ts`:** `update is passed through, and absent when not given`.
- **`helper-log.test.ts`:** lines become warnings, the file is removed, a missing file is fine, an unreadable path
  doesn't throw.
- **`create.test.ts`:**
  - `win32 gives a controller over WinBackend, darwin over MacBackend, linux null`: check with a fake updater and
    spies;
  - `configureUpdater ran with UPDATE_FEED`.
- **IPC:** `update:install calls deps.installUpdate`.

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement**
- **`index.ts`:**
  - **When packaged:**
    - call `drainHelperLog(join(userData, 'logs', 'update-helper.log'), log)` early;
    - build the controller with electron-updater's `autoUpdater`, `net.fetch`, `execFile` (promisified, stdout), and
      `spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()`;
    - pass `quit: () => app.quit()`, `exePath: app.getPath('exe')`, `tempDir: app.getPath('temp')`,
      `pid: process.pid`, `openExternal: url => shell.openExternal(url)`;
    - `onChange: () => publish()`.
  - **State and actions:**
    - `getState()` passes `updates?.status()`;
    - `actions.installUpdate` and `IpcDeps.installUpdate` call `updates?.install()` (with a `.catch(log)` in the tray
      path).
  - **Lifecycle:** `updates?.start()` after the first `publish()`; `updates?.stop()` first in `will-quit`.
- **`tray-menu.ts`:** the item from `trayUpdateItem(state.update)`, before «Показати графік» and after the captcha
  item.

- [ ] **Step 4: Run the whole suite (`npx vitest run`), `npm run typecheck`, `npm run build`: all PASS**

- [ ] **Step 5: Commit** `Wire the updater: state, IPC, tray item and the helper log`

---

### Task 5: The header button

**Files:**
- Create: `src/renderer/src/app/UpdateButton.tsx`
- Modify: `src/renderer/src/app/App.tsx` (in `.app-tools`, before the refresh button, on both tabs),
  `src/renderer/src/app/app.css`
- Test: `tests/renderer/app.test.tsx` (the `fake()` API gains `installUpdate`)

**Interfaces:**
- Consumes: `updateTooltip` (Task 1), `RendererApi.installUpdate` (Task 4).
- Produces: `UpdateButton({ status, api }: { status: UpdateStatus | undefined; api: RendererApi })`.
  - It renders nothing when idle or absent.
  - Otherwise it renders a `button.app-refresh.app-update` with `aria-label` and `title` set to `updateTooltip`, and
    `data-capture="update"`.
  - It is disabled while `downloading` or `installing`.
  - Icon: a down arrow, as an SVG in the style of the refresh icon.
  - While downloading, a progress ring: an SVG circle whose `stroke-dasharray` follows `percent`.
  - In `error`, a small dot in `var(--bw-danger-icon)`.

- [ ] **Step 1: Write the failing tests** in `tests/renderer/app.test.tsx`:
  - `no update button when idle`;
  - `an available update shows «Оновити застосунок до 1.0.2» on both tabs; a click calls installUpdate`;
  - `downloading: disabled, named «Завантаження оновлення… 42 %»`;
  - `error: named «Не вдалося оновити. Натисніть, щоб спробувати ще раз», clickable`.

- [ ] **Step 2: Run them, expect FAIL**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them, expect PASS. Capture the button with the rig.**

  Run `node --check scripts/ui-capture/*.cjs` first, then:

  ```
  npm run ui:capture -- --target app --view schedule --theme dark,light --patch '{"update":{"phase":"available","version":"1.0.2"}}' --tag update --out .superpowers/update
  ```

  Capture the same with `{"phase":"downloading","version":"1.0.2","percent":42}` and with
  `{"phase":"error","version":"1.0.2"}`. Look at the images: the button matches the refresh button's size, and the ring
  and the dot read clearly in both themes.

- [ ] **Step 5: Commit** `Header button for app updates`

---

### Task 6: Release tooling, mac workflow and README

**Files:**
- Modify: `electron-builder.yml`:
  - `mac.target` gains `zip` (arm64);
  - `mac.artifactName: Blackout-Widget-${version}-${arch}.${ext}`;
  - `dmg.artifactName` the same.
- Modify: `.github/workflows/build-mac.yml`:
  - fix the comment: the repo is public;
  - add a `workflow_dispatch` input `update_feed` (default `''`), passed as env `BW_UPDATE_FEED` to the
    `npm run dist:mac` step;
  - add a step `npx vitest run tests/main/update` after the objc smoke test (the helper test with BSD tools);
  - upload `dist/*.dmg`, `dist/*.zip`, `dist/*.blockmap` and `dist/latest-mac.yml`.
- Modify: `README.md`:
  - «Release»: bump the version every time; the assets to upload (the exe, its blockmap, `latest.yml`, the dmg, the
    zip, the blockmaps, `latest-mac.yml`, with no renaming any more); `gh release create`;
  - a «Testing an update» subsection with the test-feed procedure below;
  - a «Features» line about the update button.

- [ ] **Step 1:** make the edits. Run `npx vitest run`, `npm run typecheck`, and `npm run dist:win` again. Expected:
  the Windows files are unchanged from Task 2.
- [ ] **Step 2:** commit `Release tooling for updates: mac zip and feed, workflow inputs, README`.

The mac workflow can only run once the branch is pushed. The controller does that with the user's go-ahead (see the
runbook).

---

## Runbook after the tasks (controller with the user; every push and release only on the user's go-ahead)

1. **Test 1.** Merge to main, set `version` to `1.0.1-test.1` on a throwaway branch `update-test`, and push it.
   - Windows: `BW_UPDATE_FEED=https://github.com/Alrighter/BlackoutWidget/releases/download/update-test npm run dist:win`.
   - Mac: `gh workflow run build-mac.yml --ref update-test -f update_feed=<same URL>`.
   - The user installs both by hand.
2. **Test 2.** Set `version` to `1.0.1-test.2`, build both again with the same feed, and create the pre-release
   `update-test` with all update assets. The user clicks the button on Windows and on the M1. Expected:
   - both restart on test.2 with their addresses, widgets and EcoFlow intact;
   - on the Mac, any Bluetooth or Keychain prompts are noted.
3. **Release.** On success, set `version` to `1.0.1` on main and build without a feed. Create release `v1.0.1` with every
   asset and English notes (mention the one manual install from 1.0.0, and the possible macOS prompts). Delete the
   `update-test` pre-release and branch. The test machines then update themselves to 1.0.1 too.
