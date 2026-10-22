import { expect, test, vi, beforeEach } from 'vitest';

const windows = vi.hoisted(() => [] as any[]);

vi.mock('electron', () => {
  class BrowserWindow {
    destroyed = false;
    destroy = vi.fn(() => { this.destroyed = true; });
    removeAllListeners = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    on = vi.fn();
    isDestroyed() { return this.destroyed; }
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      loadURL: vi.fn(async () => {}),
      executeJavaScript: vi.fn(async () => true),
      getURL: () => '',
    };
    constructor() { windows.push(this); }
  }
  const ses = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  };
  return {
    app: { on: vi.fn() },
    net: { isOnline: () => true },
    session: { fromPartition: vi.fn(() => ses) },
    BrowserWindow,
  };
});

import { BrowserSession } from '../../src/main/providers/browser-session';

const make = () => new BrowserSession({ url: 'https://example.test/', partition: 'persist:t', readyCheck: 'true', readyTimeoutMs: 1000 });
beforeEach(() => { windows.length = 0; });

test('isOpen is false before use and true after ensureReady', async () => {
  const s = make();
  expect(s.isOpen()).toBe(false);
  await s.ensureReady();
  expect(s.isOpen()).toBe(true);
});

test('release destroys the window, and the next ensureReady builds a new one', async () => {
  const s = make();
  await s.ensureReady();
  s.release();
  expect(windows).toHaveLength(1);
  expect(windows[0].removeAllListeners).toHaveBeenCalledWith('close');
  expect(windows[0].destroy).toHaveBeenCalledTimes(1);
  expect(s.isOpen()).toBe(false);
  await s.ensureReady();
  expect(windows).toHaveLength(2);
  expect(windows[1].destroy).not.toHaveBeenCalled();
  expect(windows[1].webContents.loadURL).toHaveBeenCalledWith('https://example.test/');
  expect(s.isOpen()).toBe(true);
});

test('release while showForUser is pending does nothing', async () => {
  const s = make();
  await s.ensureReady();
  windows[0].webContents.executeJavaScript.mockImplementation(() => new Promise(() => {}));
  void s.showForUser();
  await Promise.resolve();
  s.release();
  expect(windows[0].destroy).not.toHaveBeenCalled();
  expect(s.isOpen()).toBe(true);
});

test('release after dispose does nothing', async () => {
  const s = make();
  await s.ensureReady();
  s.dispose();
  expect(windows[0].destroy).toHaveBeenCalledTimes(1);
  expect(() => s.release()).not.toThrow();
  expect(windows[0].destroy).toHaveBeenCalledTimes(1);
});
