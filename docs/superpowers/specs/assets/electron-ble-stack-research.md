# Electron BLE central stack: feasibility research

Research date: 2026-10-19. This was a read-only spike. No product code was written and no packages were installed.

**What was read:** package metadata from the npm registry, package source pinned on jsDelivr, GitHub issues and PRs (read with `gh`), Chromium `main` source on its GitHub mirror (HEAD `2d407638c5`, 2026-10-19), Electron `main` docs, Microsoft Learn, and Apple developer docs (JSON endpoints).

**How claims are marked:** "UNVERIFIED" means I found no primary source, or the claim is an inference I did not test. Line numbers in Chromium and noble sources refer to the files as fetched on 2026-10-19. The Chromium code was read on `main`, and Electron 44 bundles an older Chromium milestone. Line numbers and exact behaviour may therefore differ in Electron 44. The mechanisms cited (user-activation gate on `requestDevice`, 180 s device eviction, clearing advertisement clients on hidden/focus loss) look long-standing, but were not confirmed for that milestone (UNVERIFIED).

**App context:** `BlackoutWidget`, Electron `^44.9.0`, electron-vite 6, electron-builder `^26.15.3`. Targets are NSIS x64 and an arm64 dmg. The mac build is ad-hoc signed (`identity: '-'`), with `hardenedRuntime: false` and `LSUIElement: true`. Native modules already in use: `koffi` (unpacked via `asarUnpack: '**/node_modules/koffi/**'`). Main/preload dependencies stay external in electron-vite. Sources: [package.json](../../../../package.json), [electron-builder.yml](../../../../electron-builder.yml), [electron.vite.config.ts](../../../../electron.vite.config.ts).

**The workload:**
- Scan for one device by manufacturer data or name.
- Connect, discover one service, write one characteristic, and subscribe to notifications on another.
- Hold the connection for hours to days.
- Reconnect after out-of-range or sleep/resume, with no user gesture.
- Run in the background as a tray/desktop widget.

---

## 0. Recommendation in short

**Pick `@stoprocent/noble` 2.8.x.** Host it in an Electron `utilityProcess` (a Node child process), not in the main process. Main runs a small supervisor that respawns the child on `exit` and owns the reconnect state machine over a MessagePort/IPC.

- **Why noble:** it is the only maintained Node BLE central that meets all of the following today:
  - It uses WinRT on Windows (no WinUSB/Zadig) and CoreBluetooth on macOS.
  - It ships N-API prebuilds for `win32-x64` and `darwin-x64+arm64`, so no toolchain is needed at install time.
  - It exposes manufacturer data during scans.
  - It is written in JS/TS, matching the rest of the app.
