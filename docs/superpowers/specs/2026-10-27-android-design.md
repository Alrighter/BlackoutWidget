# Android app with home-screen widgets — design

Date: 2026-10-27. Status: brainstormed with the user, waiting for approval. Built after the auto-update
(`2026-10-27-auto-update-design.md`).

## Intent

The user wants Blackout Widget on their phone: «віджет на головному екрані, такі самі як на вінді ідентичні», with
«всі джерела і екофлоу прям як на комп'ютері». The phone shows the same thing as the desktop, so a glance at the home
screen tells whether the power is on, when it changes, and what the station actually sees.

Success: on the user's Samsung S25 (Android 16), the three widget styles sit on the home screen and look like the
desktop widgets. Every source and every EcoFlow mode the desktop supports works. Several addresses work. The app
installs and updates from the GitHub releases page.

## Decided by the user

- **Home-screen widgets, identical to Windows.** The three styles «Компакт», «Циферблат» and «Таймлайн», with the same
  content: the state, the countdown to the next change, the bar or ring, the emergency badge, the address name when
  there are several.
- **Full parity.** All 11 schedule sources. Several addresses (up to 5). EcoFlow by account, developer keys and
  Bluetooth.
- **Distribution:** an APK on the GitHub releases page («сторінка релізів на гітхаб поки»). Google Play may come later.
- **EcoFlow without a persistent notification**, checked about every 15 minutes instead of a live connection
  («без сповіщення і перевірка»).
- **Test device:** Samsung S25, Android 16 (the user isn't sure of the version).

## Decided by Claude (stated to the user; may be challenged on review)

- **Architecture: React Native (TypeScript) core plus native widgets, with the existing React UI in a WebView.**
  - **The core** runs in React Native's JavaScript: providers, refresh, schedule state, EcoFlow, storage. It reuses
    the desktop's TypeScript instead of a Kotlin rewrite. React Native can run it with no screen open (Headless JS
    started by WorkManager), which a WebView-only app (Capacitor) can't do well.
  - **The screens** are the existing renderer (`src/renderer/src/app`: the wizard, «Графік», «Налаштування», the
    EcoFlow forms) inside a `react-native-webview`. The core implements the same `RendererApi` the Electron preload
    exposes today, over the WebView bridge. The screens then stay identical, and one UI codebase serves both.
  - **The renderer gets a narrow (phone-width) layout** in CSS. The desktop layout must not change. Capture-rig
    images of the desktop app stay byte-identical, except where the change is intended.
  - **The widgets are native** Android App Widgets (Kotlin). A widget can't host React or a WebView.
- **One source of truth.** Shared logic is imported, never copied into a fork:
  - providers and their parsers;
  - `src/shared` (types, widget state, design tokens, time);
  - the EcoFlow protocol code.

  The builder moves Electron-only parts behind adapters, so the same modules run under Electron and React Native:
  - HTTP: Electron `net` / fetch;
  - the hidden browser page: `BrowserWindow` / a hidden `WebView`;
  - MQTT transport: Node TCP / a React Native TCP-TLS socket;
  - Bluetooth: noble in the BLE host / a React Native BLE library;
  - secret storage: `safeStorage` / Android Keystore;
  - file storage.

  The repo layout (one repo, a `mobile/` app next to the desktop app) is the builder's.
- **Three widget entries in the Android widget picker**, one per style, each with its preview. Adding one asks which
  address when there are several. Tapping a widget opens the app on that address's «Графік».
- **The widget's look:** the desktop's card, colours, type sizes and proportions from `src/shared/design-tokens.ts` and
  `widget-sizes.ts`. Light or dark follows the system.
  - Android doesn't let a widget blur the wallpaper, so the glass is the desktop's `tint` background (the solid
    underlay with the glass tint and edge).
  - Each style gets a default home-screen size close to its desktop proportions. Resizing scales the content. The
    exact cell sizes are the builder's.
- **The widget is a renderer of data, not logic.** The core writes each widget's ready view (the strings, segments,
  colours and the time of the next change) to shared storage. The widget draws it, and keeps the countdown text
  current from the stored next-change time.
- **The countdown must be right whenever the user looks at the home screen**, to the minute, in the desktop's format
  («через 2 год 10 хв»). Android 14+ denies exact alarms by default, so the mechanism must not depend on them. The
  builder chooses it (inexact updates at minute boundaries while the screen is on, refresh on screen-on or unlock,
  and so on) and states what happens in Doze.
