import { app, dialog, net, powerMonitor } from 'electron';
import { join } from 'node:path';
import type { AppState, Settings } from '../shared/types';
import { FileLogger } from './file-logger';
import { broadcastState, registerIpc } from './ipc';
import { consoleLogger, type Logger } from './log';
import { MainWindow } from './main-window';
import { BrowserSession } from './providers/browser-session';
import { createProviders, findProvider } from './providers/registry';
import { RefreshService } from './refresh';
import { RefreshScheduler } from './scheduler';
import { AppStore } from './store';
import { AppTray } from './tray';
import { buildWidgetMenu, type TrayActions } from './tray-menu';
import { createDesktopPinner } from './widget/desktop-pin';
import { startGlassUpdater } from './widget/glass-updater';
import { WidgetWindow } from './widget/widget-window';

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
  log.info(`Blackout Widget ${app.getVersion()} starting`);

  const store = new AppStore(app.getPath('userData'));
  const providers = createProviders(o => new BrowserSession(o, log), log);
  const service = new RefreshService({ store, getProvider: id => findProvider(providers, id) });
  const scheduler = new RefreshScheduler(() => service.refresh());
  const preload = join(__dirname, '../preload/index.js');
  const mainWindow = new MainWindow(preload);
  const pinner = createDesktopPinner(log);
  const widget = new WidgetWindow({ store, pinner, preload, log });

  app.on('second-instance', () => mainWindow.open());

  const applyAutostart = () => {
    // Dev runs must never write a bare electron.exe into HKCU Run.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.getSettings().autostart });
  };
  const publishState = (state: AppState) => {
    tray.update(state);
    broadcastState(state, [mainWindow, widget]);
  };
  const publish = () => publishState(service.getState());
  const updateSettings = (patch: Partial<Settings>) => {
    try {
      store.updateSettings(patch);
    } catch (err) {
      // Called from tray clicks too: an unreadable settings file must not become an uncaught main-process error.
      log.error('saving settings failed', err);
      publish();
      return;
    }
    if (patch.widgetStyle) widget.setStyle(patch.widgetStyle);
    applyAutostart();
    publish();
  };

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
    providers, service, scheduler, updateSettings, solveCaptcha,
    openMainWindow: view => mainWindow.open(view),
    widgetDrag: (phase, x, y) => widget.drag(phase, x, y),
    widgetContextMenu: () => widget.popupMenu(buildWidgetMenu(store.getSettings().widgetStyle, actions)),
    endMoveMode: () => widget.endMoveMode(),
  });

  service.onState(publishState);
  setInterval(publish, 60_000); // keeps tray icon/tooltip in step with the clock

  applyAutostart();
  publish();
  scheduler.start();
  widget.show();
  const stopGlass = process.platform === 'win32' ? startGlassUpdater(widget) : () => {};
  app.on('will-quit', () => { stopGlass(); pinner.dispose(); });

  powerMonitor.on('resume', () => scheduler.trigger('resume'));
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now && !online) scheduler.trigger('online');
    online = now;
  }, 30_000);

  if (!store.getSettings().address) mainWindow.open('setup');
}
