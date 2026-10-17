import { computeWidgetView, slotRuns, formatDurationLong, formatDurationShort } from '../../src/shared/widget-state';
import { fixtureSnapshot } from '../helpers/snapshot';
const at = (iso: string) => new Date(iso);
const allOn = (date: string) => ({ date, slots: Array(48).fill('on') });

test('11:50 Kyiv: light on, outage at 15:00', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-17T08:50:00Z'));
  expect(v.state).toBe('on'); expect(v.title).toBe('Світло є');
  expect(v.nextText).toBe('Вимкнення о 15:00 · через 3 год 10 хв');
  expect(v.countdownShort).toBe('3:10'); expect(v.countdownCaption).toBe('до вимкнення о 15:00');
  expect(v.lineLabel).toBe('Лінія 1 · черга 1.2'); expect(v.updatedText).toBe('оновлено 11:48');
  expect(v.stale).toBe(false); expect(v.tomorrow).toBeNull();
});
test('08:10: off until 08:30 ("first" half hour)', () =>
  expect(computeWidgetView(fixtureSnapshot(), at('2026-10-17T05:10:00Z')).nextText).toBe('Увімкнуть о 08:30 · через 20 хв'));
test('16:00: off until 19:00', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-17T13:00:00Z'));
  expect(v.title).toBe('Світла немає'); expect(v.nextText).toBe('Увімкнуть о 19:00 · через 3 год');
});
test('20:00 without tomorrow: no more changes', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-17T17:00:00Z'));
  expect(v.nextText).toBe('Без змін до кінця графіка'); expect(v.countdownShort).toBeUndefined();
});
test('20:00 with tomorrow: change tomorrow at 06:00', () => {
  const tmr = allOn('2026-10-18'); tmr.slots[12] = 'off';
  const v = computeWidgetView(fixtureSnapshot({ extraDays: [tmr] }), at('2026-10-17T17:00:00Z'));
  expect(v.nextText).toBe('Вимкнення завтра о 06:00 · через 10 год');
});
test('next day after sleep: yesterday-only snapshot → no data', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-18T07:00:00Z'));
  expect(v.state).toBe('unknown'); expect(v.nextText).toBe('Графік на сьогодні ще не отримано');
});
test('next day after sleep: former tomorrow becomes today', () => {
  const v = computeWidgetView(fixtureSnapshot({ extraDays: [allOn('2026-10-18')] }), at('2026-10-18T07:00:00Z'));
  expect(v.state).toBe('on'); expect(v.todayKey).toBe('2026-10-18');
});
test('DST day countdown (2026-10-25, UTC+2 after 04:00)', () => {
  const d = allOn('2026-10-25'); d.slots[30] = 'off';             // 15:00
  const v = computeWidgetView(fixtureSnapshot({ extraDays: [d] }), at('2026-10-25T10:00:00Z')); // 12:00 Kyiv
  expect(v.nextText).toBe('Вимкнення о 15:00 · через 3 год');
});
test('maybe-off target', () => {
  const d = allOn('2026-10-17'); d.slots[30] = 'maybe-off';
  const s = { ...fixtureSnapshot(), days: [d] };
  expect(computeWidgetView(s, at('2026-10-17T08:50:00Z')).nextText).toBe('Можливе вимкнення о 15:00 · через 3 год 10 хв');
});
test('emergency overrides schedule', () => {
  const s = fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення', end: '17:00 17.10.2026' } });
  const v = computeWidgetView(s, at('2026-10-17T08:50:00Z'));
  expect(v.state).toBe('emergency'); expect(v.title).toBe('Світла немає'); expect(v.outageBadge).toBe('Аварійне');
  expect(v.nextText).toBe('Аварійне · орієнтовно до 17:00');
  expect(v.countdownCaption).toBe('до орієнтовного увімкнення');
  const noEnd = computeWidgetView(fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Екстрене відключення' } }), at('2026-10-17T08:50:00Z'));
  expect(noEnd.outageBadge).toBe('Екстрене'); expect(noEnd.nextText).toBe('Екстрене відключення · час відновлення невідомий');
});
test('stale after 45 min', () => {
  expect(computeWidgetView(fixtureSnapshot(), at('2026-10-17T09:34:00Z')).stale).toBe(true);   // 46 хв
  expect(computeWidgetView(fixtureSnapshot(), at('2026-10-17T09:32:00Z')).stale).toBe(false);  // 44 хв
});
test('slotRuns GPV1.2', () =>
  expect(slotRuns(fixtureSnapshot().days[0].slots)).toEqual([
    { start: 0, end: 12, slot: 'on' }, { start: 12, end: 17, slot: 'off' }, { start: 17, end: 30, slot: 'on' },
    { start: 30, end: 38, slot: 'off' }, { start: 38, end: 48, slot: 'on' }]));
test('duration formats', () => {
  expect(formatDurationLong(190)).toBe('3 год 10 хв'); expect(formatDurationLong(45)).toBe('45 хв'); expect(formatDurationLong(60)).toBe('1 год');
  expect(formatDurationShort(190)).toBe('3:10'); expect(formatDurationShort(45)).toBe('0:45');
});
