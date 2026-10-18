import type { BrowserWindow } from 'electron';
import koffi from 'koffi';
import { join } from 'node:path';
import { createDesktopPinner, NoopPinner } from '../../../src/main/widget/desktop-pin';
import { COREGRAPHICS_PATH, LIBOBJC_PATH, loadObjc, type KoffiLike, type ObjcBindings } from '../../../src/main/widget/objc-darwin';
import {
  kCGDesktopIconWindowLevelKey, MacDesktopPinner, PIN_COLLECTION_BEHAVIOR, PIN_LEVEL_OFFSET,
} from '../../../src/main/widget/pin-darwin';
import { createPinGuard } from '../../../src/main/widget/pin-guard';
import { memFs } from '../../helpers/mem-fs';

const MARKER = '/data/pin-darwin.pending';
const VIEW = 0x1234n;
const NSWIN = 0xabcdn;
const DESKTOP_ICON_LEVEL = -2147483603; // what CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) returns on macOS

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

function fakeWin(handle: Buffer = u64(VIEW), destroyed = false) {
  const setBounds = vi.fn();
  const win = { getNativeWindowHandle: () => handle, isDestroyed: () => destroyed, setBounds } as unknown as BrowserWindow;
  return { win, setBounds };
}

/** Fake runtime: records every message send with its selector's name; `guarded` tells whether the guard marker is down. */
function fakeObjc(o: { window?: bigint; throwOn?: string; guarded?: () => boolean } = {}) {
  const selNames = new Map<bigint, string>();
  const msgs: unknown[][] = [];
  const levelKeys: number[] = [];
  const unguarded: string[] = [];
  let nextSel = 0x100n;
  const native = (what: string) => {
    if (o.guarded && !o.guarded()) unguarded.push(what);
    if (o.throwOn === what) throw new Error(`${what} failed`);
  };
  const objc: ObjcBindings = {
    cls: () => { native('cls'); return 0xc1a55n; },
    sel: name => { native('sel'); const id = nextSel++; selNames.set(id, name); return id; },
    msgId: (obj, sel) => { native('msgId'); msgs.push(['msgId', obj, selNames.get(sel)]); return o.window ?? NSWIN; },
    msgVoidLong: (obj, sel, n) => { native('msgVoidLong'); msgs.push(['msgVoidLong', obj, selNames.get(sel), n]); },
    msgVoidULong: (obj, sel, n) => { native('msgVoidULong'); msgs.push(['msgVoidULong', obj, selNames.get(sel), n]); },
    msgVoidBool: (obj, sel, b) => { native('msgVoidBool'); msgs.push(['msgVoidBool', obj, selNames.get(sel), b]); },
    msgVoidDouble: (obj, sel, d) => { native('msgVoidDouble'); msgs.push(['msgVoidDouble', obj, selNames.get(sel), d]); },
    windowLevelForKey: key => { native('windowLevelForKey'); levelKeys.push(key); return DESKTOP_ICON_LEVEL; },
  };
  return { objc, msgs, levelKeys, unguarded };
}

/** Pinner over a real guard (in-memory fs), so "inside guard.run" means "while the marker is on disk". */
function setup(o: { window?: bigint; throwOn?: string } = {}) {
  const m = memFs();
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  const f = fakeObjc({ ...o, guarded: () => m.files.has(MARKER) });
  const log = fakeLog();
  return { m, f, log, pinner: new MacDesktopPinner(f.objc, guard, log) };
}

