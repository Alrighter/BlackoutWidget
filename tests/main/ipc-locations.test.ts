import { ipcMain, type WebContents } from 'electron';
import { registerIpc, type IpcDeps } from '../../src/main/ipc';
import type { LocationActions } from '../../src/main/location-actions';
import { LocationError } from '../../src/main/store';
import { IPC } from '../../src/shared/ipc';
import { NAME_TAKEN, type LocationInput } from '../../src/shared/locations';
import type { AppState, WidgetState } from '../../src/shared/types';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

// Senders are compared by identity only.
const SENDER_A = { id: 1 } as unknown as WebContents;
const SENDER_MAIN = { id: 2 } as unknown as WebContents;

const INPUT: LocationInput = {
  name: 'Батьки',
  address: { providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'вул. Січових Стрільців', house: '7', lineIndex: 1, groupId: 'GPV1.2' },
  widgetStyle: 'ring',
};

function setup() {
  const widgetA = { locationId: 'a', drag: vi.fn(), contextMenu: vi.fn(), endMoveMode: vi.fn() };
  const locations = {
    add: vi.fn(() => ({ id: 'new', ...INPUT, widgetPosition: null })),
    edit: vi.fn(async () => {}),
    rename: vi.fn(), remove: vi.fn(), setStyle: vi.fn(), setActualLocation: vi.fn(),
  } satisfies LocationActions;
  const widgetState = { showName: true } as unknown as WidgetState;
  const appState = { locations: [], settingsLoaded: true } as unknown as AppState;
  const deps = {
    providers: [],
    getState: vi.fn(() => appState),
    locations,
    refresh: vi.fn(),
    openMainWindow: vi.fn(),
    getWidgetState: vi.fn(() => widgetState),
    widgets: { find: vi.fn((sender: WebContents) => (sender === SENDER_A ? widgetA : undefined)) },
  } satisfies Partial<IpcDeps>;
  vi.mocked(ipcMain.handle).mockClear();
  vi.mocked(ipcMain.on).mockClear();
  registerIpc(deps as unknown as IpcDeps);
  /** Calls the handler registered for `channel` (by handle or on) with a fake event from `sender`. */
  const call = (channel: string, sender: WebContents, ...args: unknown[]): unknown => {
    const registered = [...vi.mocked(ipcMain.handle).mock.calls, ...vi.mocked(ipcMain.on).mock.calls];
    const found = registered.find(([ch]) => ch === channel);
    if (!found) throw new Error(`no handler for ${channel}`);
    return (found[1] as (e: unknown, ...a: unknown[]) => unknown)({ sender }, ...args);
  };
  return { deps, widgetA, locations, widgetState, appState, call };
}

test('the location channels', () => {
  expect(IPC).toMatchObject({
    widgetGetState: 'widget:get-state', widgetState: 'widget:state', addLocation: 'loc:add', editLocation: 'loc:edit',
    renameLocation: 'loc:rename', deleteLocation: 'loc:delete', setWidgetStyle: 'loc:style', setActualLocation: 'loc:actual',
    refreshNow: 'refresh:now',
  });
  expect('saveAddress' in IPC).toBe(false);
});

