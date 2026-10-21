import { app, dialog, net, powerMonitor, screen, shell } from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/ipc';
import { UNKNOWN_LOCATION } from '../shared/locations';
import { providerSiteUrl } from '../shared/providers';
import type { AppState, Location, Settings, WidgetStyle } from '../shared/types';
import { WIDGET_SIZES } from '../shared/widget-sizes';
import { createActualActions, createActualRestart } from './actual/actions';
import { EcoflowApi } from './actual/ecoflow/api';
import { EcoflowAppApi } from './actual/ecoflow/app-api';
import { electronEncryptor, electronFetch, mqttConnect, spawnBleHost } from './actual/electron-deps';
import { BleLink } from './actual/ecoflow/ble/link';
import { HistoryStore } from './actual/history';
import { createActualSources } from './actual/registry';
import { SecretStore } from './actual/secrets';
import { ActualStateService, safeActualStatus } from './actual/service';
import { composeAppState, widgetStateOf } from './compose-state';
import { FileLogger } from './file-logger';
import { broadcastState, registerIpc, throttleLive } from './ipc';
import { guardedKeyed } from './keyed';
import { createLocationActions } from './location-actions';
import { consoleLogger, type Logger } from './log';
import { MainWindow } from './main-window';
import { BrowserSession } from './providers/browser-session';
import { electronHttp } from './providers/electron-http';
import { createProviders, findProvider } from './providers/registry';
import { RefreshService } from './refresh';
import { RefreshScheduler, startDelays, type TriggerReason } from './scheduler';
import { AppStore, LocationError } from './store';
import { AppTray } from './tray';
import { buildWidgetMenu, type TrayActions } from './tray-menu';
import { createDesktopPinner } from './widget/desktop-pin';
import { startGlassUpdater } from './widget/glass-updater';
import { placeNewWidget } from './widget/position';
import { WidgetWindow } from './widget/widget-window';

const ECOFLOW_HELP_URL = 'https://developer-eu.ecoflow.com/';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const { log, logPath } = createLog();
  bootstrap(log).catch((err: unknown) => {
    log.error('bootstrap failed', err);
    const reason = err instanceof Error ? err.message : String(err);
    const details = logPath ? `\n\nПодробиці — у журналі:\n${logPath}` : '';
    try {
      dialog.showErrorBox('Blackout Widget', `Не вдалося запустити Blackout Widget.\n\n${reason}${details}`);
    } catch { /* nothing more to do */ }
    app.exit(1);
  });
}

/** `<userData>/logs/app.log` (rotated at ~1 MB, one previous file kept). */
function createLog(): { log: Logger; logPath?: string } {
  try {
    const log = new FileLogger(join(app.getPath('userData'), 'logs'));
    return { log, logPath: log.path };
  } catch {
    return { log: consoleLogger };
  }
}

