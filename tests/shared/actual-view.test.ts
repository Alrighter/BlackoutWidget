import { dayStrip, recentOutages, formatOutage, outageParts, sinceText, type ActualOutage } from '../../src/shared/actual-view';
import type { ActualPower, ActualSegment } from '../../src/shared/types';
// Kyiv time on 2026-10-17 is UTC+3.
const seg = (power: ActualPower, start: string, end?: string, startApprox?: boolean): ActualSegment =>
  ({ power, start, ...(end ? { end } : {}), ...(startApprox ? { startApprox } : {}) });
const at = (iso: string) => new Date(iso);

test('dayStrip clips to the Kyiv day and to now', () => {
  const h = [seg('on', '2026-10-16T20:00:00Z', '2026-10-17T08:30:00Z'), seg('off', '2026-10-17T08:30:00Z')];
  expect(dayStrip(h, '2026-10-17', at('2026-10-17T10:00:00Z'))).toEqual([
    { startMin: 0, endMin: 690, power: 'on' }, { startMin: 690, endMin: 780, power: 'off' },
  ]);
});
test('dayStrip: a past day ends at 1440; future, zero-width and unparseable parts are dropped', () => {
  const h = [
    seg('on', '2026-10-16T08:00:00Z', '2026-10-16T10:00:00Z'),
    seg('off', '2026-10-16T10:00:00Z', '2026-10-17T05:00:00Z'),
    seg('on', '2026-10-17T05:00:00Z', '2026-10-17T05:00:00Z'),
    seg('on', 'garbage', 'x'),
    seg('off', '2026-10-17T05:00:00Z'),
  ];
  const now = at('2026-10-17T10:00:00Z');
  expect(dayStrip(h, '2026-10-16', now)).toEqual([
    { startMin: 660, endMin: 780, power: 'on' }, { startMin: 780, endMin: 1440, power: 'off' },
  ]);
  expect(dayStrip(h, '2026-10-17', now)).toEqual([
    { startMin: 0, endMin: 480, power: 'off' }, { startMin: 480, endMin: 780, power: 'off' },
  ]);
  expect(dayStrip(h, '2026-10-18', now)).toEqual([]);
});

test('recentOutages merges off–gap–off and marks approx ends', () => {
  const h = [
    seg('on', '2026-10-16T06:00:00Z', '2026-10-16T07:00:00Z'),
    seg('off', '2026-10-16T07:00:00Z', '2026-10-16T08:00:00Z'),
    seg('unknown', '2026-10-16T08:00:00Z', '2026-10-16T09:00:00Z'),
    seg('off', '2026-10-16T09:00:00Z', '2026-10-16T10:00:00Z', true),
    seg('on', '2026-10-16T10:00:00Z', '2026-10-16T11:00:00Z'),
    seg('off', '2026-10-16T11:00:00Z', '2026-10-16T11:30:00Z'),
    seg('unknown', '2026-10-16T11:30:00Z', '2026-10-16T12:00:00Z'),
    seg('on', '2026-10-16T12:00:00Z', '2026-10-16T13:00:00Z', true),
    seg('off', '2026-10-16T13:00:00Z', '2026-10-16T13:00:00Z'),
    seg('on', '2026-10-16T13:00:00Z', '2026-10-16T14:00:00Z'),
    seg('off', '2026-10-16T14:00:00Z', '2026-10-16T15:00:00Z', true),
    seg('unknown', 'bad', 'bad'),
    seg('on', '2026-10-16T15:00:00Z', '2026-10-16T16:00:00Z'),
    seg('off', '2026-10-16T16:00:00Z', '2026-10-16T17:00:00Z'),
    seg('unknown', '2026-10-16T17:00:00Z'),
  ];
  expect(recentOutages(h, at('2026-10-17T00:00:00Z'))).toEqual([
    { start: '2026-10-16T16:00:00Z', startApprox: false, endApprox: false, ongoing: false },
    { start: '2026-10-16T14:00:00Z', end: '2026-10-16T15:00:00Z', startApprox: true, endApprox: false, ongoing: false },
    { start: '2026-10-16T11:00:00Z', end: '2026-10-16T12:00:00Z', startApprox: false, endApprox: true, ongoing: false },
    { start: '2026-10-16T07:00:00Z', end: '2026-10-16T10:00:00Z', startApprox: false, endApprox: false, ongoing: false },
  ]);
});
test('recentOutages: last off segment is ongoing; off–gap–off at the end is ongoing too', () => {
  const now = at('2026-10-17T07:00:00Z');
  const open = [seg('on', '2026-10-17T05:00:00Z', '2026-10-17T06:00:00Z'), seg('off', '2026-10-17T06:00:00Z')];
  expect(recentOutages(open, now)).toEqual([{ start: '2026-10-17T06:00:00Z', startApprox: false, endApprox: false, ongoing: true }]);
  const rejoined = [seg('off', '2026-10-17T05:00:00Z', '2026-10-17T05:30:00Z'), seg('unknown', '2026-10-17T05:30:00Z', '2026-10-17T06:00:00Z'),
    seg('off', '2026-10-17T06:00:00Z', undefined, true)];
  expect(recentOutages(rejoined, now)).toEqual([{ start: '2026-10-17T05:00:00Z', startApprox: false, endApprox: false, ongoing: true }]);
  expect(recentOutages([], now)).toEqual([]);
});

