import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentOutageOf, parseBuildingGroups, parseBuildingNames, parseCities, parseGpvCollection, parseOutageRows, parseStreets,
  queueSlots, wallStamp, ToeShapeError,
} from '../../src/main/providers/toe/parse';
import type { Slot } from '../../src/shared/types';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const fx = (n: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'toe', n), 'utf8'));
const GPV_1_2 = fx('a_gpv_g_2026-10-17_house-1032-47931-1_group1.2.json') as any;
const GPV_TWO = fx('a_gpv_g_2026-10-17_house-1032-31848-29_groups2.2+4.1.json') as any;
const GPV_QUIET = fx('a_gpv_g_quiet-2026-10-20_valid-key.json');
const ACC_383 = fx('pw_accidents_city383_street3752_2026-10-20.json');
const PLANNED_22085 = fx('pw_accident_planeds_city22085_street41475_2026-10-20.json');

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

/** The 17.10 shape of a 3-hour outage: maybe from `from`, off for six slots, maybe again, the rest on. */
const outage = (from: number): Slot[] => Array.from({ length: 48 }, (_, i): Slot => {
  if (i === from || i === from + 7) return 'maybe-off';
  return i > from && i < from + 7 ? 'off' : 'on';
});

const withMember = (patch: (m: any) => void): unknown => {
  const copy = structuredClone(GPV_1_2);
  patch(copy['hydra:member'][0]);
  return copy;
};

