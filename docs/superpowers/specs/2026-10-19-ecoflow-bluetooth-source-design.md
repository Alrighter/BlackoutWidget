# EcoFlow over Bluetooth (no internet): design

**Date:** 2026-10-19. **Status:** approved by the user in chat. They first asked «давай додамо підтримку блутуз як опцію», then rejected a terminal probe: «мені треба шоб все було через застосунок». They were shown the flow below (a third «Джерело» option, a one-time email + password, live readings under the station, widget on / off / unknown, the held connection, the macOS prompt) and answered «робимо так».

**Research:**
- `docs/superpowers/specs/assets/ecoflow-ble-research.md` (cited as B§N): the RIVER 2 BLE protocol.
- `docs/superpowers/specs/assets/electron-ble-stack-research.md` (cited as S§N): the Electron BLE stack.

The account source this builds on is `2026-10-18-ecoflow-account-source-design.md`.

**Spike results on the user's station** (branch `spike/ecoflow-ble`, merged into this branch):
- It is a base RIVER 2, SN prefix `R601`, encrypt type 7.
- `@stoprocent/noble` 2.8.0 sees it on this Windows 11 laptop's built-in adapter, with no driver change. ATT MTU is 500.
- The secp160r1 key exchange, the session key and the encrypted auth-status reply (`0100`) all succeed in about 2 s, without the account.
- Not yet seen on the real unit: the auth with the account, and the heartbeats in each station state.

## Why
- The user's River 2 is not on Wi-Fi, so the account (cloud) source shows «станція не в мережі».
- During a blackout the home internet often goes down too, which is exactly when the cloud path is needed.
- The laptop sits 10 cm from the station. Bluetooth LE reads the station directly, with no Wi-Fi and no internet.
- The user wants this inside the app, not as a script.

## Goals
- A third EcoFlow source, **«EcoFlow — Bluetooth (без інтернету)»**, in the same «Джерело» select:
  - the user signs in once with the EcoFlow email and password;
  - the app finds the station nearby over Bluetooth;
  - from then on it reads the AC-input (grid) state with no internet at all.
- Live readings in the settings panel while the source runs:
  - link state;
  - AC-in voltage and frequency, input watts;
  - AC output on/off, SoC.

  The user can watch them while switching the AC output or pulling the wall cord. This replaces the terminal probe.
- Windows 11 x64 and macOS arm64, same as the app.

## Non-goals
- Models other than the RIVER 2 family (R601/R603, R611/R613, R621/R623; encrypt type 7, inner packet version 2).
  - Another EcoFlow station found over BLE shows «модель поки не підтримується» and is never connected to.
  - Protobuf models (River 3 etc., B§2.5) are out.
- Controlling the station. Read-only, enforced by the session's allow-list (B§2.8).
- A cloud fallback inside this source. The account source stays a separate choice.
- Releasing the Bluetooth link to the phone on demand. A later idea, not now.
- Pairing (bonding) in the OS. None is needed (S§5).

## Anti-goals
These would make the feature a failure even if it technically worked:
- **Secrets leak.** The password, the userId or the auth token appears in Settings, AppState, IPC results, logs, the live channel or error texts.
- **Invented outages.** «світла немає» is shown when the station is just silent: out of range, asleep, inverter heartbeat absent, link lost. Silence is always «невідомо» (B§2.7, B§4.3). Do not copy ha-ef-ble's fall-back-to-0.
- **Writes to the station.** Anything beyond the handshake commands 0x01/0x02 and the auth requests 0x35/0x89 and 0x35/0x86:
  - never 0x35/0x85 (bind, which can lock the official app out);
  - never a reply to the clock request;
  - never a 0x20 command (B§2.8).
- **Hammering the station.** Tight reconnect loops, or retrying a refused auth (B§4.4 «quiet spell»).
- **A dead app.** A native BLE crash or hang takes the app, the widget or the DTEK schedule down with it (S§2.5).

## Behaviour

### Setup (the EcoFlow form)
1. The «Джерело» select gets a third option, `{ value: 'ble', label: 'EcoFlow — Bluetooth (без інтернету)' }`, after the account option. It uses the same dropdown styling.
2. With `ble` selected the form shows the same region radios, email and password fields as the account mode, and this hint instead of the account one:
   > «Вхід потрібен один раз: станція пускає лише свій акаунт. Пароль не зберігається — лише ключ для цієї станції. Далі інтернет не потрібен. Поки віджет підключений, телефон зможе керувати станцією лише через інтернет.»
3. «Перевірити» does three things:
   - signs in (the existing `EcoflowAppApi.login`, with the same error texts);
   - lists the account's stations (`listDevices`);
   - scans Bluetooth for `SCAN_MS = 8000`.

   While busy, the button reads «Шукаю станцію…».
