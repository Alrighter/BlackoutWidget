# Blackout Widget

A desktop widget with the power outage schedule for an address in Ukraine. On the
desktop it shows whether the power is on by the schedule, how long until the next
change, and how the outages fall across the day. The app lives in the tray (the
menu bar on macOS) and refreshes about every 15 minutes. You can add several
addresses, each with its own widget. Optionally, the app reads an EcoFlow power
station and shows whether the power is actually on. The interface is in
Ukrainian; this README quotes its labels as they appear, with a translation.

Platforms: Windows (x64) and macOS on Apple Silicon (arm64). On both, the widget
is pinned to the desktop.

## Installation

Builds are on the releases page:
<https://github.com/Alrighter/BlackoutWidget/releases>. There is no auto-update:
download a new version from the same page and install it over the old one.

### Windows

1. Download `Blackout-Widget-Setup-<version>.exe` and run it.
2. The installer is not signed, so Windows SmartScreen shows a warning. Click
   «Докладніше» (More info) → «Виконати все одно» (Run anyway).
3. The app installs for the current user; no administrator rights are needed.

On the first start, the address setup wizard opens.

### macOS (Apple Silicon)

1. Download `Blackout-Widget-<version>-arm64.dmg`, open it and drag Blackout
   Widget to Applications.
2. The build is only ad-hoc signed and not notarized, so macOS blocks it on the
   first start. Open System Settings → Privacy & Security and click «Open
   Anyway».
3. There is no Dock icon: the app lives in the menu bar.

## Features

**Schedules from 11 companies.** DTEK (Kyiv city, Kyiv, Dnipropetrovsk and
Odesa oblasts), CEK, and the oblenergos of the Volyn, Lviv, Ternopil, Mykolaiv,
Zhytomyr and Chernivtsi oblasts. The full list, and where each schedule comes
from, is in «Where the data comes from». The wizard goes step by step: region
and company → town → street → house → line (if the house has two) → widget
style → «Готово» (Done: the address name and autostart).

**Several addresses.** Up to 5 addresses, for example «Дім» (Home) and
«Батьки» (Parents). Each has its own name (up to 24 characters), its own desktop
widget and its own widget style. A new address is added in «Налаштування»
(Settings) → «Додати адресу» (Add address). The same card has «Змінити адресу»
(Change address), «Перейменувати» (Rename) and «Видалити» (Delete; the last
address can't be deleted). With two or more addresses, a dropdown on the right
of the main window's header switches between them.

**The widget.** It shows the state («Світло є» power on, «Світла немає» power
off, «Можливе відключення» possible outage, «Немає даних» no data), the
countdown to the next change, and the schedule. When the source reports an
outage at this very house, a «Планове» (planned), «Аварійне» (emergency) or
«Екстрене» (urgent) badge appears. There are three styles:

- «Компакт» (Compact): a small card with today's bar;
- «Циферблат» (Dial): a ring with the day and the countdown;
- «Таймлайн» (Timeline): today and tomorrow on one scale.

A click on the widget opens the schedule, dragging moves it, and a right click
opens a menu: style, «Оновити зараз» (Refresh now), «Налаштування» (Settings),
«Вийти» (Quit).

- **Windows:** the widget is pinned to the desktop. It sits under normal
  windows and stays after Win+D. Its background imitates glass: the blurred patch
  of wallpaper under the widget.
- **macOS:** the widget sits just above the desktop icons, under normal windows,
  on every Space. «Show Desktop», Mission Control, Cmd+H and Cmd+M don't move or
  hide it, and it is not in the Dock or Cmd+Tab. Its glass is the system's own
  vibrancy, rounded to the card.

**The main window.** It has the «Графік» (Schedule) and «Налаштування»
(Settings) tabs. «Графік» shows today's and tomorrow's day by the hour (once the
schedule is published), the source's update time and «Оновити зараз» (Refresh
now). With EcoFlow connected, it adds a «Фактично» (Actual) row and the actual
outages over 7 days. The light and dark themes follow the system.

**The tray.** The icon shows the state of the first address; the tooltip shows
each address. Menu items: «Показати графік» (Show schedule), «Оновити зараз»
(Refresh now), «Стиль віджета» (Widget style), «Перемістити віджет» (Move
widget), «Налаштування» (Settings), «Автозапуск» (Autostart), «Вийти» (Quit).
«Пройти перевірку» (Pass the check) appears when the DTEK site asks for a
verification. On macOS the menu starts with the state lines.