describe('parseGpvCollection / queueSlots', () => {
  it('reads the 17.10 schedule of queue 1.2: maybe 10:30, off 11:00-14:00, maybe 14:00', () => {
    const days = parseGpvCollection(GPV_1_2);
    expect([...days.keys()]).toEqual(['2026-10-17']);
    const day = days.get('2026-10-17')!;
    const slots = queueSlots(day, '1.2');
    expect(slots[21]).toBe('maybe-off');
    expect(slots.slice(22, 28)).toEqual(Array(6).fill('off'));
    expect(slots[28]).toBe('maybe-off');
    expect(slots).toEqual(outage(21));
    expect(wallStamp(day.dateCreate)).toBe('18:52 17.10.2026');
  });

  it('holds both queues of a house on two queues', () => {
    const day = parseGpvCollection(GPV_TWO).get('2026-10-17')!;
    expect(Object.keys(day.queues).sort()).toEqual(['2.2', '4.1']);
    expect(queueSlots(day, '2.2')).toEqual(outage(31));
    expect(queueSlots(day, '4.1')).toEqual(outage(21));
  });

  it('a null member list is no day; an empty one is unreadable (R4)', () => {
    expect(parseGpvCollection(GPV_QUIET).size).toBe(0);
    // `[]` is the answer for no key, a wrong key, an unknown house or «Не входить»: never a quiet day after the check.
    expect(() => parseGpvCollection({ ...(GPV_QUIET as object), 'hydra:member': [] })).toThrow(ToeShapeError);
  });

  it('strips a #suffix from a queue key', () => {
    const body = withMember((m) => { m.dataJson = { '1.2#x': m.dataJson['1.2'] }; });
    expect(queueSlots(parseGpvCollection(body).get('2026-10-17')!, '1.2')).toEqual(outage(21));
  });

  it('two keys for one queue after stripping is unreadable', () => {
    const body = withMember((m) => { m.dataJson['1.2#x'] = m.dataJson['1.2']; });
    expect(() => queueSlots(parseGpvCollection(body).get('2026-10-17')!, '1.2')).toThrow(ToeShapeError);
  });

  it('a times map with 47 keys, or a 24:00 key in place of 23:30, throws', () => {
    const short = withMember((m) => { delete m.dataJson['1.2'].times['23:30']; });
    expect(() => queueSlots(parseGpvCollection(short).get('2026-10-17')!, '1.2')).toThrow(ToeShapeError);
    const renamed = withMember((m) => { delete m.dataJson['1.2'].times['23:30']; m.dataJson['1.2'].times['24:00'] = '0'; });
    expect(() => queueSlots(parseGpvCollection(renamed).get('2026-10-17')!, '1.2')).toThrow(ToeShapeError);
  });

  it('a slot value other than 0, 1 and 10 throws', () => {
    for (const v of ['2', '', 0, null]) {
      const body = withMember((m) => { m.dataJson['1.2'].times['12:00'] = v; });
      expect(() => queueSlots(parseGpvCollection(body).get('2026-10-17')!, '1.2')).toThrow(ToeShapeError);
    }
  });

  it('a member without the queue throws', () => {
    const day = parseGpvCollection(GPV_1_2).get('2026-10-17')!;
    expect(() => queueSlots(day, '4.1')).toThrow(ToeShapeError);
    const empty = withMember((m) => { m.dataJson = {}; });
    expect(() => queueSlots(parseGpvCollection(empty).get('2026-10-17')!, '1.2')).toThrow(ToeShapeError);
  });

  it('a collection of another shape throws', () => {
    expect(() => parseGpvCollection({ 'hydra:member': {} })).toThrow(ToeShapeError);
    expect(() => parseGpvCollection({ ...GPV_1_2, 'hydra:member': {} })).toThrow(ToeShapeError);
    expect(() => parseGpvCollection({ ...GPV_1_2, '@type': 'hydra:Error' })).toThrow(ToeShapeError);
    expect(() => parseGpvCollection({ ...GPV_1_2, 'hydra:totalItems': '1' })).toThrow(ToeShapeError);
    expect(() => parseGpvCollection(null)).toThrow(ToeShapeError);
    expect(() => parseGpvCollection([])).toThrow(ToeShapeError);
  });

  it('a member that cannot be dated or has no dataJson object throws, never a quiet day', () => {
    for (const patch of [
      (m: any) => { delete m.dateGraph; },
      (m: any) => { m.dateGraph = '17.10.2026'; },
      (m: any) => { m.dataJson = null; },
      (m: any) => { m.dataJson = []; },
    ]) expect(() => parseGpvCollection(withMember(patch))).toThrow(ToeShapeError);
    expect(() => parseGpvCollection({ ...GPV_1_2, 'hydra:member': [null] })).toThrow(ToeShapeError);
  });

  it('for one date the later dateCreate wins, then the larger id', () => {
    const m = GPV_1_2['hydra:member'][0];
    const other = { ...m, dataJson: { '1.2': { times: Object.fromEntries(Object.keys(m.dataJson['1.2'].times).map((k) => [k, '1'])) } } };
    const newer = { ...other, id: 40, dateCreate: '2026-10-17T19:00:00Z' };
    const byDate = parseGpvCollection({ ...GPV_1_2, 'hydra:member': [m, newer] });
    expect(queueSlots(byDate.get('2026-10-17')!, '1.2')).toEqual(Array(48).fill('off'));
    const sameStamp = { ...other, id: 47 };
    const byId = parseGpvCollection({ ...GPV_1_2, 'hydra:member': [sameStamp, m] });
    expect(queueSlots(byId.get('2026-10-17')!, '1.2')).toEqual(Array(48).fill('off'));
  });

  it('dateGraph is a Kyiv date as written, never shifted by its Z', () => {
    const body = withMember((m) => { m.dateGraph = '2026-10-18T00:00:00Z'; });
    expect([...parseGpvCollection(body).keys()]).toEqual(['2026-10-18']);
    const offset = withMember((m) => { m.dateGraph = '2026-10-18T00:00:00+00:00'; });
    expect([...parseGpvCollection(offset).keys()]).toEqual(['2026-10-18']);
  });

  it('a dateGraph other than midnight with Z or +00:00 is unreadable, never a member of another day (final M3)', () => {
    for (const dateGraph of [
      '2026-10-16T21:00:00Z', '2026-10-17T00:00:00+03:00', '2026-10-17T12:00:00Z', '2026-10-17', '2026-10-17T00:00:00',
      '2026-10-17T00:00:00.000Z', '2026-10-17T00:00Z', ' 2026-10-17T00:00:00Z',
    ]) {
      expect(() => parseGpvCollection(withMember((m) => { m.dateGraph = dateGraph; }))).toThrow(ToeShapeError);
    }
  });
});