4. The stations step lists the account's stations as today. The right-hand state for each:
   - «поруч» (green) when its SN was in the scan, or when it is the station the running Bluetooth source is connected to right now. A connected station does not advertise (B§3), so the scan alone would miss it.
   - «не знайдено поруч» otherwise.
   - Bluetooth problems replace the scan result with an alert above the list, and the list still shows:
     - adapter off: «Bluetooth на цьому комп’ютері вимкнено»;
     - no permission (macOS): «Немає дозволу на Bluetooth — дозвольте його в Системних параметрах → Конфіденційність і безпека → Bluetooth»;
     - no adapter: «На цьому комп’ютері немає Bluetooth».
5. Choosing a station shows the «Перевірка» box, without connecting:
   - nearby and a RIVER 2 family SN: «Станція поруч — стан світла з’явиться після збереження» (neutral);
   - nearby and another model: «Модель поки не підтримується» (warn);
   - not nearby: «Станцію не знайдено поруч — увімкніть її і тримайте поряд з комп’ютером» (neutral).
6. «Зберегти» works whether or not the station was found (it may be asleep), but not for an unsupported model:
   - It gets the userId from the check's cached session, or signs in again when the cache has expired.
   - It derives `token = uppercase hex MD5(userId + SN)` (B§2.3).
   - It stores `{ token }` in the SecretStore under `ecoflow-ble`, and the settings as `actualSource: { id: 'ecoflow-ble', region, deviceSn, deviceName, accountHint }`.
   - It removes the other two sources' secrets and restarts the actual service, as the other modes do.
   - The userId and the password are not kept anywhere.
7. «Змінити» on a `ecoflow-ble` source opens the form in `ble` mode.

### The connected panel
- Name line: `EcoFlow · {deviceName} · Bluetooth · акаунт {accountHint}`.
- Under the existing «Зараз: …» line, a live line updates at most once per second while the main window is open:
  - connected with an inverter heartbeat in the last 20 s: `На вході 227 В · 50 Гц · 0 Вт · вихід AC увімк · заряд 87%`;
  - connected, inverter silent: `Станція не повідомляє про вхід · вихід AC вимк · заряд 100%`;
  - searching: «Шукаю станцію поруч…»;
  - connecting: «Підключаюся…»;
  - Bluetooth problems: the texts from setup step 4;
  - refused: «Станція не прийняла вхід — натисніть «Змінити» і увійдіть знову».

  A value the station has not sent yet is left out, never shown as 0.

### The widget and the tray
No change in layout. The «Фактично» state comes from the readings below through the existing ActualStateService (60 s confirmation, history, staleness).

### Readings (what the source reports)
- **Inverter heartbeat** (src 0x04, cmd 0x02; B§2.6):
  - Build a quota `{ 'inv.acInVol': acInVol, 'inv.acInFreq': acInFreq, 'inv.inputWatts': inputWatts }` and pass it to the existing `detectGrid`. Volts are mV there, as in the cloud data.
  - Report its verdict with `observedAt` = receipt time.
  - Throttle: report when the verdict's power changes, otherwise at most every `READING_MS = 10_000`.
- **No inverter heartbeat** while connected for `INV_SILENT_MS = 20_000`: report unknown, «станція не повідомляє про вхід». When MPPT `cfgAcEnabled` says the AC output is off, append « (вимкнено вихід AC?)».
- **Link not connected** (searching, connecting, lost) for longer than `LINK_GRACE_MS = 30_000`: report unknown, «станція поза зв’язком Bluetooth». Reconnects that finish within the grace period show nothing.
- **Bluetooth problems**: report unknown with the setup texts, lower-cased as reasons:
  - «Bluetooth на цьому комп’ютері вимкнено»;
  - «немає дозволу на Bluetooth»;
  - «на цьому комп’ютері немає Bluetooth».
- **Refused auth** (0x86 code ≠ 0): report unknown, «станція не прийняла вхід — увійдіть знову в налаштуваннях». Code 6 (WrongKey) is the expected one when the station is not bound to this account.
- **Secrets missing**: the existing `secretsMissingSource` with `ACCOUNT_MISSING_REASON`.
- A reason is reported once when it starts, then repeated at most every 60 s while it holds. That keeps the service from calling it stale.

### Connection policy
- While the source runs, the app holds one connection to the station.
- **Reconnect backoff:** after a failed attempt or a lost link, wait 5, 10, 20, 40, then 60 s (cap), and rescan before each attempt. A session that reached streaming resets the backoff.
- **Connect timeout** of 20 s with `cancelConnect`, because a connect can hang while the phone holds the station.
- **Refused auth:** stop and do not retry for `REFUSED_PAUSE_MS = 30 * 60_000`. Saving the source again restarts it at once.
- **Stale session:** 10 undecodable frames in a row (the key no longer matches) mean disconnect and reconnect.
- **Sleep:** on `powerMonitor` `suspend`, disconnect and stop scanning. On `resume`, start over with no backoff (S§5).