**Autostart.** On by default, but it works only in the installed app: nothing is
registered during development. It is toggled in «Налаштування» («Запускати
разом із системою», Start with the system), on the wizard's last step, and in
the tray («Автозапуск»).

## Where the data comes from

The app talks only to the hosts below (the one exception is the verification on
the DTEK site, see below). There is no telemetry and no auto-update.

| Company | id | Region | Where the schedule comes from |
| --- | --- | --- | --- |
| DTEK Kyiv Electric Networks | `dtek-kem` | Kyiv city | YASNO API (`app.yasno.ua`), then the outage-data-ua mirror; site `dtek-kem.com.ua` |
| DTEK Kyiv Regional Electric Networks | `dtek-krem` | Kyiv oblast | the outage-data-ua mirror; site `dtek-krem.com.ua` |
| DTEK Dnipro Electric Networks | `dtek-dnem` | Dnipropetrovsk oblast | the outage-data-ua mirror; site `dtek-dnem.com.ua` |
| DTEK Odesa Electric Networks | `dtek-oem` | Odesa oblast | the outage-data-ua mirror; site `dtek-oem.com.ua` |
| CEK | `cek` | Dnipropetrovsk oblast | `cek.dp.ua` |
| Volynoblenergo | `voe` | Volyn oblast | `api-voe-poweron.inneti.net` (schedule image), `energy.volyn.ua` |
| Lvivoblenergo | `loe` | Lviv oblast | `api.loe.lviv.ua`, `power-api.loe.lviv.ua` |
| Ternopiloblenergo | `toe` | Ternopil oblast | `api-poweron.toe.com.ua` |
| Mykolaivoblenergo | `mkoe` | Mykolaiv oblast | `off.energy.mk.ua` |
| Zhytomyroblenergo | `ztoe` | Zhytomyr oblast | `www.ztoe.com.ua`, `api-ztoe-poweron.inneti.net` |
| Chernivtsioblenergo | `cvoe` | Chernivtsi oblast | `oblenergo.cv.ua` |

**DTEK.** The schedules of all four DTEK sites are read as JSON, without opening
a page:

