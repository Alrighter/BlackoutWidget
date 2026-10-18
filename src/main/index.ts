import { app, dialog, net, powerMonitor, shell } from 'electron';
import { join } from 'node:path';
import type { AppState, Settings } from '../shared/types';
import { createActualActions, createActualRestart } from './actual/actions';
import { EcoflowApi } from './actual/ecoflow/api';
import { electronEncryptor, electronFetch, mqttConnect } from './actual/electron-deps';
import { HistoryStore } from './actual/history';
import { createActualSources } from './actual/registry';
import { SecretStore } from './actual/secrets';
import { ActualStateService, safeActualStatus } from './actual/service';
import { FileLogger } from './file-logger';
import { broadcastState, registerIpc } from './ipc';
import { consoleLogger, type Logger } from './log';
import { MainWindow } from './main-window';
import { BrowserSession } from './providers/browser-session';
import { DTEK_URL } from './providers/dtek-krem/page-scripts';
import { createProviders, findProvider } from './providers/registry';
import { RefreshService } from './refresh';
import { RefreshScheduler } from './scheduler';
import { AppStore } from './store';
import { AppTray } from './tray';
import { buildWidgetMenu, type TrayActions } from './tray-menu';
import { createDesktopNative } from './widget/desktop-pin';
import { startGlassUpdater } from './widget/glass-updater';
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
  const providers = createProviders(o => new BrowserSession(o, log), log);
  const service = new RefreshService({ store, getProvider: id => findProvider(providers, id) });
  const scheduler = new RefreshScheduler(() => service.refresh());
  const secrets = new SecretStore(join(userData, 'secrets.json'), electronEncryptor);
  const actualService = new ActualStateService({ history: new HistoryStore(join(userData, 'actual-history.json')), log });
  const actualSources = createActualSources({ fetch: electronFetch, connect: mqttConnect });
  const preload = join(__dirname, '../preload/index.js');
  const mainWindow = new MainWindow(preload);
  const { pinner, glass } = createDesktopNative(log, { userData, version: app.getVersion() });
  const widget = new WidgetWindow({ store, pinner, glass, preload, log });

  app.on('second-instance', () => mainWindow.open());

  const applyAutostart = () => {
    // Dev runs must never write a bare electron.exe into HKCU Run.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.getSettings().autostart });
  };
  // Every state that reaches a window or the tray goes through composeState.
  const actualStatus = safeActualStatus(() => actualService.getStatus(), log);
  const composeState = (s: AppState): AppState => ({ ...s, actual: actualStatus() });
  const getState = () => composeState(service.getState());
  const publishState = (state: AppState) => {
    tray.update(state);
    broadcastState(state, [mainWindow, widget]);
  };
  const publish = () => publishState(getState());
  const settingsSaved = (patch: Partial<Settings>) => {
    if (patch.widgetStyle) widget.setStyle(patch.widgetStyle);
    applyAutostart();
    publish();
  };
  const updateSettings = (patch: Partial<Settings>) => {
    try {
      store.updateSettings(patch);
    } catch (err) {
      // Called from tray clicks too: an unreadable settings file must not become an uncaught main-process error.
      log.error('saving settings failed', err);
      publish();
      return;
    }
    settingsSaved(patch);
  };
  /** Throws when the settings file cannot be written, so the EcoFlow save/disconnect can report it (ruling R10). */
  const saveSettingsOrThrow = (patch: Partial<Settings>) => {
    store.updateSettings(patch);
    settingsSaved(patch);
  };

  const startActual = createActualRestart({
    getSettings: () => store.getSettings(), updateSettings, secrets, service: actualService, sources: actualSources, log,
  });
  // A failed start may have shut the old source down without an onChange.
  const restartActual = () => { if (!startActual()) publish(); };
  const actualActions = createActualActions({
    makeApi: (region, keys) => new EcoflowApi(region, keys, { fetch: electronFetch }),
    secrets, getSettings: () => store.getSettings(), updateSettings: saveSettingsOrThrow, restartActual, log,
  });

  const solveCaptcha = async () => {
    const address = store.getSettings().address;
    const provider = address ? findProvider(providers, address.providerId) : providers[0];
    await provider.showVerification();
    scheduler.trigger('manual');
  };

  const actions: TrayActions = {
    showWindow: () => mainWindow.open(),
    showSchedule: () => mainWindow.open('schedule'),
    refreshNow: () => scheduler.trigger('manual'),
    setStyle: widgetStyle => updateSettings({ widgetStyle }),
    moveWidget: () => widget.beginMoveMode(),
    openSettings: () => mainWindow.open('settings'),
    toggleAutostart: () => updateSettings({ autostart: !store.getSettings().autostart }),
    solveCaptcha: () => { solveCaptcha().catch(err => log.error('showVerification failed', err)); },
    quit: () => app.quit(),
  };
  const tray = new AppTray(actions);

  registerIpc({
    providers, service, scheduler, updateSettings, solveCaptcha, getState, actualActions,
    openMainWindow: view => mainWindow.open(view),
    widgetDrag: (phase, x, y) => widget.drag(phase, x, y),
    widgetContextMenu: () => widget.popupMenu(buildWidgetMenu(store.getSettings().widgetStyle, actions)),
    endMoveMode: () => widget.endMoveMode(),
    openEcoflowHelp: () => {
      shell.openExternal(ECOFLOW_HELP_URL).catch(err => log.error('opening the EcoFlow developer site failed', err));
    },
    openDtekSite: () => {
      shell.openExternal(DTEK_URL).catch(err => log.error('opening the DTEK site failed', err));
    },
  });

  service.onState(s => publishState(composeState(s)));
  const stopActualUpdates = actualService.onChange(publish);
  // Keeps the tray icon/tooltip in step with the clock, and actual.observedAt current (the service emits no change for it).
  setInterval(publish, 60_000);

  applyAutostart();
  restartActual();
  publish();
  scheduler.start();
  widget.show();
  // Windows: the glass shows the wallpaper crop under the widget. macOS: the window's own vibrancy blurs it, and the
  // widget sends the renderer `native` (or `tint` if the native glass is off), so no updater runs there.
  const stopGlass = process.platform === 'win32' ? startGlassUpdater(widget) : () => {};
  app.on('will-quit', () => {
    stopGlass();
    pinner.dispose(); // macOS: also drops the crash marker still held after the last native call
    stopActualUpdates();
    actualService.stop(); // closes the journal with a gap and ends the MQTT session
  });

  powerMonitor.on('resume', () => scheduler.trigger('resume'));
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now && !online) scheduler.trigger('online');
    online = now;
  }, 30_000);

  if (!store.getSettings().address) mainWindow.open('setup');
}
