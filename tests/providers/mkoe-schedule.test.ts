// SYNTHETIC-schedule-active-shape.json is HAND-BUILT, not a real response: no day with outages has been seen live from
// off.energy.mk.ua (the API keeps no history). It follows the shape the site's own app.js and three independent clients
// read (mykolaiv.md §1.2). Everything else here is the real answer of 20.10.2026, or a variant made in the test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MkoeShapeError, mkoeDay } from '../../src/main/providers/mkoe/schedule';
import type { Slot } from '../../src/shared/types';

const fx = (n: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'mkoe', n), 'utf8');
const SYNTHETIC = JSON.parse(fx('SYNTHETIC-schedule-active-shape.json'));
const QUIET = JSON.parse(fx('schedule-active-2026-10-20.json'));
const TIME_SERIES = JSON.parse(fx('time-series-2026-10-20.json'));
const QUEUES = JSON.parse(fx('queues-type3-2026-10-20.json'));

const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
const slotsWith = (marks: Record<number, Slot>): Slot[] => fill('on').map((s, i) => marks[i] ?? s);

/** One schedule row of the API's shape for the Kyiv day starting at `from`. */
const row = (from: string, series: unknown[] | undefined, extra: Record<string, unknown> = {}) => ({
  id: 900, from, to: from, ...(series === undefined ? {} : { series }), ...extra,
});
/** One series entry: queue id, slot id (1-48), type. */
const entry = (queue: number, slot: number, type: string, updated_at = '2026-10-19T18:05:12.000000Z') => ({
  id: 1, outage_schedule_id: 900, time_series_id: slot, outage_queue_id: queue, created_at: updated_at, updated_at, type,
});
const OCT20 = '2026-10-19T21:00:00.000000Z';
const day = (active: unknown, date = '2026-10-20', queue = '2.2') => mkoeDay(active, TIME_SERIES, QUEUES, date, queue);