- Kyiv city: first the public YASNO API. If it gives no schedule, the app takes
  the [outage-data-ua](https://github.com/Baskerville42/outage-data-ua) mirror
  (files from `raw.githubusercontent.com`).
- Kyiv, Dnipropetrovsk and Odesa oblasts: the outage-data-ua mirror.

A mirror updated more than 30 minutes ago is not used.

The app opens the `/ua/shutdowns` page of the DTEK site in a hidden window only:

- in the setup wizard (towns, streets, houses, lines);
- once a day, to check the house (its lines and the current outage); more often
  while the check finds an outage, within the limit below;
- when YASNO reports emergency outages;
- as a fallback, when no JSON source gave a schedule.

During refreshes the page opens at most once per 30 minutes per site. The window
closes a minute after a refresh, or 5 minutes after a wizard step. The hidden
page's requests to hosts other than the DTEK site are blocked. When the DTEK site
asks for a verification, «Пройти перевірку» (Pass the check) appears in the tray
and the main window. While you pass it, the page is shown and may load the
site's own third-party resources (for example, the verification widget).

**Oblenergos and CEK.** The app makes plain HTTPS requests to the company's site
or API; there is no hidden window. Volynoblenergo's schedule is read from the
image the company publishes. The town lists of the Volyn, Mykolaiv, Zhytomyr and
Chernivtsi oblasts are built into the app.

**EcoFlow** (only when connected): `api-e.ecoflow.com` for Europe or
`api.ecoflow.com` for other regions, plus the MQTT broker whose address EcoFlow
returns. In Bluetooth mode, after the sign-in the app talks only to the station
nearby.

**How often.** Each address refreshes every 15 minutes (±1 minute). After an
error it retries in 1, 2, 4 and 8 minutes, then every 15. Once a request has
reached the source, the next automatic one is at least 5 minutes later. After the
computer wakes up or the network comes back, the app refreshes out of turn;
«Оновити зараз» (Refresh now) refreshes at once. At startup, addresses on the
same source are spread 30 seconds apart. A DTEK JSON response is kept for 2
minutes, so two addresses on one site make one request.

## Actual state (EcoFlow)

Besides the schedule, the widget can show whether the power is actually on. For
that the app reads an EcoFlow power station (read-only) and tells from the AC
input whether the grid is there. One station is connected for the whole app.
With several addresses, the settings say where it stands («Станція стоїть у:»,
The station is at). The actual state is shown only for that address: on its
widget, in the «Фактично» (Actual) row and in the actual outages over 7 days.

**Where to connect it.** «Налаштування» (Settings) → «Фактичний стан світла»
(Actual power state) → «Підключити EcoFlow» (Connect EcoFlow). The «Джерело»
(Source) field has two ways to sign in. Bluetooth is switched on later, for a
particular station, after an account sign-in. The region is «Європа» (Europe) or
«Інший регіон» (Other region).

1. **Account sign-in** («EcoFlow — вхід через акаунт»): the email and password of
   the EcoFlow app. This is an unofficial way, the same sign-in and MQTT as the
   EcoFlow app, so it may stop working if EcoFlow changes something. The email
   and password are stored encrypted.
2. **Developer keys** («EcoFlow — ключі розробника»): the official Open API.
   Apply at <https://developer-eu.ecoflow.com/> («Become a Developer»). Requests
   are reviewed by hand, which can take several days. Once access is approved,
   create an Access Key and a Secret Key there. Both keys are stored encrypted.
3. **Bluetooth**, for RIVER 2 family stations (serial number starting with R601,
   R603, R611, R613, R621 or R623). After an account sign-in the app looks for
   stations nearby, and a found one gets a «Підключення: Bluetooth | Інтернет»
   (Connection: Bluetooth | Internet) switch. Reading the station then needs no
   internet, but it must be near the computer. The password is not stored, only a
   key for that station, derived at sign-in. While the widget is connected, a
   phone can control the station only over the internet. On macOS the system
   first asks for Bluetooth permission. Bluetooth runs in a separate process
   (`src/main/ble-host.ts`).

**How secrets are stored.** Keys, sign-in data and the station key are encrypted
with the OS through Electron `safeStorage` (DPAPI on Windows, Keychain on macOS)
and kept in `secrets.json` in the app data folder. If encryption is unavailable,
they are not stored at all. Secrets never reach the log: it gets masks instead
(the first 4 characters of a key, `x…@domain` for an email).

**«Невідомо» (Unknown).** The app doesn't know the state: the station is offline
or out of Bluetooth range, there is no internet, or the data is stale. In that
case «Світла немає» (power off) is never shown.

**Limitations.**

- Not every EcoFlow station can be read through the developer API. Error `1006`
  during «Перевірити» (Check) means the station is bound to another account or
  the model is not supported. River 2 support through the Open API is not
  confirmed.
- The account sign-in and the developer keys go through the cloud. If the router
  is not powered by the station, during an outage the state is «Невідомо»
  (unknown): there is no internet, and the app can't see the station. Bluetooth
  doesn't depend on the internet.
- EcoFlow allows about 10 different MQTT clientIds per day per account. Both
  cloud ways use one fixed clientId per installation. The exception is the
  station preview after an account sign-in (the «Перевірка», Check, row): it
  opens a short MQTT session with a one-off clientId.

**Live smoke script for the developer keys** (needs `npm run build`; the keys come
from environment variables, the region defaults to `eu`, `us` if needed):

```
$env:ECOFLOW_ACCESS_KEY = "..."
$env:ECOFLOW_SECRET_KEY = "..."
$env:ECOFLOW_REGION = "eu"
npx electron out/main/smoke-ecoflow.js
```

The check takes about 2 minutes. The script prints the Access Key mask and the
list of stations. For each station it requests `quota/all` twice, at least 60 s
apart. It prints:

- the grid verdict;
- the names of all readings (values only for the AC input keys);
- the raw `inv.acInVol` / `plugInInfoAcInVol` values, to tell millivolts from
  volts;
- the names of the keys that changed between the two requests. If nothing
  changed, the script warns about it: `quota/all` alone then can't tell whether
  the data is fresh.

Then it listens to MQTT for 60 s and prints:

- the SUBACK codes for each station and topic (0–2: the granted QoS; 128: the
  broker refused the subscription, and the script prints the codes and exits
  with code 1);
- whether the first `/quota` message is marked retained (the app ignores
  retained messages);
- the number of messages per minute;
- whether MQTT sends the AC input keys that `quota/all` has;
- the verdict after the merge.

The script writes nothing to disk and publishes nothing to MQTT. It uses the
one-off clientId `BlackoutWidget-smoke`, which also counts toward the limit of
about 10 clientIds per day. Exit code: 0 on success; 1 on an error, a refused
subscription, an account with no stations, or no station returning `quota/all`.

Run the script while the power is on, and again during a real outage: that shows
what the station reports when the grid is gone.

Bluetooth is checked by `npx electron out/main/smoke-ble.js` (no account): it
scans for stations and goes through the handshake with the first EcoFlow station
nearby up to the sign-in status. The serial number is printed as its first 4
characters only.

## Development

```
npm i
npm run dev        # the app in development mode
npm test           # tests (vitest)
npm run typecheck  # type check
npm run build      # build into out/
```

Other commands:

- `npm run ui:capture`: captures of the widget and the main window in invisible
  windows, without showing the app on screen. See
  [scripts/ui-capture/README.md](scripts/ui-capture/README.md).
- `npm run tray:icons`: regenerates the tray icons in `resources/tray/`.
- `node scripts/gen-mkoe-settlements.mjs`, `gen-ztoe-settlements.mjs`,
  `gen-cvoe-settlements.mjs`: update the built-in town lists (live requests to
  the company's site).

Code: `src/main` is the main process (schedule sources in `providers/`, EcoFlow
in `actual/`, the widget's pinning and glass in `widget/`, with `pin-win32.ts`,
`pin-darwin.ts` and `glass-darwin.ts`); `src/renderer/src` is the main window
(`app/`) and the widget (`widget/`); `src/shared` holds shared types and texts;
`tests` holds tests and fixtures.

### Live checks (smoke)

Each needs `npm run build` and runs as `npx electron out/main/<script>.js`. The
scripts make real requests, don't touch the app's data (all but `smoke-ecoflow`
run in a temporary profile) and print the result to the console. Exit code 0
means everything is fine.

- `smoke-dtek.js [--provider <id>] [--offline]`: one DTEK site (`dtek-krem` by
  default): town → street → house → the schedule from the page, then the same
  schedule from the JSON source. At the end it checks that the hidden window has
  closed.
- `smoke-voe.js`: Volynoblenergo: the streets of Kovel → the houses on
  Nezalezhnosti street → the schedule for house 25.
- `smoke-loe.js`: Lvivoblenergo: Lviv → a short street → the first house with a
  queue → the schedule. Prints the path, status and time of each request.
- `smoke-toe.js`: Ternopiloblenergo: Ternopil → the first street with houses → a
  house with a queue → the schedule. Prints the status of each request and the
  Origin header.
- `smoke-mkoe.js`: Mykolaivoblenergo: Mykolaiv city → a street → a house with a
  scheduled-outage queue → the schedule. If `v2/schedule/active` is not empty, it
  saves it (ids, types and times only) to a temp folder.
- `smoke-ztoe.js`: Zhytomyroblenergo: Zhytomyr city, then the village of
  Berezivka. Checks that the windows-1251 pages read correctly.
- `smoke-cvoe.js`: Chernivtsioblenergo: Chernivtsi city, then Hertsa. A
  Cloudflare block is only reported.
- `smoke-cek.js`: CEK: the map page → Dnipro city → a street → a house with one
  queue → the schedule.
- `smoke-memory.js [--provider <id>] [--settle <seconds>] [--no-gpu]`: the
  memory of one DTEK page session for each Electron process. `--no-gpu` turns
  hardware acceleration off.
- `smoke-ecoflow.js`: EcoFlow through the developer keys; needs environment
  variables (see above).
- `smoke-ble.js`: EcoFlow over Bluetooth, no account (see above).

### Log and data

The app's data lives in Electron's `userData` folder. For the installed app that
is `%APPDATA%\Blackout Widget` on Windows and
`~/Library/Application Support/Blackout Widget` on macOS; during development it
is `%APPDATA%\blackoutwidget`. It holds, among others, `settings.json`
(addresses and settings), `snapshots.json` (the last schedules), `secrets.json`
(the encrypted EcoFlow secrets), `actual-history.json` (actual outages) and the
log.

The log is `logs\app.log`, up to ~1 MB; the previous file is `app.log.1`. The
startup error window shows the exact path. It records:

- source errors;
- which DTEK JSON source failed and why the page was opened;
- the raw fields of the current outage from the DTEK response;
- unknown hour statuses;
- EcoFlow events;
- on macOS, failures of the desktop pinning and the native glass.

### Memory

In normal operation on Windows the app takes about 110 MB (it used to be
~275). The DTEK page is not kept open, and hardware acceleration is off on
Windows. Chromium's GPU and network services run in the main process
(`src/main/index.ts`). The `smoke-memory.js` script measures memory.

## Building

### Windows

```
npm run dist:win
```

Result: `dist/Blackout Widget Setup <version>.exe` (NSIS, x64, installs for the
current user without administrator rights).

### macOS

electron-builder doesn't build a dmg on Windows, so the macOS build is made by
the manual GitHub Actions workflow `.github/workflows/build-mac.yml`. It runs on
`macos-14` (arm64) and does `npm ci`, a smoke test of the Objective-C bindings
against the real runtime (`tests/main/widget/objc-darwin.smoke.test.ts`),
`npm run typecheck` and `npm run dist:mac`.

```
gh workflow run build-mac.yml --ref main
gh run list --workflow build-mac.yml
gh run download <id> -n blackout-widget-mac-arm64
```

The `blackout-widget-mac-arm64` artifact holds
`Blackout Widget-<version>-arm64.dmg` and is kept for 14 days. The build is
ad-hoc signed (`identity: '-'`), without notarization or hardened runtime; there
is no Dock icon (`LSUIElement`). On a Mac itself, `npm run dist:mac` does the
same.

### Release

1. Bump `version` in `package.json` when the version is already taken by a tag.
2. Build the Windows installer locally and the dmg through Actions.
3. Rename the files without spaces (`Blackout-Widget-Setup-<version>.exe`,
   `Blackout-Widget-<version>-arm64.dmg`) and create the release:
   `gh release create v<version> <files> --notes-file <notes>`.

## Adding a source

1. Implement the `ScheduleProvider` interface (see `src/main/providers/types.ts`)
   in `src/main/providers/<id>/`. For a site or API with plain HTTPS requests,
   follow `toe/` or `loe/` (the shared plumbing is `http-source.ts`,
   `resolve.ts`, `snapshot.ts`). For a page that has to be opened in a hidden
   window, follow `dtek/` (`browser-session.ts`).
2. Add an entry to `PROVIDERS` in `src/shared/providers.ts`: the name, short
   name, region and schedule page. The order of the entries is the order of the
   cards in the wizard.
3. Add one line to `make` in `src/main/providers/registry.ts`.
4. Put fixtures in `tests/fixtures/<id>/` and tests in `tests/providers/`
   (follow `toe-parse.test.ts` and `toe-provider.test.ts`).
5. Add a live check as `src/main/smoke-<id>.ts` and list it in
   `rollupOptions.input` in `electron.vite.config.ts`.

## Known limitations

- macOS: the build is for Apple Silicon only and is not notarized.
- macOS: if a native call of the desktop pinning or the glass ever crashes the
  app, both turn off for that app version, so the app doesn't crash on every
  start: the widget is then an ordinary window with the plain tinted glass. To try
  again, delete `pin-darwin.pending` in the app data folder.
- Windows: separate wallpapers on different monitors are not supported, because
  the widget's glass takes one wallpaper for all monitors.
- Windows: when the widget is dragged between monitors with different scaling
  (DPI), its content may scale wrongly until a restart. The fallback is «Перемістити
  віджет» (Move widget) in the tray.
- Windows: the GPU and network services run in the main process, so a crash of
  either closes the app (as a separate process, Chromium would have restarted
  it).
- DTEK schedules depend on YASNO and the third-party outage-data-ua mirror. If
  they don't give a fresh schedule, the app reads the DTEK page, but during
  refreshes at most once per 30 minutes per site.
- Mykolaivoblenergo: the app hasn't seen a real outage day yet. If the house's
  queues come in an unfamiliar form, today's schedule will be unknown.
- The EcoFlow limitations are in «Actual state (EcoFlow)».
