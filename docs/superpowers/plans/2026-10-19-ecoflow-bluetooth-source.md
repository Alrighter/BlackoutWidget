# EcoFlow over Bluetooth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third «Джерело» option, «EcoFlow — Bluetooth (без інтернету)». After a one-time account sign-in, the app reads the RIVER 2's grid state over BLE with no internet, and shows live readings in settings.

**Architecture:**
- **BLE host.** noble runs in an Electron `utilityProcess` (the «BLE host»). Its logic (`BleHost`) is pure and talks to noble through a small `BleCentral` interface.
- **Main side.** Main owns a `BleLink` supervisor that spawns, respawns and idles the host, and tracks the live readings. An `EcoflowBleSource` turns link events into `ActualReading`s for the existing `ActualStateService`.
- **Setup.** It reuses the account sign-in, plus a Bluetooth scan.
- **Reused code.** The spike's protocol modules (`src/main/actual/ecoflow/ble/`) are reused, with the session switched from userId to the auth token.

**Tech Stack:** Electron 44 (`utilityProcess`, `powerMonitor`), TypeScript, React 19, vitest, `@stoprocent/noble` 2.8.0, `@noble/curves` 2.4.0, electron-vite, electron-builder.

**Spec:** `docs/superpowers/specs/2026-10-19-ecoflow-bluetooth-source-design.md`. It includes the section «Calls made after the builder check». Research: `docs/superpowers/specs/assets/ecoflow-ble-research.md` and `electron-ble-stack-research.md`.

## Global Constraints
- **Pure modules.** `src/shared/**` and `src/main/actual/**`, except `src/main/actual/electron-deps.ts`, import neither `electron` nor `@stoprocent/noble`.
  - Only `src/main/ble-host.ts` imports noble.
  - Only `electron-deps.ts`, `src/main/index.ts` and the smoke entries import `utilityProcess`/`powerMonitor`.
  - Renderer bundles import only `src/shared/**` and their own files.
- **No secret anywhere visible.** The password, userId, token and full SN never reach Settings, AppState, IPC results, the live channel, logs or error texts.
  - Logs show at most the 4-character SN prefix.
  - Log one line per link state change, never one per heartbeat.
- **Read-only station.** The host sends only what `EcoflowBleSession`'s allow-list permits. Do not loosen it.
- **Silence is never «off».** Every lost, silent or failed state reports `power: 'unknown'`.
- **Copy.** User-facing Ukrainian texts are exactly those in the spec, including the builder-check table. They live in one shared table (Task 1).
- **Licensing.** Ported protocol code keeps its Apache-2.0 attribution headers.
- **Commits.**
  - Subject plus body only.
  - Never a `Co-Authored-By` trailer or any Claude attribution line.
- **Line endings.** The repo uses `autocrlf=true`. Edit existing files with targeted edits. Never rewrite a whole existing file, which would change its line endings.
- **Each task ends green.**
  - `npm run typecheck` passes.
  - `npx vitest run` passes.

## Review Focus
1. **Silent station.** Out of range, asleep, or AC output off with no inverter heartbeat: the widget must say «невідомо», never «світла немає». Covered by Task 4's silence/grace tests.
2. **Phone holds the station.** A connect that hangs must time out at 20 s and back off: no tight loop, no retry storm after a refusal. Covered by Task 2's timeout, backoff and refused-pause tests.
3. **Host crash or bad native binding.** The app, widget and DTEK schedule keep working. The watch is replayed after a respawn. Three dead spawns show «не вдалося запустити Bluetooth у застосунку». Covered by Task 3's respawn tests.
4. **Setup reopened while connected.** The connected station does not advertise, yet it must show «поруч». Covered by Task 5's `test` test.
5. **Sleep and resume.** After resume the link reconnects at once, not after a 60 s backoff. Covered by Task 2's suspend/resume test.

---

### Task 1: Session takes the token; shared BLE vocabulary

**Files:**
- Create:
  - `src/main/actual/ecoflow/ble/token.ts`
  - `src/shared/ecoflow-ble.ts`
  - `tests/shared/ecoflow-ble.test.ts`
- Modify:
  - `src/main/actual/ecoflow/ble/crypto.ts` (remove `authToken`)
  - `src/main/actual/ecoflow/ble/session.ts`
  - `src/shared/ipc.ts` (add `ActualLive`)
  - `tests/main/actual/ecoflow-ble.test.ts`

