import { computeWidgetView, slotRuns, formatDurationLong, formatDurationShort, STALE_AFTER_MIN } from '../../src/shared/widget-state';
import { fixtureSnapshot } from '../helpers/snapshot';
import type { ActualStatus, CurrentOutage, DaySchedule, Slot } from '../../src/shared/types';
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
test('the line label lower-cases only the first letter of the queue label', () => {
  const snap = { ...fixtureSnapshot({ lineIndex: 2 }), groupLabel: 'Не залучено до ГПВ' };
  expect(computeWidgetView(snap, at('2026-10-17T08:50:00Z')).lineLabel).toBe('Лінія 2 · не залучено до ГПВ');
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
describe('maybe-off now: the mockup copy, «можливо до HH:MM»', () => {
  // A day with the given half hours set to `slot`.
  const day = (date: string, slot: Slot, from: number, to: number, base: DaySchedule = allOn(date)): DaySchedule => {
    for (let i = from; i < to; i++) base.slots[i] = slot;
    return base;
  };
  const view = (days: DaySchedule[], iso: string) => computeWidgetView({ ...fixtureSnapshot(), days }, at(iso));

  test('the maybe slot ends at midnight: «24:00», not «завтра о 00:00»', () => {
    const v = view([day('2026-10-17', 'maybe-off', 44, 48), allOn('2026-10-18')], '2026-10-17T19:20:00Z'); // 22:20 Kyiv
    expect(v.state).toBe('maybe-off'); expect(v.title).toBe('Можливе відключення');
    expect(v.nextText).toBe('Можливо без світла до 24:00 · ще 1 год 40 хв');
    expect(v.countdownShort).toBe('1:40'); expect(v.countdownCaption).toBe('можливо до 24:00');
  });
  test('the maybe slot ends today', () => {
    const v = view([day('2026-10-17', 'maybe-off', 30, 34)], '2026-10-17T12:20:00Z'); // 15:20 Kyiv
    expect(v.nextText).toBe('Можливо без світла до 17:00 · ще 1 год 40 хв');
    expect(v.countdownCaption).toBe('можливо до 17:00');
  });
  test('the maybe slot runs past midnight: the line says «завтра», the caption does not', () => {
    const v = view([day('2026-10-17', 'maybe-off', 44, 48), day('2026-10-18', 'maybe-off', 0, 4)], '2026-10-17T19:20:00Z');
    expect(v.nextText).toBe('Можливо без світла до завтра 02:00 · ще 3 год 40 хв');
    expect(v.countdownShort).toBe('3:40'); expect(v.countdownCaption).toBe('можливо до 02:00');
  });
  test('a sure outage after the maybe slot keeps its own copy', () => {
    const v = view([day('2026-10-17', 'off', 32, 36, day('2026-10-17', 'maybe-off', 30, 32))], '2026-10-17T12:20:00Z');
    expect(v.state).toBe('maybe-off');
    expect(v.nextText).toBe('Вимкнення о 16:00 · через 40 хв'); expect(v.countdownCaption).toBe('до вимкнення о 16:00');
  });
  test('«24:00» is for the maybe copy only', () => {
    const v = view([allOn('2026-10-17'), day('2026-10-18', 'off', 0, 2)], '2026-10-17T19:20:00Z');
    expect(v.nextText).toBe('Вимкнення завтра о 00:00 · через 1 год 40 хв'); expect(v.countdownCaption).toBe('до вимкнення о 00:00');
  });
});
test('emergency overrides schedule', () => {
  const s = fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення', end: '17:00 17.10.2026' } });
  const v = computeWidgetView(s, at('2026-10-17T08:50:00Z'));
  expect(v.state).toBe('emergency'); expect(v.title).toBe('Світла немає'); expect(v.outageBadge).toBe('Аварійне');
  expect(v.nextText).toBe('Аварійне · орієнтовно до 17:00');
  expect(v.countdownCaption).toBe('орієнтовно до 17:00');
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

// Fixture: fetchedAt 11:48 Kyiv; at 11:50 the schedule says «Світло є» until 15:00.
const NOW = at('2026-10-17T08:50:00Z');
const withOutage = (o: CurrentOutage, fetchedAt?: string) =>
  computeWidgetView(fixtureSnapshot({ currentOutage: o, ...(fetchedAt ? { fetchedAt } : {}) }), NOW);
test('a planned outage at the house overrides like an emergency, with the «Планове» badge', () => {
  const planned: CurrentOutage = { kind: 'planned', text: 'Планові ремонтні роботи', start: '20.10.2026 09:36', end: '20.10.2026 19:00' };
  const snap = fixtureSnapshot({ currentOutage: planned, fetchedAt: '2026-10-20T06:50:00.000Z' });
  const v = computeWidgetView(snap, at('2026-10-20T07:00:00Z')); // 10:00 Kyiv
  expect(v.state).toBe('emergency'); expect(v.title).toBe('Світла немає'); expect(v.outageBadge).toBe('Планове');
  expect(computeWidgetView(snap, at('2026-10-20T16:30:00Z')).outageBadge).toBeUndefined(); // 19:30 Kyiv: it has ended
});
test('emergency that has not started yet → schedule state', () => {
  const v = withOutage({ kind: 'emergency', text: 'Аварійне відключення', start: '13:00 17.10.2026', end: '17:00 17.10.2026' });
  expect(v.state).toBe('on'); expect(v.outageBadge).toBeUndefined();
});
test('emergency that already started (or has an unreadable start) overrides', () => {
  expect(withOutage({ kind: 'emergency', text: 'Аварійне відключення', start: '10:05 17.10.2026', end: '17:00 17.10.2026' }).state).toBe('emergency');
  expect(withOutage({ kind: 'emergency', text: 'Аварійне відключення', start: 'незабаром', end: '17:00 17.10.2026' }).state).toBe('emergency');
});
test('emergency whose end has passed → schedule state', () => {
  const v = withOutage({ kind: 'emergency', text: 'Аварійне відключення', start: '08:00 17.10.2026', end: '11:00 17.10.2026' });
  expect(v.state).toBe('on'); expect(v.outageBadge).toBeUndefined(); expect(v.nextText).toBe('Вимкнення о 15:00 · через 3 год 10 хв');
});
test('emergency without an end: overrides only while the snapshot is fresh', () => {
  const fresh = withOutage({ kind: 'emergency', text: 'Екстрене відключення' });
  expect(fresh.state).toBe('emergency'); expect(fresh.outageBadge).toBe('Екстрене');
  const stale = withOutage({ kind: 'emergency', text: 'Екстрене відключення' }, '2026-10-17T07:50:00.000Z'); // 60 min old
  expect(stale.state).toBe('on'); expect(stale.outageBadge).toBeUndefined(); expect(stale.stale).toBe(true);
  const unreadableEnd = withOutage({ kind: 'emergency', text: 'Екстрене відключення', end: 'невідомо' }, '2026-10-17T07:50:00.000Z');
  expect(unreadableEnd.state).toBe('on');
});
describe('emergency without an end: its staleness is judged from houseCheckedAt (a feed renews only fetchedAt)', () => {
  const noEnd: CurrentOutage = { kind: 'emergency', text: 'Екстрене відключення', start: '10:05 17.10.2026' };
  const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const feedSnap = (houseCheckedAt: string) =>
    ({ ...fixtureSnapshot({ currentOutage: noEnd, fetchedAt: NOW.toISOString() }), houseCheckedAt });
  test('a house check older than STALE_AFTER_MIN drops it, while the display stays fresh by fetchedAt', () => {
    const v = computeWidgetView(feedSnap(minAgo(STALE_AFTER_MIN + 1)), NOW);
    expect(v.state).toBe('on'); expect(v.outageBadge).toBeUndefined(); expect(v.emergency).toBeUndefined();
    expect(v.stale).toBe(false);
  });
  test('a house check 5 min old keeps it', () => {
    const v = computeWidgetView(feedSnap(minAgo(5)), NOW);
    expect(v.state).toBe('emergency'); expect(v.outageBadge).toBe('Екстрене');
  });
  test('no houseCheckedAt: keyed on fetchedAt, as before', () => {
    expect(withOutage(noEnd, minAgo(5)).state).toBe('emergency');
    expect(withOutage(noEnd, minAgo(STALE_AFTER_MIN + 1)).state).toBe('on');
  });
});
test("kind 'other' never overrides and gets no badge", () => {
  const v = withOutage({ kind: 'other', text: 'Планові ремонтні роботи', start: '10:00 17.10.2026', end: '17:00 17.10.2026' });
  expect(v.state).toBe('on'); expect(v.title).toBe('Світло є'); expect(v.outageBadge).toBeUndefined();
});
test('an unreadable fetchedAt counts as stale and does not break the view', () => {
  const v = computeWidgetView(fixtureSnapshot({ fetchedAt: 'not a date' }), NOW);
  expect(v.stale).toBe(true); expect(v.updatedText).toBe('оновлено --:--'); expect(v.state).toBe('on');
});

test('emergency window in Kyiv minutes of today, for painting the strip', () => {
  const o = { kind: 'emergency' as const, text: 'Аварійні ремонтні роботи' };
  // The capture rig's outage, 13:30–17:00, seen at 14:20 Kyiv.
  const v = computeWidgetView(fixtureSnapshot({ currentOutage: { ...o, start: '13:30 17.10.2026', end: '17:00 17.10.2026' } }), at('2026-10-17T11:20:00Z'));
  expect(v.emergency).toEqual({ startMin: 810, endMin: 1020 });
  expect(v.state).toBe('emergency'); expect(v.nextText).toBe('Аварійне · орієнтовно до 17:00'); // unchanged
  // Unreadable end: from the start through the now cell (11:30–12:00), so the now cell is never «on».
  expect(withOutage({ ...o, start: '10:05 17.10.2026', end: 'невідомо' }).emergency).toEqual({ startMin: 605, endMin: 720 });
  // Clipped to today: started yesterday, ends tomorrow.
  expect(withOutage({ ...o, start: '22:00 16.10.2026', end: '03:00 18.10.2026' }).emergency).toEqual({ startMin: 0, endMin: 1440 });
  // Unreadable start: only what is known, from the now cell to the end.
  expect(withOutage({ ...o, start: 'незабаром', end: '17:00 17.10.2026' }).emergency).toEqual({ startMin: 690, endMin: 1020 });
});
test('no emergency window without an active emergency', () => {
  expect(computeWidgetView(fixtureSnapshot(), NOW).emergency).toBeUndefined();
  expect(withOutage({ kind: 'emergency', text: 'Аварійне відключення', start: '13:00 17.10.2026', end: '17:00 17.10.2026' }).emergency).toBeUndefined();
  expect(withOutage({ kind: 'other', text: 'Планові ремонтні роботи', start: '10:00 17.10.2026', end: '17:00 17.10.2026' }).emergency).toBeUndefined();
});
test('emergency for other queues does not override the saved queue (GPV1.2)', () => {
  const base = { kind: 'emergency' as const, text: 'Аварійне відключення', end: '17:00 17.10.2026' };
  expect(withOutage({ ...base, groups: ['GPV4.2'] }).state).toBe('on');
  expect(withOutage({ ...base, groups: ['GPV4.2'] }).outageBadge).toBeUndefined();
  expect(withOutage({ ...base, groups: ['GPV4.2', 'GPV1.2'] }).state).toBe('emergency');
  expect(withOutage({ ...base, groups: [] }).state).toBe('emergency');
});

describe('with an actual reading', () => {
  const ON_SLOT = at('2026-10-17T08:50:00Z');   // 11:50 Kyiv, schedule: on
  const OFF_SLOT = at('2026-10-17T13:00:00Z');  // 16:00 Kyiv, schedule: off
  const SINCE = '2026-10-17T07:10:00Z';         // 10:10 Kyiv
  const act = (power: 'on' | 'off' | 'unknown', now = ON_SLOT, over: Partial<ActualStatus> = {}): ActualStatus => ({
    sourceLabel: 'EcoFlow', power, since: SINCE,
    observedAt: new Date(now.getTime() - 30_000).toISOString(), history: [{ power, start: SINCE }], ...over,
  });
  const emergency = () => fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення', end: '17:00 17.10.2026' } });

  test('fresh actual off while schedule says on → mismatch, no countdown', () => {
    const v = computeWidgetView(fixtureSnapshot(), ON_SLOT, act('off'));
    expect(v.state).toBe('off'); expect(v.title).toBe('Світла немає');
    expect(v.nextText).toBe('Не за графіком · з 10:10');
    expect(v.countdownShort).toBeUndefined(); expect(v.countdownCaption).toBeUndefined();
    expect(v.actual).toEqual({ power: 'off', sinceText: 'з 10:10', mismatch: true });
    expect(v.actualStrip).toEqual([{ startMin: 610, endMin: 710, power: 'off' }]);
    expect(v.actualUnknownReason).toBeUndefined();
  });
  test('mismatch without since', () => {
    const v = computeWidgetView(fixtureSnapshot(), ON_SLOT, act('off', ON_SLOT, { since: undefined }));
    expect(v.nextText).toBe('Не за графіком'); expect(v.actual).toEqual({ power: 'off', mismatch: true });
  });
  test('fresh actual on while schedule says off → mismatch', () => {
    const v = computeWidgetView(fixtureSnapshot(), OFF_SLOT, act('on', OFF_SLOT));
    expect(v.state).toBe('on'); expect(v.title).toBe('Світло є'); expect(v.actual?.mismatch).toBe(true);
    expect(v.countdownShort).toBeUndefined();
  });
  test('fresh actual matching schedule keeps schedule texts and countdown', () => {
    const v = computeWidgetView(fixtureSnapshot(), ON_SLOT, act('on'));
    expect(v.state).toBe('on'); expect(v.nextText).toBe('Вимкнення о 15:00 · через 3 год 10 хв');
    expect(v.countdownShort).toBe('3:10'); expect(v.countdownCaption).toBe('до вимкнення о 15:00');
    expect(v.actual).toEqual({ power: 'on', sinceText: 'з 10:10', mismatch: false });
    const off = computeWidgetView(fixtureSnapshot(), OFF_SLOT, act('off', OFF_SLOT));
    expect(off.state).toBe('off'); expect(off.nextText).toBe('Увімкнуть о 19:00 · через 3 год'); expect(off.actual?.mismatch).toBe(false);
  });
  test('actual on matches a maybe-off schedule slot', () => {
    const d = allOn('2026-10-17'); d.slots[23] = 'maybe-off';
    const v = computeWidgetView({ ...fixtureSnapshot(), days: [d] }, ON_SLOT, act('on'));
    expect(v.actual?.mismatch).toBe(false); expect(v.state).toBe('on');
  });
  test('missing schedule for today counts as a match and keeps its text', () => {
    const v = computeWidgetView({ ...fixtureSnapshot(), days: [] }, ON_SLOT, act('on'));
    expect(v.actual?.mismatch).toBe(false); expect(v.state).toBe('on'); expect(v.nextText).toBe('Графік на сьогодні ще не отримано');
  });
  test('actual off during DTEK emergency → emergency texts stay', () => {
    const v = computeWidgetView(emergency(), ON_SLOT, act('off'));
    expect(v.state).toBe('emergency'); expect(v.nextText).toBe('Аварійне · орієнтовно до 17:00');
    expect(v.countdownCaption).toBe('орієнтовно до 17:00'); expect(v.outageBadge).toBe('Аварійне');
    expect(v.actual?.mismatch).toBe(false);
  });
  test('actual on during DTEK emergency → mismatch, badge kept', () => {
    const v = computeWidgetView(emergency(), ON_SLOT, act('on'));
    expect(v.state).toBe('on'); expect(v.title).toBe('Світло є'); expect(v.outageBadge).toBe('Аварійне');
    expect(v.nextText).toBe('Не за графіком · з 10:10'); expect(v.countdownShort).toBeUndefined(); expect(v.actual?.mismatch).toBe(true);
  });
  test('stale actual (observedAt 11 min ago) falls back to schedule with unknown reason', () => {
    const plain = computeWidgetView(fixtureSnapshot(), ON_SLOT);
    const v = computeWidgetView(fixtureSnapshot(), ON_SLOT, act('off', ON_SLOT, { observedAt: new Date(ON_SLOT.getTime() - 11 * 60_000).toISOString() }));
    expect(v).toMatchObject(plain); expect(v.actual).toBeUndefined();
    expect(v.actualUnknownReason).toBe('немає свіжих даних'); expect(v.actualStrip).toBeDefined();
    const edge = computeWidgetView(fixtureSnapshot(), ON_SLOT, act('off', ON_SLOT, { observedAt: new Date(ON_SLOT.getTime() - 10 * 60_000).toISOString() }));
    expect(edge.actual?.mismatch).toBe(true);
  });
  test('actual unknown → schedule view + actualUnknownReason', () => {
    const v = computeWidgetView(fixtureSnapshot(), ON_SLOT, act('unknown', ON_SLOT, { reason: 'Станція не на зв’язку' }));
    expect(v).toMatchObject(computeWidgetView(fixtureSnapshot(), ON_SLOT));
    expect(v.actualUnknownReason).toBe('Станція не на зв’язку'); expect(v.actual).toBeUndefined();
    expect(computeWidgetView(fixtureSnapshot(), ON_SLOT, act('unknown', ON_SLOT, { observedAt: undefined })).actualUnknownReason).toBe('немає свіжих даних');
  });
  test('no actual → identical to previous behaviour', () => {
    const plain = computeWidgetView(fixtureSnapshot(), ON_SLOT);
    expect(computeWidgetView(fixtureSnapshot(), ON_SLOT, null)).toEqual(plain);
    expect(computeWidgetView(fixtureSnapshot(), ON_SLOT, undefined)).toEqual(plain);
    expect('actualUnknownReason' in plain).toBe(false); expect('actualStrip' in plain).toBe(false); expect('actual' in plain).toBe(false);
  });
});
