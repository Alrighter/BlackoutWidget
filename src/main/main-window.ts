import { app, BrowserWindow, nativeTheme } from 'electron';
import { join } from 'node:path';
import { IPC, type MainView } from '../shared/ipc';

// The page is transparent so Mica shows through on Windows; elsewhere the window paints the mockup's window colour.
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1e2028' : '#eef0f5');

export class MainWindow {
  private win: BrowserWindow | null = null;
  private ready = false;
  private pendingView: MainView | null = null;
  private quitting = false;

  constructor(private readonly preload: string) {
    app.on('before-quit', () => { this.quitting = true; });
  }

  /**
   * The window is loaded once and never reloaded. The initial view goes in the query string; later views are
   * pushed to the renderer (after did-finish-load if it is still loading). No view: only show/focus.
   */
  open(view?: MainView): void {
    if (!this.win || this.win.isDestroyed()) {
      this.win = this.create();
      this.ready = false;
      this.pendingView = null;
      this.load(this.win, view ?? 'schedule');
    } else if (view) {
      if (this.ready) this.win.webContents.send(IPC.navigate, view);
      else this.pendingView = view;
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
    // Closing hides the window; the app lives in the tray.
    win.on('close', e => {
      if (this.quitting || win.isDestroyed()) return;
      e.preventDefault();
      win.hide();
    });
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      if (this.pendingView) win.webContents.send(IPC.navigate, this.pendingView);
      this.pendingView = null;
    });
    return win;
  }

  private load(win: BrowserWindow, view: MainView): void {
    const url = process.env.ELECTRON_RENDERER_URL;
    const loading = url
      ? win.loadURL(`${url}/app.html?view=${view}`)
      : win.loadFile(join(__dirname, '../renderer/app.html'), { query: { view } });
    loading.catch(err => console.error('main window load failed', err));
  }
}
