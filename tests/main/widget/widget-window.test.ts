import type { BrowserWindowConstructorOptions } from 'electron';
import type { DesktopPinner } from '../../../src/main/widget/desktop-pin';
import { MacNativeGlass, type NativeGlass } from '../../../src/main/widget/glass-darwin';
import type { ObjcBindings } from '../../../src/main/widget/objc-darwin';
import { createPinGuard } from '../../../src/main/widget/pin-guard';
import { WidgetWindow } from '../../../src/main/widget/widget-window'; // electron is mocked below (vi.mock is hoisted)
import type { AppStore } from '../../../src/main/store';
import { IPC } from '../../../src/shared/ipc';
import type { WidgetStyle } from '../../../src/shared/types';
import { memFs } from '../../helpers/mem-fs';

/** Electron stand-ins: a BrowserWindow that records what is done to it, in one shared order log. */
const h = vi.hoisted(() => {
  const order: string[] = [];
  type Handler = (...args: unknown[]) => void;
  class FakeWin {
    static all: FakeWin[] = [];
    readonly handlers = new Map<string, Handler[]>();
    readonly sent: [string, unknown][] = [];
    destroyed = false;
    readonly webContents = {
      send: (channel: string, payload: unknown) => { this.sent.push([channel, payload]); },
      on: (event: string, cb: Handler) => { this.on(event, cb); },
    };
    readonly showInactive = vi.fn(() => { order.push('showInactive'); });
    readonly setVibrancy = vi.fn((type: unknown) => { order.push(`setVibrancy ${String(type)}`); });
    readonly setAlwaysOnTop = vi.fn((on: boolean) => { order.push(`setAlwaysOnTop ${on}`); });
    readonly setShape = vi.fn(() => { order.push('setShape'); });
    readonly loadFile = vi.fn(() => Promise.resolve());
    readonly loadURL = vi.fn(() => Promise.resolve());
    constructor(readonly options: Record<string, unknown>) { FakeWin.all.push(this); }
    on(event: string, cb: Handler): this { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); return this; }
    once(event: string, cb: Handler): this { return this.on(event, cb); }
    emit(event: string, ...args: unknown[]): void { for (const cb of this.handlers.get(event) ?? []) cb(...args); }
    isDestroyed(): boolean { return this.destroyed; }
    getNativeWindowHandle(): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(0x1234n); return b; }
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  return { order, FakeWin, display };
});

vi.mock('electron', () => ({
  app: { on: vi.fn(), isPackaged: true },
  BrowserWindow: h.FakeWin,
  Menu: { buildFromTemplate: vi.fn() },
  screen: {
    on: vi.fn(), getAllDisplays: () => [h.display], getPrimaryDisplay: () => h.display, getDisplayMatching: () => h.display,
  },
}));

type Win = InstanceType<typeof h.FakeWin>;
const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** One location, 'a', with no saved position; `restyle` changes its style the way the settings or the tray do. */
function fakeStore(style: WidgetStyle = 'compact') {
  const location = { id: 'a', name: 'Дім', widgetStyle: style, widgetPosition: null };
  const store = { getLocation: (id: string) => (id === 'a' ? location : undefined), updateLocation: vi.fn() } as unknown as AppStore;
  return { store, location };
}

/** A style change: the store first, then main tells the widget to sync. */
function restyle(widget: WidgetWindow, location: { widgetStyle: WidgetStyle }, style: WidgetStyle) {
  location.widgetStyle = style;
  widget.sync();
}

function fakePinner(): DesktopPinner {
  return {
    pinned: false,
    pin: vi.fn(() => { h.order.push('pin'); }),
    unpin: vi.fn(() => { h.order.push('unpin'); }),
    setBounds: vi.fn(() => { h.order.push('setBounds'); }),
    dispose: vi.fn(),
  };
}

/** A glass that succeeds (or fails) on demand and, like the real one, turns itself off after a failure. */
function fakeGlass(ok: () => boolean = () => true) {
  let enabled = true;
  const glass: NativeGlass = {
    get enabled() { return enabled; },
    windowOptions: () => (enabled ? { vibrancy: 'popover', visualEffectState: 'active' } : {}),
    round: vi.fn((_win, style: WidgetStyle) => {
      h.order.push(`round ${style}`);
      if (!enabled) return false;
      enabled = ok();
      return enabled;
    }),
  };
  return glass;
}

/** Windows unless a glass is given (the glass exists on macOS only) or the platform is named. */
function setup(o: { glass?: NativeGlass | null; style?: WidgetStyle; platform?: NodeJS.Platform; log?: ReturnType<typeof fakeLog> } = {}) {
  const log = o.log ?? fakeLog();
  const pinner = fakePinner();
  const platform = o.platform ?? (o.glass ? 'darwin' : 'win32');
  const { store, location } = fakeStore(o.style);
  const widget = new WidgetWindow({
    locationId: 'a', store, pinner, preload: '/preload.js', log, glass: o.glass ?? null, platform,
    otherBounds: () => [], quitting: () => false,
  });
  widget.show();
  const win = h.FakeWin.all.at(-1)!;
  return { widget, win, pinner, log, location };
}