describe('wallStamp', () => {
  it('takes the digits as Kyiv wall clock', () => {
    expect(wallStamp('2026-10-17T18:52:36Z')).toBe('18:52 17.10.2026');
    expect(wallStamp('2026-10-20T03:31:35+00:00')).toBe('03:31 20.10.2026');
    expect(wallStamp('вчора')).toBeUndefined();
    expect(wallStamp(undefined)).toBeUndefined();
  });
});

describe('address lists', () => {
  it('parseCities keeps id, name and громада, and drops empty names', () => {
    const cities = parseCities(fx('pw_cities_all.json'));
    expect(cities.every((c) => c.name.trim() !== '')).toBe(true);
    expect(cities.find((c) => c.id === 1032)).toEqual({ id: 1032, name: 'Тернопіль', otg: 'Тернопільська' });
    expect(cities.filter((c) => c.name === 'Ланівці').map((c) => c.otg)).toEqual(['Лановецька', 'Борщівська']);
    expect(cities.length).toBe(55);
  });

  it('parseStreets keeps id and name', () => {
    const streets = parseStreets(fx('pw_streets_city1032.json'));
    expect(streets).toHaveLength(299);
    expect(streets.find((s) => s.id === 47931)).toEqual({ id: 47931, name: 'вул. Василя Юрчака' });
  });

  it('parseBuildingNames keeps only the house text and its queue', () => {
    const rows = parseBuildingNames(fx('building-names_city1032_street31848_mixed-groups.json'));
    expect(rows[0]).toEqual({ house: '1', queue: '1.2' });
    expect(rows.find((r) => r.house === '3')).toEqual({ house: '3', queue: 'Не входить' });
    expect(rows).toHaveLength(21);
  });

  it('parseBuildingGroups gives the queue strings', () => {
    expect(parseBuildingGroups(fx('building-groups_1032_47931_1-A.json'))).toEqual(['1.2']);
    expect(parseBuildingGroups({ buildingGroups: [] })).toEqual([]);
  });

  it('list answers of another shape throw', () => {
    expect(() => parseCities({ 'hydra:member': null })).toThrow(ToeShapeError);
    expect(() => parseCities({ 'hydra:member': [] })).toThrow(ToeShapeError);
    expect(() => parseStreets({})).toThrow(ToeShapeError);
    expect(() => parseBuildingNames({ buildingNames: {} })).toThrow(ToeShapeError);
    expect(() => parseBuildingGroups({})).toThrow(ToeShapeError);
    expect(() => parseBuildingGroups({ buildingGroups: [{ chergGpv: 12 }] })).toThrow(ToeShapeError);
    expect(() => parseBuildingGroups({ buildingGroups: [null] })).toThrow(ToeShapeError);
  });
});

