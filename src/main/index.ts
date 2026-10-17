import { app, net, powerMonitor } from 'electron';
import { join } from 'node:path';
import type { Settings } from '../shared/types';
import { broadcastState, registerIpc } from './ipc';
import { MainWindow } from './main-window';
import { BrowserSession } from './providers/browser-session';
import { createProviders, findProvider } from './providers/registry';
import { RefreshService } from './refresh';
import { RefreshScheduler } from './scheduler';
import { AppStore } from './store';
import { AppTray } from './tray';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('ua.blackoutwidget.app');
  // The app lives in the tray; closing every window must not quit it.
  app.on('window-all-closed', () => {});
  await app.whenReady();

  const store = new AppStore(app.getPath('userData'));
  const providers = createProviders(o => new BrowserSession(o));
  const service = new RefreshService({ store, getProvider: id => findProvider(providers, id) });
  const scheduler = new RefreshScheduler(() => service.refresh());
  const mainWindow = new MainWindow(join(__dirname, '../preload/index.js'));

  app.on('second-instance', () => mainWindow.open());

  const applyAutostart = () => {
    // Dev runs must never write a bare electron.exe into HKCU Run.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.getSettings().autostart });
  };
  const publish = () => {
    const state = service.getState();
    tray.update(state);
    broadcastState(state);
  };
  const updateSettings = (patch: Partial<Settings>) => {
    store.updateSettings(patch);
    applyAutostart();
    publish();
  };

  const solveCaptcha = async () => {
    const address = store.getSettings().address;
    const provider = address ? findProvider(providers, address.providerId) : providers[0];
    await provider.showVerification();
    scheduler.trigger('manual');
  };

  const tray = new AppTray({
    showWindow: () => mainWindow.open(),
    showSchedule: () => mainWindow.open('schedule'),
    refreshNow: () => scheduler.trigger('manual'),
    setStyle: widgetStyle => updateSettings({ widgetStyle }),
    moveWidget: () => {}, // wired in Task 10 (widget window)
    openSettings: () => mainWindow.open('settings'),
    toggleAutostart: () => updateSettings({ autostart: !store.getSettings().autostart }),
    solveCaptcha: () => { solveCaptcha().catch(err => console.error('showVerification failed', err)); },
    quit: () => app.quit(),
  });

  registerIpc({ providers, service, scheduler, updateSettings, solveCaptcha, openMainWindow: view => mainWindow.open(view) });

  service.onState(state => { tray.update(state); broadcastState(state); });
  setInterval(publish, 60_000); // keeps tray icon/tooltip in step with the clock

  applyAutostart();
  publish();
  scheduler.start();

  powerMonitor.on('resume', () => scheduler.trigger('resume'));
  let online = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now && !online) scheduler.trigger('online');
    online = now;
  }, 30_000);

  if (!store.getSettings().address) mainWindow.open('setup');
}
