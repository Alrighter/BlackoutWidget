import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore, buildSegments, pruneTransitions, type HistoryData, type Transition } from '../../../src/main/actual/history';
import { ActualStateService, CHECK_MS, KEEP_MS, safeActualStatus } from '../../../src/main/actual/service';
import type { ActualReading, ActualStateSource } from '../../../src/main/actual/types';
import type { ActualPower, ActualStatus } from '../../../src/shared/types';

const base = Date.parse('2026-10-17T10:00:00Z');
const MIN = 60_000;
const ms = (min: number) => base + Math.round(min * MIN);
const t = (min: number) => new Date(ms(min)).toISOString();
const d = (days: number) => t(days * 1440);
const STALE = 'дані станції не оновлюються';
const CHECKING = 'перевіряю зміну стану';
const LABEL = 'EcoFlow · River 2';
/** Two ways the clock can jump: timers fire on the way (the check timer sees the gap) or not (the next reading sees it). */
const jumps: [string, (byMs: number) => void, ActualPower][] = [
  ['the check timer', byMs => { vi.advanceTimersByTime(byMs); }, 'unknown'],
  ['the next reading', byMs => { vi.setSystemTime(Date.now() + byMs); }, 'on'],
];

let running: ActualStateService[] = [];
beforeEach(() => vi.useFakeTimers({ now: base }));
afterEach(() => { running.forEach(s => s.stop()); running = []; vi.useRealTimers(); });

function fakeSource() {
  let onReading: ((r: ActualReading) => void) | undefined;
  const source = { start: vi.fn((cb: (r: ActualReading) => void) => { onReading = cb; }), stop: vi.fn() } satisfies ActualStateSource;
  return { source, emit: (r: ActualReading) => onReading?.(r) };
}

function setup(initial?: HistoryData) {
  const file = join(mkdtempSync(join(tmpdir(), 'bw-hist-')), 'actual-history.json');
  if (initial) new HistoryStore(file).write(initial);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const svc = new ActualStateService({ history: new HistoryStore(file), log });
  running.push(svc);
  const { source, emit } = fakeSource();
  /** Moves the clock to t(min) — timers fire on the way — and delivers a reading observed then. */
  const at = (min: number, power: ActualPower, extra: Partial<ActualReading> = {}) => {
    vi.advanceTimersByTime(Math.max(0, ms(min) - Date.now()));
    emit({ power, observedAt: t(min), ...extra });
  };
  return { svc, log, source, at, begin: () => svc.start(source, LABEL), journal: () => new HistoryStore(file).read() };
}

test('starts unknown; confirms on after 60 s of readings, at the first reading time', () => {
  const { svc, log, begin, at, journal } = setup();
  begin();
  expect(svc.getStatus()).toEqual({ sourceLabel: LABEL, power: 'unknown', history: [] });
  at(0, 'on', { detail: 'на вході 229 В' });
  at(0.5, 'on', { detail: 'на вході 229 В' });
  expect(svc.getStatus()).toEqual({
    sourceLabel: LABEL, power: 'unknown', reason: CHECKING, observedAt: t(0.5), detail: 'на вході 229 В', history: [],
  });
  at(1, 'on', { detail: 'на вході 229 В' });
  expect(svc.getStatus()).toEqual({
    sourceLabel: LABEL, power: 'on', since: t(0), sinceApprox: false, observedAt: t(1), detail: 'на вході 229 В',
    history: [{ power: 'on', start: t(0) }],
  });
  // The first state ever known has nothing to be approximate against (ruling R4).
  expect(journal().transitions).toStrictEqual([{ at: t(0), power: 'on', approx: false }]);
  expect(log.info).toHaveBeenCalledWith(`actual: on since ${t(0)}`);
});

test('while a change from unknown is being confirmed the reason says so (ruling R15)', () => {
  const { svc, begin, at } = setup();
  begin();
  const cb = vi.fn();
  svc.onChange(cb);
  at(0, 'unknown', { reason: 'чекаю на дані від станції' });
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: 'чекаю на дані від станції' });
  at(1, 'off');
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: CHECKING });
  expect(cb).toHaveBeenCalledTimes(2);
  at(1.5, 'off');
  expect(cb).toHaveBeenCalledTimes(2);
  // Another reason outranks it, and the candidate is gone with it.
  at(1.75, 'unknown', { reason: 'станція не в мережі' });
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: 'станція не в мережі' });
  at(2, 'on');
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: CHECKING });
  at(3, 'on');
  expect(svc.getStatus()?.reason).toBeUndefined();
  // A change pending from a confirmed state shows that state, with no reason.
  at(4, 'off');
  expect(svc.getStatus()).toMatchObject({ power: 'on' });
  expect(svc.getStatus()?.reason).toBeUndefined();
});

