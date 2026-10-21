import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { Logger } from '../../src/main/log';
import { AppStore } from '../../src/main/store';
import type { DesktopPinner } from '../../src/main/widget/desktop-pin';
import { WidgetWindow, type WidgetWindowDeps } from '../../src/main/widget/widget-window';
import { fixtureSnapshot } from '../helpers/snapshot';

/** Just enough of Electron for WidgetWindow: windows record their handlers, the screen is a mutable display list. */
const fake = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class FakeWindow {
    static created: FakeWindow[] = [];
    readonly handlers = new Map<string, Handler[]>();
    readonly webContents = { on: vi.fn(), send: vi.fn() };
    destroyed = false;
    constructor(readonly options: Record<string, unknown>) { FakeWindow.created.push(this); }
    on(event: string, cb: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); return this; }
    once(event: string, cb: Handler) { return this.on(event, cb); }
    emit(event: string, ...args: unknown[]) { for (const cb of this.handlers.get(event) ?? []) cb(...args); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    setShape() {}
    showInactive() {}
    setAlwaysOnTop() {}
  }
  type Display = { id: number; workArea: { x: number; y: number; width: number; height: number } };
  const screen = {
    displays: [] as Display[],
    getAllDisplays: () => screen.displays,
    getPrimaryDisplay: () => screen.displays[0],
    getDisplayMatching: () => screen.displays[0],
  };
  return { FakeWindow, screen };
});
vi.mock('electron', () => ({
  app: { isPackaged: true }, BrowserWindow: fake.FakeWindow, Menu: { buildFromTemplate: vi.fn() }, screen: fake.screen,
}));

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1000 } };
const compact = { width: 290, height: 150 };
const address = fixtureSnapshot().address;

/** A real store in a temp dir with locations 'a' (at 100,100) and 'b' (at 500,500), both on display 1. */
function twoLocations(): AppStore {
  const ids = ['a', 'b'];
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')), { newId: () => ids.shift()! });
  store.addLocation({ name: 'Home', address, widgetStyle: 'compact', widgetPosition: { x: 100, y: 100, displayId: 1 } });
  store.addLocation({ name: 'Parents', address, widgetStyle: 'compact', widgetPosition: { x: 500, y: 500, displayId: 1 } });
  return store;
}

const fakePinner = () => ({ pinned: false, pin: vi.fn(), unpin: vi.fn(), setBounds: vi.fn(), dispose: vi.fn() }) satisfies DesktopPinner;

function widget(store: AppStore, over: Partial<WidgetWindowDeps> = {}) {
  const pinner = fakePinner();
  const deps: WidgetWindowDeps = {
    locationId: 'a', store, pinner, preload: 'preload.js', otherBounds: () => [], quitting: () => false, ...over,
  };
  return { w: new WidgetWindow(deps), pinner };
}

/** Shows the widget and lets its window come up, as Electron would. */
function shown(w: WidgetWindow) {
  w.show();
  const win = fake.FakeWindow.created.at(-1)!;
  win.emit('ready-to-show');
  return win;
}

beforeEach(() => {
  fake.FakeWindow.created = [];
  fake.screen.displays = [primary];
});
afterEach(() => vi.useRealTimers());

test('commit saves to its own location only', () => {
  const store = twoLocations();
  const update = vi.spyOn(store, 'updateLocation');
  const { w } = widget(store);
  shown(w);
  w.drag('start', 10, 10);
  w.drag('move', 60, 30);
  w.drag('end', 60, 30);
  expect(update).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledWith('a', expect.any(Function));
  expect(store.getLocation('a')!.widgetPosition).toEqual({ x: 150, y: 120, displayId: 1 });
  expect(store.getLocation('b')!.widgetPosition).toEqual({ x: 500, y: 500, displayId: 1 });
});

test('a failed position save is logged by location id only; a deleted location saves nothing and does not throw', () => {
  const store = twoLocations();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const { w } = widget(store, { log });
  const err = new Error('EBUSY');
  const update = vi.spyOn(store, 'updateLocation').mockImplementationOnce(() => { throw err; });
  w.drag('start', 0, 0);
  w.drag('end', 5, 5);
  expect(log.error).toHaveBeenCalledWith('saving the widget position failed (location a)', err);

  store.removeLocation('a');
  update.mockClear();
  w.drag('start', 0, 0);
  expect(() => w.drag('end', 5, 5)).not.toThrow();
  expect(() => w.sync()).not.toThrow();
  expect(() => w.refit()).not.toThrow();
  expect(update).not.toHaveBeenCalled();
  expect(log.error).toHaveBeenCalledTimes(1);
});

test('sync applies a stored style change', () => {
  const store = twoLocations();
  const { w, pinner } = widget(store);
  const win = shown(w);
  pinner.setBounds.mockClear();
  w.sync(); // nothing changed
  expect(pinner.setBounds).not.toHaveBeenCalled();
  store.updateLocation('a', l => ({ ...l, widgetStyle: 'timeline' }));
  w.sync();
  // The top-left corner stays; the size is the new style's.
  expect(pinner.setBounds).toHaveBeenCalledWith(win, { x: 100, y: 100, width: 400, height: 200 });
  expect(w.getBoundsDip()).toEqual({ x: 100, y: 100, width: 400, height: 200 });
});

