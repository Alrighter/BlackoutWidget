# Multiple locations: several addresses, one widget each

Date: 2026-10-21. Status: design for review.

## Intent

Today the app follows one address: one schedule, one widget, one tray state. The user wants to watch their own home and their parents' home at the same time, with two widgets on the desktop: «треба додати можливість додавати кілька локацій, наприклад мені треба дивитися в мене вдома і вдома батьків, треба зробити шоб два віджети були можливими».

The picture below was played back to the user and confirmed twice («так»). Calls that were mine, not theirs, are marked *(my call)*.

## Goals

- **Locations.** Up to 5 *(my call)*. Each location has:
  - a name the user gives it («Дім», «Батьки»);
  - its own address (provider, city, street, house, line);
  - its own widget, with its own style and position on the desktop.
- **Upgrade.** On the first start of the new version, the current address becomes the first location, named «Дім». It keeps its widget style, widget position, cached schedule and EcoFlow. Nothing has to be entered again.
- **Names on widgets.** With 2+ locations, every widget shows its location's name, so two widgets side by side are not confused *(my call)*. With one location every widget looks exactly as today.
- **EcoFlow.** The actual-power status (EcoFlow) belongs to one location. By default that is the first one, the user's home. The EcoFlow card lets the user pick it *(my call)*.
- **Main window.**
  - A location switcher.
  - The schedule tab and the location's own settings follow the switcher *(my call)*.
  - The user can add, rename and delete locations. The last location cannot be deleted.
- **Tray.**
  - The icon follows the first location.
  - The tooltip lists every location.
  - «Стиль віджета» and «Перемістити віджет» get a submenu of location names *(my call)*.
- **Refresh.** All locations refresh on today's 15-minute schedule. One location's error or captcha never touches another location's state, schedule or retry timing.

## Non-goals

- **Order and the «main» location.** Locations cannot be reordered, and the tray location cannot be changed. The first one stays first.
- **A location without a widget.** There is no hide-widget switch: every location has a widget.
- **One station only.** No more than one EcoFlow station, and one actual-power source for the whole app.
- **No shared fetches.** Two locations on the same street do not share one fetch. Each location fetches its own.
- **Notifications.**
- **Downgrade.** An older build that reads the new settings file sees no address and opens setup. That is accepted.

## Anti-goals (failure even if it «works»)

- **Losing any part of today's setup on upgrade.** That covers:
  - the address, widget style, widget position and autostart;
  - the EcoFlow configuration, `secrets.json` and the actual history;
  - the cached snapshot.

  A settings file that cannot be read or written during migration must never be replaced by defaults. The rule is the same as today's `updateSettings`.
- **One location's data shown under another's name.** This covers:
  - a snapshot cached for another location;
  - a snapshot cached for an older address of the same location;
  - an in-flight result that lands after the location was changed or deleted;
  - the EcoFlow status on a location it does not belong to.
- **Extra load on a source.** That means:
  - two requests to the same source at the same time;
  - a healthy location refreshing more often because another location keeps failing.

  The earlier anti-goal «no extra load on DTEK» stands. Each extra DTEK location costs one `getHomeNum` call per refresh, not one page load.
- **Widgets on top of each other.** A new widget must not land on an existing one when there is room on the display.
- **A deleted location's widget coming back by itself.**
- **New log lines naming a location by its name or address.** Logs use the location id.

## Data model

Shared types (`src/shared/types.ts`):

```ts
interface Location {
  /** Made once when the location is created; never changed or reused. */
  id: string;
  /** Trimmed, 1–24 characters, unique among the locations ignoring case. */
  name: string;
  address: Address;
  widgetStyle: WidgetStyle;
  widgetPosition: WidgetPosition | null;
}
interface Settings {
  /** 0–5, in the order created. `locations[0]` is the tray's location. */
  locations: Location[];
  /** The location EcoFlow belongs to; null with no locations, or after that location was deleted. */
  actualLocationId: string | null;
  autostart: boolean;
  actualSource: ActualSourceConfig | null;
  ecoflowClientId?: string;
  ecoflowAppClientUuid?: string;
}
```

The top-level `address`, `widgetStyle` and `widgetPosition` are removed from `Settings`. `DEFAULT_SETTINGS` gets `locations: []` and `actualLocationId: null`. The never-throwing `getSettings()` fallback returns the new shape as well.

### Migration (in `AppStore`)

