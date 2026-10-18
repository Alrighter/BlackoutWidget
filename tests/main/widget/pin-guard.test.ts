import { createPinGuard, PIN_GUARD_FILE } from '../../../src/main/widget/pin-guard';
import { memFs } from '../../helpers/mem-fs';

const MARKER = '/data/pin-darwin.pending';

test('the marker file is pin-darwin.pending', () => expect(PIN_GUARD_FILE).toBe('pin-darwin.pending'));

test('no marker at start: enabled, nothing written yet', () => {
  const m = memFs();
  expect(createPinGuard(m.fs, MARKER, '1.2.3').disabled).toBe(false);
  expect(m.ops).toEqual([]);
});

test('run writes the version marker before fn and removes it after', () => {
  const m = memFs();
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  const seen: (string | undefined)[] = [];
  const result = guard.run(() => { seen.push(m.files.get(MARKER)); return 42; });
  expect(result).toBe(42);
  expect(seen).toEqual(['1.2.3']);
  expect(m.files.has(MARKER)).toBe(false);
  expect(m.ops).toEqual([`write ${MARKER} 1.2.3`, `rm ${MARKER}`]);
});

test('a throwing fn still removes the marker and the error is rethrown', () => {
  const m = memFs();
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  const boom = new Error('boom');
  expect(() => guard.run(() => { throw boom; })).toThrow(boom);
  expect(m.files.has(MARKER)).toBe(false);
  expect(guard.disabled).toBe(false);
});

test('a marker of the same version at start (the process died mid-call) disables the guard and is kept', () => {
  const m = memFs({ [MARKER]: '1.2.3' });
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  expect(guard.disabled).toBe(true);
  // Kept, so every later start of this version stays disabled instead of crashing every other launch.
  expect(m.files.get(MARKER)).toBe('1.2.3');
  expect(m.ops).toEqual([]);
});

test('a disabled guard never runs fn and never touches the marker', () => {
  const m = memFs({ [MARKER]: '1.2.3' });
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  const fn = vi.fn();
  expect(() => guard.run(fn)).toThrow(/disabled/);
  expect(fn).not.toHaveBeenCalled();
  expect(m.files.get(MARKER)).toBe('1.2.3');
  expect(m.ops).toEqual([]);
});

test('a marker of another version is stale: deleted, guard enabled', () => {
  const m = memFs({ [MARKER]: '1.2.2' });
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  expect(guard.disabled).toBe(false);
  expect(m.files.has(MARKER)).toBe(false);
  expect(m.ops).toEqual([`rm ${MARKER}`]);
});

test('an empty or garbage marker counts as another version: deleted, guard enabled', () => {
  for (const junk of ['', '\u0000\u0000', 'not a version']) {
    const m = memFs({ [MARKER]: junk });
    expect(createPinGuard(m.fs, MARKER, '1.2.3').disabled).toBe(false);
    expect(m.files.has(MARKER)).toBe(false);
  }
});

test('surrounding whitespace in the marker is ignored', () => {
  const m = memFs({ [MARKER]: '1.2.3\n' });
  expect(createPinGuard(m.fs, MARKER, '1.2.3').disabled).toBe(true);
});

test('when the marker cannot be written, fn does not run (native code never runs unguarded)', () => {
  const m = memFs();
  m.fs.writeFileSync = () => { throw new Error('EACCES'); };
  const guard = createPinGuard(m.fs, MARKER, '1.2.3');
  const fn = vi.fn();
  expect(() => guard.run(fn)).toThrow('EACCES');
  expect(fn).not.toHaveBeenCalled();
});

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

test('an rmSync that throws after a good fn: the result still comes back, one error line names the marker', () => {
  const m = memFs();
  const log = fakeLog();
  const guard = createPinGuard(m.fs, MARKER, '1.2.3', log);
  m.fs.rmSync = () => { throw new Error('EBUSY'); };
  expect(guard.run(() => 42)).toBe(42);
  expect(log.error).toHaveBeenCalledTimes(1);
  expect(log.error.mock.calls[0][0]).toContain(MARKER);
});

