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