test('refit on a lost display takes a free spot next to the others and saves nothing', () => {
  fake.screen.displays = [primary, second];
  const store = twoLocations();
  store.updateLocation('a', l => ({ ...l, widgetPosition: { x: 2000, y: 100, displayId: 2 } }));
  const { w } = widget(store, { otherBounds: () => [{ x: 1606, y: 24, ...compact }] });
  shown(w);
  expect(w.getBoundsDip()).toEqual({ x: 2000, y: 100, ...compact });
  const update = vi.spyOn(store, 'updateLocation');
  fake.screen.displays = [primary];
  w.refit();
  expect(w.getBoundsDip()).toEqual({ x: 1606, y: 24 + 150 + 16, ...compact });
  expect(update).not.toHaveBeenCalled();
  expect(store.getLocation('a')!.widgetPosition).toEqual({ x: 2000, y: 100, displayId: 2 }); // it comes back with the display
});

test('a widget never dragged keeps its corner through a boot, a refit and a style change, a sibling next to it or not', () => {
  const store = twoLocations();
  store.updateLocation('a', l => ({ ...l, widgetPosition: null })); // the migrated «Дім», never dragged
  // «Батьки» parked snug left of the corner: closer than the 16 DIP a free spot keeps.
  const sibling = { x: 1310, y: 24, ...compact };
  const update = vi.spyOn(store, 'updateLocation');
  const { w } = widget(store, { otherBounds: () => [sibling] });
  expect(w.getBoundsDip()).toEqual({ x: 1606, y: 24, ...compact }); // the boot
  shown(w);
  w.refit();
  expect(w.getBoundsDip()).toEqual({ x: 1606, y: 24, ...compact });
  update.mockRestore();
  store.updateLocation('a', l => ({ ...l, widgetStyle: 'timeline' }));
  const save = vi.spyOn(store, 'updateLocation');
  w.sync();
  // The timeline's corner, overlapping the sibling: moving it is up to the user.
  expect(w.getBoundsDip()).toEqual({ x: 1920 - 400 - 24, y: 24, width: 400, height: 200 });
  expect(save).not.toHaveBeenCalled();
  expect(store.getLocation('a')!.widgetPosition).toBeNull();
});

test('a widget never dragged keeps its corner when a sibling sits right below it', () => {
  const store = twoLocations();
  store.updateLocation('a', l => ({ ...l, widgetPosition: null }));
  const { w } = widget(store, { otherBounds: () => [{ x: 1606, y: 190, ...compact }] });
  shown(w);
  store.updateLocation('a', l => ({ ...l, widgetStyle: 'timeline' }));
  w.sync();
  expect(w.getBoundsDip()).toEqual({ x: 1496, y: 24, width: 400, height: 200 });
  w.refit();
  expect(w.getBoundsDip()).toEqual({ x: 1496, y: 24, width: 400, height: 200 });
});

test('a disposed widget is never rebuilt', () => {
  vi.useFakeTimers();
  const store = twoLocations();
  const { w, pinner } = widget(store);
  const win = shown(w);
  w.dispose();
  w.dispose(); // idempotent
  expect(win.destroyed).toBe(true); // a deleted location's widget leaves the desktop
  expect(pinner.dispose).toHaveBeenCalledTimes(1);
  win.emit('closed');
  expect(vi.getTimerCount()).toBe(0); // no rebuild is even scheduled
  vi.advanceTimersByTime(1100);
  w.show();
  expect(fake.FakeWindow.created).toHaveLength(1);
});

test('a disposed widget cancels a rebuild already on its way', () => {
  vi.useFakeTimers();
  const { w } = widget(twoLocations());
  shown(w).emit('closed');
  w.dispose();
  vi.advanceTimersByTime(1100);
  expect(fake.FakeWindow.created).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('a live widget is rebuilt 1 s after explorer takes its window down, unless the app is quitting', () => {
  vi.useFakeTimers();
  const store = twoLocations();
  const { w } = widget(store);
  shown(w).emit('closed');
  vi.advanceTimersByTime(999);
  expect(fake.FakeWindow.created).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(fake.FakeWindow.created).toHaveLength(2);

  let quitting = false;
  const other = widget(store, { locationId: 'b', quitting: () => quitting });
  const win = shown(other.w);
  quitting = true;
  win.emit('closed');
  vi.advanceTimersByTime(1100);
  expect(fake.FakeWindow.created).toHaveLength(3);

  // The app starts quitting while the rebuild is on its way: the timer checks again.
  quitting = false;
  const late = shown(other.w);
  late.emit('closed');
  quitting = true;
  vi.advanceTimersByTime(1100);
  expect(fake.FakeWindow.created).toHaveLength(4);
});

test('owns', () => {
  const { w } = widget(twoLocations());
  const win = shown(w);
  expect(w.owns(win.webContents as unknown as WebContents)).toBe(true);
  expect(w.owns({} as WebContents)).toBe(false);
  w.dispose();
  expect(w.owns(win.webContents as unknown as WebContents)).toBe(false);
});

test('onMoved returns an unsubscribe; dispose drops every listener', () => {
  const store = twoLocations();
  const { w } = widget(store);
  const a = vi.fn(), b = vi.fn();
  const offA = w.onMoved(a);
  w.onMoved(b);
  w.refit();
  offA();
  w.refit();
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(2);
  w.dispose();
  w.refit();
  expect(b).toHaveBeenCalledTimes(2);
});
