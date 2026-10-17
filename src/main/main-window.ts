import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { MainView } from '../shared/ipc';

export class MainWindow {
  private win: BrowserWindow | null = null;
  private quitting = false;

  constructor(private readonly preload: string) {
    app.on('before-quit', () => { this.quitting = true; });
  }

  open(view: MainView = 'schedule'): void {
    if (!this.win || this.win.isDestroyed()) this.win = this.create(view);
    else void this.load(this.win, view);
    const w = this.win;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  private create(view: MainView): BrowserWindow {
    const win = new BrowserWindow({
      width: 900, height: 640, title: 'Графік відключень',
      ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : {}),
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    win.on('page-title-updated', e => e.preventDefault()); // keep the fixed window title
    // Closing hides the window; the app lives in the tray.
    win.on('close', e => {
      if (this.quitting || win.isDestroyed()) return;
      e.preventDefault();
      win.hide();
    });
    void this.load(win, view);
    return win;
  }

  private load(win: BrowserWindow, view: MainView): Promise<void> {
    const url = process.env.ELECTRON_RENDERER_URL;
    if (url) return win.loadURL(`${url}/app.html?view=${view}`);
    return win.loadFile(join(__dirname, '../renderer/app.html'), { query: { view } });
  }
}
