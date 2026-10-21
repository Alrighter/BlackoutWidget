import { createRequire } from 'node:module';
import { Win32DesktopPinner } from '../../src/main/widget/pin-win32';

vi.mock('electron', () => ({ screen: { dipToScreenRect: (_: unknown, r: unknown) => r } }));

// pin-win32 loads koffi with a lazy CommonJS require (so the native binary is touched only on Windows), which
// vi.mock does not intercept: the fake goes into Node's module cache under koffi's resolved path instead.
const nodeRequire = createRequire(import.meta.url);
const koffiPath = nodeRequire.resolve('koffi');
const lib = { func: vi.fn(() => vi.fn(() => 0)) };
const koffi = { load: vi.fn(() => lib), struct: vi.fn() };

beforeEach(() => {
  nodeRequire.cache[koffiPath] = { id: koffiPath, filename: koffiPath, loaded: true, exports: koffi } as NodeJS.Module;
});
afterEach(() => {
  delete nodeRequire.cache[koffiPath];
  vi.useRealTimers();
});

test('each widget gets its own pinner; user32 loads once', () => {
  vi.useFakeTimers();
  const a = new Win32DesktopPinner();
  const b = new Win32DesktopPinner();
  // koffi rejects a second struct of the same name: a second pinner must not declare RECT again.
  expect(koffi.load).toHaveBeenCalledTimes(1);
  expect(koffi.struct).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(2); // one explorer-restart watch per pinner
  a.dispose();
  expect(vi.getTimerCount()).toBe(1);
  b.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