### Where the code runs
Requirements:
- **Process isolation (S§2.5):** noble runs in an Electron `utilityProcess` (the «BLE host»), never in the main process.
- **Supervision:** main supervises the host. On an unexpected exit it respawns with a backoff of 1, 2, 5, 10, then 30 s, and replays the current watch.
- **Lifetime:** the host is started only when needed, for a Bluetooth source or a setup scan. It is stopped when neither has been needed for 60 s.
- **Session location:** the BLE session (crypto, framing, the allow-list) runs in the host, since it needs the GATT write/notify. The host gets `{ sn, token }`, never the userId.
- **Host ↔ main protocol:** messages over the `utilityProcess` port. Main → host:
  - `watch {sn, token}`;
  - `unwatch`;
  - `scan {ms}`;
  - `suspend` / `resume`.

  Host → main:
  - `adapter {state}`;
  - `link {state: 'searching'|'connecting'|'connected'|'refused'|'lost', reason?}`;
  - `heartbeat {module, fields}`, only the five modules of `heartbeatOf`;
  - `scan-result {adverts: [{sn, soc, rssi, encryptType}]}`;
  - `log {level, text}`, which goes to the app log and must contain no secrets.
- **Pure/impure split:** the protocol modules from the spike and the source's logic are pure and unit-tested. Only `electron-deps.ts` (`utilityProcess`, `powerMonitor`) and the host entry touch Electron and noble.
- **The session API changes** from `userId` to `token`, so the userId never reaches the host. `authToken(userId, sn)` moves to main.
- **No tests from the terminal.** `scripts/ble-probe/` and the `ble:probe` npm script are removed. A dev smoke entry `src/main/smoke-ble.ts`, next to `smoke-dtek`/`smoke-ecoflow`, keeps a no-window, no-account check: scan, then the handshake up to the auth status, through the real `utilityProcess` host.

### Packaging
- **Dependencies:**
  - `@stoprocent/noble` 2.8.0, pinned exact; a runtime dependency, kept external.
  - `@noble/curves` 2.4.0, bundled into the host bundle. It is ESM-only, so do not rely on `require(esm)` at runtime.
- **electron-vite:** the host is another `main` input (`ble-host`), as are the smoke entries.
- **electron-builder:**
  - `asarUnpack` adds `'**/node_modules/@stoprocent/noble/**'`.
  - Leave out the optional HCI dependency tree:
    - `!**/node_modules/@stoprocent/bluetooth-hci-socket/**`
    - `!**/node_modules/usb/**`
    - `!**/node_modules/serialport/**`
    - `!**/node_modules/@serialport/**`

    If the packaged app then fails to resolve the default binding, keep them (S§2.4).
  - macOS:
    - `mac.extendInfo.NSBluetoothAlwaysUsageDescription: «Blackout Widget читає зарядну станцію EcoFlow через Bluetooth.»`;
    - `npmRebuild: false`, so the universal `darwin-x64+arm64` prebuild is used rather than a CI compile (S§2.4).
- **Checks:**
  - Windows: the installer build must contain the noble `win32-x64` prebuild under `app.asar.unpacked`.
  - macOS: the CI dmg build must pass.

## Constraints
- **The project's pure-module rule:** `src/shared/**` and `src/main/actual/**` (except `electron-deps.ts`) import no Electron. The new host entry is the only other file that imports noble.
- **Licensing:** the ported protocol code and the key table keep their Apache-2.0 attribution headers (already in the spike files).
- **Copy:** user-facing texts are Ukrainian, exactly as written above.
- **Logs:**
  - SN prefix (4 chars) at most;
  - no token, no userId, no full SN;
  - one line per link state change, not per heartbeat.
- **Platforms:**
  - Windows 11 is verified by the user with the installer.
  - macOS is built by CI and verified by the user later. Expect the Bluetooth permission prompt after each update, because the build is ad-hoc signed (S§4).