test('a pending check is announced even when nothing else changed', () => {
  const { svc, begin, at } = setup();
  begin();
  const cb = vi.fn();
  svc.onChange(cb);
  at(0, 'on');
  expect(cb).toHaveBeenCalledTimes(1);
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: CHECKING });
});

test('a detail change alone is stored but not announced', () => {
  const { svc, begin, at } = setup();
  begin();
  at(0, 'on', { detail: 'на вході 229 В' });
  at(1, 'on', { detail: 'на вході 229 В' });
  const cb = vi.fn();
  svc.onChange(cb);
  at(1.5, 'on', { detail: 'на вході 230 В' });
  at(2, 'on', { detail: 'на вході 229 В' });
  at(2.5, 'on', { detail: 'на вході 231 В' });
  expect(cb).not.toHaveBeenCalled();
  expect(svc.getStatus()).toMatchObject({ power: 'on', detail: 'на вході 231 В', observedAt: t(2.5) });
});

test('blip shorter than 60 s is ignored', () => {
  const { svc, begin, at, journal } = setup();
  begin();
  for (let m = 0; m <= 4; m++) at(m, 'on');
  at(5, 'off');
  at(5 + 40 / 60, 'on');
  at(6 + 40 / 60, 'on');
  at(7, 'off'); // a new blip starts its own 60 s, not from the 5:00 one
  expect(journal().transitions.map(x => x.power)).toEqual(['on']);
  expect(svc.getStatus()).toMatchObject({ power: 'on', since: t(0) });
});

test('on → off transition timestamp is the first off reading; approx false when readings are continuous', () => {
  const { svc, log, begin, at, journal } = setup();
  begin();
  for (let m = 0; m <= 5; m += 0.5) at(m, 'on');
  at(5.5, 'off');
  at(6, 'off');
  expect(svc.getStatus()?.power).toBe('on');
  at(6.5, 'off');
  expect(journal().transitions).toStrictEqual([
    { at: t(0), power: 'on', approx: false },
    { at: t(5.5), power: 'off', approx: false, lastBefore: t(5) },
  ]);
  expect(svc.getStatus()).toMatchObject({ power: 'off', since: t(5.5), sinceApprox: false });
  expect(svc.getStatus()?.history).toEqual([{ power: 'on', start: t(0), end: t(5.5) }, { power: 'off', start: t(5.5) }]);
  expect(log.info).toHaveBeenCalledWith(`actual: off since ${t(5.5)}`);
});

test('a candidate re-created from a lagging observedAt needs 60 s of observed evidence (ruling R6)', () => {
  const { svc, begin, at, journal } = setup();
  begin();
  for (let m = 0; m <= 5; m += 0.5) at(m, 'on');
  const F = 5.5;
  at(F, 'off'); // one 0 V message
  at(F + 20 / 60, 'unknown', { reason: 'станція не в мережі' });
  at(F + 70 / 60, 'off', { observedAt: t(F) }); // back online, unchanged data re-emitted
  expect(svc.getStatus()?.power).toBe('unknown');
  expect(journal().transitions.map(x => x.power)).toEqual(['on', 'unknown']);
  at(F + 80 / 60, 'off');
  expect(svc.getStatus()).toMatchObject({ power: 'off', since: t(F) });
  expect(journal().transitions.at(-1)).toStrictEqual({ at: t(F), power: 'off', approx: false, lastBefore: t(5) });
});

test('repeated readings with the same old observedAt never confirm (ruling R6)', () => {
  const { svc, begin, at, journal } = setup();
  begin();
  for (let m = 0; m <= 5; m += 0.5) at(m, 'on');
  for (let m = 5.5; m <= 15; m += 0.5) at(m, 'off', { observedAt: t(5.5) });
  expect(svc.getStatus()?.power).toBe('on');
  expect(journal().transitions.map(x => x.power)).toEqual(['on']);
  at(16, 'off', { observedAt: t(5.5) }); // a static map decays to unknown, never to off
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: STALE });
  expect(journal().transitions.map(x => x.power)).toEqual(['on', 'unknown']);
});

