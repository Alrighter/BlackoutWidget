import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import type { MainView } from '../shared/ipc';

export class MainWindow {
  private win: BrowserWindow | null = null;
  private currentView: MainView | null = null;
  private quitting = false;

  constructor(private readonly preload: string) {
    app.on('before-quit', () => { this.quitting = true; });
  }

  /**
   * No view (tray click, second instance): only show/focus, loading the window once if it never was.
   * An explicit view different from the current one reloads the window with it.
   */
  open(view?: MainView): void {
    if (!this.win || this.win.isDestroyed()) {
      this.win = this.create();
      this.currentView = null;
    }
    const w = this.win;
    const target = view ?? this.currentView ?? 'schedule';
    if (target !== this.currentView) this.load(w, target);
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  private create(): BrowserWindow {
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
    return win;
  }

  private load(win: BrowserWindow, view: MainView): void {
    this.currentView = view;
    const url = process.env.ELECTRON_RENDERER_URL;
    const loading = url
      ? win.loadURL(`${url}/app.html?view=${view}`)
      : win.loadFile(join(__dirname, '../renderer/app.html'), { query: { view } });
    loading.catch(err => console.error('main window load failed', err));
  }
}