describe('mkoeDay', () => {
  it('queue 2.2 (id 17) on 20.10 is off and maybe-off in the fixture\'s slots and on elsewhere', () => {
    expect(day(SYNTHETIC)).toEqual({
      // Slots 21-22 OFF, 23-24 PROBABLY_OFF, 29 SURE_OFF; indexes are time_series_id - 1.
      slots: slotsWith({ 20: 'off', 21: 'off', 22: 'maybe-off', 23: 'maybe-off', 28: 'off' }),
      // The newest series updated_at of the day's rows, 19:40:03Z, is 22:40 in Kyiv (UTC+3 before 25.10).
      updatedAt: '22:40 19.10.2026',
    });
  });

  it('buckets rows by the Kyiv date of `from`: 21.10 starts at 21:00Z on 20.10', () => {
    expect(day(SYNTHETIC, '2026-10-21')).toEqual({
      slots: slotsWith({ 0: 'off', 1: 'off', 2: 'off', 3: 'off' }),
      updatedAt: '22:40 19.10.2026',
    });
    expect(day(SYNTHETIC, '2026-10-20', '1.1')?.slots).toEqual(slotsWith({ 36: 'off', 37: 'off', 38: 'off', 39: 'off' }));
  });

  it('PROBABLY_OFF gives maybe-off; OFF and SURE_OFF give off', () => {
    const active = [row(OCT20, [entry(17, 1, 'PROBABLY_OFF'), entry(17, 2, 'OFF'), entry(17, 3, 'SURE_OFF')])];
    expect(day(active)?.slots).toEqual(slotsWith({ 0: 'maybe-off', 1: 'off', 2: 'off' }));
  });

  it('an OFF and a PROBABLY_OFF on the same slot give off, in either order and across rows of the day', () => {
    const a = [entry(17, 5, 'OFF'), entry(17, 5, 'PROBABLY_OFF')];
    for (const series of [a, [...a].reverse()]) {
      expect(day([row(OCT20, series)])?.slots).toEqual(slotsWith({ 4: 'off' }));
    }
    const twoRows = [row(OCT20, [entry(17, 5, 'PROBABLY_OFF')]), row(OCT20, [entry(17, 5, 'SURE_OFF'), entry(17, 6, 'PROBABLY_OFF')])];
    expect(day(twoRows)?.slots).toEqual(slotsWith({ 4: 'off', 5: 'maybe-off' }));
  });

  it('a date with rows but none for 1.1 gives 1.1 all on, not undefined (Review Focus 6)', () => {
    expect(day(SYNTHETIC, '2026-10-21', '1.1')).toEqual({ slots: fill('on'), updatedAt: '22:40 19.10.2026' });
  });

  it('a row without series, or with an empty one, is a day with every queue on', () => {
    expect(day([row(OCT20, undefined)])).toEqual({ slots: fill('on') });
    expect(day([row(OCT20, [])])).toEqual({ slots: fill('on') });
  });

  it('the type «MAYBE» throws, also on another queue and another day', () => {
    expect(() => day([row(OCT20, [entry(17, 1, 'MAYBE')])])).toThrow(MkoeShapeError);
    expect(() => day([row(OCT20, [entry(14, 1, 'MAYBE')])])).toThrow(MkoeShapeError);
    expect(() => day([row('2026-10-22T21:00:00Z', [entry(14, 1, 'MAYBE')])])).toThrow(MkoeShapeError);
    for (const type of ['ON', 'ENABLE', 'off', '', null, 3]) {
      expect(() => day([row(OCT20, [entry(17, 1, type as string)])])).toThrow(MkoeShapeError);
    }
  });

  it('time_series_id 49 throws, as does 0 or a non-integer', () => {
    for (const slot of [49, 0, 1.5, '21', null]) {
      expect(() => day([row(OCT20, [entry(17, slot as number, 'OFF')])])).toThrow(MkoeShapeError);
    }
  });

  it('a series entry that is not an object, or without a numeric queue id, throws', () => {
    expect(() => day([row(OCT20, ['OFF'])])).toThrow(MkoeShapeError);
    expect(() => day([row(OCT20, [{ ...entry(17, 1, 'OFF'), outage_queue_id: '17' }])])).toThrow(MkoeShapeError);
  });

  it('a 47-row time series throws, as do 48 rows whose ids are not 1-48', () => {
    expect(() => mkoeDay(SYNTHETIC, TIME_SERIES.slice(0, 47), QUEUES, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    const shifted = TIME_SERIES.map((r: { id: number }) => ({ ...r, id: r.id + 1 }));
    expect(() => mkoeDay(SYNTHETIC, shifted, QUEUES, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    const repeated = TIME_SERIES.map((r: { id: number }) => ({ ...r, id: r.id === 48 ? 47 : r.id }));
    expect(() => mkoeDay(SYNTHETIC, repeated, QUEUES, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    expect(() => mkoeDay(SYNTHETIC, {}, QUEUES, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
  });

  it('by-type/3 without 6.2 throws; a deleted 6.2 does not count', () => {
    const without = QUEUES.filter((q: { name: string }) => q.name !== '6.2');
    expect(() => mkoeDay(SYNTHETIC, TIME_SERIES, without, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    const deleted = QUEUES.map((q: { name: string }) => (q.name === '6.2' ? { ...q, deleted: 1 } : q));
    expect(() => mkoeDay(SYNTHETIC, TIME_SERIES, deleted, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    expect(() => mkoeDay(SYNTHETIC, TIME_SERIES, {}, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
  });

  it('a queue name twice among the live rows throws; a deleted twin is ignored', () => {
    const twin = { ...QUEUES[3], id: 99 };
    expect(() => mkoeDay(SYNTHETIC, TIME_SERIES, [...QUEUES, twin], '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    expect(day(SYNTHETIC)).toEqual(mkoeDay(SYNTHETIC, TIME_SERIES, [...QUEUES, { ...twin, deleted: 1 }], '2026-10-20', '2.2'));
  });

  it('the queue is found by name: a name by-type/3 does not have throws', () => {
    expect(() => day(SYNTHETIC, '2026-10-20', '7.1')).toThrow(MkoeShapeError);
    expect(() => day(QUIET, '2026-10-20', '7.1')).toThrow(MkoeShapeError);
  });

  it('active as {} throws, as does a row without a `from` instant or with a series that is not an array', () => {
    expect(() => day({})).toThrow(MkoeShapeError);
    expect(() => day(null)).toThrow(MkoeShapeError);
    expect(() => day([{ id: 1, series: [] }])).toThrow(MkoeShapeError);
    expect(() => day([row('not a date', [])])).toThrow(MkoeShapeError);
    // A wall time without Z or an offset would be read in the machine's zone: not trusted.
    expect(() => day([row('2026-10-20 00:00:00', [])])).toThrow(MkoeShapeError);
    expect(() => day([row(OCT20, {} as unknown[])])).toThrow(MkoeShapeError);
    expect(() => day([row(OCT20, null as unknown as unknown[])])).toThrow(MkoeShapeError);
    expect(() => day(['row'])).toThrow(MkoeShapeError);
  });

  it('the real [] of 20.10 gives undefined for today, once the dictionaries check out', () => {
    expect(day(QUIET)).toBeUndefined();
    expect(day(SYNTHETIC, '2026-10-22')).toBeUndefined();
    // A quiet answer never short-circuits the dictionary checks.
    expect(() => mkoeDay(QUIET, TIME_SERIES.slice(1), QUEUES, '2026-10-20', '2.2')).toThrow(MkoeShapeError);
    expect(() => mkoeDay(QUIET, TIME_SERIES, QUEUES.slice(1), '2026-10-20', '2.2')).toThrow(MkoeShapeError);
  });

  it('updatedAt is the newest series updated_at of the day\'s rows, whatever the queue', () => {
    const active = [row(OCT20, [entry(17, 1, 'OFF', '2026-10-20T05:00:00Z'), entry(14, 2, 'OFF', '2026-10-20T09:15:30.000000Z')])];
    expect(day(active)?.updatedAt).toBe('12:15 20.10.2026');
    // Another day's rows do not count.
    const other = [...active, row('2026-10-20T21:00:00Z', [entry(17, 1, 'OFF', '2026-10-20T15:00:00Z')])];
    expect(day(other)?.updatedAt).toBe('12:15 20.10.2026');
  });
});