async function bootstrap(log: Logger): Promise<void> {
  app.setAppUserModelId('ua.blackoutwidget.app');
  // The app lives in the tray; closing every window must not quit it.
  app.on('window-all-closed', () => {});
  await app.whenReady();
  // A menu-bar app on macOS: no Dock icon (the packaged app also sets LSUIElement, so it never flashes there).
  app.dock?.hide();
  log.info(`Blackout Widget ${app.getVersion()} starting`);

  const userData = app.getPath('userData');
  const store = new AppStore(userData);
  const providers = createProviders(o => new BrowserSession(o, log), log, { fetch: electronHttp, isOnline: () => net.isOnline() });
  const service = new RefreshService({ store, getProvider: id => findProvider(providers, id) });
  const secrets = new SecretStore(join(userData, 'secrets.json'), electronEncryptor);
  const actualService = new ActualStateService({ history: new HistoryStore(join(userData, 'actual-history.json')), log });
  const bleLink = new BleLink({ spawn: spawnBleHost, log });
  const actualSources = createActualSources({ fetch: electronFetch, connect: mqttConnect, ble: bleLink });
  const preload = join(__dirname, '../preload/index.js');
  const mainWindow = new MainWindow(preload);
  // The widgets' close guard and explorer-restart rebuild read this: once the app quits, they close for good.
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  const safely = (what: string, fn: () => void) => {
    try { fn(); } catch (err) { log.error(what, err); }
  };

  app.on('second-instance', () => mainWindow.open());

  // One scheduler per location. The first reconcile with real settings is the boot: its locations start staggered
  // per provider, each delay used once; a location added later refreshes at once.
  let bootDelays: Map<string, number> | null = null;
  const schedulers = guardedKeyed<RefreshScheduler>(log, 'scheduler', id => {
    const scheduler = new RefreshScheduler(() => service.refresh(id));
    scheduler.start(bootDelays?.get(id) ?? 0);
    bootDelays?.delete(id);
    return scheduler;
  }, scheduler => scheduler.stop());
  const triggerAll = (reason: TriggerReason) => { for (const s of schedulers.values()) s?.trigger(reason); };

  // One widget per location, each with its own pinner and, on Windows, its own glass updater.
  // `unplaced`: the widgets the running reconcile built and has not refit yet.
  const unplaced = new Set<string>();
  const widgets = guardedKeyed<{ window: WidgetWindow; stopGlass(): void }>(log, 'widget', id => {
    const window = new WidgetWindow({
      locationId: id, store, pinner: createDesktopPinner(log), preload, log,
      otherBounds: () => liveWidgets().filter(w => w.locationId !== id).map(w => w.getBoundsDip()),
      quitting: () => quitting,
    });
    const stopGlass = process.platform === 'win32' ? startGlassUpdater(window) : () => {};
    unplaced.add(id);
    return { window, stopGlass };
  }, ({ window, stopGlass }, id) => {
    unplaced.delete(id);
    safely(`widget: the glass updater could not be stopped for location ${id}`, stopGlass);
    window.dispose();
  });
  /** The widget windows, in location order. */
  const liveWidgets = (): WidgetWindow[] => widgets.values().flatMap(w => (w ? [w.window] : []));

  /**
   * Keeps a scheduler and a widget for exactly the locations in settings: a location that reads again (a file
   * locked at login) gets them back, a deleted one is gone for good.
   */
  const reconcile = (locations: Location[]) => {
    if (quitting) return; // the widgets have closed for good: nothing may build them again
    bootDelays ??= startDelays(locations);
    const ids = locations.map(l => l.id);
    schedulers.sync(ids);
    widgets.sync(ids);
    // A widget's constructor sees none of the siblings built in the same sync. So the new ones refit now, in
    // location order: a widget whose display is gone takes a free spot clear of every sibling, before its window
    // is built there.
    for (const w of liveWidgets()) {
      if (unplaced.delete(w.locationId)) safely(`widget: refit failed for location ${w.locationId}`, () => w.refit());
    }
    for (const w of liveWidgets()) safely(`widget: could not be shown for location ${w.locationId}`, () => { w.sync(); w.show(); });
  };

  const applyAutostart = () => {
    // Dev runs must never write a bare electron.exe into HKCU Run.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.getSettings().autostart });
  };
  // Every state that reaches a window or the tray goes through composeAppState.
  const actualStatus = safeActualStatus(() => actualService.getStatus(), log);
  const getState = (): AppState => {
    const settings = store.getSettings();
    // Read right after `settings`: whether they are real ones and not the fallback of an unreadable file.
    const loaded = store.settingsLoaded;
    return composeAppState(settings, service.getStates(), actualStatus(), loaded);
  };
  const publish = () => {
    const state = getState();
    // Only real settings drive the schedulers and widgets: the fallback has no locations.
    if (state.settingsLoaded) safely('reconciling the locations failed', () => reconcile(state.settings.locations));
    tray.update(state);
    broadcastState(state, [mainWindow]);
    // A widget gets its own location only.
    for (const w of liveWidgets()) {
      const own = widgetStateOf(state, w.locationId);
      if (own) w.send(IPC.widgetState, own);
    }
  };
  const updateSettings = (patch: Partial<Omit<Settings, 'locations'>>) => {
    try {
      store.updateSettings(patch);
    } catch (err) {
      // Called from tray clicks too: an unreadable settings file must not become an uncaught main-process error.
      log.error('saving settings failed', err);
      publish();
      return;
    }
    applyAutostart();
    publish();
  };
  /** Throws when the settings file cannot be written, so the EcoFlow save/disconnect can report it (ruling R10). */
  const saveSettingsOrThrow = (patch: Partial<Omit<Settings, 'locations'>>) => {
    store.updateSettings(patch);
    applyAutostart();
    publish();
  };

  const startActual = createActualRestart({
    getSettings: () => store.getSettings(), updateSettings, secrets, service: actualService, sources: actualSources, log,
  });
  // A failed start may have shut the old source down without an onChange.
  const restartActual = () => { if (!startActual()) publish(); };
  const actualActions = createActualActions({
    makeApi: (region, keys) => new EcoflowApi(region, keys, { fetch: electronFetch }),
    makeAppApi: (region, account) => new EcoflowAppApi(region, account, { fetch: electronFetch }),
    connect: mqttConnect,
    ble: bleLink,
    secrets, getSettings: () => store.getSettings(), updateSettings: saveSettingsOrThrow, restartActual, log,
  });

  const locationActions = createLocationActions({
    store, service,
    isProvider: id => providers.some(p => p.id === id),
    // On the first location's display (else the primary), clear of every widget; addLocation saves it.
    placeNew: style => placeNewWidget(
      WIDGET_SIZES[style], screen.getAllDisplays(), screen.getPrimaryDisplay().id,
      store.getSettings().locations[0]?.widgetPosition?.displayId, liveWidgets().map(w => w.getBoundsDip()),
    ),
    changed: () => publish(),
  });

  /** The given provider's verification, else the first captcha location's, else the first location's; then every location on it refreshes. */
  const solveCaptcha = async (providerId?: string) => {
    const id = providerId
      ?? service.getStates().find(s => s.phase === 'captcha')?.location.address.providerId
      ?? store.getSettings().locations[0]?.address.providerId;
    if (!id) return;
    await findProvider(providers, id).showVerification();
    for (const l of store.getSettings().locations) {
      if (l.address.providerId === id) schedulers.get(l.id)?.trigger('manual');
    }
  };

  /** From the tray and the widget menu: a locked file or a gone location is logged, and the menus get the state back. */
  const setStyle = (id: string, style: WidgetStyle) => {
    try {
      locationActions.setStyle(id, style);
    } catch (err) {
      log.error(`setting the widget style failed (location ${id})`, err);
      publish();
    }
  };

  const actions: TrayActions = {
    showWindow: () => mainWindow.open(),
    showSchedule: () => mainWindow.open('schedule', store.getSettings().locations[0]?.id),
    refreshAll: () => triggerAll('manual'),
    setStyle,
    moveWidget: id => widgets.get(id)?.window.beginMoveMode(),
    openSettings: () => mainWindow.open('settings'),
    toggleAutostart: () => updateSettings({ autostart: !store.getSettings().autostart }),
    solveCaptcha: () => { solveCaptcha().catch(err => log.error('showVerification failed', err)); },
    quit: () => app.quit(),
  };
  const tray = new AppTray(actions);

  /** The widget's right-click menu, bound to its own location: its style, its refresh, its settings. */
  const showWidgetMenu = (w: WidgetWindow) => {
    const id = w.locationId;
    const location = store.getLocation(id);
    if (!location) return; // deleted meanwhile: the widget is about to go
    w.popupMenu(buildWidgetMenu(location.widgetStyle, {
      setStyle: style => setStyle(id, style),
      refreshNow: () => schedulers.get(id)?.trigger('manual'),
      openSettings: () => mainWindow.open('settings', id),
      quit: () => app.quit(),
    }));
  };

  registerIpc({
    providers, updateSettings, solveCaptcha, getState, actualActions,
    getWidgetState: id => widgetStateOf(getState(), id),
    locations: locationActions,
    refresh: id => {
      if (id === undefined) return triggerAll('manual');
      if (!store.getLocation(id)) throw new LocationError(UNKNOWN_LOCATION);
      schedulers.get(id)?.trigger('manual');
    },
    widgets: {
      find: sender => {
        const w = liveWidgets().find(x => x.owns(sender));
        return w && {
          locationId: w.locationId,
          drag: (phase, x, y) => w.drag(phase, x, y),
          contextMenu: () => showWidgetMenu(w),
          endMoveMode: () => w.endMoveMode(),
        };
      },
    },
    openMainWindow: (view, locationId) => mainWindow.open(view, locationId),
    openEcoflowHelp: () => {
      shell.openExternal(ECOFLOW_HELP_URL).catch(err => log.error('opening the EcoFlow developer site failed', err));
    },
    openProviderSite: providerId => {
      const url = providerSiteUrl(providerId);
      if (!url) { log.error(`no site known for provider ${providerId}`); return; }
      shell.openExternal(url).catch(err => log.error('opening the provider site failed', err));
    },
    getSettings: () => store.getSettings(),
    bleLive: bleLink,
  });

  service.onState(() => publish());
  const stopActualUpdates = actualService.onChange(publish);
  // The Bluetooth live line goes to the main window only (the settings panel), at most once a second.
  const livePush = throttleLive(mainWindow);
  const stopLive = bleLink.onLive(live => livePush.push(live));
  // Keeps the tray icon/tooltip in step with the clock, and actual.observedAt current (the service emits no change
  // for it). It is also what brings the widgets and schedulers once a settings file locked at login reads.
  setInterval(publish, 60_000);

  // A monitor came or went (or its work area or scale changed): every widget refits, in location order, so each one
  // whose display is gone finds its own free spot.
  const refitAll = () => {
    for (const w of liveWidgets()) safely(`widget: refit failed for location ${w.locationId}`, () => w.refit());
  };
  screen.on('display-added', refitAll);
  screen.on('display-removed', refitAll);
  screen.on('display-metrics-changed', refitAll);

  applyAutostart();
  restartActual();
  publish(); // the first reconcile: the schedulers start (staggered) and the widgets show
  app.on('will-quit', () => {
    widgets.clear(); // each widget's glass updater and pinner
    schedulers.clear();
    stopActualUpdates();
    stopLive();
    livePush.dispose();
    actualService.stop(); // closes the journal with a gap and ends the MQTT session
    bleLink.dispose(); // after the source has unwatched: kills the Bluetooth host for good
  });

  powerMonitor.on('resume', () => triggerAll('resume'));
  // Sleep drops the Bluetooth link and stops scanning; waking starts over with no backoff.
  powerMonitor.on('suspend', () => bleLink.suspend());
  powerMonitor.on('resume', () => bleLink.resume());
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now && !online) triggerAll('online');
    online = now;
  }, 30_000);

  // Only a settings file that was read and has no locations is a new install: a locked one shows its note instead.
  const settings = store.getSettings();
  if (store.settingsLoaded && settings.locations.length === 0) mainWindow.open('setup');
}