test('formatOutage variants', () => {
  const now = at('2026-10-17T14:00:00Z');
  const base: ActualOutage = { start: '2026-10-17T11:32:00Z', end: '2026-10-17T13:05:00Z', startApprox: false, endApprox: false, ongoing: false };
  expect(formatOutage(base, now)).toBe('17.10 · 14:32–16:05 · 1 год 33 хв');
  expect(formatOutage({ ...base, startApprox: true }, now)).toBe('17.10 · ≈14:32–16:05 · 1 год 33 хв');
  expect(formatOutage({ ...base, endApprox: true }, now)).toBe('17.10 · 14:32–≈16:05 · 1 год 33 хв');
  expect(formatOutage({ start: base.start, startApprox: false, endApprox: false, ongoing: true }, at('2026-10-17T13:37:00Z')))
    .toBe('17.10 · з 14:32 · триває 2 год 5 хв');
  expect(formatOutage({ start: base.start, startApprox: false, endApprox: false, ongoing: false }, now))
    .toBe('17.10 · з 14:32 · кінець невідомий');
});

test('outageParts: date, range and duration apart; ongoing marks a live outage', () => {
  const now = at('2026-10-17T14:00:00Z');
  const base: ActualOutage = { start: '2026-10-17T11:32:00Z', end: '2026-10-17T13:05:00Z', startApprox: false, endApprox: true, ongoing: false };
  expect(outageParts(base, now)).toEqual({ date: '17.10', range: '14:32–≈16:05', duration: '1 год 33 хв', live: false });
  expect(outageParts({ start: base.start, startApprox: true, endApprox: false, ongoing: true }, at('2026-10-17T13:37:00Z')))
    .toEqual({ date: '17.10', range: 'з ≈14:32', duration: 'триває 2 год 5 хв', live: true });
  expect(outageParts({ start: base.start, startApprox: false, endApprox: false, ongoing: false }, now))
    .toEqual({ date: '17.10', range: 'з 14:32', duration: 'кінець невідомий', live: false });
});

test('sinceText same day / other day / approx', () => {
  const now = at('2026-10-17T10:00:00Z');
  expect(sinceText('2026-10-17T09:32:00Z', false, now)).toBe('з 12:32');
  expect(sinceText('2026-10-17T09:32:00Z', true, now)).toBe('з ≈12:32');
  expect(sinceText('2026-10-16T20:10:00Z', false, now)).toBe('з 16.10 23:10');
  expect(sinceText('2026-10-16T20:10:00Z', true, now)).toBe('з 16.10 ≈23:10');
  expect(sinceText('garbage', false, now)).toBe('');
});
