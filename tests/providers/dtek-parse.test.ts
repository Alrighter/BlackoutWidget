import stale from '../fixtures/dtek-krem/getHomeNum-stale-updateFact.json';
import { parseHomeNumResponse, hourToSlots, factToDays, deriveLines, parseHouses, parseCurrentOutage } from '../../src/main/providers/dtek-krem/parse';
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
    .toEqual({ kind: 'emergency', text: 'Аварійне відключення', start: '10:05 17.10.2026', end: '17:00 17.10.2026' });
  expect(parseCurrentOutage({ ...resp.data['40'], sub_type: 'Екстрене відключення' })?.kind).toBe('emergency');
  expect(parseCurrentOutage({ ...resp.data['40'], type: 'Планові ремонтні роботи' })?.kind).toBe('other');
});
test('parseHomeNumResponse rejects garbage', () => {
  expect(() => parseHomeNumResponse('<html>')).toThrow(ProviderError);
  expect(() => parseHomeNumResponse({ result: false })).toThrow(ProviderError);
  expect(() => parseHomeNumResponse({ result: true })).toThrow(ProviderError);
});