A settings file that has the old top-level keys and no `locations` is migrated:

- **An old address** becomes one location:
  - `{ id: 'home', name: 'Дім', address, widgetStyle: old ?? 'compact', widgetPosition: old ?? null }`;
  - `actualLocationId: 'home'`.

  The id is fixed, so a migration that could not be written yet gives the same location on every read.
- **An old `address: null`** becomes `locations: []`, `actualLocationId: null`.
- **The old keys** are removed from the object that is written back. A plain `{...DEFAULT_SETTINGS, ...file}` merge would keep both shapes.
- **The write.** The migration is written back as soon as it succeeds. If the file cannot be read, nothing is written and the store keeps returning the display fallback, as today. If only the write fails, the in-memory migrated settings are used and the next write carries them.
- **The old `snapshot.json`** becomes the cache entry of `home` when its address equals the migrated address. It may be deleted once the new cache is written.

Migration tests use temp directories only.

### Snapshot cache

The cache is one file, `snapshots.json`, of the form `{ [locationId]: ScheduleSnapshot }` *(my call)*.

- A cached snapshot is shown for a location only while its address equals the location's current address. This is today's `sameAddress` rule, per location.
- Deleting a location drops its entry.
- Changing a location's address drops its entry and its last error, as today's `setAddress` does.

### Safe settings writes

`updateSettings(patch)` merges at the top level. A `locations` array built from an earlier read would undo a change made in between, for example a drag-end position save that lands during a rename. So the store gets:

- `updateLocation(id, fn)`, which reads, applies `fn` to that one location, validates and writes, all in one synchronous step;
- `addLocation` and `removeLocation`, built the same way.

The widget's position save (`WidgetWindow.commit`) and its style change write through `updateLocation`, not through top-level keys. Adding a location is one call that carries the name, address and style together. The wizard no longer saves the address and the style in two calls, so a failure can never leave a half-made location with a live widget.

### Settings that cannot be read at start *(my call)*

At login a settings file is sometimes locked for a moment, by OneDrive or an antivirus. While no read has succeeded, `getSettings()` returns the display fallback, which has `locations: []`. That must not look like a new install.

- **The store reports it.** The store tells the caller whether the last read succeeded. The first-setup wizard opens only after a successful read with no locations. While the file is unreadable, the main window shows its normal error state instead.
- **Main follows the settings.** Main keeps its widgets and schedulers in step with `settings.locations` after every successful read, not only at start, add and delete:
  - A location id in settings with no widget gets one.
  - A widget whose id is no longer in settings is disposed.

  So «Дім» comes back by itself once a locked file reads. A deleted location never comes back, because its id is gone from the file.

## State that windows get

`AppState` becomes:

```ts
interface LocationState {
  location: Location;
  snapshot: ScheduleSnapshot | null; phase: RefreshPhase; lastError?: string; lineChanged: boolean;
  /** Present only on the EcoFlow location (`actualLocationId`). */
  actual?: ActualStatus | null;
}
interface AppState { settings: Settings; locations: LocationState[] }
```

- **The main window** gets the whole `AppState`.
- **Each widget** gets a state composed for its own location only: its `LocationState`, plus whether 2+ locations exist, which tells it whether to show its name. The shape is the builder's call. A widget never receives another location's snapshot.
- **The tray** reads the whole `AppState`.
- **Every state goes out through `composeState`**, so `actual` is attached in one place, to the EcoFlow location only.

### Which widget is calling

A widget's calls are mapped to the widget that owns the calling `webContents` (`event.sender`). They are:

- `getState`;
- `widgetDrag`;
- `widgetContextMenu`;
- `widgetMoveDone`;
- `openMainWindow`, for the click that opens the schedule.

Main does not trust a location id that the widget renderer sends. The current `handle` helper drops the event, so this is a deliberate change in `ipc.ts`.

### IPC from the main window

The main window sends location ids it got from state. For every such call, main checks:

- the id exists;
- the name rules (trimmed, 1–24 characters, unique ignoring case);
- the style is a known one;
- the 5-location limit.

A failed check is an error the window shows. The calls are: add, change address, rename, delete, set style, refresh one location, and set the EcoFlow location. Channel names and signatures are the builder's call.

## Refresh

