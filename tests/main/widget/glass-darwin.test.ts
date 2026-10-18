import type { BrowserWindow } from 'electron';
import { MacNativeGlass, NATIVE_VIBRANCY } from '../../../src/main/widget/glass-darwin';
import type { ObjcBindings } from '../../../src/main/widget/objc-darwin';
import { PIN_HOLD_MS } from '../../../src/main/widget/pin-darwin';
import { createPinGuard } from '../../../src/main/widget/pin-guard';
import { WIDGET_RADII } from '../../../src/shared/widget-sizes';
import { memFs } from '../../helpers/mem-fs';

const MARKER = '/data/pin-darwin.pending';
const VIEW = 0x1234n;
const NSWIN = 0xabcdn;
const CONTENT = 0xc0n;
const LAYER = 0x1a7n;

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };

function fakeWin(handle: Buffer = u64(VIEW), destroyed = false) {
  return { getNativeWindowHandle: () => handle, isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

/**
 * Fake runtime: `[view window]` → NSWIN, `[nswin contentView]` → CONTENT, `[content layer]` → LAYER (each overridable,
 * 0n = nil). Records every send with its selector's name and every native call made while the guard marker is down.
 */
function fakeObjc(o: { ids?: Record<string, bigint>; throwOn?: string; guarded?: () => boolean } = {}) {
  const ids: Record<string, bigint> = { window: NSWIN, contentView: CONTENT, layer: LAYER, ...o.ids };
  const selNames = new Map<bigint, string>();
  const msgs: unknown[][] = [];
  const unguarded: string[] = [];
  let nextSel = 0x100n;
  const native = (what: string) => {
    if (o.guarded && !o.guarded()) unguarded.push(what);
    if (o.throwOn === what) throw new Error(`${what} failed`);
  };
  const objc: ObjcBindings = {
    cls: () => { native('cls'); return 0xc1a55n; },
    sel: name => { native('sel'); const id = nextSel++; selNames.set(id, name); return id; },
    msgId: (obj, sel) => {
      native('msgId');
      const name = selNames.get(sel)!;
      msgs.push(['msgId', obj, name]);
      return ids[name] ?? 0n;
    },
    msgVoidLong: (obj, sel, n) => { native('msgVoidLong'); msgs.push(['msgVoidLong', obj, selNames.get(sel), n]); },
    msgVoidULong: (obj, sel, n) => { native('msgVoidULong'); msgs.push(['msgVoidULong', obj, selNames.get(sel), n]); },
    msgVoidBool: (obj, sel, b) => { native('msgVoidBool'); msgs.push(['msgVoidBool', obj, selNames.get(sel), b]); },
    msgVoidDouble: (obj, sel, d) => { native('msgVoidDouble'); msgs.push(['msgVoidDouble', obj, selNames.get(sel), d]); },
    windowLevelForKey: () => { native('windowLevelForKey'); return 0; },
  };
  return { objc, msgs, unguarded, selNames };
}

/** Glass over a real guard (in-memory fs), so "inside guard.run" means "while the marker is on disk". */
function setup(o: { ids?: Record<string, bigint>; throwOn?: string } = {}) {
  const m = memFs();
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  const f = fakeObjc({ ...o, guarded: () => m.files.has(MARKER) });
  const log = fakeLog();
  return { m, f, log, guard, glass: new MacNativeGlass(f.objc, guard, log) };
}

const rounding = (radius: number) => [
  ['msgId', VIEW, 'window'],
  ['msgId', NSWIN, 'contentView'],
  ['msgVoidBool', CONTENT, 'setWantsLayer:', true],
  ['msgId', CONTENT, 'layer'],
  ['msgVoidDouble', LAYER, 'setCornerRadius:', radius],
  ['msgVoidBool', LAYER, 'setMasksToBounds:', true],
];

describe('MacNativeGlass', () => {
  test('vibrancy: the popover material, kept active (the widget window is never key)', () => {
    const { glass } = setup();
    expect(NATIVE_VIBRANCY).toBe('popover');
    expect(glass.enabled).toBe(true);
    expect(glass.windowOptions()).toEqual({ vibrancy: 'popover', visualEffectState: 'active' });
  });

  test('compact: [[view window] contentView] setWantsLayer:YES, then its layer setCornerRadius: 22 and setMasksToBounds:YES', () => {
    const { f, log, glass } = setup();
    expect(glass.round(fakeWin(), 'compact')).toBe(true);
    expect(f.msgs).toEqual(rounding(22));
    expect(log.error).not.toHaveBeenCalled();
  });

  test('a style change re-sends the radius of the new card: ring 26, timeline 24, back to compact 22', () => {
    const { f, glass } = setup();
    const win = fakeWin();
    glass.round(win, 'compact');
    for (const style of ['ring', 'timeline', 'compact'] as const) {
      f.msgs.length = 0;
      expect(glass.round(win, style)).toBe(true);
      expect(f.msgs).toEqual(rounding(WIDGET_RADII[style]));
    }
    expect(WIDGET_RADII).toEqual({ compact: 22, ring: 26, timeline: 24 });
  });

  test('selectors are registered once, at construction and under the guard', () => {
    const { f, glass } = setup();
    expect([...f.selNames.values()].sort())
      .toEqual(['contentView', 'layer', 'setCornerRadius:', 'setMasksToBounds:', 'setWantsLayer:', 'window']);
    glass.round(fakeWin(), 'compact');
    glass.round(fakeWin(), 'ring');
    expect(f.selNames.size).toBe(6);
    expect(f.unguarded).toEqual([]);
  });

  test('the NSView pointer is read from the handle as a little-endian u64', () => {
    const { f, glass } = setup();
    glass.round(fakeWin(Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0, 0])), 'compact');
    expect(f.msgs[0]).toEqual(['msgId', 0x1234n, 'window']);
  });

  test('every corner call runs inside the guard, which holds the marker PIN_HOLD_MS after a good round', () => {
    vi.useFakeTimers();
    try {
      const { m, f, glass } = setup();
      glass.round(fakeWin(), 'compact');
      expect(f.unguarded).toEqual([]);
      expect(m.files.get(MARKER)).toBe('1.2.3');
      vi.advanceTimersByTime(PIN_HOLD_MS);
      expect(m.files.has(MARKER)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(['msgId', 'msgVoidBool', 'msgVoidDouble'])(
    'a throwing %s: false, one log line, the marker removed, and the glass stays off from then on',
    throwOn => {
      const { m, f, log, glass } = setup({ throwOn });
      const win = fakeWin();
      expect(glass.round(win, 'compact')).toBe(false);
      expect(log.error).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled();
      expect(m.files.has(MARKER)).toBe(false);
      expect(glass.enabled).toBe(false);
      expect(glass.windowOptions()).toEqual({}); // a window rebuilt later gets no vibrancy: the tint
      f.msgs.length = 0;
      expect(glass.round(win, 'ring')).toBe(false);
      expect(f.msgs).toEqual([]);
      expect(log.error).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    ['window', [['msgId', VIEW, 'window']]],
    ['contentView', [['msgId', VIEW, 'window'], ['msgId', NSWIN, 'contentView']]],
    ['layer', rounding(22).slice(0, 4)],
  ] as const)('a nil %s is a failure, not a silent no-op: nothing is sent to nil, one log line', (nil, sent) => {
    const { f, log, glass } = setup({ ids: { [nil]: 0n } });
    expect(glass.round(fakeWin(), 'compact')).toBe(false);
    expect(f.msgs).toEqual(sent);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(glass.enabled).toBe(false);
  });

  test('a destroyed window: no native calls, nothing logged, the glass stays on', () => {
    const { f, log, glass } = setup();
    expect(glass.round(fakeWin(u64(VIEW), true), 'compact')).toBe(false);
    expect(f.msgs).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
    expect(glass.enabled).toBe(true);
  });
});
