import stale from '../fixtures/dtek/getHomeNum-stale-updateFact.json';
import { parseHomeNumResponse, hourToSlots, factToDays, deriveLines, parseHouses, parseCurrentOutage, hasOutageFields, hasActiveOutage, queueLabelFromId } from '../../src/main/providers/dtek/parse';
import { ProviderError } from '../../src/main/providers/types';
const resp = parseHomeNumResponse(stale);
const fact = resp.fact!; const names = resp.preset!.sch_names;

test('hourToSlots maps every DTEK status', () => {
  expect(hourToSlots('yes')).toEqual(['on', 'on']);
  expect(hourToSlots('no')).toEqual(['off', 'off']);
  expect(hourToSlots('first')).toEqual(['off', 'on']);
  expect(hourToSlots('second')).toEqual(['on', 'off']);
  expect(hourToSlots('maybe')).toEqual(['maybe-off', 'maybe-off']);
  expect(hourToSlots('mfirst')).toEqual(['maybe-off', 'on']);
  expect(hourToSlots('msecond')).toEqual(['on', 'maybe-off']);
  expect(hourToSlots('weird')).toEqual(['unknown', 'unknown']);
});
test('factToDays: GPV1.2 on 2026-10-17 matches the site screenshot', () => {
  const days = factToDays(fact, 'GPV1.2');
  expect(days.map(d => d.date)).toEqual(['2026-10-17']);
  expect(days[0].slots).toHaveLength(48);
  const off = days[0].slots.flatMap((s, i) => (s === 'off' ? [i] : []));
  expect(off).toEqual([12, 13, 14, 15, 16, 30, 31, 32, 33, 34, 35, 36, 37]);
});
test('factToDays: GPV4.2 half hours', () => {
  const s = factToDays(fact, 'GPV4.2')[0].slots;
  expect(s.slice(0, 2)).toEqual(['off', 'off']);
  expect(s.slice(36, 38)).toEqual(['on', 'off']);
  expect(s.slice(44, 46)).toEqual(['off', 'on']);
});
test('factToDays: unknown group → []', () => expect(factToDays(fact, 'GPV9.9')).toEqual([]));
test('deriveLines: house 40 → Лінія 1 = GPV1.2, Лінія 2 = GPV4.2', () => {
  expect(deriveLines(['GPV1.2', 'GPV4.2'], fact, names)).toEqual([
    { index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' },
    { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' },
  ]);
});
test('deriveLines keeps only first two (house 13)', () =>
  expect(deriveLines(['GPV4.2', 'GPV2.2', 'GPV4.1', 'GPV1.2'], fact, names).map(l => l.groupId)).toEqual(['GPV4.2', 'GPV2.2']));
test('deriveLines: slice first, then filter, then number', () => {
  expect(deriveLines(['GPV9.9', 'GPV1.2'], fact, names)).toEqual([{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }]);
  expect(deriveLines(['GPV9.9', 'GPV8.8', 'GPV1.2'], fact, names)).toEqual([]);
  expect(deriveLines([], fact, names)).toEqual([]);
});
test('parseHouses keeps response order and odd keys', () => {
  const houses = parseHouses(resp, fact, names);
  expect(houses.find(h => h.house === '40')!.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
  expect(houses.some(h => h.house === ':0098')).toBe(true);
});
test('parseCurrentOutage: empty → undefined; filled → emergency', () => {
  expect(parseCurrentOutage(resp.data['40'])).toBeUndefined();
  expect(parseCurrentOutage({ ...resp.data['40'], type: 'Аварійне відключення', start_date: '10:05 17.10.2026', end_date: '17:00 17.10.2026' }))
    .toEqual({ kind: 'emergency', text: 'Аварійне відключення', start: '10:05 17.10.2026', end: '17:00 17.10.2026', groups: ['GPV1.2', 'GPV4.2'] });
  expect(parseCurrentOutage({ ...resp.data['40'], sub_type: 'Екстрене відключення' })?.kind).toBe('emergency');
  expect(parseCurrentOutage({ ...resp.data['40'], type: 'Планові ремонтні роботи' })?.kind).toBe('other');
});
test('parseHomeNumResponse rejects garbage', () => {
  expect(() => parseHomeNumResponse('<html>')).toThrow(ProviderError);
  expect(() => parseHomeNumResponse({ result: false })).toThrow(ProviderError);
  expect(() => parseHomeNumResponse({ result: true })).toThrow(ProviderError);
});
test('factToDays reports statuses it does not know (they become unknown slots)', () => {
  const ts = Object.keys(fact.data)[0];
  const odd = { ...fact, data: { [ts]: { ...fact.data[ts], 'GPV1.2': { ...fact.data[ts]['GPV1.2'], '1': 'weird', '2': 'weird', '3': 'odd' } } } };
  const seen: string[] = [];
  const days = factToDays(odd, 'GPV1.2', s => seen.push(s));
  expect(seen).toEqual(['weird', 'weird', 'odd']);
  expect(days[0].slots.slice(0, 6)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  const none: string[] = [];
  factToDays(fact, 'GPV1.2', s => none.push(s));
  expect(none).toEqual([]);
});
test('hasOutageFields: only when type/sub_type/dates are non-empty or voluntarily/cek non-null', () => {
  const e = resp.data['40'];
  expect(hasOutageFields(e)).toBe(false);
  expect(hasOutageFields({ ...e, type: '  ' })).toBe(false);
  expect(hasOutageFields({ ...e, sub_type: 'Екстрене відключення' })).toBe(true);
  expect(hasOutageFields({ ...e, end_date: '17:00 17.10.2026' })).toBe(true);
  expect(hasOutageFields({ ...e, voluntarily: false })).toBe(true);
  expect(hasOutageFields({ ...e, cek: 0 })).toBe(true);
});

// Shape seen live on 2026-10-17 during a stabilization outage of house 40.
const SUB = 'Стабілізаційне відключення (Згідно графіку погодинних відключень)';
const liveEntry = { ...resp.data['40'], type: '2', sub_type: SUB, start_date: '15:11 17.10.2026', end_date: '19:00 17.10.2026', sub_type_reason: ['GPV1.2'] };
test('parseCurrentOutage drops a numeric type and carries the outage queues', () => {
  expect(parseCurrentOutage(liveEntry)).toEqual({ kind: 'other', text: SUB, start: '15:11 17.10.2026', end: '19:00 17.10.2026', groups: ['GPV1.2'] });
  expect(parseCurrentOutage({ ...resp.data['40'], type: ' 2 ' })).toBeUndefined();
  expect(parseCurrentOutage({ ...resp.data['40'], type: '1', sub_type: 'Аварійне відключення' })?.text).toBe('Аварійне відключення');
  expect(parseCurrentOutage({ ...resp.data['40'], type: 'Екстрене', sub_type: 'відключення' })?.text).toBe('Екстрене · відключення');
});
test('hasActiveOutage: type or sub_type filled; parseHouses reports it per house', () => {
  expect(hasActiveOutage(resp.data['40'])).toBe(false);
  expect(hasActiveOutage(liveEntry)).toBe(true);
  expect(hasActiveOutage({ ...resp.data['40'], type: '2' })).toBe(true);
  expect(hasActiveOutage({ ...resp.data['40'], end_date: '19:00 17.10.2026' })).toBe(false);
  const houses = parseHouses({ ...resp, data: { ...resp.data, '40': liveEntry } }, fact, names);
  expect(houses.find(h => h.house === '40')).toMatchObject({ outageActive: true, lines: [{ index: 1, groupId: 'GPV1.2' }] });
  expect(houses.find(h => h.house === '13')?.outageActive).toBe(false);
});
test('queueLabelFromId', () => {
  expect(queueLabelFromId('GPV4.2')).toBe('Черга 4.2');
  expect(queueLabelFromId('GPV12')).toBe('Черга 12');
  expect(queueLabelFromId('weird')).toBe('weird');
});