describe('current outage', () => {
  const ZBARAZH = { cityId: 383, streetId: 3752 };
  const NAHIRIANKA = { cityId: 22085, streetId: 41475 };

  it('the Збараж emergency counts between 03:31 and 13:00 for house 10 only', () => {
    const rows = parseOutageRows(ACC_383, 'emergency', ZBARAZH);
    expect(currentOutageOf(rows, [], '10', at('2026-10-20', 10))).toEqual({
      kind: 'emergency', text: 'Аварійне відключення', start: '03:31 20.10.2026', end: '13:00 20.10.2026',
    });
    expect(currentOutageOf(rows, [], '10', at('2026-10-20', 14))).toBeUndefined();
    expect(currentOutageOf(rows, [], '10', at('2026-10-20', 3, 30))).toBeUndefined();
    expect(currentOutageOf(rows, [], '1', at('2026-10-20', 10))).toBeUndefined();
  });

  it('never keeps koment', () => {
    const rows = parseOutageRows(ACC_383, 'emergency', ZBARAZH);
    expect(JSON.stringify(rows)).not.toContain('Пошкодження');
  });

  it('a planned row counts only while it runs', () => {
    const planned = parseOutageRows(PLANNED_22085, 'planned', NAHIRIANKA);
    expect(currentOutageOf([], planned, '1', at('2026-10-21', 9))).toEqual({
      kind: 'planned', text: 'Планові роботи', start: '08:00 21.10.2026', end: '17:00 21.10.2026',
    });
    expect(currentOutageOf([], planned, '1', at('2026-10-20', 17, 30))).toBeUndefined();
  });

  it('emergency wins over planned', () => {
    const emergency = parseOutageRows(ACC_383, 'emergency', ZBARAZH);
    const planned = parseOutageRows(PLANNED_22085, 'planned', NAHIRIANKA).map((r) => ({ ...r, houses: ['10'] }));
    expect(currentOutageOf(emergency, planned, '10', at('2026-10-20', 10))?.kind).toBe('emergency');
    expect(currentOutageOf([], planned, '10', at('2026-10-20', 10))?.kind).toBe('planned');
  });

  it('matches the house exactly in a comma list', () => {
    const body = structuredClone(ACC_383) as any;
    body['hydra:member'][0].buildingNames = ', 1, 1-Б, 10 , 12';
    const rows = parseOutageRows(body, 'emergency', ZBARAZH);
    expect(currentOutageOf(rows, [], '10', at('2026-10-20', 10))?.kind).toBe('emergency');
    expect(currentOutageOf(rows, [], '1-б', at('2026-10-20', 10))).toBeUndefined();
    expect(currentOutageOf(rows, [], '', at('2026-10-20', 10))).toBeUndefined();
  });

  it('an emergency without an end counts once it has started; a planned one without an end does not', () => {
    const body = structuredClone(ACC_383) as any;
    body['hydra:member'][0].datePlanIn = null;
    const rows = parseOutageRows(body, 'emergency', ZBARAZH);
    expect(currentOutageOf(rows, [], '10', at('2026-10-20', 23))).toEqual({
      kind: 'emergency', text: 'Аварійне відключення', start: '03:31 20.10.2026',
    });
    const planned = parseOutageRows(body, 'planned', ZBARAZH);
    expect(currentOutageOf([], planned, '10', at('2026-10-20', 10))).toBeUndefined();
  });

  it('switchSubReason 2 repeats the hourly schedule and is skipped; 1 and 3 are emergencies', () => {
    const withReason = (v: number) => {
      const body = structuredClone(ACC_383) as any;
      body['hydra:member'][0].switchSubReason = v;
      return currentOutageOf(parseOutageRows(body, 'emergency', ZBARAZH), [], '10', at('2026-10-20', 10));
    };
    expect(withReason(2)).toBeUndefined();
    expect(withReason(1)?.kind).toBe('emergency');
    expect(withReason(3)?.kind).toBe('emergency');
  });

  it('a row of another city or street never counts', () => {
    expect(parseOutageRows(ACC_383, 'emergency', { cityId: 383, streetId: 1 })).toEqual([]);
    expect(parseOutageRows(ACC_383, 'emergency', { cityId: 1, streetId: 3752 })).toEqual([]);
  });

  it('an outage answer of another shape throws', () => {
    expect(() => parseOutageRows({ 'hydra:member': null }, 'emergency', ZBARAZH)).toThrow(ToeShapeError);
    expect(() => parseOutageRows('<html>', 'planned', ZBARAZH)).toThrow(ToeShapeError);
  });
});