- **One scheduler per location** *(my call)*. Each `RefreshScheduler` keeps today's `INTERVAL_MS`, `JITTER_MS`, `MIN_GAP_MS` and `BACKOFF_MS`, so one location's backoff never changes another's timing.
- **No new queue is needed.** Every provider already runs one operation at a time: `HttpSource.serial`, and the DTEK provider's own `serial`. Two locations on the same provider wait for each other inside the provider. Different providers may run in parallel, as the wizard's preview already can today.
- **Staggered starts.** At app start, locations on the same provider start 30 s apart, in location order *(my call)*. Their 15-minute cycles then stay spread out by the jitter.
- **Triggers.**
  - `resume` and `online` reach every location's scheduler.
  - The tray's «Оновити зараз» refreshes every location.
  - The widget menu's «Оновити зараз» refreshes that widget's location only. So does the main window's refresh button, for the selected location.
- **Captcha.** `phase: 'captcha'` is per location. «Пройти перевірку» opens that location's provider verification. Afterwards every location on that provider gets a manual refresh.
- **Results that arrive late.** A result that comes back after its location was deleted, or after its address was changed, is dropped. This is today's `'stale'` loop, applied per location.
- **Adding** a location refreshes it at once. **Deleting** one stops its scheduler.

## Widgets

### One window per location

There is one `WidgetWindow` per location:

- every location gets one at app start;
- a new location gets one when it is added;
- a location's window is disposed when the location is deleted.

`WidgetWindow` and the services around it were built as single instances for the app's whole life. Disposal has to switch all of the following off:

- **The rebuild on `closed`.** Today the window rebuilds itself after 1 s unless the app is quitting, which is the explorer-restart recovery. A disposed widget must never rebuild.
- **The constructor's `before-quit` listener and its three `screen` listeners** are removed.
- **The glass updater.** `startGlassUpdater` takes one widget, so each widget gets its own updater, stopped with that widget.
- **The desktop pinner.** `Win32DesktopPinner` holds one `win`, `progman` and `rect`, plus a watch timer. A second `pin()` takes over the first widget's slot, and the first widget would no longer be re-attached after an explorer restart. So each widget gets its own pinner, disposed with it *(my call)*.

### Placement *(my call)*

One helper finds a free spot. It is given a display's work area, the widget's size and the rectangles of the other widgets.

- **The search.** It starts at today's default corner (top-right, 24 DIP margin) and scans in 16-DIP steps, down first, then one column to the left. It returns the first spot with no overlap and at least 16 DIP between this widget and every other.
- **When the area is full.** It falls back to the default corner. Overlap is accepted only then.

When it runs:

- **Adding a location.** It runs on the display of `locations[0]`'s widget, else on the primary display. The spot is saved to the new location at once.
- **A widget whose display is gone** today goes to the primary display's corner, and that position is not saved. With several widgets, each one goes to its own free spot, found in location order. The position is still not saved, so the widget returns when the display comes back.
- **A style change** keeps the widget's top-left corner, as today, even if the bigger size now overlaps a neighbour. Moving the widget is up to the user.

### Name on the widget

- With 2+ locations, each style shows the location name in its caption or header line. The name is cut with an ellipsis, and widget sizes stay as `WIDGET_SIZES`.
- Where each style puts it is the builder's call. It must not push out the status, the countdown or the day bar. The compact and timeline captions can lead with «Батьки · …». The ring shows it in its existing caption area.

### Gestures and menu

- **A click** opens the main window on the schedule tab, with that widget's location selected.
- **The right-click menu:**
  - «Стиль» for this widget;
  - «Оновити зараз» for this location;
  - «Налаштування», which opens the main window's settings tab on this location;
  - «Вийти».
- **Move mode** is per widget.

## Main window

- **Switcher.** With 2+ locations the app bar shows a location switcher: one pill per name, next to the tabs. Long names are cut with an ellipsis. With one location there is no switcher and the window looks as today.
  - The selection starts on `locations[0]`.
  - Opening the window from a widget, or from the tray's per-location items, selects that location.
  - The selection is not persisted.
- **What follows the selection:**
  - the «Графік» tab, with its schedule, banners, captcha action and refresh button;
  - in «Налаштування», the address card, the widget style card and the «Графік відключень · Оновлено о …» row.
- **Address card.**
  - The location name, with «Перейменувати» for an inline edit using the name rules above.
  - The address line and «Змінити адресу». This runs today's wizard and keeps the name, style and position.
  - «Видалити», hidden while only one location exists. It asks first: «Видалити локацію «Батьки»? Її віджет зникне з робочого столу.»
  - Deleting `locations[0]` makes the next location the first one, and the tray follows it *(my call)*.
  - Below the card, «Додати адресу» starts the wizard for a new location. At 5 locations the button is disabled with «Можна додати до 5 адрес».
