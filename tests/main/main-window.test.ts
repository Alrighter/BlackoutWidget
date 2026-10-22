import { MainWindow } from '../../src/main/main-window';
import { IPC } from '../../src/shared/ipc';

const windows = vi.hoisted(() => [] as FakeWindow[]);

interface FakeWindow {
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn>; finishLoad(): void };
  /** Fires a window event the way Electron does; 'closed' also destroys the window. */
  emit(event: string, ...args: unknown[]): void;
}

vi.mock('electron', () => {
  class BrowserWindow {
    private destroyed = false;
    private readonly contentsHandlers = new Map<string, () => void>();
    private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    loadFile = vi.fn(async () => {});
    loadURL = vi.fn(async () => {});
    webContents = {
      send: vi.fn(),
      on: (event: string, cb: () => void) => { this.contentsHandlers.set(event, cb); },
      finishLoad: () => this.contentsHandlers.get('did-finish-load')?.(),
    };
    constructor() { windows.push(this as unknown as FakeWindow); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() {}
    focus() {}
    hide = vi.fn();
    on(event: string, cb: (...args: unknown[]) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
    emit(event: string, ...args: unknown[]) {
      if (event === 'closed') this.destroyed = true;
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    setMenuBarVisibility() {}
    setBackgroundColor() {}
  }
  return { BrowserWindow, app: { on: vi.fn(), focus: vi.fn() }, nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), off: vi.fn() } };
});

beforeEach(() => {
  windows.length = 0;
  vi.unstubAllEnvs();
  vi.stubEnv('ELECTRON_RENDERER_URL', '');
});

test('the first open puts the view and the location in the query', () => {
  new MainWindow('preload.js').open('settings', 'b');
  expect(windows).toHaveLength(1);
  expect(windows[0].loadFile).toHaveBeenCalledWith(expect.stringContaining('app.html'), { query: { view: 'settings', location: 'b' } });
});

test('without a location the query has the view only', () => {
  new MainWindow('preload.js').open();
  expect(windows[0].loadFile).toHaveBeenCalledWith(expect.stringContaining('app.html'), { query: { view: 'schedule' } });
});

test('the dev server URL carries the location encoded', () => {
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173');
  new MainWindow('preload.js').open('schedule', 'a b&c');
  expect(windows[0].loadURL).toHaveBeenCalledWith('http://localhost:5173/app.html?view=schedule&location=a+b%26c');
});

test('later opens send a MainNav, once the page has loaded', () => {
  const main = new MainWindow('preload.js');
  main.open('schedule');
  const win = windows[0];
  // Still loading: the last navigation waits for did-finish-load.
  main.open('settings', 'b');
  expect(win.webContents.send).not.toHaveBeenCalled();
  win.webContents.finishLoad();
  expect(win.webContents.send).toHaveBeenCalledWith(IPC.navigate, { view: 'settings', locationId: 'b' });
  main.open('schedule');
  expect(win.webContents.send).toHaveBeenLastCalledWith(IPC.navigate, { view: 'schedule' });
  // No view: only show and focus.
  win.webContents.send.mockClear();
  main.open();
  expect(win.webContents.send).not.toHaveBeenCalled();
  expect(windows).toHaveLength(1);
});

test('closing frees the window; the next open loads a fresh one on its own view', () => {
  const main = new MainWindow('preload.js');
  main.open('schedule', 'b');
  const first = windows[0];
  first.webContents.finishLoad();
  const close = { preventDefault: vi.fn() };
  first.emit('close', close);
  // Not kept hidden: the window really closes, and its renderer with it.
  expect(close.preventDefault).not.toHaveBeenCalled();
  expect(first.hide).not.toHaveBeenCalled();
  first.emit('closed');
  main.send(IPC.state, {});
  expect(first.webContents.send).not.toHaveBeenCalled();
  main.open('settings');
  expect(windows).toHaveLength(2);
  expect(windows[1].loadFile).toHaveBeenCalledWith(expect.stringContaining('app.html'), { query: { view: 'settings' } });
  // The new page is still loading: a navigation waits for it instead of reaching the old window.
  main.open('schedule', 'b');
  expect(windows[1].webContents.send).not.toHaveBeenCalled();
  windows[1].webContents.finishLoad();
  expect(windows[1].webContents.send).toHaveBeenCalledWith(IPC.navigate, { view: 'schedule', locationId: 'b' });
});