**Interfaces:**
- Produces:
  - `authToken(userId: string, sn: string): string`: uppercase hex MD5 of `userId + sn` (ASCII), 32 characters. Uses only `node:crypto`. Main imports it without pulling in `@noble/curves`.
  - `SessionOptions` loses `userId` and `sn` and gains `token?: string`. The token is required unless `stopAfterAuthStatus`. The auth payload is `Buffer.from(token, 'ascii')`.
  - `SessionError` gains `kind: 'timeout' | 'refused' | 'failed'` and `code?: number`:
    - refused: a 0x86 reply with code ≠ 0 (`code` = that byte);
    - timeout: a stage got no reply;
    - failed: everything else.
  - `src/shared/ecoflow-ble.ts`:
    - `BLE_PREFIXES = ['R601','R603','R611','R613','R621','R623']`;
    - `isRiver2Family(sn: string): boolean`;
    - `type BleProblem = 'bt-off' | 'bt-denied' | 'bt-missing' | 'bt-unavailable' | 'host-failed' | 'scan-failed'`;
    - `BLE_PROBLEM_TEXT: Record<BleProblem, string>`: the setup-alert and live-line texts;
    - `BLE_LINK_TEXT`: `searching` «Шукаю станцію поруч…», `connecting` «Підключаюся…», `refused` «Станція не прийняла вхід — натисніть «Змінити» і увійдіть знову», `stalled` «Станція не відповідає — спробую ще раз за кілька хвилин», `unsupported` «Модель поки не підтримується»;
    - `BLE_REASON`: the source reasons from the spec's Readings section and the builder-check table, e.g. `lost: 'станція поза зв’язком Bluetooth'`, `invSilent: 'станція не повідомляє про вхід'`, `acOffHint: ' (вимкнено вихід AC?)'`, `refused`, `stalled`, `unsupported`, plus one per `BleProblem` except `scan-failed`.
  - `shared/ipc.ts`:
    ```ts
    export interface ActualLive {
      link: 'searching' | 'connecting' | 'connected' | 'refused' | 'stalled' | 'unsupported' | Exclude<BleProblem, 'scan-failed'>;
      acInVolts?: number; acInHz?: number; inputWatts?: number; acOut?: boolean; soc?: number; invSilent?: boolean;
    }
    ```

- [ ] **Step 1: Tests first.**
  - In `ecoflow-ble.test.ts`, replace `userId`/`sn` with `token: authToken(...)` everywhere. The station double keeps checking MD5(userId+SN).
  - Add `authToken('1234567890123456789', 'R601ZEB4XXXX0000')`, which must equal the uppercase MD5 hex (32 chars, `/^[0-9A-F]{32}$/`).
  - Add: a refusal rejects with `{ kind: 'refused', code: 6 }`.
  - Add: a silent station at `auth-status` rejects with `{ kind: 'timeout', stage: 'auth-status' }`.
  - Add: `stopAfterAuthStatus` with no token resolves.
  - New `tests/shared/ecoflow-ble.test.ts`:
    - `isRiver2Family` is true for each prefix and false for `R331…`, `D361…` and `''`;
    - every `BleProblem` has a non-empty text;
    - `BLE_REASON.invSilent + BLE_REASON.acOffHint === 'станція не повідомляє про вхід (вимкнено вихід AC?)'`.
