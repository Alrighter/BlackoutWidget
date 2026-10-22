import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { IPC, type MainNav, type MainView } from '../shared/ipc';

// The page is transparent so Mica shows through on Windows; elsewhere the window paints the mockup's window colour.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1e2028' : '#eef0f5');

export class MainWindow {
  private win: BrowserWindow | null = null;
  private ready = false;
  private pendingNav: MainNav | null = null;

  constructor(private readonly preload: string) {}

  /**
   * A window is loaded once and never reloaded; closing it frees it, and the next open builds a fresh one. The
   * initial view and location go in the query string; later ones are pushed to the renderer as a MainNav (after
   * did-finish-load if it is still loading). No view: only show/focus. No location: the window keeps (or starts
   * on) its own selection.
   */
  open(view?: MainView, locationId?: string): void {
    if (!this.win || this.win.isDestroyed()) {
      this.win = this.create();
      this.ready = false;
      this.pendingNav = null;
      this.load(this.win, view ?? 'schedule', locationId);
    } else if (view) {
      const nav: MainNav = locationId === undefined ? { view } : { view, locationId };
      if (this.ready) this.win.webContents.send(IPC.navigate, nav);
      else this.pendingNav = nav;
    }
    const w = this.win;
    if (w.isMinimized()) w.restore();
    w.show();
    // A Dock-less macOS app is not brought forward by showing a window; activate it explicitly.
    if (process.platform === 'darwin') app.focus({ steal: true });
    w.focus();
  }

  send(channel: string, payload: unknown): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 900, height: 640, minWidth: 760, minHeight: 560, title: 'Blackout Widget',
      ...(process.platform === 'win32' ? { backgroundMaterial: 'mica' as const } : { backgroundColor: windowBackground() }),
      webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (process.platform !== 'win32') {
      const repaint = () => { if (!win.isDestroyed()) win.setBackgroundColor(windowBackground()); };
      nativeTheme.on('updated', repaint);
      win.on('closed', () => nativeTheme.off('updated', repaint));
    }
    win.setMenuBarVisibility(false);
    win.on('page-title-updated', e => e.preventDefault()); // keep the fixed window title
    // Closing really closes: a hidden window would keep its renderer (and its GPU surfaces) for the app's whole life.
    // The app lives in the tray; the next open builds the window again.
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.ready = false;
      this.pendingNav = null;
    });
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      if (this.pendingNav) win.webContents.send(IPC.navigate, this.pendingNav);
      this.pendingNav = null;
    });
    return win;
  }

  private load(win: BrowserWindow, view: MainView, locationId: string | undefined): void {
    const query: Record<string, string> = locationId === undefined ? { view } : { view, location: locationId };
    const url = process.env.ELECTRON_RENDERER_URL;
    const loading = url
      ? win.loadURL(`${url}/app.html?${new URLSearchParams(query)}`)
      : win.loadFile(join(__dirname, '../renderer/app.html'), { query });
    loading.catch(err => console.error('main window load failed', err));
  }
}