describe('widget calls are routed by the sender', () => {
  test('widget:get-state gives the calling widget its own state; an unknown sender gets null', () => {
    const { deps, widgetState, call } = setup();
    expect(call(IPC.widgetGetState, SENDER_A)).toBe(widgetState);
    expect(deps.getWidgetState).toHaveBeenCalledWith('a');
    deps.getWidgetState.mockClear();
    expect(call(IPC.widgetGetState, SENDER_MAIN)).toBeNull();
    expect(deps.getWidgetState).not.toHaveBeenCalled();
  });

  test('state:get answers the main window with every location, and a widget with null', () => {
    const { deps, appState, call } = setup();
    expect(call(IPC.getState, SENDER_MAIN)).toBe(appState);
    deps.getState.mockClear();
    // A widget never receives another location's data, so not the whole AppState either.
    expect(call(IPC.getState, SENDER_A)).toBeNull();
    expect(deps.getState).not.toHaveBeenCalled();
  });

  test('widget:drag reaches the sending widget only, and bad input is ignored', () => {
    const { widgetA, call } = setup();
    call(IPC.widgetDrag, SENDER_MAIN, 'start', 10, 20);
    expect(widgetA.drag).not.toHaveBeenCalled();
    call(IPC.widgetDrag, SENDER_A, 'move', 10, 20);
    expect(widgetA.drag).toHaveBeenCalledWith('move', 10, 20);
    widgetA.drag.mockClear();
    for (const bad of [['move', Number.NaN, 1], ['move', 1, Infinity], ['move', '1', 2], ['fling', 1, 2]]) {
      call(IPC.widgetDrag, SENDER_A, ...bad);
    }
    expect(widgetA.drag).not.toHaveBeenCalled();
  });

  test('widget:context-menu and widget:move-done reach the sending widget only', () => {
    const { widgetA, call } = setup();
    call(IPC.widgetContextMenu, SENDER_MAIN);
    call(IPC.widgetMoveDone, SENDER_MAIN);
    expect(widgetA.contextMenu).not.toHaveBeenCalled();
    expect(widgetA.endMoveMode).not.toHaveBeenCalled();
    call(IPC.widgetContextMenu, SENDER_A);
    call(IPC.widgetMoveDone, SENDER_A);
    expect(widgetA.contextMenu).toHaveBeenCalledTimes(1);
    expect(widgetA.endMoveMode).toHaveBeenCalledTimes(1);
  });

  test('window:open-main from a widget opens its own location on the schedule', () => {
    const { deps, call } = setup();
    call(IPC.openMainWindow, SENDER_A, 'schedule');
    expect(deps.openMainWindow).toHaveBeenLastCalledWith('schedule', 'a');
    // The widget's click opens the schedule, whatever it sends.
    call(IPC.openMainWindow, SENDER_A, 'setup');
    expect(deps.openMainWindow).toHaveBeenLastCalledWith('schedule', 'a');
  });

  test('window:open-main from the main window keeps its view and has no location', () => {
    const { deps, call } = setup();
    call(IPC.openMainWindow, SENDER_MAIN, 'settings');
    expect(deps.openMainWindow).toHaveBeenLastCalledWith('settings', undefined);
    call(IPC.openMainWindow, SENDER_MAIN);
    expect(deps.openMainWindow).toHaveBeenLastCalledWith(undefined, undefined);
    // Only a known view goes on into the window's query string.
    call(IPC.openMainWindow, SENDER_MAIN, 'x&location=a');
    expect(deps.openMainWindow).toHaveBeenLastCalledWith(undefined, undefined);
  });
});

describe('the main window calls pass their arguments to the location actions unchanged', () => {
  test('loc:add', async () => {
    const { locations, call } = setup();
    // Resolves to nothing: the window learns about the new location from the state push.
    expect(await call(IPC.addLocation, SENDER_MAIN, INPUT)).toBeUndefined();
    expect(locations.add).toHaveBeenCalledWith(INPUT);
  });

  test('loc:edit resolves only when the edit has (the wizard waits for the first fetch)', async () => {
    const { locations, call } = setup();
    let finish!: () => void;
    locations.edit.mockImplementationOnce(() => new Promise<void>(r => { finish = r; }));
    let done = false;
    const p = Promise.resolve(call(IPC.editLocation, SENDER_MAIN, 'b', INPUT)).then(() => { done = true; });
    expect(locations.edit).toHaveBeenCalledWith('b', INPUT);
    await Promise.resolve();
    expect(done).toBe(false);
    finish();
    await p;
    expect(done).toBe(true);
  });

  test('loc:rename, loc:delete, loc:style and loc:actual', async () => {
    const { locations, call } = setup();
    await call(IPC.renameLocation, SENDER_MAIN, 'b', 'Хата');
    await call(IPC.deleteLocation, SENDER_MAIN, 'b');
    await call(IPC.setWidgetStyle, SENDER_MAIN, 'b', 'timeline');
    await call(IPC.setActualLocation, SENDER_MAIN, 'b');
    expect(locations.rename).toHaveBeenCalledWith('b', 'Хата');
    expect(locations.remove).toHaveBeenCalledWith('b');
    expect(locations.setStyle).toHaveBeenCalledWith('b', 'timeline');
    expect(locations.setActualLocation).toHaveBeenCalledWith('b');
    // Untrusted values go on as they came: the actions validate them.
    await call(IPC.setWidgetStyle, SENDER_MAIN, 5, { x: 1 });
    expect(locations.setStyle).toHaveBeenLastCalledWith(5, { x: 1 });
  });

  test('a failed check reaches the window as the error', async () => {
    const { locations, call } = setup();
    locations.rename.mockImplementationOnce(() => { throw new LocationError(NAME_TAKEN); });
    await expect(Promise.resolve().then(() => call(IPC.renameLocation, SENDER_MAIN, 'b', 'дім'))).rejects.toThrow(NAME_TAKEN);
  });
});

test('refresh:now refreshes one location, or every one without an id', async () => {
  const { deps, call } = setup();
  await call(IPC.refreshNow, SENDER_MAIN, 'b');
  expect(deps.refresh).toHaveBeenLastCalledWith('b');
  await call(IPC.refreshNow, SENDER_MAIN);
  expect(deps.refresh).toHaveBeenLastCalledWith(undefined);
  await call(IPC.refreshNow, SENDER_MAIN, 42);
  expect(deps.refresh).toHaveBeenLastCalledWith(undefined);
});