test('an rmSync that throws after a throwing fn: fn\'s error is the one rethrown, the rm failure is logged', () => {
  const m = memFs();
  const log = fakeLog();
  const guard = createPinGuard(m.fs, MARKER, '1.2.3', log);
  m.fs.rmSync = () => { throw new Error('EBUSY'); };
  const boom = new Error('boom');
  expect(() => guard.run(() => { throw boom; })).toThrow(boom);
  expect(log.error).toHaveBeenCalledTimes(1);
});

describe('holdMs: the marker outlives a successful run, for crashes AppKit raises a few run-loop cycles later', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('the marker stays for holdMs after fn returns, then a timer removes it', () => {
    const m = memFs();
    const guard = createPinGuard(m.fs, MARKER, '1.2.3');
    expect(guard.run(() => 7, { holdMs: 10_000 })).toBe(7);
    expect(m.files.get(MARKER)).toBe('1.2.3');
    vi.advanceTimersByTime(9_999);
    expect(m.files.has(MARKER)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.files.has(MARKER)).toBe(false);
    expect(m.ops).toEqual([`write ${MARKER} 1.2.3`, `rm ${MARKER}`]);
  });

  test('a throwing fn is not held: the marker goes at once', () => {
    const m = memFs();
    const guard = createPinGuard(m.fs, MARKER, '1.2.3');
    expect(() => guard.run(() => { throw new Error('boom'); }, { holdMs: 10_000 })).toThrow('boom');
    expect(m.files.has(MARKER)).toBe(false);
  });

  test('a later run without holdMs does not cut an earlier hold short; a longer hold extends it', () => {
    const m = memFs();
    const guard = createPinGuard(m.fs, MARKER, '1.2.3');
    guard.run(() => {}, { holdMs: 10_000 });
    vi.advanceTimersByTime(4_000);
    guard.run(() => {}); // e.g. the corner calls right after the pin
    expect(() => guard.run(() => { throw new Error('boom'); })).toThrow('boom');
    expect(m.files.has(MARKER)).toBe(true);
    guard.run(() => {}, { holdMs: 2_000 }); // ends before the first hold: changes nothing
    vi.advanceTimersByTime(5_999);
    expect(m.files.has(MARKER)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.files.has(MARKER)).toBe(false);
    guard.run(() => {}, { holdMs: 10_000 });
    vi.advanceTimersByTime(6_000);
    guard.run(() => {}, { holdMs: 10_000 }); // a second pin 6 s later: held until 10 s after it
    vi.advanceTimersByTime(9_999);
    expect(m.files.has(MARKER)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(m.files.has(MARKER)).toBe(false);
  });

  test('release (app quit) removes a held marker at once and cancels its timer', () => {
    const m = memFs();
    const guard = createPinGuard(m.fs, MARKER, '1.2.3');
    guard.run(() => {}, { holdMs: 10_000 });
    guard.release();
    expect(m.files.has(MARKER)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('release with nothing held touches nothing, and never removes a disabled guard\'s marker', () => {
    const m = memFs();
    createPinGuard(m.fs, MARKER, '1.2.3').release();
    expect(m.ops).toEqual([]);
    const crashed = memFs({ [MARKER]: '1.2.3' });
    createPinGuard(crashed.fs, MARKER, '1.2.3').release();
    expect(crashed.files.get(MARKER)).toBe('1.2.3');
    expect(crashed.ops).toEqual([]);
  });

  test('the hold timer and release never throw: an rmSync failure there is logged', () => {
    const m = memFs();
    const log = fakeLog();
    const guard = createPinGuard(m.fs, MARKER, '1.2.3', log);
    guard.run(() => {}, { holdMs: 10_000 });
    m.fs.rmSync = () => { throw new Error('EBUSY'); };
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(1);
    guard.run(() => {}, { holdMs: 10_000 });
    expect(() => guard.release()).not.toThrow();
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});