describe('MacDesktopPinner', () => {
  test('constants: desktop icon level key 18, offset 1, behaviour CanJoinAllSpaces|Stationary|IgnoresCycle = 81', () => {
    expect(kCGDesktopIconWindowLevelKey).toBe(18);
    expect(PIN_LEVEL_OFFSET).toBe(1);
    expect(PIN_COLLECTION_BEHAVIOR).toBe(81);
  });

  test('pin: [view window], then setLevel: icon level + 1, then setCollectionBehavior: 81', () => {
    const { f, log, pinner } = setup();
    pinner.pin(fakeWin().win);
    expect(f.levelKeys).toEqual([18]);
    expect(f.msgs).toEqual([
      ['msgId', VIEW, 'window'],
      ['msgVoidLong', NSWIN, 'setLevel:', DESKTOP_ICON_LEVEL + 1],
      ['msgVoidULong', NSWIN, 'setCollectionBehavior:', 81],
    ]);
    expect(pinner.pinned).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
  });

  test('every native call of pin and unpin runs inside guard.run, and the marker is gone afterwards', () => {
    const { m, f, pinner } = setup();
    const { win } = fakeWin();
    pinner.pin(win);
    pinner.unpin(win);
    expect(f.unguarded).toEqual([]);
    expect(f.msgs.length).toBeGreaterThan(0);
    expect(m.files.has(MARKER)).toBe(false);
  });

  test('the NSView pointer is read from the handle as a little-endian u64', () => {
    const { f, pinner } = setup();
    pinner.pin(fakeWin(Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0, 0])).win);
    expect(f.msgs[0]).toEqual(['msgId', 0x1234n, 'window']);
  });

  test('unpin: normal window level 0 and behaviour CanJoinAllSpaces (move mode)', () => {
    const { f, pinner } = setup();
    const { win } = fakeWin();
    pinner.pin(win);
    f.msgs.length = 0;
    pinner.unpin(win);
    expect(f.msgs).toEqual([
      ['msgId', VIEW, 'window'],
      ['msgVoidLong', NSWIN, 'setLevel:', 0],
      ['msgVoidULong', NSWIN, 'setCollectionBehavior:', 1],
    ]);
    expect(pinner.pinned).toBe(false);
  });

  test('pin after unpin pins again (end of move mode)', () => {
    const { f, pinner } = setup();
    const { win } = fakeWin();
    pinner.pin(win);
    pinner.unpin(win);
    f.msgs.length = 0;
    pinner.pin(win);
    expect(f.msgs.at(-2)).toEqual(['msgVoidLong', NSWIN, 'setLevel:', DESKTOP_ICON_LEVEL + 1]);
    expect(pinner.pinned).toBe(true);
  });

  test('a throwing native call: pin does not throw, logs one line, stays unpinned, marker removed', () => {
    const { m, log, pinner } = setup({ throwOn: 'msgVoidLong' });
    expect(() => pinner.pin(fakeWin().win)).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(pinner.pinned).toBe(false);
    expect(m.files.has(MARKER)).toBe(false);
  });

  test('a failed pin after a good one leaves the pinner unpinned', () => {
    const { f, log, pinner } = setup();
    const { win } = fakeWin();
    pinner.pin(win);
    f.objc.msgVoidULong = () => { throw new Error('nope'); };
    pinner.pin(win);
    expect(pinner.pinned).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  test('a throwing unpin logs one line and does not throw', () => {
    const { log, pinner } = setup({ throwOn: 'msgId' });
    expect(() => pinner.unpin(fakeWin().win)).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(pinner.pinned).toBe(false);
  });

  test('a view with no window (nil) is a failure, not a silent no-op', () => {
    const { f, log, pinner } = setup({ window: 0n });
    pinner.pin(fakeWin().win);
    expect(f.msgs).toEqual([['msgId', VIEW, 'window']]);
    expect(pinner.pinned).toBe(false);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  test('a destroyed window: no native calls', () => {
    const { f, pinner } = setup();
    const { win } = fakeWin(u64(VIEW), true);
    pinner.pin(win);
    pinner.unpin(win);
    expect(f.msgs).toEqual([]);
    expect(f.levelKeys).toEqual([]);
    expect(pinner.pinned).toBe(false);
  });

  test('setBounds moves the window with Electron, pinned or not', () => {
    const { pinner } = setup();
    const { win, setBounds } = fakeWin();
    const rect = { x: 10, y: 20, width: 300, height: 150 };
    pinner.setBounds(win, rect);
    pinner.pin(win);
    pinner.setBounds(win, { ...rect, x: 11 });
    expect(setBounds.mock.calls).toEqual([[rect], [{ ...rect, x: 11 }]]);
    const gone = fakeWin(u64(VIEW), true);
    pinner.setBounds(gone.win, rect);
    expect(gone.setBounds).not.toHaveBeenCalled();
  });
});

/** Fake koffi: records loaded libraries, declared prototypes and calls; never touches native code. */
function fakeKoffi(ret: (def: string) => unknown = () => 0x1234) {
  const loaded: string[] = [];
  const declared: { lib: string; def: string }[] = [];
  const calls: { lib: string; def: string; args: unknown[] }[] = [];
  const ffi: KoffiLike = {
    load: lib => {
      loaded.push(lib);
      return {
        func: def => {
          declared.push({ lib, def });
          return (...args: unknown[]) => { calls.push({ lib, def, args }); return ret(def); };
        },
      };
    },
  };
  return { ffi, loaded, declared, calls };
}

const P = {
  getClass: 'uintptr_t objc_getClass(const char *name)',
  registerName: 'uintptr_t sel_registerName(const char *name)',
  msgId: 'uintptr_t objc_msgSend(uintptr_t self, uintptr_t op)',
  msgVoidLong: 'void objc_msgSend(uintptr_t self, uintptr_t op, long value)',
  msgVoidULong: 'void objc_msgSend(uintptr_t self, uintptr_t op, unsigned long value)',
  msgVoidBool: 'void objc_msgSend(uintptr_t self, uintptr_t op, bool value)',
  msgVoidDouble: 'void objc_msgSend(uintptr_t self, uintptr_t op, double value)',
  levelForKey: 'int32_t CGWindowLevelForKey(int32_t key)',
};

describe('loadObjc', () => {
  test('loads libobjc and CoreGraphics by absolute path and calls nothing native while loading', () => {
    const k = fakeKoffi();
    loadObjc(k.ffi);
    expect(LIBOBJC_PATH).toBe('/usr/lib/libobjc.A.dylib');
    expect(COREGRAPHICS_PATH).toBe('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    expect([...k.loaded].sort()).toEqual([COREGRAPHICS_PATH, LIBOBJC_PATH].sort());
    expect(k.calls).toEqual([]);
  });

  test('declares exactly these non-variadic prototypes, each in its library', () => {
    const k = fakeKoffi();
    loadObjc(k.ffi);
    const cg = [P.levelForKey];
    expect(k.declared.map(d => d.def).sort()).toEqual(Object.values(P).sort());
    for (const d of k.declared) expect(d.lib).toBe(cg.includes(d.def) ? COREGRAPHICS_PATH : LIBOBJC_PATH);
  });

  test('each binding goes through its own prototype with its arguments as given', () => {
    const k = fakeKoffi();
    const b = loadObjc(k.ffi);
    b.cls('NSWindow');
    b.sel('setLevel:');
    b.msgId(1n, 2n);
    b.msgVoidLong(1n, 2n, -5);
    b.msgVoidULong(1n, 2n, 81);
    b.msgVoidBool(1n, 2n, true);
    b.msgVoidDouble(1n, 2n, 12.5);
    b.windowLevelForKey(18);
    expect(k.calls.map(c => [c.def, c.args])).toEqual([
      [P.getClass, ['NSWindow']],
      [P.registerName, ['setLevel:']],
      [P.msgId, [1n, 2n]],
      [P.msgVoidLong, [1n, 2n, -5]],
      [P.msgVoidULong, [1n, 2n, 81]],
      [P.msgVoidBool, [1n, 2n, true]],
      [P.msgVoidDouble, [1n, 2n, 12.5]],
      [P.levelForKey, [18]],
    ]);
  });

  test('pointer results come back as bigint whether koffi returns a number or a bigint', () => {
    expect(loadObjc(fakeKoffi(() => 0x1234).ffi).msgId(1n, 2n)).toBe(0x1234n);
    expect(loadObjc(fakeKoffi(() => 0x1234).ffi).sel('window')).toBe(0x1234n);
    expect(loadObjc(fakeKoffi(() => 0x1234).ffi).cls('NSView')).toBe(0x1234n);
    expect(loadObjc(fakeKoffi(() => 0xffff_ffff_ffff_fff0n).ffi).msgId(1n, 2n)).toBe(0xffff_ffff_ffff_fff0n);
    expect(loadObjc(fakeKoffi(() => -2147483603).ffi).windowLevelForKey(18)).toBe(-2147483603);
  });

  test('every declared prototype parses with the real koffi (syntax only; long is 4 bytes on Windows)', () => {
    const k = fakeKoffi();
    loadObjc(k.ffi);
    const tag = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    k.declared.forEach((d, i) => {
      // koffi.proto registers a named type, so give each a unique name; lib.func itself accepts repeated symbols.
      const t = koffi.type(koffi.proto(d.def.replace(/(\w+)\(/, `$1_${tag}_${i}(`))) as unknown as
        { proto: { arguments: { type: { name: string } }[] } };
      expect(t.proto.arguments.length).toBe((d.def.match(/,/g)?.length ?? 0) + 1);
    });
  });
});

describe('createDesktopPinner on macOS', () => {
  const opts = { userData: '/data', version: '1.2.3' };
  const marker = join('/data', 'pin-darwin.pending');

  test('darwin with the guard enabled gives a MacDesktopPinner and logs nothing', () => {
    const log = fakeLog();
    const m = memFs();
    const pinner = createDesktopPinner(log, opts, { platform: 'darwin', fs: m.fs, loadObjc: () => fakeObjc().objc });
    expect(pinner).toBeInstanceOf(MacDesktopPinner);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(m.files.has(marker)).toBe(false);
  });

  test('loadObjc runs inside the guard, with the marker at <userData>/pin-darwin.pending', () => {
    const m = memFs();
    let markerDuringLoad: string | undefined;
    createDesktopPinner(fakeLog(), opts, {
      platform: 'darwin', fs: m.fs, loadObjc: () => { markerDuringLoad = m.files.get(marker); return fakeObjc().objc; },
    });
    expect(markerDuringLoad).toBe('1.2.3');
  });

  test('darwin with a disabled guard gives NoopPinner and exactly one warning, without loading the runtime', () => {
    const log = fakeLog();
    const m = memFs({ [marker]: '1.2.3' });
    const load = vi.fn(() => fakeObjc().objc);
    const pinner = createDesktopPinner(log, opts, { platform: 'darwin', fs: m.fs, loadObjc: load });
    expect(pinner).toBeInstanceOf(NoopPinner);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(m.files.get(marker)).toBe('1.2.3');
  });

  test('darwin with a marker from another version pins again', () => {
    const m = memFs({ [marker]: '1.2.2' });
    const pinner = createDesktopPinner(fakeLog(), opts, { platform: 'darwin', fs: m.fs, loadObjc: () => fakeObjc().objc });
    expect(pinner).toBeInstanceOf(MacDesktopPinner);
    expect(m.files.has(marker)).toBe(false);
  });

  test('darwin with a throwing loadObjc gives NoopPinner and exactly one error; the marker is cleared', () => {
    const log = fakeLog();
    const m = memFs();
    const pinner = createDesktopPinner(log, opts, {
      platform: 'darwin', fs: m.fs, loadObjc: () => { throw new Error('dlopen failed'); },
    });
    expect(pinner).toBeInstanceOf(NoopPinner);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(m.files.has(marker)).toBe(false);
  });

  test('darwin with an unreadable marker gives NoopPinner and exactly one error', () => {
    const log = fakeLog();
    const m = memFs({ [marker]: '1.2.3' });
    m.fs.readFileSync = () => { throw new Error('EACCES'); };
    const pinner = createDesktopPinner(log, opts, { platform: 'darwin', fs: m.fs, loadObjc: () => fakeObjc().objc });
    expect(pinner).toBeInstanceOf(NoopPinner);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  test('other platforms keep the NoopPinner warning and never touch the guard file', () => {
    const log = fakeLog();
    const m = memFs();
    const load = vi.fn(() => fakeObjc().objc);
    const pinner = createDesktopPinner(log, opts, { platform: 'linux', fs: m.fs, loadObjc: load });
    expect(pinner).toBeInstanceOf(NoopPinner);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(m.ops).toEqual([]);
  });
});