- **Why a separate process:** there is a documented, unfixed native crash after about 5 days in an Electron *main* process on macOS ([stoprocent/noble#140](https://github.com/stoprocent/noble/issues/140)). One Electron 44 app moved away from noble because of it ([Colorado-Mesh/mesh-client#1010](https://github.com/Colorado-Mesh/mesh-client/pull/1010)). Isolating noble turns that crash into a respawn instead of an app crash.
- **Fallback 1 (cheap):** the same `utilityProcess` host with `webbluetooth@7` (btleplug + napi-rs, MIT, prebuilt for both targets).
- **Fallback 2 (robust, more work):** a small Rust btleplug sidecar binary over stdio, as mesh-client did.
- **Not recommended as the primary path:** Web Bluetooth in a hidden renderer. Details in section 1.

---

## 1. Electron Web Bluetooth (`navigator.bluetooth` in a renderer)

### 1.1 What Electron exposes

- **Device selection:** `webContents` event `select-bluetooth-device` (docs: [web-contents.md](https://github.com/electron/electron/blob/main/docs/api/web-contents.md#event-select-bluetooth-device)).
  - It is emitted when `navigator.bluetooth.requestDevice` is called.
  - It "will cause `select-bluetooth-device` to fire multiple times until `callback` is called".
  - "If no event listener is added for this event, all bluetooth requests will be cancelled."
- **Data in that event:** each device carries only `deviceName` and `deviceId` ([structures/bluetooth-device.md](https://github.com/electron/electron/blob/main/docs/api/structures/bluetooth-device.md)). The event carries no advertisement data, no RSSI and no manufacturer data.
- **Pairing:** `ses.setBluetoothPairingHandler(handler)` is "_Windows_ _Linux_" only ([session.md](https://github.com/electron/electron/blob/main/docs/api/session.md#sessetbluetoothpairinghandlerhandler-windows-linux)).
  - Open or recent 2026 reports say the handler does not fire as expected on Windows 11. See [electron#52743](https://github.com/electron/electron/issues/52743) (open, 2026-08-10) and [electron#52837](https://github.com/electron/electron/issues/52837), which was closed for lack of a repro. In #52837 a user says the flag `enable-features=WebBluetoothConfirmPairingSupport` is needed.
- **Persistent device permissions:** not available for Bluetooth.
  - `ses.setDevicePermissionHandler` supports `deviceType` "`hid`, `serial`, or `usb`" only ([session.md](https://github.com/electron/electron/blob/main/docs/api/session.md#sessetdevicepermissionhandlerhandler)).
  - The proposal to add Bluetooth (`session.devices`) is still open ([electron#53659](https://github.com/electron/electron/issues/53659), 2026-09-07). It states that "hid/usb/serial have `setDevicePermissionHandler` and `*-revoked` while Bluetooth doesn't".

### 1.2 User gesture

- **Chromium gates two calls on user activation:**
  - `requestDevice` returns `USER_ACTIVATION_REQUIRED` unless `render_frame_host().HasTransientUserActivation()` ([web_bluetooth_service_impl.cc ~L869](https://github.com/chromium/chromium/blob/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)).
  - `requestLEScan` has the same check (~L1675).
- **`gatt.connect()` is not gated.** `RemoteServerConnect` (~L955–1000) checks only the following, and has no user-activation check:
  - that Bluetooth is allowed;
  - that the device ID is in the frame's allowed-devices map;
  - that the adapter still has the device cached.
- **Workaround for `requestDevice`:** `webContents.executeJavaScript(code, true)`. Docs: "Setting `userGesture` to `true` will remove this limitation" ([web-contents.md](https://github.com/electron/electron/blob/main/docs/api/web-contents.md#contentsexecutejavascriptcode-usergesture)).
  - A maintainer confirmed it for Web Bluetooth when closing [electron#28116](https://github.com/electron/electron/issues/28116) on 2026-08-11: "`webContents.executeJavaScript(code, true)` gives you the gesture, confirmed working".
  - Combined with auto-selecting in `select-bluetooth-device`, a new `requestDevice` can run with no human.

### 1.3 Can it reconnect without a gesture?

- **Within one document: yes.** The Chrome team's sample ([automatic-reconnect.js](https://github.com/GoogleChrome/samples/blob/gh-pages/web-bluetooth/automatic-reconnect.js), demo at [googlechrome.github.io](https://googlechrome.github.io/samples/web-bluetooth/automatic-reconnect.html)) works like this:
  - it gets the device with one `requestDevice`;
  - on `gattserverdisconnected` it calls `bluetoothDevice.gatt.connect()` with exponential backoff.
- **Across app restarts or renderer reloads: no, unless you redo `requestDevice`.**
  - Without the `WebBluetoothNewPermissionsBackend` feature, permission is checked against `allowed_devices()`, which is in-memory per document (`QueryCacheForDevice` and `RemoteServerConnect`, ~L960–990 and ~L2470–2500 of [web_bluetooth_service_impl.cc](https://github.com/chromium/chromium/blob/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)).
  - Persistent permissions and `getDevices()` are behind 🚩 flags in Chromium ([implementation-status.md](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)). Electron has no Bluetooth permission store (section 1.1).
  - A 2021 report shows `getDevices()` returns an empty list after an app restart ([electron#29910](https://github.com/electron/electron/issues/29910), closed as needs-repro).
- **macOS evicts the device after 3 minutes, which breaks `gatt.connect()`.**
  - `BluetoothAdapter::RemoveTimedOutDevices()` drops every device that is not paired, not connected and not GATT-connected once its last update is older than `timeoutSec = base::Seconds(180)` ([bluetooth_adapter.cc ~L711–752](https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_adapter.cc)).
  - On macOS it is called on every adapter poll (`BluetoothAdapterMac::PollAdapter`, [bluetooth_adapter_mac.mm ~L560](https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_adapter_mac.mm)).
  - Once the device is gone from the adapter, `gatt.connect()` fails. The source comment reads "When a device can't be found in the BluetoothAdapter, that generally indicates that it's gone out of range. We reject with a NetworkError" (~L2492).
  - Net effect on macOS: after the station has been out of range for about 3 minutes, the page must run `requestDevice` again (with the faked gesture).
  - Windows: the WinRT adapter ([bluetooth_adapter_winrt.cc](https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_adapter_winrt.cc)) has no `RemoveTimedOutDevices` call. Whether `gatt.connect()` to a long-absent device then waits, fails, or needs a re-request is UNVERIFIED.

### 1.4 Manufacturer data during scanning

- **Filtering works.** `requestDevice` filters on `manufacturerData` from Chrome 92 on all desktop platforms ([implementation-status.md](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)), so you can *select* the station by manufacturer data.
- **Reading the data does not.**
  - The Electron chooser event has no advertisement payload. A user in [electron#31869](https://github.com/electron/electron/issues/31869) says `requestDevice` "does not provide any advertisement data for any devices it finds".
  - `watchAdvertisements()` and `getDevices()` are behind `enable-experimental-web-platform-features` ([implementation-status.md](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)).
  - `requestLEScan` events never arrive in Electron. The issue was closed because upstream "Development paused" ([electron#37964](https://github.com/electron/electron/issues/37964)).
- **Advertisement watching is incompatible with a hidden or unfocused widget.** Chromium clears all advertisement and scan clients when the WebContents becomes `HIDDEN` or `OCCLUDED`, or loses focus (`OnVisibilityChanged` / `OnWebContentsLostFocus` → `ClearAdvertisementClients()`, [web_bluetooth_service_impl.cc ~L635–653, ~L2686](https://github.com/chromium/chromium/blob/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)).
  - `backgroundThrottling: false` keeps the *page* visibility state `visible` ([browser-window.md](https://github.com/electron/electron/blob/main/docs/api/browser-window.md#page-visibility)). Whether it also changes the browser-side `content::Visibility` that this observer sees is UNVERIFIED. The lost-focus path clears clients regardless.

### 1.5 Hidden window for hours

- **GATT notifications** are not cleared on visibility or focus changes. Only advertisement clients are (code above). A hidden window should therefore keep receiving notifications. Multi-hour behaviour is UNVERIFIED.
- **Timers:** a hidden renderer needs `webPreferences.backgroundThrottling: false` so reconnect timers are not throttled ([web-preferences.md](https://github.com/electron/electron/blob/main/docs/api/structures/web-preferences.md)).
- **Lifetime:** the whole BLE session lives in that renderer. A reload or crash loses every `BluetoothDevice` object (section 1.3).

### 1.6 Platform caveats

- **Windows:** needs Windows 10 1703 or later ([implementation-status.md](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)). Chromium's backend is WinRT ([bluetooth_adapter_winrt.cc](https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_adapter_winrt.cc)), so no driver swap is needed.
- **Windows crashes:**
  - A main-process crash after re-inserting a Bluetooth dongle during a request was reported in [electron#42835](https://github.com/electron/electron/issues/42835) (closed).
  - Using noble and Web Bluetooth in the same Electron app crashed in `BthRadioMedia.dll` ([abandonware/noble#337](https://github.com/abandonware/noble/issues/337), open). **Do not mix the two stacks.**
- **macOS:** Electron's default `Info.plist` already contains `NSBluetoothAlwaysUsageDescription` and `NSBluetoothPeripheralUsageDescription`, both set to "This app needs access to Bluetooth" ([Info.plist](https://github.com/electron/electron/blob/main/shell/browser/resources/mac/Info.plist)).
  - A Chromium engineer explains that crashes without it are the OS killing the app over the missing key or permission. Terminal-launched builds inherit the terminal's TCC grant ([electron#31167](https://github.com/electron/electron/issues/31167)).
- **`file://` origins:** Chromium refuses to bind Web Bluetooth for an opaque top-level origin ([web_bluetooth_service_impl.cc ~L377](https://github.com/chromium/chromium/blob/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)). Electron's official Web Bluetooth fiddle uses `loadFile('index.html')` ([fiddle main.js](https://github.com/electron/electron/blob/main/docs/fiddles/features/web-bluetooth/main.js)), so `file://` is presumably fine. That is UNVERIFIED for this app's `loadFile` renderer.

### 1.7 Verdict

Web Bluetooth is feasible but hacky for this workload.
- **What works:**
  - filtering by manufacturer data;
  - `gatt.connect()` without a gesture inside one document;
  - re-running `requestDevice` via `executeJavaScript(…, true)` with auto-selection.
- **What does not:**
  - you cannot *read* advertisement or manufacturer data in a hidden or unfocused window;
  - on macOS an absent device is forgotten after 180 s;
  - nothing survives a renderer reload or app restart;
  - the BLE session's lifetime is tied to a hidden BrowserWindow.

It is a reasonable no-native-code fallback, not the primary path.

---

## 2. noble forks

### 2.1 Status (npm registry, GitHub; read 2026-10-19)

| | `@abandonware/noble` | `@stoprocent/noble` |
|---|---|---|
| Latest | `1.9.2-26`, 2025-02-09 ([npm](https://www.npmjs.com/package/@abandonware/noble)) | `2.8.0`, 2026-08-20 ([npm](https://www.npmjs.com/package/@stoprocent/noble), [release](https://github.com/stoprocent/noble/releases/tag/v2.8.0)) |
| Release cadence | 2 releases since 2024-02; last repo push 2025-02-09 ([repo](https://github.com/abandonware/noble)) | 2.5.6 → 2.8.0 between 2026-07-13 and 2026-08-20 ([releases](https://github.com/stoprocent/noble/releases)) |
| Downloads (30 d to 2026-10-16) | 38,407 ([npm API](https://api.npmjs.org/downloads/point/last-month/@abandonware/noble)) | 185,366 ([npm API](https://api.npmjs.org/downloads/point/last-month/@stoprocent/noble)) |
| Open issues + PRs (GitHub `open_issues_count`) | 143 | 8 |
| Windows backend | C++/WinRT N-API addon ([lib/win/binding.gyp](https://cdn.jsdelivr.net/npm/@abandonware/noble@1.9.2-26/lib/win/binding.gyp): `noble_winrt.cc`, `radio_watcher.cc` …) | C++/WinRT N-API addon, C++20 ([lib/win/binding.gyp](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/win/binding.gyp), `msvs_target_platform_minversion 10.0.18362.0`) |
| macOS backend | Objective-C++ CoreBluetooth addon | CoreBluetooth addon (`-framework CoreBluetooth`, `MACOSX_DEPLOYMENT_TARGET 11`, built for `x86_64` and `arm64`) ([lib/mac/binding.gyp](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/mac/binding.gyp)) |
| Prebuilt binaries | **None in the tarball.** `install: node-gyp-build` compiles on install, which needs VS Build Tools or Xcode ([file list](https://data.jsdelivr.com/v1/packages/npm/@abandonware/noble@1.9.2-26?structure=flat)) | **Yes**, N-API: `prebuilds/win32-x64/node.napi.node` (560 KB), `prebuilds/darwin-x64+arm64/node.napi.node` (universal, 506 KB), plus linux/android ([file list](https://data.jsdelivr.com/v1/packages/npm/@stoprocent/noble@2.8.0?structure=flat)) |
| Known Electron problems | Exit crash in `napi-thread-safe-callback` ([#215](https://github.com/abandonware/noble/issues/215)); packaged-app `stateChange unknown` ([#145](https://github.com/abandonware/noble/issues/145)); crash when mixed with Web Bluetooth ([#337](https://github.com/abandonware/noble/issues/337)); Windows build failures ([#277](https://github.com/abandonware/noble/issues/277), [#313](https://github.com/abandonware/noble/issues/313)) | Multi-day main-process crash on macOS ([#140](https://github.com/stoprocent/noble/issues/140), closed as stale and **not fixed**). Section 2.5. |

- **Verdict on `@abandonware/noble`:** effectively dormant. Every user must compile it on install. Do not use it.
- **Other users of `@stoprocent/noble`:**
  - matter.js depends on it: `@matter/nodejs-ble` 0.17.9 lists `@stoprocent/noble ^2.7.1` as an optional dependency ([npm](https://www.npmjs.com/package/@matter/nodejs-ble)).
  - The matter.js maintainer (Apollon77) contributes fixes (e.g. [#91](https://github.com/stoprocent/noble/issues/91)).
  - OneKey's `@onekeyfe/hwk-desktop-noble-ble` (a "Main-process BLE service") has peer dependencies `electron` and `@stoprocent/noble` ([npm](https://www.npmjs.com/package/@onekeyfe/hwk-desktop-noble-ble)).
- **Maintainer bandwidth:** the owner wrote "I typically don't have time to work on it weekly, so I dedicate a full week to noble/bleno development every few months" ([#52](https://github.com/stoprocent/noble/issues/52)). Bug fixes arrive in bursts. Stale issues are auto-closed after 44 days.

### 2.2 `@stoprocent/noble` on Windows: native WinRT, no driver swap

- **Binding selection.** On `win32`, the default binding is `'win'`. `getWindowsBindings()` returns the WinRT addon when `os.release()` is 10.0.15063 or later, and otherwise falls back to HCI, which would need WinUSB ([lib/resolve-bindings.js](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/resolve-bindings.js)). Windows 11 always gets WinRT.
  - The README's "Bluetooth 4.0 USB adapter + Zadig" prerequisite applies only to the HCI path ([README](https://github.com/stoprocent/noble)).
- **What the WinRT code does** ([lib/win/src/ble_manager.cc](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/win/src/ble_manager.cc)):
  - **Scanning:** a `BluetoothLEAdvertisementWatcher` with `ScanningMode(Active)`. Service-UUID filtering happens after reception, not in the OS filter (~L168–245).
  - **Manufacturer data:** parsed from `BluetoothLEAdvertisementDataTypes::ManufacturerSpecificData()`. Local name and TX power are parsed too ([peripheral_winrt.cc ~L114–160](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/win/src/peripheral_winrt.cc)).
  - **Connect:** `BluetoothLEDevice::FromBluetoothAddressAsync`. It also builds a peripheral from a raw address if it was never scanned ("direct connect", ~L270–310).
  - After connect, the binding:
    - creates a `GattSession`;
    - reads `MaxPduSize` as the MTU and listens for `MaxPduSizeChanged`;
    - sets `session.MaintainConnection(true)` (~L349–370);
    - discovers services and characteristics with `BluetoothCacheMode::Uncached`.
  - **Disconnect:** `ConnectionStatusChanged` → `Disconnected` emits `disconnect` (~L620–640).
    - This was broken in 2.3.3–2.4.0: "the `disconnect` event is never emitted" when the device goes out of range. Fixed in 2.4.1 ([#77](https://github.com/stoprocent/noble/issues/77)).
  - **Scan stopped by the OS:** `OnScanStopped` just emits `scanStop` (~L261–265). The app must restart scanning itself, for example after resume.
- **Windows-specific bugs fixed in 2025–2026 (they show the binding is still settling):**
  - A false "connected" result on reconnect on Windows 11 ([#39](https://github.com/stoprocent/noble/issues/39), fixed 2.3.3).
  - `writeAsync` hung when the user cancelled the pairing dialog ([#59](https://github.com/stoprocent/noble/issues/59)).
  - The adapter was reported "unsupported" on builds before 19041 ([#84](https://github.com/stoprocent/noble/issues/84), fixed 2.5.4).
  - A crash when `bthserv` is disabled ([#85](https://github.com/stoprocent/noble/issues/85), fixed 2.5.4).
  - `stop()` ACCESS_VIOLATION, and `waitForPoweredOnAsync` keeping the process alive ([#95](https://github.com/stoprocent/noble/issues/95), fixed 2.5.9; `stop()` is now "safe/idempotent").
  - A one-packet notification lag above 20 bytes that the maintainer attributed to the Windows stack and that the reporter later could not reproduce ([#93](https://github.com/stoprocent/noble/issues/93)).

### 2.3 `@stoprocent/noble` on macOS: CoreBluetooth

From [lib/mac/src/ble_manager.mm](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/mac/src/ble_manager.mm):
- `CBCentralManager` runs on its own dispatch queue.
- A 2-second GCD timer re-checks `central.state` "to handle sleep/wake cycles" (~L25–43).
- When the radio comes back from powered-off, the binding cancels stale connections (~L58–66).
- Manufacturer data comes from `CBAdvertisementDataManufacturerDataKey` (~L120).
- Direct connect uses `retrievePeripheralsWithIdentifiers` (~L164). Connect sets `CBConnectPeripheralOptionNotifyOnDisconnectionKey` (~L173).
- MTU comes from `maximumWriteValueLengthForType:` (~L50).
- **Reconnect without polling:** CoreBluetooth "Attempts to connect to a peripheral don't time out" ([Apple: connect(_:options:)](https://developer.apple.com/documentation/corebluetooth/cbcentralmanager/connect(_:options:))). A pending `connect` to a known identifier therefore reconnects on its own when the station comes back.
- **Device identity:** on macOS the peripheral ID is a per-host CoreBluetooth UUID, not the MAC address. Store it per platform. Source: the btleplug README notes that CoreBluetooth gives no MAC address ([btleplug README](https://github.com/deviceplug/btleplug)).
- **Dev runs:** grant Bluetooth to the terminal app ("allow bluetooth access on the terminal app", [README](https://github.com/stoprocent/noble)).

### 2.4 Loading in Electron and packaging with electron-builder

- **No rebuild for the Electron ABI.** It is an N-API addon built with `prebuildify --napi` ([package.json](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/package.json)) and loaded through `node-gyp-build`.
- **Electron memory cage:** native code must not hand V8 external buffers. This one copies data (`Napi::Buffer<uint8_t>::Copy` in [lib/common/src/Emit.cc ~L30–36](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/common/src/Emit.cc)), which is what the [Electron memory-cage post](https://www.electronjs.org/blog/v8-memory-cage) requires ("ArrayBuffers which point to external ("off-heap") memory are no longer allowed").
  - Callbacks use `Napi::TypedThreadSafeFunction` ([ThreadSafeCallback.h](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/common/include/ThreadSafeCallback.h)), not the `napi-thread-safe-callback` package behind abandonware's exit crash.
- **How `node-gyp-build` picks a binary** ([node-gyp-build.js](https://github.com/prebuild/node-gyp-build/blob/master/node-gyp-build.js)):
  - It tries `build/Release` first.
  - It then parses multi-arch folders such as `darwin-x64+arm64` (~L95–118).
  - So the universal mac prebuild loads on arm64.
- **Pitfall with electron-builder's default `npmRebuild: true`**, which runs `@electron/rebuild` ([scheme.json NativeModulesConfig.npmRebuild](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/scheme.json)):
  - The prebuildify detector in `@electron/rebuild` looks only for `prebuilds/${platform}-${arch}/node.napi.node`, or `…armv8.node` on arm64 ([prebuildify.ts](https://github.com/electron/rebuild/blob/main/src/module-type/prebuildify.ts)).
  - On Windows x64 it finds `win32-x64/node.napi.node` and skips the rebuild.
  - On darwin-arm64 it looks for `prebuilds/darwin-arm64/` and does not see `darwin-x64+arm64/`. It will therefore *compile from source*: node-gyp plus Xcode CLT on the mac runner, which GitHub macOS runners have (UNVERIFIED for this repo's workflow).
  - The resulting `build/Release` binary then wins at runtime.
  - **Option A:** set `npmRebuild: false`. Neither `koffi` nor noble needs it, and the universal prebuild loads as is.
  - **Option B:** keep the rebuild and accept a CI compile.
  - Either way, smoke-test the packaged app.
- **asar:** electron-builder's `smartUnpack` defaults to true ([scheme.json AsarOptions.smartUnpack](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/scheme.json)) and treats `*.node` as lib/exe ([unpackDetector.ts](https://github.com/electron-userland/electron-builder/blob/master/packages/app-builder-lib/src/asar/unpackDetector.ts)).
  - Even so, add `'**/node_modules/@stoprocent/noble/**'` to `asarUnpack` next to the koffi line. `node-gyp-build` does `readdirSync` on `prebuilds/`, so keeping the whole package unpacked is the safe choice (UNVERIFIED whether a partial unpack fails).
- **Optional HCI dependency tree:** `@stoprocent/bluetooth-hci-socket ^2.3.0` is an optional dependency and pulls in `serialport` and `usb`, both native ([npm](https://www.npmjs.com/package/@stoprocent/bluetooth-hci-socket)).
  - On win32 (build ≥ 15063) and darwin it is required only when the binding type is `hci` ([resolve-bindings.js](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/resolve-bindings.js)).
  - It can be excluded from `files` (`!**/node_modules/@stoprocent/bluetooth-hci-socket/**`, `!**/node_modules/usb/**`, `!**/node_modules/serialport/**`, `!**/node_modules/@serialport/**`) to save size and rebuild work. Verify the exclusion in a packaged smoke test.
  - Note that `patch-package` is listed as a runtime dependency (harmless).
- **electron-vite:** add the BLE host script as another `main` rollup input. Dependencies stay external, as for koffi ([electron.vite.config.ts](../../../../electron.vite.config.ts)).

### 2.5 The long-run risk, and why the utilityProcess matters

- **The crash.** [stoprocent/noble#140](https://github.com/stoprocent/noble/issues/140) (2026-08-30): "When a Noble BLE GATT session stays continuously connected for roughly 5+ days, the entire Electron app hard-crashes with a native abort — `EXC_BREAKPOINT` / SIGTRAP on macOS".
  - Environment: `@stoprocent/noble` 2.8.0 and earlier, running in the Electron main process.
  - Windows is "believed same class, unconfirmed".
  - The issue was auto-closed as stale on 2026-10-15 with no fix.
- **The same app's history** ([Colorado-Mesh/mesh-client](https://github.com/Colorado-Mesh/mesh-client), Electron 44):
  1. It added a "day-4 restart nudge" ([PR #890](https://github.com/Colorado-Mesh/mesh-client/pull/890), merged 2026-08-24).
  2. It then moved all BLE to a Rust btleplug sidecar ([issue #1009](https://github.com/Colorado-Mesh/mesh-client/issues/1009), [PR #1010](https://github.com/Colorado-Mesh/mesh-client/pull/1010), merged 2026-09-15). Its `electron-builder.yml` now says "Native BLE moved to reticulum-sidecar (btleplug); @stoprocent/noble removed" ([electron-builder.yml](https://github.com/Colorado-Mesh/mesh-client/blob/main/electron-builder.yml)).
- **Mitigation: run noble in `utilityProcess.fork()`.**
  - It is "the equivalent of `child_process.fork`" ([utility-process.md](https://github.com/electron/electron/blob/main/docs/api/utility-process.md)).
  - Main listens for `exit`, respawns with backoff, and re-issues connect.
  - A planned recycle (for example daily, while disconnected) is cheap insurance.
  - Native addon loading in a utility process is expected to work because it is a Node.js environment, but that is UNVERIFIED in this spike.

### 2.6 Notifications and MTU

- **Notifications:** `subscribeAsync()` / `notificationsAsync()` / `data` events with `isNotification` ([README](https://github.com/stoprocent/noble)).
  - On Windows this writes the CCCD and hooks `ValueChanged`, which matches Microsoft's documented pattern ([GATT client](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-client)).
- **MTU:**
  - Windows negotiates the MTU itself. noble reports `MaxPduSize`, which the code comment calls "equivalent to the MTU-3" ([ble_manager.cc ~L356](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/win/src/ble_manager.cc)).
  - The `connect({ mtu })` option added in 2.4.0 ([#71](https://github.com/stoprocent/noble/issues/71), types fixed in [#138](https://github.com/stoprocent/noble/issues/138)) targets the HCI path. Its effect on WinRT and CoreBluetooth is UNVERIFIED.
  - On macOS the MTU is whatever CoreBluetooth negotiated.

---

## 3. Other options

| Option | Platforms / backend | Status | Fit |
|---|---|---|---|
| **node-ble** 1.13.0 (2025-01-19) | Linux only. Its only dependency is `dbus-next` (BlueZ D-Bus) ([npm](https://www.npmjs.com/package/node-ble), [repo](https://github.com/chrvadala/node-ble)) | Slow | ❌ No Windows or macOS |
| **webbluetooth** v3–v6 ([thegecko/webbluetooth](https://github.com/thegecko/webbluetooth)) | SimpleBLE. v3 = SimpleBLE 0.6.1 (MIT); v6 = latest SimpleBLE (**BUSL-1.1**) | Superseded | Licensing trap above v3 |
| **webbluetooth** v7.1.0 (2026-10-04) ([npm](https://www.npmjs.com/package/webbluetooth), [webbluetooth-rs](https://github.com/thegecko/webbluetooth-rs)) | "complete rewrite in rust using … btleplug … and napi-rs", MIT. Optional native packages include `@webbluetooth/webbluetooth-win32-x64-msvc` (2.2 MB) and `-darwin-arm64` (1.8 MB). `Cargo.toml`: `btleplug = "0.13.0"`, `napi 3.12` ([Cargo.toml](https://github.com/thegecko/webbluetooth-rs/blob/main/Cargo.toml)) | Very new: v7.0.0 2026-08-24, about 5k downloads/month, single maintainer | ✅ Fallback 1. Web Bluetooth-shaped API: `requestDevice` with a `manufacturerData` filter, `getDevices()`, `gattserverdisconnected`, `characteristicvaluechanged`. Raw advertisement data is not exposed: `watchAdvertisements()` "unsupported in adapter" ([README](https://github.com/thegecko/webbluetooth-rs)) |
| **simpleble** (npm, Symbitic) 1.2.0 (2022-12-04) ([npm](https://www.npmjs.com/package/simpleble)) | cmake-js + prebuild-install | Abandoned | ❌ |
| **simplejsble** (official SimpleBLE JS) ([repo dir](https://github.com/simpleble/simpleble/tree/main/simplejsble), [npm](https://www.npmjs.com/package/simplejsble)) | SimpleBLE: WinRT and CoreBluetooth. "includes the native addon for every supported platform", Node ≥ 22 | Only `1.2.1-devNN` builds (latest 2026-10-19) | ⚠️ **BUSL-1.1**: "requires a commercial license for commercial use" ([README](https://github.com/simpleble/simpleble)). Pre-release |
| **simplersble** (Rust bindings for SimpleBLE) ([crates.io](https://crates.io/crates/simplersble)) | Rust | `1.2.1-dev94` | Same BUSL licensing. Rust, not Node |
| **btleplug** 0.13.5 (2026-10-10) ([repo](https://github.com/deviceplug/btleplug), [crates.io](https://crates.io/crates/btleplug)) | Rust. WinRT on Windows, CoreBluetooth on macOS (≥ 10.15). The feature table ticks manufacturer data, connect/disconnect events, notifications and MTU for Windows and macOS | Active, 1,187★ | ✅ Basis for fallback 2 (own sidecar binary) |
| **noble-winrt** (urish) 0.1.1 (2018) ([npm](https://www.npmjs.com/package/noble-winrt)) | Chrome native-messaging bridge | Dead | ❌ |
| **NodeRT** WinRT projections, e.g. `@nodert-win11-22h2/windows.devices.bluetooth` 0.1.6 (2022-09-27) ([npm](https://www.npmjs.com/package/@nodert-win11-22h2/windows.devices.bluetooth), repo `demosjarco/NodeRT`) | Generated WinRT wrappers, Windows only. Built on **NAN** (`"nan": "latest"`) with `install: node-gyp rebuild`. No prebuilds in the tarball ([file list](https://data.jsdelivr.com/v1/packages/npm/@nodert-win11-22h2/windows.devices.bluetooth@0.1.6?structure=flat)) | No publish since 2022 | ❌ Every Electron bump means a rebuild with VS + Windows SDK, on every developer machine and in CI. Windows only, so macOS would still need something else |
| **Other noble forks** (npm search `text=noble`, 2026-10-19, [query](https://registry.npmjs.org/-/v1/search?text=noble&size=100)) | Of the BLE packages published 2025–2026, the only maintained fork with its own native code is `@stoprocent/noble`. The rest are wrappers: `@csllc/noble-ble` wraps `@abandonware/noble`; `@onekeyfe/hwk-desktop-noble-ble` is a "Main-process BLE service" with peer dependencies `electron` and `@stoprocent/noble` ([npm](https://www.npmjs.com/package/@onekeyfe/hwk-desktop-noble-ble)) | — | No alternative fork. OneKey (a hardware-wallet vendor) is another Electron production user of `@stoprocent/noble` |
| **`@homebridge/*` BLE / WinRT bindings** | npm search `scope:homebridge` returned 0 packages (2026-10-19, [query](https://registry.npmjs.org/-/v1/search?text=scope:homebridge&size=250)). The search API may not index scopes this way, so this is UNVERIFIED. No homebridge BLE/WinRT binding turned up in any other search in this spike | — | None found |
| **Own native helpers over stdio** | Swift CLI (CoreBluetooth) + C++/WinRT or C# console exe | — | Possible, two codebases (section 3.1) |
| **koffi + WinRT / CoreBluetooth** | — | — | ❌ Impractical (section 3.2) |

### 3.1 Cost of writing native helpers

Size and effort figures in this section are estimates (UNVERIFIED) unless a link is given.

- **macOS: Swift CLI.** A few hundred lines covering `CBCentralManagerDelegate` and `CBPeripheralDelegate`, plus JSON lines on stdin/stdout.
  - Build with `swiftc` on the existing mac runner and ship via `extraResources` or `Contents/MacOS`. electron-builder ad-hoc signs it with the app.
  - TCC: by default a child process is attributed to the responsible (parent) app. Apple DTS: "processes inheriting the permissions of their parent process", with the caveat that "the actually behavior for any given case depends on … engineering choices … [and] bugs" ([forum 763956](https://developer.apple.com/forums/thread/763956)). The app's `Info.plist` key would therefore apply. UNVERIFIED for a CLI binary under an ad-hoc `LSUIElement` app.
- **Windows, option 1: C++/WinRT console exe.** Small (hundreds of KB) and needs MSVC plus the Windows SDK in CI.
- **Windows, option 2: C# console.**
  - Framework-dependent would need the .NET runtime installed. Self-contained is large.
  - NativeAOT is supported for WinRT projections "As of CsWinRT 2.1.1 … generated projections are AOT compatible" ([CsWinRT aot-trimming.md](https://github.com/microsoft/CsWinRT/blob/master/docs/aot-trimming.md)).
- **Total:** two languages, two CI toolchains and one stdio protocol. A **single Rust btleplug sidecar** gives the same process isolation with one codebase. That is what mesh-client chose ([PR #1010](https://github.com/Colorado-Mesh/mesh-client/pull/1010)) and why it is the preferred "own helper" option.

### 3.2 koffi + WinRT, or koffi + CoreBluetooth: impractical

- **Windows (WinRT through koffi)** would mean hand-rolling, in JS:
  - `RoInitialize` and `RoGetActivationFactory` with HSTRING class names;
  - `QueryInterface` by IID and calls through vtable slot indices;
  - IIDs for parameterized interfaces such as `IAsyncOperation<BluetoothLEDevice>` and `TypedEventHandler<…>`, which must be derived with the WinRT pinterface algorithm;
  - COM objects implemented in JS (vtable + `AddRef`/`Release`/`Invoke`) for every async completion and every event handler.
- **macOS (CoreBluetooth through koffi)** would mean:
  - building delegate classes at runtime (`objc_allocateClassPair` / `class_addMethod`);
  - `objc_msgSend` with the right signatures;
  - creating dispatch queues.
- **Threading:** koffi can call JS from secondary threads only by queueing to the main thread. It warns "you can easily get into a deadlock situation". Registered callbacks are capped ("A maximum of 8192 callbacks") ([koffi callbacks](https://koffi.dev/callbacks)).
- **COM / Objective-C:** the koffi callbacks docs do not mention either.
- **Conclusion:** far more code and risk than any other option here. Not recommended.

---

## 4. macOS specifics (14+, Apple Silicon, ad-hoc, LSUIElement)

- **Usage string:** `NSBluetoothAlwaysUsageDescription` "is required if your app uses the device's Bluetooth interface" ([Apple](https://developer.apple.com/documentation/bundleresources/information-property-list/nsbluetoothalwaysusagedescription)).
  - Electron's base `Info.plist` already includes a generic string ([Info.plist](https://github.com/electron/electron/blob/main/shell/browser/resources/mac/Info.plist)).
  - Set a real one via `mac.extendInfo`, for example:
    ```yaml
    mac:
      extendInfo:
        LSUIElement: true
        NSBluetoothAlwaysUsageDescription: "Blackout Widget reads your power station over Bluetooth."
    ```
    mesh-client does the same ([electron-builder.yml](https://github.com/Colorado-Mesh/mesh-client/blob/main/electron-builder.yml)). Whether electron-builder keeps Electron's default key when `extendInfo` omits it is UNVERIFIED. Set it explicitly.
- **Entitlement:** none needed without App Sandbox. `com.apple.security.device.bluetooth` is a sandbox entitlement ("enable the App Sandbox capability in Xcode, and under Hardware, select Bluetooth", [Apple](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.bluetooth)).
  - With `hardenedRuntime: false`, library validation is not enforced (UNVERIFIED in docs read here). koffi already loads under the same config, which is consistent with that.
- **Ad-hoc signing and TCC: expect a re-prompt after every app update.**
  - TN3127: "Ad hoc signed code … has a DR but it's tied to that specific version of the code … If you tweak the code and run it again, macOS repeats that prompt" ([TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)).
  - Quinn (DTS): "TCC uses the DR to track whether build N+1 of your program is the same as build N" ([forum 707177](https://developer.apple.com/forums/thread/707177)).
  - A Developer ID signature would fix this later.
- **utilityProcess attribution:** TCC requests from a `utilityProcess` are attributed to the main app unless `disclaim: true`. Electron docs: "When responsibility is disclaimed, the parent process will not be attributed for any TCC requests initiated by the child process" ([utility-process.md](https://github.com/electron/electron/blob/main/docs/api/utility-process.md)). The default is `false`, so the main bundle's usage string and grant apply.
  - Do **not** set `allowLoadingUnsignedLibraries` (it switches to the Plugin helper), and do not set `disclaim`.
- **Prompt timing:** the prompt appears on first `CBCentralManager` use. Authorization can be read through `CBManager.authorization`, initially `notDetermined` ([Apple](https://developer.apple.com/documentation/corebluetooth/cbmanager/authorization-swift.type.property)).
  - Whether the prompt shows for an `LSUIElement` agent app with no visible window is UNVERIFIED. It is expected to, because TCC prompts are system UI, but test it.
- **Denied or missing permission:** noble reports the state as `unauthorized`. A missing usage string kills the process (the [electron#31167](https://github.com/electron/electron/issues/31167) explanation). Inside a `utilityProcess` that means a child crash, not an app crash.
- **Launch location:** launching from `/Applications` is fine. TCC keys on the code requirement, not the path; for ad-hoc that is the cdhash (TN3127 above). App Translocation (running quarantined from Downloads or the dmg) should not change the identity, but that is UNVERIFIED.
- **Dev mode** (`electron-vite dev` from a terminal): the terminal app is the responsible process and needs the Bluetooth grant ([electron#31167](https://github.com/electron/electron/issues/31167) comments, [btleplug README](https://github.com/deviceplug/btleplug)).
- **Sleep/wake:** noble's mac binding polls the manager state every 2 s and cancels stale connections when power returns (section 2.3). A pending `connect` never times out (section 2.3).

## 5. Windows specifics (11 x64, built-in adapter, unpackaged NSIS app)

- **No MSIX identity needed.**
  - Microsoft lists the WinRT APIs that are unsupported or need package identity in desktop apps ([winrt-api-desktop-app-support](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/winrt-api-desktop-app-support), updated 2026-07-22). It contains **no** `Windows.Devices.Bluetooth*` entries; I checked the full text.
  - Two unpackaged Win32 programs use these APIs in practice: Chromium ([bluetooth_adapter_winrt.cc](https://github.com/chromium/chromium/blob/main/device/bluetooth/bluetooth_adapter_winrt.cc)) and noble's WinRT addon.
- **Manifest capability:** the `bluetooth` `DeviceCapability` in `Package.appxmanifest` ([GATT client doc](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-client)) applies to packaged apps. An NSIS Win32 exe has no appx manifest. That this capability is irrelevant for unpackaged apps is inferred from the above; I found no explicit Microsoft statement (UNVERIFIED wording).
- **Pairing is not needed for unencrypted GATT.**
  - Microsoft's own discovery sample enumerates *unpaired* devices (`BluetoothLEDevice.GetDeviceSelectorFromPairingState(false)`). Its connect text says a connection is initiated by `GattSession.MaintainConnection = true`, by uncached discovery, or by a read/write, with no pairing step ([GATT client](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-client)).
  - If a characteristic requires encryption, Windows raises its own pairing dialog. See noble [#59](https://github.com/stoprocent/noble/issues/59), "user cancels Windows BLE pairing dialog during a GATT write".
- **Connection semantics** ([GATT client](https://learn.microsoft.com/en-us/windows/apps/develop/devices-sensors/gatt-client)):
  - "If **GattSession.MaintainConnection** is set to true, then the system waits indefinitely for a connection, and it will connect when the device is available". noble sets this (section 2.2).
  - Otherwise, an unreachable device times out after "seven (7) seconds" per queued request.
  - "Currently, you can't cancel the connection process."
- **Sleep/resume** ([BluetoothLEAdvertisementWatcher.Start remarks](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.advertisement.bluetoothleadvertisementwatcher.start)):
  - "When the system enters any of the supported sleep states (such as S3 or S4), the Bluetooth controller is reset … if your app still has a watcher in the on state when the system wakes up, then scanning will resume automatically".
  - For Modern Standby: "We don't recommend that you scan during a Modern Standby session; instead, your app will need to stop actively scanning, and then resume scanning after the system itself resumes".
  - Hook Electron `powerMonitor` `suspend` / `resume` ([power-monitor.md](https://github.com/electron/electron/blob/main/docs/api/power-monitor.md)): stop scanning on suspend, and on resume restart scanning and reconnect.
  - Expect the GATT link to drop across sleep. That is consistent with the controller reset quoted above; a live test is still needed.
  - The watcher's `Stopped` event fires when scanning is "cancelled or aborted either by the app or due to an error" ([class page](https://learn.microsoft.com/en-us/uwp/api/windows.devices.bluetooth.advertisement.bluetoothleadvertisementwatcher)). noble surfaces it only as `scanStop`, so restart on that too.
- **Minimum OS:** noble needs 10.0.15063 or later for WinRT ([resolve-bindings.js](https://cdn.jsdelivr.net/npm/@stoprocent/noble@2.8.0/lib/resolve-bindings.js)). Chromium needs 1703 ([implementation-status.md](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/implementation-status.md)). Windows 11 meets both.

---

## 6. Comparison

| Criterion | Web Bluetooth (hidden renderer) | @stoprocent/noble in utilityProcess | webbluetooth@7 in utilityProcess | Rust btleplug sidecar |
|---|---|---|---|---|
| Windows without a driver swap | ✅ WinRT | ✅ WinRT | ✅ WinRT (btleplug) | ✅ WinRT |
| macOS CoreBluetooth | ✅ | ✅ | ✅ | ✅ |
| Read manufacturer data while scanning | ❌ (filter only; watchAdvertisements flagged and cleared when hidden/unfocused) | ✅ | ❌ (filter only) | ✅ |
| Reconnect with no gesture | ⚠️ in-document only; macOS evicts after 180 s → re-`requestDevice` with faked gesture | ✅ | ✅ `gatt.connect()` / `getDevices()` | ✅ |
| Survives app restart without a chooser | ❌ (no Bluetooth permission store in Electron) | ✅ store the ID | ✅ (`bluetooth` instance is unrestricted) | ✅ |
| Native crash isolated from the app | ❌ (Chromium browser process = main) | ✅ (child) | ✅ (child) | ✅ (child) |
| Prebuilt for win32-x64 + darwin-arm64 | n/a | ✅ N-API | ✅ napi-rs packages | build it yourself |
| New CI toolchains | none | none (mac may node-gyp, see 2.4) | none | Rust (+ MSVC / Xcode) |
| Maturity for this workload | Electron gaps open since 2021 | 185k/month, active bursts, known multi-day crash | 2 months old | btleplug mature; your code new |

---

## 7. Recommendation, risks and fallback

### Pick: `@stoprocent/noble` (pin 2.8.x), hosted in `utilityProcess`

**Main process (supervisor):**
- `utilityProcess.fork(bleHost.js, [], { serviceName: 'BLE' })`.
- On `exit`: respawn with backoff and replay the desired state (target ID, subscriptions).
- Optionally recycle the child once a day while idle.

**Child process (BLE host):**
- `withBindings('default')` → `waitForPoweredOnAsync()` → `startScanningAsync([], true)`.
- Match on `advertisement.manufacturerData` / `localName`.
- `connectAsync` → discover the service → write → `subscribeAsync`.
- On `disconnect`, by platform:
  - macOS: issue a pending connect by stored UUID, which never times out.
  - Windows: rescan, then connect by address. noble keeps `MaintainConnection(true)`.
- Handle `stateChange` (`poweredOff`, `unauthorized`).
- Always call `stop()` on teardown. It is idempotent since 2.5.9 ([#95](https://github.com/stoprocent/noble/issues/95)).

**Power events:** on `powerMonitor` `suspend`, stop scanning. On `resume`, restart scanning and reconnect (section 5).

**Packaging:**
- Add `asarUnpack: '**/node_modules/@stoprocent/noble/**'`.
- Either set `npmRebuild: false`, or accept the darwin-arm64 source build (section 2.4).
- Optionally exclude the HCI optional dependency tree.
- Add `NSBluetoothAlwaysUsageDescription` to `mac.extendInfo`.

**Why this one:**
- It is the only option that ticks all four of: native WinRT + CoreBluetooth, manufacturer data during scanning, reconnect without any gesture or chooser, and zero new toolchains.
- It keeps everything in TypeScript next to the existing EcoFlow code.
- Running it in a child process turns the known native long-run crash into a recoverable event.

### Main risks

1. **Multi-day native crash.** [#140](https://github.com/stoprocent/noble/issues/140) was seen on macOS after about 5 days in the Electron main process. It is unfixed, and Windows is unconfirmed. Mitigation: the utilityProcess plus auto-respawn. Proof: a 7-day soak on both OSes.
2. **Maintainer bus factor.** The owner works on noble in periodic bursts ([#52](https://github.com/stoprocent/noble/issues/52)). Windows binding regressions have shipped before ([#77](https://github.com/stoprocent/noble/issues/77): disconnect never emitted in 2.3.3–2.4.0). Mitigation: pin the exact version and run a smoke test on every upgrade.
3. **Packaging on mac arm64.** `@electron/rebuild` does not recognise the `darwin-x64+arm64` prebuild (section 2.4). Mitigation: `npmRebuild: false`, or verify the CI compile.
4. **utilityProcess plus native addon plus TCC.** All expected to work per the Electron docs, but UNVERIFIED here. If the utility process misbehaves, the alternative is `child_process.fork` of the app binary with `ELECTRON_RUN_AS_NODE` (UNVERIFIED; it depends on the `RunAsNode` fuse staying enabled).
5. **macOS re-prompt after each update** because of the ad-hoc signature (TN3127). This is a UX issue, not a blocker.
6. **Windows sleep and Modern Standby.** You must restart scanning and reconnect yourself on resume.

### Fallback

1. **Swap the library inside the same host:** use `webbluetooth@7`. It is btleplug via napi-rs, MIT, with prebuilt `win32-x64-msvc` and `darwin-arm64` packages.
   - Matching works through `requestDevice({ filters: [{ manufacturerData: [...] }] })` with a device-found callback (the README calls it `deviceFound` in the options list and `devicesFound` in the example).
   - Raw advertisement bytes are not readable.
   - The library is young (v7.0.0 on 2026-08-24).
2. **Own Rust btleplug sidecar** (one codebase, stdio JSON protocol, the same supervisor). Chosen by mesh-client on Electron 44 for macOS, Windows and Linux ([PR #1010](https://github.com/Colorado-Mesh/mesh-client/pull/1010)); the PR states "Physical radio testing remains outstanding" at merge, so it is a design precedent, not field proof. Cost: a Rust toolchain in both CI jobs, plus about 500–1,000 lines (estimate, UNVERIFIED).
3. **Last resort with no native code:** Web Bluetooth in a hidden renderer, with `executeJavaScript(…, true)` and auto-select, accepting the limits in section 1.7.

### Spike checklist before committing

- [ ] Packaged NSIS build on Windows 11 with the built-in adapter: scan by manufacturer data, connect, write, notify for 8 h or more. Walk out of range and back. Sleep and resume, plus Modern Standby lid-close.
- [ ] Packaged dmg on macOS 14+ arm64 from `/Applications`: the TCC prompt appears for the `LSUIElement` app from the utility process, and the grant persists across relaunch. Same range and sleep tests as Windows.
- [ ] Kill the utility process with `process.kill` and confirm the supervisor recovers the session.
- [ ] Run a 7-day soak on at least one OS, watching for #140.
- [ ] Confirm whether CI compiles noble on mac with `npmRebuild` on or off, and that the packaged app loads the binary from `app.asar.unpacked`.
