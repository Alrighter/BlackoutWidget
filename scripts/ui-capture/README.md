# UI capture rig

Renders the **built** renderer pages (`out/renderer/widget.html`, `out/renderer/app.html`) in hidden offscreen
Electron windows. Each page gets a fake `window.api`, a frozen clock and a throwaway profile. The rig saves a PNG and
a JSON of element boxes for each capture. It never touches the screen, the user's app data or the installed app, and
it makes no network requests.

```
npm run build
npm run ui:capture -- --target widget --style compact --scenario on --theme light,dark --out .superpowers/design-refresh/captures/task-3
```

Rebuild after every source change: the rig only sees `out/`.

## Options

| option | values | default |
| --- | --- | --- |
| `--target` | `widget`, `app` | `widget` |
| `--style` | `compact`, `ring`, `timeline` (widget: style and window size; app: the saved style) | `compact` |
| `--scenario` | see [Scenarios](#scenarios) | `on` |
| `--theme` | `light`, `dark` (`nativeTheme.themeSource`, so `prefers-color-scheme` follows) | `dark` |
| `--view` | `schedule`, `settings`, `setup` (app only, the `?view=` query the main window loads) | `schedule` |
| `--out` | output directory (keep task captures in `.superpowers/design-refresh/captures/<task>/`) | `.superpowers/design-refresh/captures` |
| `--now` | `HH:MM` (Kyiv, on 2026-10-17) or an ISO date-time; overrides the scenario's clock | the scenario's |
| `--wallpaper` | `auto` (= theme), `light`, `dark`, `busy`, `none` (no image: `{ kind: 'tint' }`) | `auto` |
| `--move-mode` | flag: the widget is told it is in move mode (`onMoveMode(true)`) | off |
| `--patch` | JSON merged into the AppState (`settings` one level deep), e.g. `'{"phase":"captcha"}'` | none |
| `--stubs` | JSON replacing what `window.api` calls resolve with, by name: `ecoflowTest`, `ecoflowPreview`, `ecoflowSave` (see [Scenarios](#scenarios)); `"pending"` never settles | none |
| `--exec` | JS run in the page after it rendered (awaited if it returns a promise), e.g. clicks | none |
| `--tag` | text appended to the file name, for variants made with `--now` / `--patch` / `--exec` | none |
| `--delay` | ms to wait before the capture (after `--exec`) | `300` |
| `--scale` | output device scale factor (2 = retina-size PNG; layout stays in DIP) | `1` |

`--target`, `--style`, `--scenario`, `--theme` and `--view` take a comma list or `all`, and the rig captures every
combination in one run. `--view` applies only to the app. For example, `--style all --scenario all --theme all` gives
66 widget PNGs in about half a minute.

## Output

Each capture writes two files: `<out>/<name>.png` and `<out>/<name>.json`. It also prints the JSON as one line on
stdout.

- **Widget names:** `widget-<style>-<scenario>-<theme>[-wp-<wallpaper>][-move][-<tag>]`.
- **App names:** `app-<view>[-<style>]-<scenario>-<theme>…`. The style appears only when the run has several.

The JSON fields:

- `viewport`: the window's CSS size.
- `document`: `scrollWidth` and `scrollHeight` of `<html>`. A value larger than the viewport means the page overflows.
- `elements`: one entry per element with a `data-capture="<name>"` attribute, in document order. Each entry has:
  - `name`, plus `x`, `y`, `width` and `height` from `getBoundingClientRect`;
  - `scrollWidth`, `clientWidth`, `scrollHeight` and `clientHeight`;
  - `overflowX` / `overflowY`: content wider or taller than the box (true for a single line cut with an ellipsis);
  - `outside`: the box crosses the window edge;
  - `text`.
- `errors`: console errors from the page. Expect `[]`.

To measure something, add `data-capture="status"` (or any name) to the element in the component. The attribute
changes nothing visually. Remove it again if it is only temporary.

The PNG is the window at its real size. Widgets keep their alpha: the window is transparent, and the rounded card is
the visible shape. App captures are flattened over a solid stand-in for Mica (`#eef0f5` light, `#1e2028` dark, the
middle stops of the mockup's window background). app.css keeps the page transparent for Mica, and the rig assumes
Mica shows through. Repeated runs give
byte-identical PNGs, so comparing hashes shows whether a change altered the look.

## Windows and backgrounds

- **Widget size:** `WIDGET_SIZES`, i.e. compact 290×150, ring 236×260, timeline 400×200.
- **App size:** 886×604, the content area of the real 900×640 main window on Windows 11.
- **Display scale:** the rig pins it to 1 (`force-device-scale-factor`), so DIP sizes are exact. `--scale` sets only
  the output resolution.
- **Widget background:** the preload paints the mockup's wallpapers (`WP` in `widget-compact-states.html`) on a canvas
  the size of the window. It sends the result as `WidgetBackground { kind: 'image', dataUrl }`, as main's glass
  updater sends the wallpaper crop under the widget. `busy` is the mockup's «строкаті шпалери».

## Clock

Scenarios depend on the time, so `preload.cjs` freezes the page's clock. It calls `contextBridge.executeInMainWorld`
to replace the page's `Date` with a subclass whose `new Date()` and `Date.now()` return the capture's instant. Other
`Date` uses behave as normal, so `Intl` formatting in `src/shared/time.ts` still works. Timers and `performance.now()`
run normally.

- **Default clock:** the scenario's mockup time, as Kyiv wall time on 2026-10-17 (the mockup's day and the DTEK
  fixture's).
- **`--now`:** moves only the clock. The schedule, «оновлено», EcoFlow segments and outage times stay at their
  mockup wall times on the clock's Kyiv day. Example: `--now 13:00` turns `on` into «Вимкнення о 15:00 · через 2 год».

## Scenarios

The names, day schedules, clock times and EcoFlow history are the mockup's `SCEN` in
`docs/superpowers/specs/assets/design-2026-10-18/widget-compact.html`. The ring and timeline mockups use the same
data. The address, lines and queue are those of `tests/helpers/snapshot.ts`: Біла Церква, house 40, «Лінія 1 · черга
1.2», with a second line on «Черга 4.2».

Why not the DTEK fixture itself? Its single day is none of the mockup's days, and plain CJS can't load the TS parser.
So the snapshots are built in `scenarios.cjs`. `tests/ui-capture/scenarios.test.ts` runs every scenario through the
real `computeWidgetView` and checks the mockup's state, text and countdown.

| scenario | clock | what the app shows |
| --- | --- | --- |
| `on` | 11:50 | Світло є · Вимкнення о 15:00 · через 3 год 10 хв |
| `off` | 17:55 | Світла немає · Увімкнуть о 19:00 · через 1 год 5 хв (no tomorrow) |
| `maybe` | 22:20 | Можливе відключення until 24:00 (the app's line reads «Увімкнуть завтра о 00:00 · через 1 год 40 хв») |
| `emergency` | 14:20 | Світла немає + «Аварійне», «Аварійне · орієнтовно до 17:00» |
| `nodata` | 06:10 | Немає даних · Графік на сьогодні ще не отримано |
| `stale` | 20:40 | updated 14:50, so «дані застаріли» |
| `warning` | 11:50 | `on` with `lineChanged: true` (Схема підключення змінилась) |
| `nochange` | 19:40 | Без змін до кінця графіка |
| `ecoMatch` | 17:20 | EcoFlow on since 14:32, agrees with the schedule; EcoFlow line under the strip |
| `ecoMismatch` | 15:40 | EcoFlow off since 14:32 while the schedule says on: «Не за графіком · з 14:32» |
| `ecoOffline` | 11:50 | `on`, EcoFlow unknown since 10:20: «станція не в мережі» |

The fake data departs from the mockup in a few places, so that the app's own logic produces each scenario's state:

- **`nodata`** has no day at all. An all-unknown day would read «Без змін…».
- **`nochange`** has no tomorrow. The mockup's tomorrow would bring a change at 01:00.
- **`emergency`** uses DTEK's `currentOutage`: kind emergency, «Аварійні ремонтні роботи», 13:30–17:00, queue 1.2.
  The day's slots are the planned schedule, because the app has no emergency slot. The mockup paints 13:30–17:00 red
  in the strip.
- **EcoFlow history** adds two earlier outages (15.10 08:00–12:04, 16.10 16:02–19:58), so the main window's 7-day
  list has entries.

Non-EcoFlow scenarios have `actual: null` and no `actualSource`, so the main window shows the EcoFlow empty state.

The other `window.api` methods resolve with plausible data: providers, cities, streets, houses, the two lines with
today's schedule, and an EcoFlow test/preview/save that succeeds with one online «Delta 2» reading «на вході 229 В».
`--stubs` swaps the EcoFlow results, e.g. `'{"ecoflowTest":"pending"}'` (the check never ends) or
`'{"ecoflowPreview":{"ok":true,"online":false,"power":"unknown"}}'` (station offline). Pushes (`onState`,
`onNavigate`) never fire. Nothing calls the real EcoFlow API.

## Recipes

```
# every widget style and scenario in both themes
npm run ui:capture -- --style all --scenario all --theme all --out .superpowers/design-refresh/captures/task-2
# the main window's three views
npm run ui:capture -- --target app --view all --scenario ecoMatch --theme all --out …
# the captcha banner
npm run ui:capture -- --target app --scenario on --patch '{"phase":"captcha"}' --tag captcha --out …
# no address saved: the main window opens the wizard
npm run ui:capture -- --target app --patch '{"settings":{"address":null}}' --tag first-run --out …
# move mode on busy wallpaper
npm run ui:capture -- --style compact --scenario on --theme all --wallpaper busy --move-mode --out …
# the EcoFlow check that never ends: open the form, type the keys (React needs the native value setter), press «Перевірити»
npm run ui:capture -- --target app --view settings --stubs '{"ecoflowTest":"pending"}' --exec "(async () => { …clicks… })()" --tag checking --out …
# on Windows `npm run` goes through cmd.exe, which ends the command at a newline: keep --exec on one line there, or run
# node_modules/electron/dist/electron.exe scripts/ui-capture/capture.cjs … directly (same options) for multi-line JS
# a later wizard step: click through first (the page's Date is frozen, so wait with setTimeout, not Date)
npm run ui:capture -- --target app --view setup --exec "[...document.querySelectorAll('button')].find(b => b.textContent === 'Далі').click()" --tag step2 --out …
```

## Files and limits

- `capture.cjs`: the Electron main script, which also handles CLI parsing, windows, capture and JSON.
- `preload.cjs`: the fake `window.api`, the frozen clock and the wallpaper painter. It is sandboxed, so it gets
  everything from `capture.cjs` in one sync IPC call.
- `scenarios.cjs`: the AppState and stub data per scenario.

Limits:

- There is no hover, so tooltips need `--exec` to show them, if the component supports that.
- Each run uses a fresh profile in `%TEMP%\bw-ui-capture-*`. Chromium keeps some of its files open until exit, so a
  run can't fully delete its own profile. The next run deletes profiles older than ten minutes.