- [ ] **Step 2:** Run `npx vitest run tests/main/actual/ecoflow-ble.test.ts tests/shared/ecoflow-ble.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. `crypto.ts` keeps everything except `authToken`.
- [ ] **Step 4:** Run the same command, then `npm run typecheck`. Expect PASS. The spike's `scripts/ble-probe/*` will no longer typecheck against the session. They are deleted in Task 7. Until then, change their two `userId:` call sites to `token`, or delete `scripts/ble-probe/` now together with the `ble:probe` npm script. Either is fine.
- [ ] **Step 5:** Commit: «BLE session authenticates with the token; shared BLE texts».

### Task 2: The BLE host logic (pure)

**Files:**
- Create:
  - `src/main/actual/ecoflow/ble/messages.ts`
  - `src/main/actual/ecoflow/ble/host.ts`
  - `tests/main/actual/ecoflow-ble-host.test.ts`

**Interfaces:**
- Consumes (Task 1): `EcoflowBleSession` with its `token` and `kind` changes, `parseAdvert`, `heartbeatOf`, `decodeHeartbeat`, `isRiver2Family`.
- Produces in `messages.ts`:
  ```ts
  export type AdapterState = 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown' | 'resetting';
  export type LinkState = 'idle' | 'searching' | 'connecting' | 'connected' | 'refused' | 'stalled' | 'unsupported' | 'lost';
  export interface AdvertView { sn: string; soc: number; rssi: number; encryptType: number }
  export type HostCommand =
    | { cmd: 'watch'; sn: string; token: string } | { cmd: 'unwatch' }
    | { cmd: 'scan'; id: number; ms: number } | { cmd: 'suspend' } | { cmd: 'resume' }
    | { cmd: 'probe'; id: number };                 // smoke only: first EcoFlow advert, handshake to auth status, no auth
  export type HostEvent =
    | { ev: 'adapter'; state: AdapterState }
    | { ev: 'link'; sn: string; state: LinkState; detail?: string }   // detail: English, log-safe ('auth code 6', 'no reply in auth-status')
    | { ev: 'heartbeat'; sn: string; module: 'inv' | 'pd' | 'mppt'; fields: Fields }
    | { ev: 'scan-result'; id: number; adverts: AdvertView[] }
    | { ev: 'probe-result'; id: number; ok: boolean; detail: string }
    | { ev: 'log'; level: 'info' | 'warn' | 'error'; text: string };
  ```
- Produces in `host.ts`:
  ```ts
  export interface BleChannel { write(data: Buffer): Promise<void> }
  export interface BlePeripheral {
    readonly id: string;
    connect(): Promise<void>; cancelConnect(): void; disconnect(): Promise<void>;
    onceDisconnect(cb: () => void): void;
    /** Finds write 0002 + notify 0003 (or the Nordic UART pair), subscribes; null when the pair is absent. */
    openChannel(onNotify: (data: Buffer) => void): Promise<BleChannel | null>;
  }
  export interface BleCentral {
    readonly state: AdapterState;
    onState(cb: (s: AdapterState) => void): void;
    startScan(onAdvert: (a: { peripheral: BlePeripheral; manufacturerData?: Buffer; rssi: number }) => void): Promise<void>;
    stopScan(): Promise<void>;
  }
  export interface HostTimers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void; now(): number }
  export class BleHost {
    constructor(central: BleCentral, post: (e: HostEvent) => void, timers?: HostTimers);
    handle(cmd: HostCommand): void;
  }
  ```
- Constants, exported for the tests:
  - `SCAN_FIND_MS = 15_000`
  - `CONNECT_TIMEOUT_MS = 20_000`
  - `BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000]`
  - `STALL_LIMIT = 3`
  - `STALL_PAUSE_MS = 300_000`
  - `REFUSED_PAUSE_MS = 1_800_000`
  - `UNSUPPORTED_RECHECK_MS = 1_800_000`
  - `BAD_FRAME_LIMIT = 10`

**Behaviour** (the spec's Connection policy; this is the state machine the tests pin):
- **Adapter events.** Post `adapter` on start and on every state change. While the state is not `poweredOn`, a watch waits for it, with no timers spinning.
- **One shared scan.** There is a single noble scan session for watch, scan and probe listeners. Start it when the first listener needs it and stop it when the last one leaves.
- **A watch attempt:**
  1. Post `link searching`, then scan up to `SCAN_FIND_MS` for an advert whose SN is the watched one.
  2. An SN outside the RIVER 2 family or `encryptType !== 7` posts `link unsupported` and waits `UNSUPPORTED_RECHECK_MS`.
  3. Otherwise post `link connecting`. Connect with a `CONNECT_TIMEOUT_MS` timeout; on timeout call `cancelConnect`. Then `openChannel` and the session with `token`.
  4. On success post `link connected`, reset the backoff index and the stall count, and forward the `inv`/`pd`/`mppt` heartbeats only.
  5. When the link drops, post `link lost` and attempt again after `BACKOFF_MS[0]`.
- **Failures.**
  - Not found, connect timeout, no channel, `failed`, or a non-stall `timeout`: wait `BACKOFF_MS[i]`, where `i` is capped at the last entry.
  - `refused`: post `link refused` with detail `auth code N`, disconnect, and pause `REFUSED_PAUSE_MS`.
  - `timeout` at the `auth-status` or `auth` stage is a stall. On the `STALL_LIMIT`-th stall in a row, post `link stalled`, pause `STALL_PAUSE_MS` and reset the count. Before that, use the normal backoff.
  - `BAD_FRAME_LIMIT` bad frames in a row: disconnect, which then counts as lost.
- **Commands.**
  - `unwatch`: abort, disconnect, post `link idle`.
  - `suspend`: abort, disconnect, stop the scan, and wait.
  - `resume`: attempt at once with the backoff reset. Pauses are cleared too.
  - A new `watch` replaces the old one.
- **`scan {id, ms}`**: collect `parseAdvert` hits for `ms` and post `scan-result` with one entry per SN, keeping the last RSSI. The watch carries on alongside it.
- **`probe {id}`**: scan for any EcoFlow advert for up to `SCAN_FIND_MS`, then connect and run the session with `stopAfterAuthStatus`. Post `probe-result` with `ok` and detail `'R601… auth-status 0100 in 1712 ms'`, then disconnect.
- **Logs.** Post a `log` event on each link state change, with the SN prefix only.

- [ ] **Step 1: Tests.** Use a fake central, fake peripherals and fake timers. A station double answers through `openChannel`; reuse the `fakeStation` helper pattern from `ecoflow-ble.test.ts` by moving it to `tests/helpers/ble-station.ts`. Test names and their assertions:
  - `watches: searching → connecting → connected, then forwards inverter heartbeats`: events in that order, and `heartbeat` carries `module: 'inv'` with `acInVol: 119189`.
  - `does not forward ems/bms heartbeats`.
  - `retries a missing station with 5, 10, 20, 40, 60, 60 s backoff`: the times between scan starts.
  - `cancels a connect that hangs for 20 s and backs off`: `cancelConnect` is called.
  - `a refusal pauses 30 min and posts refused with the code`: no further connect before 1 800 000 ms.
  - `three stalls in a row pause 5 min; a good session resets the count`.
  - `an unsupported advert is never connected to`: R331 prefix, or encrypt type 1.
  - `ten bad frames drop the link and reconnect`.
  - `suspend disconnects and resume reconnects at once`: the connect happens without the 60 s wait, even after five failures.
  - `scan returns one entry per SN while a watch keeps its own scan`.
  - `never writes anything the session did not build`: every `write` buffer decodes as a handshake or a 0x35/0x89 or 0x86 packet.
- [ ] **Step 2:** Run `npx vitest run tests/main/actual/ecoflow-ble-host.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement `messages.ts` and `host.ts`.
- [ ] **Step 4:** Run the tests again, then typecheck. Expect PASS.
- [ ] **Step 5:** Commit: «Bluetooth host: watch, scan and reconnect logic».