- **Wizard.**
  - The steps are the same as today.
  - The «Готово» step gets a name field: «Дім» filled in for the very first location, empty for a further one, with the placeholder «Наприклад, Батьки» *(my call)*. «Готово» stays disabled until the name passes the rules.
  - For a new location, the style step starts from `locations[0]`'s style.
  - Cancelling an add saves nothing.
  - On first setup, with no locations yet, the wizard behaves as today and the window cannot be used without finishing it.
- **The global cards** stay as they are: autostart and EcoFlow. With 2+ locations the EcoFlow card shows «Станція стоїть у:» with a picker of location names, which sets `actualLocationId`.
- **The EcoFlow row on the schedule tab.**
  - The actual-power row and the EcoFlow summary appear only on the EcoFlow location.
  - On other locations neither appears, and neither does the «Підключити EcoFlow» prompt.
  - While EcoFlow is not connected, the prompt appears only on the location `actualLocationId` points to.

## Tray

- **One location:** everything as today.
- **2+ locations:**
  - **Icon:** follows `locations[0]`.
  - **Tooltip:** one line per location, `«<name>: <title> · <nextText>»`, cut to Windows' 127-character tooltip limit.
  - **macOS:** the status lines at the top of the menu become one disabled line per location, in the same `<name>: …` form.
  - **«Пройти перевірку»:** shown while any location is in captcha. It opens the first such location's provider.
  - **«Показати графік»:** opens the window on `locations[0]`.
  - **«Оновити зараз»:** refreshes every location.
  - **«Стиль віджета»:** a submenu of location names, each with the three styles.
  - **«Перемістити віджет»:** a submenu of location names.

## EcoFlow

- `actualLocationId` is set by the migration, and by the very first location when one is created from scratch.
- **Deleting that location** leaves `actualLocationId` null *(my call)*. The station is then shown on no location, so nothing guesses where it stands.
  - The EcoFlow card says «Оберіть, де стоїть станція».
  - The card shows the picker even when only one location is left.
  - Picking a location sets `actualLocationId` again.
- **The history stays the station's own** when the picker moves it to another location *(my call)*. It is carried over: not cut and not tagged. The user is saying «the station stands here», so the new location shows the station's past week, and its mismatch text compares the readings with this location's schedule. `HistoryStore` and `ActualStateService` stay unchanged.
- The actual-power status reaches only that location's view everywhere: the widget, the schedule tab and the tray. That includes the status itself, `actualStrip`, the mismatch text and «з HH:MM».
- The actual source, its secrets, history and Bluetooth link are unchanged, one for the app.

## Testing

**Unit tests:**

- **Migration:**
  - an old address;
  - an old `null` address;
  - snapshot carry-over, matching and not matching;
  - an unwritable file that keeps the same id;
  - an unreadable file that writes nothing.
- **Name rules and the 5-location limit.**
- **`updateLocation`** keeps a concurrent change: a position save landing between a read and a rename.
- **Placement:**
  - the first free spot, with the 16-DIP gap;
  - a full work area falls back to the corner;
  - when a display is lost, each widget gets its own spot, and nothing is saved;
  - a style change keeps the top-left corner.
- **Unreadable settings at start:** no first-setup wizard opens. Widgets and schedulers appear once the file reads, and a deleted location never comes back.
- **Tray tooltip and menu** with 1 and with 2+ locations, including the 127-character cut.
- **Per-location schedulers:** a failing location does not change a healthy one's next run. Starts on the same provider are staggered.
- **Late results** are dropped after a delete or an address change.
- **EcoFlow** appears only on its location. Deleting that location leaves it unassigned, and the picker brings it back.
- **Widget disposal:** no rebuild after `closed`, and the listeners, glass updater and pinner are stopped.
- **IPC** maps widget calls by sender.

All existing tests pass, reshaped to one location where they read `settings.address`.

No run of the installed or packaged app. A dev run on the user's desktop happens only with the user's go-ahead.

## Left to the builder

- IPC channel names and signatures.
- The exact per-widget state shape.
- The component structure.
- The pill styling of the switcher, using the existing design tokens.
- Where each widget style puts the name, within the rules above.
- Whether `snapshot.json` is deleted after migration.