const backgrounds = (win: Win) => win.sent.filter(([ch]) => ch === IPC.background).map(([, bg]) => bg);

/** The widget window options as they were before the native glass: Windows must keep exactly these. */
const WINDOWS_OPTIONS: BrowserWindowConstructorOptions = {
  x: 1920 - 290 - 24, y: 24, width: 290, height: 150, show: false,
  frame: false, transparent: true, resizable: false, skipTaskbar: true, focusable: true, hasShadow: false,
  webPreferences: { preload: '/preload.js', contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
};

beforeEach(() => {
  h.order.length = 0;
  h.FakeWin.all.length = 0;
});

describe('WidgetWindow without a native glass (Windows, or macOS with native calls off)', () => {
  test('the window options are unchanged: no vibrancy', () => {
    const { win } = setup();
    expect(win.options).toEqual(WINDOWS_OPTIONS);
  });

  test('ready-to-show: bounds, the Windows corner shape, show, pin; no background sent (the glass updater or the renderer\'s tint owns it)', () => {
    const { win } = setup();
    win.emit('ready-to-show');
    expect(h.order).toEqual(['setBounds', 'setShape', 'showInactive', 'pin']);
    expect(backgrounds(win)).toEqual([]);
  });
});

describe('WidgetWindow with the macOS native glass', () => {
  test('the window is created transparent with vibrancy kept active; everything else as on Windows', () => {
    const { win } = setup({ glass: fakeGlass() });
    expect(win.options).toEqual({
      ...WINDOWS_OPTIONS, vibrancy: 'popover', visualEffectState: 'active', acceptFirstMouse: true, minimizable: false,
    });
  });

  test('ready-to-show: bounds, the corners (before the first frame shows), show, pin; then «native» is sent once', () => {
    const { win } = setup({ glass: fakeGlass() });
    win.emit('ready-to-show');
    expect(h.order).toEqual(['setBounds', 'round compact', 'showInactive', 'pin']);
    expect(backgrounds(win)).toEqual([{ kind: 'native' }]);
  });

  test('the corners follow the saved style from the start', () => {
    const { win } = setup({ glass: fakeGlass(), style: 'timeline' });
    win.emit('ready-to-show');
    expect(h.order).toContain('round timeline');
  });

  test('every style change re-applies the corners for the new card; the same style does nothing', () => {
    const glass = fakeGlass();
    const { widget, win, location } = setup({ glass });
    win.emit('ready-to-show');
    h.order.length = 0;
    restyle(widget, location, 'ring');
    restyle(widget, location, 'ring');
    restyle(widget, location, 'timeline');
    expect(h.order).toEqual(['setBounds', 'round ring', 'setBounds', 'round timeline']);
    expect(backgrounds(win)).toEqual([{ kind: 'native' }]); // already native: not re-sent
  });

  test('a renderer reload gets «native» again', () => {
    const { win } = setup({ glass: fakeGlass() });
    win.emit('ready-to-show');
    win.sent.length = 0;
    win.emit('did-finish-load');
    expect(backgrounds(win)).toEqual([{ kind: 'native' }]);
  });

  test('failed corners: the vibrancy goes, «tint» is sent, WidgetWindow adds no log line of its own', () => {
    const { win, log } = setup({ glass: fakeGlass(() => false) });
    win.emit('ready-to-show');
    expect(h.order).toEqual(['setBounds', 'round compact', 'setVibrancy null', 'showInactive', 'pin']);
    expect(backgrounds(win)).toEqual([{ kind: 'tint' }]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('after a failure: no more corner calls on style changes, and a rebuilt window gets no vibrancy', () => {
    vi.useFakeTimers();
    try {
      const glass = fakeGlass(() => false);
      const { widget, win, location } = setup({ glass });
      win.emit('ready-to-show');
      h.order.length = 0;
      restyle(widget, location, 'ring');
      expect(h.order).toEqual(['setBounds']);
      win.destroyed = true;
      win.emit('closed'); // e.g. the window went away: WidgetWindow builds a new one a second later
      vi.advanceTimersByTime(1000);
      const rebuilt = h.FakeWin.all.at(-1)!;
      expect(rebuilt).not.toBe(win);
      expect(rebuilt.options).not.toHaveProperty('vibrancy');
      expect(rebuilt.options).not.toHaveProperty('visualEffectState');
      rebuilt.emit('did-finish-load');
      expect(backgrounds(rebuilt)).toEqual([{ kind: 'tint' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('move mode: nothing touches the level after a pin (setAlwaysOnTop(false) comes before pin, true after unpin)', () => {
    const { widget, win } = setup({ glass: fakeGlass() });
    win.emit('ready-to-show');
    h.order.length = 0;
    widget.beginMoveMode();
    widget.endMoveMode();
    expect(h.order).toEqual(['unpin', 'setAlwaysOnTop true', 'setBounds', 'setAlwaysOnTop false', 'pin']);
  });
});

describe('WidgetWindow on macOS: the first click and Cmd+M, with or without the native glass', () => {
  // The app is LSUIElement and almost never active: without acceptFirstMouse the first left press (open the schedule,
  // start a drag, «Готово») only activates it. minimizable: false keeps Cmd+M off the widget once it is the key window.
  test('with the glass: acceptFirstMouse and not minimizable, beside the vibrancy', () => {
    const { win } = setup({ glass: fakeGlass(), platform: 'darwin' });
    expect(win.options).toMatchObject({ acceptFirstMouse: true, minimizable: false, vibrancy: 'popover' });
  });

  test('with the glass or the guard off (glass: null): still acceptFirstMouse and not minimizable, no vibrancy', () => {
    const { win } = setup({ glass: null, platform: 'darwin' });
    expect(win.options).toEqual({ ...WINDOWS_OPTIONS, acceptFirstMouse: true, minimizable: false });
  });
});

describe('WidgetWindow: one native glass shared by several widgets', () => {
  test('another widget\'s failed corners turn the glass off: this one drops its vibrancy and sends «tint» at its next style change', () => {
    let ok = true;
    const glass = fakeGlass(() => ok);
    const home = setup({ glass });
    home.win.emit('ready-to-show');
    const parents = setup({ glass });
    ok = false;
    parents.win.emit('ready-to-show'); // its rounding fails: the shared glass goes off
    expect(glass.enabled).toBe(false);
    h.order.length = 0;
    restyle(home.widget, home.location, 'ring');
    expect(home.win.setVibrancy).toHaveBeenCalledWith(null);
    expect(backgrounds(home.win)).toEqual([{ kind: 'native' }, { kind: 'tint' }]);
    expect(h.order).toEqual(['setBounds', 'setVibrancy null']); // no corner call on a glass that is off
    restyle(home.widget, home.location, 'timeline');
    expect(home.win.setVibrancy).toHaveBeenCalledTimes(1);
    expect(backgrounds(home.win)).toEqual([{ kind: 'native' }, { kind: 'tint' }]);
  });

  test('a window created with vibrancy whose glass went off before it showed: no vibrancy, «tint»', () => {
    let ok = true;
    const glass = fakeGlass(() => ok);
    const home = setup({ glass });
    const parents = setup({ glass }); // both windows built with vibrancy
    ok = false;
    home.win.emit('ready-to-show'); // fails: the glass is off
    parents.win.emit('ready-to-show');
    expect(parents.win.setVibrancy).toHaveBeenCalledWith(null);
    expect(backgrounds(parents.win)).toEqual([{ kind: 'tint' }]);
  });
});

describe('WidgetWindow with the real MacNativeGlass over fake bindings', () => {
  function fakeObjc(o: { throwOnCornerRadius?: boolean } = {}) {
    const names = new Map<bigint, string>();
    const radii: number[] = [];
    let next = 0x100n;
    const objc: ObjcBindings = {
      cls: () => 1n,
      sel: name => { const id = next++; names.set(id, name); return id; },
      msgId: () => 0x99n,
      msgVoidLong: () => {},
      msgVoidULong: () => {},
      msgVoidBool: () => {},
      msgVoidDouble: (_obj, sel, d) => {
        if (o.throwOnCornerRadius) throw new Error('setCornerRadius: failed');
        if (names.get(sel) === 'setCornerRadius:') radii.push(d);
      },
      windowLevelForKey: () => 0,
    };
    return { objc, radii };
  }

  test('a throwing msgVoidDouble end to end: the widget gets only «tint», the vibrancy goes, exactly one error line', () => {
    const log = fakeLog();
    const glass = new MacNativeGlass(fakeObjc({ throwOnCornerRadius: true }).objc,
      createPinGuard(memFs().fs, '/data/pin-darwin.pending', '1.2.3', log), log);
    const { widget, win, location } = setup({ glass, log });
    win.emit('ready-to-show');
    restyle(widget, location, 'ring'); // the glass is off now: no second attempt, no second line
    expect(backgrounds(win)).toEqual([{ kind: 'tint' }]);
    expect(win.setVibrancy).toHaveBeenCalledTimes(1);
    expect(win.setVibrancy).toHaveBeenCalledWith(null);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('compact sends 22 at ready-to-show; a style change to ring re-sends 26', () => {
    const f = fakeObjc();
    const glass = new MacNativeGlass(f.objc, createPinGuard(memFs().fs, '/data/pin-darwin.pending', '1.2.3'));
    const { widget, win, location } = setup({ glass });
    win.emit('ready-to-show');
    restyle(widget, location, 'ring');
    expect(f.radii).toEqual([22, 26]);
    expect(backgrounds(win)).toEqual([{ kind: 'native' }]);
  });
});