### Task 3: The host process, its supervisor and the live readings

**Files:**
- Create:
  - `src/main/ble-host.ts`: the utilityProcess entry, which adapts noble to `BleCentral`
  - `src/main/actual/ecoflow/ble/link.ts`
  - `tests/main/actual/ecoflow-ble-link.test.ts`
- Modify: `src/main/actual/electron-deps.ts`

**Interfaces:**
- Consumes (Task 2): `HostCommand`, `HostEvent`, `AdvertView`, `AdapterState`, `LinkState`.
- Produces in `link.ts`:
  ```ts
  export interface HostPort { post(cmd: HostCommand): void; onEvent(cb: (e: HostEvent) => void): void; onExit(cb: (code: number) => void): void; kill(): void }
  export type LinkEvent = HostEvent | { ev: 'host-failed' };
  export interface ScanOutcome { adverts: AdvertView[]; problem?: BleProblem }
  export interface BleLinkLike {
    watch(sn: string, token: string): void; unwatch(): void;
    scan(ms: number): Promise<ScanOutcome>;
    connectedSn(): string | null;
    onEvent(cb: (e: LinkEvent) => void): () => void;
  }
  export class BleLink implements BleLinkLike {
    constructor(deps: { spawn(): HostPort; log: Logger; timers?: HostTimers });
    suspend(): void; resume(): void;
    getLive(): ActualLive | null;                  // null while nothing is watched
    onLive(cb: (live: ActualLive | null) => void): () => void;
    dispose(): void;                               // kills the host; no respawn
  }
  ```