## Calls made after the builder check (mine, not the user's)
- **Stalls.** A station that stops answering mid-handshake (`no reply in auth-status` / `no reply in auth`, B§4.4 #471) is a *stall*, not a refusal.
  - Stalls use the normal backoff.
  - After `STALL_LIMIT = 3` stalls in a row, the host pauses for `STALL_PAUSE_MS = 5 * 60_000` with link state `stalled` before it tries again. The pause gives the station its «quiet spell».
  - A session that reaches streaming resets the count.
- **Unsupported model.** Decided by the SN prefix: R601, R603, R611, R613, R621, R623 are supported (`isRiver2Family`, in `src/shared/`).
  - In setup, an unsupported station shows «Модель поки не підтримується» (warn) whether or not it is nearby, and «Зберегти» is disabled. Main's save refuses it too.
  - At runtime, an advert whose encrypt type is not 7 means link state `unsupported`: no connect, recheck after 30 min. Reason: «модель поки не підтримується».
- **Texts the design did not cover** (mine). All live in one shared table so the renderer and main use the same words:

  | State | Setup alert / live line | Reason (source) |
  |---|---|---|
  | adapter `unknown`/`resetting` for more than 10 s | «Bluetooth ще не готовий — якщо система питає дозвіл, дозвольте і спробуйте ще раз» | «Bluetooth недоступний» |
  | BLE host failed: 3 exits in a row without ever reporting the adapter | «Не вдалося запустити Bluetooth у застосунку» | «не вдалося запустити Bluetooth у застосунку» |
  | setup scan failed for another reason | «Не вдалося пошукати станцію через Bluetooth» | — |
  | stalled | «Станція не відповідає — спробую ще раз за кілька хвилин» | «станція не відповідає по Bluetooth» |
- **«Вихід AC»** comes from MPPT `cfgAcEnabled`, or else the inverter's own `cfgAcEnabled`. PD has no such field, so « (вимкнено вихід AC?)» is appended only when one of those two says 0.

## Revision: Bluetooth chosen per station, not as a «Джерело» (2026-10-19)
The user tested the Bluetooth source («ок працює») and asked to pick Bluetooth after signing in, from the station list, rather than as a sign-in method. Shown two mockups, they chose «Перемикач у рядку». This replaces Setup steps 1–5 and 7 (step 6, the save, is unchanged):

1. **«Джерело» options.** The select keeps only «EcoFlow — вхід через акаунт» and «EcoFlow — ключі розробника». The `ble` option and its hint are gone. The account hint stays as it is.
2. **«Перевірити» in account mode.**
   - It signs in and shows the account's stations at once, as before.
   - At the same moment it starts a Bluetooth scan (`SCAN_MS` = 8 s) through a new IPC call. The scan never delays or fails the list.
   - Under the list, while the scan runs: «Шукаю станції поруч через Bluetooth…».
   - A scan problem shows its `BLE_PROBLEM_TEXT` as an alert under the list.
3. **Each station row.**
   - The right-hand state reads «поруч» (green) when its SN was found by the scan, or when it is the station the running Bluetooth source is connected to.
   - Otherwise it shows the cloud state («в мережі» / «не в мережі»), as before.
4. **Under the selected station**, a segmented switch «Підключення»: «Bluetooth» | «Інтернет».
   - **«Bluetooth»** is enabled only when the station is nearby and `isRiver2Family`.
     - When disabled because it is not nearby: «Станцію не знайдено поруч — увімкніть її і тримайте поряд з комп’ютером», plus a «Шукати ще раз» link once the scan has ended.
     - When disabled because of the model: «Модель поки не підтримується».
   - **Default:** «Bluetooth» when it is enabled, else «Інтернет». The default is re-applied when the scan result arrives, unless the user has already touched the switch.
   - **With «Bluetooth» chosen:**
     - the «Перевірка» box reads «Станція поруч — стан світла з’явиться після збереження» (no IPC);
     - a hint reads «Поки віджет підключений, телефон зможе керувати станцією лише через інтернет. Пароль не зберігається — лише ключ для цієї станції.»;
     - «Зберегти» saves with `mode: 'ble'`.
   - **With «Інтернет» chosen:** today's account behaviour — the preview over MQTT, and the save with `mode: 'account'`.
5. **«Змінити» on an `ecoflow-ble` source** opens the account form. After the check, that station is preselected with «Bluetooth» if it is still available.
6. **Main.**
   - `test` no longer takes `mode: 'ble'`, because the scan has its own call: `ecoflowScan(): Promise<{ nearby: string[]; bluetooth?: string }>`. `nearby` holds the scanned SNs plus `connectedSn()`. `bluetooth` is the problem text. The call never rejects.
   - `save` with `mode: 'ble'` is unchanged.

The connected panel, the live line, the readings and the whole Bluetooth stack stay unchanged.

## Left to the builder
- The exact module boundaries inside `src/main/actual/ecoflow/ble/`, and the message type names.
- How the live line is pushed. Suggested:
  - an `actual:live` IPC push to the main window only, throttled to 1/s;
  - `getActualLive()` for the first paint;
  - a new `ActualLive` type in `shared/ipc.ts`.
- Test doubles for the host port and for noble.
