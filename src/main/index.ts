import { app, dialog, net, powerMonitor, screen, shell } from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/ipc';
import { UNKNOWN_LOCATION } from '../shared/locations';
import { providerSiteUrl } from '../shared/providers';
import type { AppState, Settings, WidgetStyle } from '../shared/types';
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
import { createLocationActions } from './location-actions';
import { LocationRuntime, opensSetupAtBoot } from './location-runtime';
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
import { createDesktopNative } from './widget/desktop-pin';
import { startGlassUpdater } from './widget/glass-updater';
import { placeNewWidget } from './widget/position';
import { WidgetWindow } from './widget/widget-window';

const ECOFLOW_HELP_URL = 'https://developer-eu.ecoflow.com/';

// Windows: software compositing. The widgets repaint once a minute and the main window rarely, so the GPU buys
// nothing here, while its process held about 40 MB more than the software one (smoke-memory, --no-gpu).
// Must run before the app is ready.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  // The (software) GPU and the network service run inside this process instead of two more: about 20 MB less, 4
  // processes to 2 for one widget (measured 2026-10-22). A crash of either now ends the app, where Chromium would have
  // restarted the process.
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
}

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
  const service = new RefreshService({ store, getProvider: id => findProvider(providers, id), log });
  const secrets = new SecretStore(join(userData, 'secrets.json'), electronEncryptor);
  const actualService = new ActualStateService({ history: new HistoryStore(join(userData, 'actual-history.json')), log });
  const bleLink = new BleLink({ spawn: spawnBleHost, log });
  const actualSources = createActualSources({ fetch: electronFetch, connect: mqttConnect, ble: bleLink });
  const preload = join(__dirname, '../preload/index.js');
  const mainWindow = new MainWindow(preload);
  // The widgets' native side, once per process: on macOS one crash guard for every widget's pinner and the shared glass.
  const native = createDesktopNative(log, { userData, version: app.getVersion() });
  // The widgets' close guard and explorer-restart rebuild read this: once the app quits, they close for good.
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  const safely = (what: string, fn: () => void) => {
    try { fn(); } catch (err) { log.error(what, err); }
  };

  app.on('second-instance', () => mainWindow.open());

  // One scheduler and one widget per location (location-runtime.ts). The first reconcile with real settings is the
  // boot: its locations start staggered per provider, each delay used once; a location added later refreshes at once.
  // Each widget has its own pinner and, on Windows, its own glass updater. macOS has no updater: the window's own
  // vibrancy blurs the desktop, and the widget sends the renderer `native` (or `tint` with the native glass off).
  const runtime = new LocationRuntime<RefreshScheduler, { window: WidgetWindow; stopGlass(): void }>({
    log,
    createScheduler: (id, delayMs) => {
      const scheduler = new RefreshScheduler(() => service.refresh(id));
      scheduler.start(delayMs);
      return scheduler;
    },
    disposeScheduler: scheduler => scheduler.stop(),
    // A create that throws is tried again by the next reconcile, so whatever it built so far is disposed first.
    createWidget: id => {
      const pinner = native.createPinner();
      let window: WidgetWindow;
      try {
        window = new WidgetWindow({
          locationId: id, store, pinner, glass: native.glass, preload, log,
          otherBounds: () => liveWidgets().filter(w => w.locationId !== id).map(w => w.getBoundsDip()),
          quitting: () => quitting,
        });
      } catch (err) {
        pinner.dispose();
        throw err;
      }
      try {
        return { window, stopGlass: process.platform === 'win32' ? startGlassUpdater(window) : () => {} };
      } catch (err) {
        window.dispose();
        throw err;
      }
    },
    disposeWidget: ({ window, stopGlass }, id) => {
      safely(`widget: the glass updater could not be stopped for location ${id}`, stopGlass);
      window.dispose();
    },
    startDelays,
    quitting: () => quitting, // the widgets have closed for good: nothing may build them again
  });
  const triggerAll = (reason: TriggerReason) => { for (const s of runtime.schedulers()) s.trigger(reason); };
  /** The widget windows, in location order. */
  const liveWidgets = (): WidgetWindow[] => runtime.widgets().map(w => w.window);

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
    // Only real settings drive the schedulers and widgets (the runtime skips the fallback, which has no locations).
    safely('reconciling the locations failed', () => runtime.reconcile(state));
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
      if (l.address.providerId === id) runtime.scheduler(l.id)?.trigger('manual');
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
    moveWidget: id => runtime.widget(id)?.window.beginMoveMode(),
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
      refreshNow: () => runtime.scheduler(id)?.trigger('manual'),
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
      runtime.scheduler(id)?.trigger('manual');
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
    runtime.clear(); // each widget's glass updater and pinner, then the schedulers
    native.release(); // macOS: drops the crash marker still held after the last native call
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
  if (opensSetupAtBoot(store)) mainWindow.open('setup');
}