- Constants:
  - `RESPAWN_MS = [1_000, 2_000, 5_000, 10_000, 30_000]`
  - `HOST_FAIL_LIMIT = 3`
  - `IDLE_STOP_MS = 60_000`
  - `ADAPTER_UNREADY_MS = 10_000`
  - `INV_SILENT_MS = 20_000` (shared with Task 4; export it from here)
  - `SCAN_GRACE_MS = 5_000`
- `electron-deps.ts` adds `spawnBleHost(): HostPort`. It runs `utilityProcess.fork(join(__dirname, 'ble-host.js'), [], { serviceName: 'Blackout Widget Bluetooth' })` and maps `postMessage`/`message`/`exit`/`kill`.

**Behaviour:**
- **Lazy spawn.** Spawn on the first `watch`/`scan`. The current watch is re-posted to every new host.
- **Unexpected exit.** Respawn after `RESPAWN_MS[i]`. If `HOST_FAIL_LIMIT` hosts in a row exit without ever posting `adapter`, emit `host-failed`, set live to `host-failed`, and keep respawning at the 30 s cap.
- **Idle stop.** Kill the host when nothing is watched and no scan is pending for `IDLE_STOP_MS`. That is an expected exit, with no respawn.
- **`scan(ms)`.**
  - Resolves on the matching `scan-result`.
  - Resolves with `problem: 'scan-failed'` after `ms + SCAN_GRACE_MS`, or when the host exits.
  - Resolves with `problem: 'host-failed'` when the host has failed.
  - Otherwise `problem` is set from the last adapter state:
    - `poweredOff` → `bt-off`;
    - `unauthorized` → `bt-denied`;
    - `unsupported` → `bt-missing`;
    - `unknown`/`resetting` → `bt-unavailable`.
- **`connectedSn()`.** The watched SN while the last link state is `connected`, else null.
- **Live**, while a watch exists:
  - `link`: a non-`poweredOn` adapter maps as in `scan`, but `unknown`/`resetting` count only after `ADAPTER_UNREADY_MS` and read `searching` before that. Otherwise the last link state: `lost`/`idle` read `searching`.
  - From the current connection's heartbeats:
    - `acInVolts = round(acInVol / 1000)`;
    - `acInHz`;
    - `inputWatts`;
    - `acOut = (mppt.cfgAcEnabled ?? inv.cfgAcEnabled) === 1`;
    - `soc` from pd.
  - `invSilent`: connected and no inverter heartbeat for `INV_SILENT_MS`. Check it on a 5 s timer while connected.
  - Values are cleared when the link leaves `connected`.
  - `onLive` fires on every change.
- **`log` events** go to `deps.log` at their level.

- [ ] **Step 1: Tests** with a fake `HostPort` factory and fake timers. Test names and assertions:
  - `spawns lazily and replays the watch after a crash`
  - `three hosts dying before reporting the adapter emit host-failed and keep retrying`
  - `stops an idle host after 60 s without respawning it`
  - `scan resolves with adverts, with the adapter problem, or scan-failed on timeout or exit`
  - `connectedSn follows the link state`
  - `live: volts rounded from mV, acOut from MPPT before the inverter, values cleared on lost`
  - `live: invSilent after 20 s without an inverter heartbeat`
  - `live: an unknown adapter reads searching for 10 s, then bt-unavailable`
- [ ] **Step 2:** Run the tests. Expect FAIL. **Step 3:** Implement `link.ts`, `spawnBleHost` and `src/main/ble-host.ts`.
  - The noble adapter is `withBindings('default')`. Normalise UUIDs as the spike did: `short()` strips dashes and the Bluetooth base, then parses hex, so `0002`/`2` both match.
  - `openChannel` discovers all services and characteristics, then subscribes. It writes with response (`writeAsync(data, false)`).
  - The entry wires `process.parentPort` messages to `BleHost.handle` and posts events back.
- [ ] **Step 4:** Run the tests again, then typecheck. Expect PASS.
- [ ] **Step 5:** Commit: «Bluetooth host process and its supervisor».