test('unknown readings never create off', () => {
  const { svc, log, begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(1, 'on'); at(2, 'on');
  const cb = vi.fn();
  svc.onChange(cb);
  for (let i = 1; i <= 20; i++) at(2 + i * 1.5, 'unknown', { reason: 'станція не в мережі' });
  expect(journal().transitions).toStrictEqual([{ at: t(0), power: 'on', approx: false }, { at: t(2), power: 'unknown' }]);
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: 'станція не в мережі', observedAt: t(2) });
  expect(svc.getStatus()?.since).toBeUndefined();
  expect(cb).toHaveBeenCalledTimes(1); // the transition with its reason, not every unchanged reading
  expect(log.info.mock.calls.filter(([m]) => m === 'actual: unknown — станція не в мережі')).toHaveLength(1);
  expect(log.info).toHaveBeenCalledWith(`actual: unknown since ${t(2)}`);
});

test('stale data → unknown after 10 min via timer, gap starts at lastObservedAt', () => {
  const { svc, log, begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(1, 'on'); at(2, 'on');
  const cb = vi.fn();
  svc.onChange(cb);
  vi.advanceTimersByTime(10 * MIN); // check at 12:00 — exactly 10 min old is still fresh
  expect(svc.getStatus()?.power).toBe('on');
  expect(cb).not.toHaveBeenCalled();
  vi.advanceTimersByTime(CHECK_MS); // check at 12:30
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: STALE, observedAt: t(2) });
  expect(journal().transitions.at(-1)).toStrictEqual({ at: t(2), power: 'unknown' });
  expect(cb).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledWith(`actual: unknown — ${STALE}`);
});