- **Background refresh:** a WorkManager periodic job (15 minutes, Android's minimum) runs the same refresh as the
  desktop scheduler for every address, then the EcoFlow check, then updates the widgets. No foreground service and
  no notification.
  - Samsung puts background apps to sleep. The app shows a one-time hint, linked to the right settings screen, to set
    its battery usage to «Без обмежень» (Unrestricted). Until then the widgets may refresh less often.
- **EcoFlow, every ~15 minutes, briefly:**
  - account mode connects to MQTT, takes a fresh `/quota`, and disconnects;
  - developer keys mode reads `quota/all` over HTTPS;
  - Bluetooth connects, reads, and disconnects.

  The 7-day actual-outage history then has about 15-minute resolution on the phone. «Невідомо» (unknown) rules are
  the desktop's: a missing reading is never «Світла немає» (power off).
  - The MQTT clientId stays one fixed id per installation, so the phone is one more id toward EcoFlow's ~10 a day.
- **No sync between the PC and the phone.** Each device is set up on its own (addresses, EcoFlow).
- **Known limit, Bluetooth on two devices:** a station takes one Bluetooth connection at a time. Use Bluetooth on one
  device and the cloud on the other. The app reports a busy station as «Невідомо» (unknown), not as an error loop.
- **Signing:** one Android release key, created once. Its keystore and passwords live only in GitHub Actions secrets
  and in a backup the user keeps; never in the repo. Losing it means users can't update without uninstalling.
- **Builds:** a GitHub Actions workflow builds the release APK, manual like `build-mac.yml`. Claude can't run the app
  or an emulator here, so the user tests every build on the S25.
- **Releases:** the APK goes into the same GitHub release as the desktop files, with the same version number (see
  «One release carries every platform» below). An English line in the release notes covers installing it.
- **Updates on the phone:** the same arrow-down button as the desktop's auto-update. The app downloads the APK of the
  latest release, and Android shows its own «Update this app?» prompt, which the user confirms (sideloaded apps can't
  skip it). This needs the install-packages permission, which Android asks for once. It uses the desktop design's
  feed, version and test-feed rules.
- **Minimum Android:** 10 (API 29). (Claude's call; the builder may raise it with a reason.)

## After the builder check (2026-10-27)

**EcoFlow freshness on the phone (Claude's call).**
- The desktop's thresholds assume a live connection: `STALE_MS` 10 min and `CONFIRM_MS` 60 s in
  `src/main/actual/service.ts`, `ACTUAL_STALE_MS` 10 min in `src/shared/actual-view.ts`, `APPROX_GAP_MS` 3 min. With a
  reading every ~15 minutes they would turn everything into «Невідомо» (unknown).
- The phone passes its own values, so the shared service and view take the thresholds as parameters:
  - a reading stays fresh for about two check intervals (~35 min);
  - one reading is enough to record a change, and its boundary is marked approximate (≈), placed between the two
    checks.
- Accepted cost: a short grid dip that happens to fall on a check can show as an outage until the next check.
- Each check stays connected only as long as it takes to get one reading.
- The desktop's values and tests don't change.

**One release carries every platform (Claude's call).** Every release has the Windows, macOS and Android files with one
version number. electron-updater reads only the latest release, so a release missing `latest.yml` would hide an earlier
desktop update from Windows users. A phone-only fix therefore also publishes a desktop build; its notes say «no changes
for desktop». The Mac prompts this can cause (Bluetooth, Keychain) are the known cost.

**To confirm with the user (provisional defaults below):**
- **DTEK's hidden page in the background.** The desktop uses the page for the house check (emergency badge), a YASNO
  emergency day, the fallback when no feed is usable, and a captcha. Running a hidden WebView inside a WorkManager job,
  with no screen open, is the most fragile native piece, and the site's bot protection may treat it differently.
  - *Provisional default:* try it, keeping parity. If it proves unreliable on the S25, the background job falls back to
    the feeds only, and page work (house check, fallback) runs while the app is open.
  - A captcha in the background never blocks: the widget keeps the last schedule, and the app shows «Пройти
    перевірку».
  - The cost of feeds-only: a DTEK emergency badge can lag until the app is opened.
- **Widget style: per widget or per address.** The desktop stores the style on the address (wizard step, Settings
  thumbnails, `setWidgetStyle`). Android's picker naturally chooses a style per widget.
  - *Provisional default:* three picker entries, the style belongs to the widget, and the phone hides the wizard's
    style step and the Settings style card.
  - The phone keeps its own table of widget id → address + style; `Location.widgetStyle` is unused there.
  - The alternative is one picker entry with the style per address (exactly the desktop's model). Changing the style
    then restyles every widget of that address, but each widget keeps its home-screen size, so a new style may be
    letterboxed.

## Constraints

- **The desktop app must not regress.** Its tests stay green, and refactoring shared modules for adapters keeps
  behaviour identical. The desktop tests prove it.
- **Pure logic is tested with vitest in the existing suite;** the mobile adapters get their own tests with fakes.
  Native widget drawing gets screenshot or preview checks where the toolchain allows.
- **Secrets:** the same rules as the desktop. Never in logs, settings, the view state or the bridge messages beyond
  what the forms already send. Encrypted with the Android Keystore; if that isn't available, not stored.
- The UI copy stays Ukrainian; the README and release notes are in English.
- **No telemetry.** The phone contacts the same hosts as the desktop (sources, YASNO, the mirror, EcoFlow, GitHub
  releases) and nothing else.

## Non-goals

- iOS.
- Google Play publishing (for now).
- Notifications or outage alerts.
- A live EcoFlow connection.
- Tablet layouts.
- Wear OS.
- Syncing settings between devices.
- Lock-screen widgets.

## Left to the builder

- The repo layout and the shared-module boundaries, within «one source of truth».
- The library choices: React Native version, BLE, TCP-TLS, keystore, WebView, widget framework (Glance or
  RemoteViews).
- The countdown update mechanism, within the constraint above.
- Widget cell sizes and resize behaviour.
- The bridge message format for `RendererApi`.
- The order of work, provided the first build the user tests already shows a real schedule in a real widget for one
  address. EcoFlow and the remaining sources can follow in later builds.