### Task 4: The Bluetooth source

**Files:**
- Create:
  - `src/main/actual/ecoflow/ble/source.ts`
  - `tests/main/actual/ecoflow-ble-source.test.ts`
- Modify:
  - `src/main/actual/ecoflow/index.ts` (add `createEcoflowBleFactory`)
  - `src/main/actual/registry.ts`
  - `src/main/actual/actions.ts` (`createActualRestart` only)
  - `src/shared/types.ts`
  - `tests/main/actual/service.test.ts` or the restart tests where they live

**Interfaces:**
- Consumes:
  - `BleLinkLike`, `LinkEvent`, `INV_SILENT_MS` (Task 3);
  - `detectGrid` (`grid.ts`);
  - `BLE_REASON`, `isRiver2Family` (Task 1).
- Produces:
  - `ActualSourceConfig` gains `| { id: 'ecoflow-ble'; region: EcoflowRegion; deviceSn: string; deviceName: string; accountHint: string }`.
  - `class EcoflowBleSource implements ActualStateSource`, with constructor `({ sn, token }, link: BleLinkLike, { log, now?, timers? })`.
  - `createEcoflowBleFactory({ ble }: { ble: BleLinkLike }): ActualSourceFactory` with `id: 'ecoflow-ble'` and `displayName: 'EcoFlow'`.
  - `createActualSources(deps: { fetch; connect; ble: BleLinkLike })` returns all three factories.
- Constants:
  - `READING_MS = 10_000`
  - `LINK_GRACE_MS = 30_000`
  - `REASON_REPEAT_MS = 60_000`
- **Restart.**
  - For `ecoflow-ble`, no clientId is made or needed.
  - The secrets are complete when `/^[0-9A-F]{32}$/.test(secrets.token)`. Otherwise use `secretsMissingSource(ACCOUNT_MISSING_REASON)`.
  - `factory.create(config, secrets)` gets `{ sn: config.deviceSn, token: secrets.token }`.