test('a fresh-looking reading with old observedAt counts as stale', () => {
  const { svc, begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(1, 'on'); at(2, 'on');
  at(11, 'on', { observedAt: t(0) }); // before the timer would notice: the last fresh reading is only 9 min old
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', reason: STALE });
  expect(journal().transitions.at(-1)).toStrictEqual({ at: t(2), power: 'unknown' });
});

test.each(jumps)('sleep jump inserts gap before new state; different state gets approx (gap seen by %s)', (_, jump, afterJump) => {
  const { svc, begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(1, 'on'); at(2, 'on');
  jump(120 * MIN);
  expect(svc.getStatus()?.power).toBe(afterJump);
  at(122, 'off');
  at(123, 'off');
  expect(journal().transitions).toStrictEqual([
    { at: t(0), power: 'on', approx: false },
    { at: t(2), power: 'unknown' },
    { at: t(122), power: 'off', approx: true, lastBefore: t(2) },
  ]);
  expect(svc.getStatus()).toMatchObject({ power: 'off', since: t(122), sinceApprox: true });
});

test.each(jumps)('a pending change does not survive a gap (gap seen by %s)', (_, jump, afterJump) => {
  const { svc, begin, at, journal } = setup();
  begin();
  for (let m = 0; m <= 4.5; m += 0.5) at(m, 'on');
  at(5, 'off');
  jump(55 * MIN);
  expect(svc.getStatus()?.power).toBe(afterJump);
  at(60, 'off');
  expect(svc.getStatus()?.power).toBe('unknown'); // the 5:00 reading does not count towards the 60 s
  at(61, 'off');
  expect(journal().transitions).toStrictEqual([
    { at: t(0), power: 'on', approx: false },
    { at: t(5), power: 'unknown' },
    { at: t(60), power: 'off', approx: true, lastBefore: t(4.5) },
  ]);
});

test('same state after a gap: since keeps the earlier start', () => {
  const { svc, begin, at, journal } = setup();
  begin();
  at(0, 'off'); at(1, 'off'); at(2, 'off');
  vi.advanceTimersByTime(30 * MIN);
  expect(svc.getStatus()?.power).toBe('unknown');
  at(40, 'off'); at(41, 'off');
  expect(journal().transitions.map(x => [x.at, x.power])).toEqual([[t(0), 'off'], [t(2), 'unknown'], [t(40), 'off']]);
  expect(svc.getStatus()).toMatchObject({ power: 'off', since: t(0), sinceApprox: false });
  vi.advanceTimersByTime(30 * MIN);
  at(80, 'off'); at(81, 'off');
  expect(svc.getStatus()).toMatchObject({ power: 'off', since: t(0), sinceApprox: false });
});

test('restart inserts gap from lastObservedAt', () => {
  const { svc, begin, at, journal } = setup({ transitions: [{ at: t(0), power: 'off' }], lastObservedAt: t(30) });
  vi.setSystemTime(ms(90));
  begin();
  expect(journal().transitions).toStrictEqual([{ at: t(0), power: 'off' }, { at: t(30), power: 'unknown' }]);
  expect(svc.getStatus()).toMatchObject({ power: 'unknown', observedAt: t(30) });
  // The saved lastObservedAt is the "before" side of the next change.
  at(90, 'off'); at(91, 'off');
  expect(journal().transitions.at(-1)).toStrictEqual({ at: t(90), power: 'off', approx: true, lastBefore: t(30) });
  expect(svc.getStatus()).toMatchObject({ power: 'off', since: t(0) });
});

test('restart after a closed journal adds nothing', () => {
  const initial: HistoryData = { transitions: [{ at: t(0), power: 'on' }, { at: t(30), power: 'unknown' }], lastObservedAt: t(30) };
  const { begin, journal } = setup(initial);
  begin();
  expect(journal()).toStrictEqual(initial);
});

test('prunes transitions older than 30 days but keeps the last one before the cutoff', () => {
  const old: Transition[] = [
    { at: d(-40), power: 'on' }, { at: d(-35), power: 'off' }, { at: d(-31), power: 'on' }, { at: d(-20), power: 'unknown' },
  ];
  expect(pruneTransitions(old, base, KEEP_MS)).toEqual(old.slice(2));
  expect(pruneTransitions(old.slice(0, 2), base, KEEP_MS)).toEqual([old[1]]);
  expect(pruneTransitions([], base, KEEP_MS)).toEqual([]);
  const { begin, at, journal } = setup({ transitions: old, lastObservedAt: d(-20) });
  begin();
  at(0, 'on'); at(1, 'on');
  expect(journal().transitions).toStrictEqual([...old.slice(2), { at: t(0), power: 'on', approx: true, lastBefore: d(-20) }]);
});

test('a journal with malformed entries reads as its valid entries only; the service starts on it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'bw-hist-')), 'actual-history.json');
  const valid: Transition[] = [
    { at: t(0), power: 'on', approx: false }, { at: t(5), power: 'off', approx: true, lastBefore: t(1) }, { at: t(8), power: 'unknown' },
  ];
  writeFileSync(file, JSON.stringify({
    transitions: [
      null, valid[0], {}, { at: 5, power: 'on' }, { at: 'x', power: 'on' }, { at: t(3), power: 'maybe' }, 'on', [t(3), 'on'],
      valid[1], { at: t(6), power: 'on', approx: 'yes' }, { at: t(7), power: 'on', lastBefore: 7 }, valid[2],
    ],
    lastObservedAt: 12345,
  }));
  expect(new HistoryStore(file).read()).toStrictEqual({ transitions: valid });
  writeFileSync(file, JSON.stringify({ transitions: [null, { at: t(0), power: 'off' }, { at: 'x', power: 'on' }], lastObservedAt: t(2) }));
  const svc = new ActualStateService({ history: new HistoryStore(file), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  running.push(svc);
  vi.setSystemTime(ms(5));
  svc.start(fakeSource().source, LABEL);
  expect(svc.getStatus()).toEqual({
    sourceLabel: LABEL, power: 'unknown', observedAt: t(2),
    history: [{ power: 'off', start: t(0), end: t(2) }, { power: 'unknown', start: t(2) }],
  });
});

test('safeActualStatus: a throwing getStatus gives null and logs once per distinct message', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const status: ActualStatus = { sourceLabel: LABEL, power: 'on', history: [] };
  const results: (Error | ActualStatus)[] =[new TypeError('a'), new TypeError('a'), new Error('b'), new Error('b'), status, new TypeError('a')];
  const get = safeActualStatus(() => {
    const r = results.shift()!;
    if (r instanceof Error) throw r;
    return r;
  }, log);
  expect([get(), get(), get(), get()]).toEqual([null, null, null, null]);
  expect(log.error.mock.calls).toEqual([
    ['actual: could not compose the status', expect.objectContaining({ message: 'a' })],
    ['actual: could not compose the status', expect.objectContaining({ message: 'b' })],
  ]);
  expect(get()).toBe(status);
  expect(get()).toBeNull(); // a recurrence after a good call is news again
  expect(log.error).toHaveBeenCalledTimes(3);
});

test('history in status covers 7 days, last segment open', () => {
  const { svc, begin, at } = setup({
    transitions: [
      { at: d(-9), power: 'off' }, { at: d(-8), power: 'on' },
      { at: d(-3), power: 'off', approx: true, lastBefore: t(-3 * 1440 - 30) }, { at: d(-2), power: 'unknown' },
    ],
    lastObservedAt: d(-2),
  });
  begin();
  at(0, 'on'); at(1, 'on');
  expect(svc.getStatus()?.history).toEqual([
    { power: 'on', start: t(1 - 7 * 1440), end: d(-3) },
    { power: 'off', start: d(-3), end: d(-2), startApprox: true },
    { power: 'unknown', start: d(-2), end: t(0) },
    { power: 'on', start: t(0), startApprox: true },
  ]);
  // Adjacent transitions of the same power form one segment.
  const same: Transition[] = [{ at: t(0), power: 'on' }, { at: t(10), power: 'on', approx: true }, { at: t(20), power: 'off' }];
  expect(buildSegments(same, ms(30), ms(-60))).toEqual([{ power: 'on', start: t(0), end: t(20) }, { power: 'off', start: t(20) }]);
});

test('lastObservedAt is saved at most once a minute', () => {
  const { begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(0.5, 'on'); at(1, 'on');
  at(1.5, 'on');
  expect(journal().lastObservedAt).toBe(t(1));
  at(2, 'on');
  expect(journal().lastObservedAt).toBe(t(2));
});

test('stop() records gap and getStatus() is null', () => {
  const { svc, source, begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(1, 'on'); at(2, 'on');
  vi.advanceTimersByTime(MIN);
  const cb = vi.fn();
  svc.onChange(cb);
  svc.stop();
  expect(source.stop).toHaveBeenCalledTimes(1);
  expect(svc.getStatus()).toBeNull();
  expect(cb).toHaveBeenCalledTimes(1);
  expect(journal()).toStrictEqual({ transitions: [{ at: t(0), power: 'on', approx: false }, { at: t(2), power: 'unknown' }], lastObservedAt: t(2) });
  // A late reading from the stopped source and later timer ticks change nothing.
  at(4, 'off');
  vi.advanceTimersByTime(60 * MIN);
  expect(svc.getStatus()).toBeNull();
  expect(journal().transitions).toHaveLength(2);
  svc.stop();
  expect(source.stop).toHaveBeenCalledTimes(1);
});

test('start() stops the previous source', () => {
  const { svc, source, begin, at, journal } = setup();
  begin();
  at(0, 'on'); at(1, 'on');
  const next = fakeSource();
  svc.start(next.source, 'EcoFlow · Delta 2');
  expect(source.stop).toHaveBeenCalledTimes(1);
  expect(journal().transitions.at(-1)).toStrictEqual({ at: t(1), power: 'unknown' });
  expect(svc.getStatus()).toMatchObject({ sourceLabel: 'EcoFlow · Delta 2', power: 'unknown' });
  at(2, 'off'); // from the old source
  expect(svc.getStatus()?.observedAt).toBe(t(1));
});

test('listener throwing does not break others', () => {
  const { svc, log, begin, at } = setup();
  begin();
  const good = vi.fn();
  svc.onChange(() => { throw new Error('boom'); });
  const unsubscribe = svc.onChange(good);
  at(0, 'on', { detail: 'на вході 229 В' });
  expect(good).toHaveBeenCalledTimes(1);
  expect(log.error).toHaveBeenCalledWith('ActualStateService listener failed', expect.any(Error));
  at(0.5, 'on', { detail: 'на вході 229 В' });
  expect(good).toHaveBeenCalledTimes(1);
  unsubscribe();
  at(1, 'on', { detail: 'на вході 230 В' });
  expect(good).toHaveBeenCalledTimes(1);
});