**Behaviour** (the spec's Readings section):
- `start` calls `link.watch(sn, token)`. `stop` calls `unwatch` and drops its subscription and timers.
- **Inverter heartbeat:** compute `detectGrid({'inv.acInVol', 'inv.acInFreq', 'inv.inputWatts'})`. Report it if the verdict's power changed or `READING_MS` has passed since the last report. `observedAt` is the receipt time.
- **No inverter heartbeat** for `INV_SILENT_MS` while connected: report unknown `BLE_REASON.invSilent`. Append `acOffHint` when the last MPPT or inverter `cfgAcEnabled` is 0.
- **Link not `connected`** for longer than `LINK_GRACE_MS`, counted from start or from the drop:
  - `refused`, `stalled`, `unsupported` → their reasons;
  - adapter problems and `host-failed` → their reasons;
  - otherwise `BLE_REASON.lost`.
- **Repeats.** An unknown reason is reported when it starts, then every `REASON_REPEAT_MS` while it holds.
- **Filtering.** Events for another SN are ignored.

- [ ] **Step 1: Tests**, each with a fake link:
  - `inverter heartbeat with 119189 mV reports on`
  - `0 V and 0 Hz reports off`
  - `throttles to one reading per 10 s unless the power changes`
  - `20 s without an inverter heartbeat reports unknown, with the AC-off hint when MPPT says 0`
  - `a drop shorter than 30 s reports nothing; longer reports «станція поза зв’язком Bluetooth»`
  - `refused / stalled / unsupported / bt-off / host-failed map to their reasons`
  - `repeats an unknown reason every 60 s`
  - `stop unwatches and stays silent`
  - Restart: `an ecoflow-ble source with a valid token starts the Bluetooth factory; a missing token gives ACCOUNT_MISSING_REASON`.
- [ ] **Step 2:** Run the tests. Expect FAIL. **Step 3:** Implement. **Step 4:** Run the tests again, then typecheck. Expect PASS.
- [ ] **Step 5:** Commit: «Bluetooth source for the actual-power service».

### Task 5: Setup actions, IPC and main wiring

**Files:**
- Modify:
  - `src/main/actual/actions.ts`
  - `src/shared/ipc.ts`
  - `src/preload/index.ts`
  - `src/main/ipc.ts`
  - `src/main/index.ts`
  - `tests/main/actual/ecoflow-app-*.test.ts` or the actions test file (find where `createActualActions` is tested)
  - `tests/main/actual/ipc-actual.test.ts`

**Interfaces:**
- Consumes: `BleLink` (Task 3), `authToken` (Task 1), `isRiver2Family`, `BLE_PROBLEM_TEXT`.
- Produces:
  - `EcoflowInput` gains `| { mode: 'ble'; region; email; password }`.
  - `EcoflowDeviceView` gains `nearby?: boolean; supported?: boolean`.
  - `EcoflowTestResult` ok gains `bluetooth?: string`, the problem text.
  - `IPC.actualLive = 'actual:live'` (push) and `IPC.getActualLive = 'actual:get-live'` (invoke).
  - `RendererApi.getActualLive(): Promise<ActualLive | null>` and `onActualLive(cb): () => void`.
  - `ActualActionsDeps` gains `ble: Pick<BleLinkLike, 'scan' | 'connectedSn'>`.
- `SCAN_MS = 8_000`.

**Behaviour:**
- **`test` with `mode: 'ble'`.**
  - Sign in exactly like account mode, caching the session in the same cache.
  - In parallel, run `ble.scan(SCAN_MS)`.
  - For each device:
    - `nearby` = its SN is in the adverts, or equals `ble.connectedSn()`;
    - `supported` = `isRiver2Family(sn)`.
  - `bluetooth` = `BLE_PROBLEM_TEXT[problem]` when the scan has a problem.
  - A scan problem never fails the test; a sign-in error does.
- **`preview` with `mode: 'ble'`** returns `BAD_INPUT`. The renderer never calls it.
- **`save` with `mode: 'ble'`.**
  - Refuse `!isRiver2Family(sn)` with «Модель поки не підтримується».
  - Take the session from the cache, or `login()`.
  - `secrets.save('ecoflow-ble', { token: authToken(session.userId, sn) })`.
  - Settings: `actualSource: { id: 'ecoflow-ble', region, deviceSn, deviceName, accountHint: maskEmail(email) }`.
  - Remove the `ecoflow` and `ecoflow-app` secrets, then restart.
  - Errors are scrubbed as in account mode.
- **Switching back.** Saving keys or account removes `ecoflow-ble`. `disconnect` removes all three.
- **Main (`index.ts`).**
  - Create `bleLink = new BleLink({ spawn: spawnBleHost, log })` and pass `ble: bleLink` to `createActualSources` and `createActualActions`.
  - `powerMonitor` `suspend` calls `bleLink.suspend()`; `resume` calls `bleLink.resume()`.
  - Push `bleLink.onLive` to `mainWindow.send(IPC.actualLive, live)`, throttled to one send per 1000 ms. Use a trailing send so the last value always arrives.
  - `IPC.getActualLive` returns `bleLink.getLive()` when the saved source is `ecoflow-ble`, else `null`.
  - On quit, call `bleLink.dispose()` next to `actualService.stop()`.

- [ ] **Step 1: Tests** for the actions:
  - `ble test: signs in, scans, marks nearby/supported, and the connected station counts as nearby`
  - `ble test: a scan problem becomes the bluetooth text, the devices still come back`
  - `ble save: stores only the token, settings carry the masked email, the other secrets go`
  - `ble save refuses an unsupported model`
  - `ble save signs in again when the cached session expired`
  - `no result, log or error contains the password, userId or token`, which extends the existing secret-scrub tests
  - `ipc-actual`: `getActualLive` is wired.
- [ ] **Step 2:** Run the tests. Expect FAIL. **Step 3:** Implement. **Step 4:** Run the full `npx vitest run` and typecheck. Expect PASS.
- [ ] **Step 5:** Commit: «Bluetooth setup actions and live readings over IPC».

### Task 6: The settings UI

**Files:**
- Modify:
  - `src/renderer/src/app/ActualSettings.tsx`
  - `src/renderer/src/app/app.css`, only if a new class is needed; reuse `st-station-state` and `.online`
  - `tests/renderer/actual-settings.test.tsx`

**Interfaces:**
- Consumes: `EcoflowInput` `ble`, `EcoflowDeviceView.nearby`/`supported`, `EcoflowTestResult.bluetooth`, `getActualLive`/`onActualLive`, `BLE_*` texts, `isRiver2Family`.

**Behaviour:** exactly the spec's Setup and Connected-panel sections.
- **Mode option.** `MODES` gets the `ble` option third. `initialMode` follows `source.id` (`ecoflow`→keys, `ecoflow-app`→account, `ecoflow-ble`→ble).
- **Form.** `ble` shows the region, email and password fields with the Bluetooth hint, word for word from the spec. The check button reads «Шукаю станцію…» while busy.
- **Stations step.**
  - Each station's state reads «поруч» (the `.online` style) or «не знайдено поруч».
  - The `bluetooth` text shows as an `Alert` above the list.
  - Choosing a station sets the «Перевірка» box locally, without IPC, to one of the three texts in spec step 5.
  - «Зберегти» is disabled for an unsupported station.
- **Connected panel.**
  - Name: `EcoFlow · {deviceName} · Bluetooth · акаунт {accountHint}`.
  - A live line under «Зараз»:
    - connected and not silent: `На вході {V} В · {Hz} Гц · {W} Вт · вихід AC увімк|вимк · заряд {soc}%`;
    - connected and silent: `Станція не повідомляє про вхід · вихід AC … · заряд …%`;
    - other states: their text.
  - A missing value drops its part.
  - Subscribe with `onActualLive` while the panel is mounted, and seed it from `getActualLive()`.

- [ ] **Step 1: Tests**, using the existing api mock pattern:
  - `ble mode shows email, password and the Bluetooth hint`
  - `check shows stations with поруч / не знайдено поруч and the bluetooth alert`
  - `choosing a nearby RIVER 2 shows the after-save text; an unsupported one warns and disables Зберегти`
  - `save sends mode ble`
  - `connected ecoflow-ble panel shows the Bluetooth name and the live line, updating on push`
  - `live line leaves out values not received yet`
  - `Змінити on an ecoflow-ble source opens the form in ble mode`
- [ ] **Step 2:** Run the tests. Expect FAIL. **Step 3:** Implement. **Step 4:** Run the full suite and typecheck. Expect PASS.
- [ ] **Step 5:** Commit: «Bluetooth option in the EcoFlow settings».

### Task 7: Build, packaging, smoke, cleanup

**Files:**
- Create: `src/main/smoke-ble.ts`
- Modify:
  - `electron.vite.config.ts`
  - `electron-builder.yml`
  - `package.json` (drop the `ble:probe` script)
- Delete: `scripts/ble-probe/`, if Task 1 did not already.

**Steps:**
- [ ] **Step 1: electron-vite.**
  - Add the `ble-host` and `smoke-ble` main inputs.
  - Bundle `@noble/curves` into the main build instead of externalising it, using the installed electron-vite's externalize-deps exclude option; check its docs or types for the exact key.
  - `@stoprocent/noble` stays external.
- [ ] **Step 2: electron-builder.**
  - `asarUnpack` adds `'**/node_modules/@stoprocent/noble/**'`.
  - `files` adds the four HCI exclusions from the spec.
  - Add `npmRebuild: false`.
  - `mac.extendInfo` adds `NSBluetoothAlwaysUsageDescription: 'Blackout Widget читає зарядну станцію EcoFlow через Bluetooth.'`.
- [ ] **Step 3: `smoke-ble.ts`.** No windows. It spawns the host through `spawnBleHost`, sends `scan {ms: 8000}`, prints the SN prefixes, then sends `probe` and prints `probe-result`, and quits. It never signs in or touches userData; set userData to a temp dir, as `scripts/ui-capture/capture.cjs` does.
- [ ] **Step 4: Verify.**
  - `npm run build`, then `npx electron out/main/smoke-ble.js`. Expect an `R601…` advert and `probe-result ok`.
  - `npm run dist:win`, then confirm that `dist/win-unpacked/resources/app.asar.unpacked/node_modules/@stoprocent/noble/prebuilds/win32-x64/` exists and that `out/main/ble-host.js` contains no `require("@noble/curves`.
  - Never run the installed or packaged app.
- [ ] **Step 5:** Full suite and typecheck. Commit: «Package the Bluetooth host; smoke check; drop the terminal probe».
