import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accidentRows, currentOutageOf, plannedRows, wallInstant, wallStamp, type OutageRow, type SubReason,
} from '../../src/main/providers/inneti';
import { TOE_SUB_REASON } from '../../src/main/providers/toe';
import { ShapeError } from '../../src/main/providers/shape';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const fx = (n: string): unknown => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'toe', n), 'utf8'));
const ACC_383 = fx('pw_accidents_city383_street3752_2026-10-20.json');
const PLANNED_22085 = fx('pw_accident_planeds_city22085_street41475_2026-10-20.json');

const at = (date: string, h: number, m = 0) => kyivWallTimeToInstant(date, h * 60 + m);

describe('wallStamp', () => {
  it('takes the digits as Kyiv wall clock', () => {
    expect(wallStamp('2026-10-17T18:52:36Z')).toBe('18:52 17.10.2026');
    expect(wallStamp('2026-10-20T03:31:35+00:00')).toBe('03:31 20.10.2026');
    expect(wallStamp('вчора')).toBeUndefined();
    expect(wallStamp(undefined)).toBeUndefined();
  });

  it('wallInstant reads the same digits as Kyiv time and refuses odd ones', () => {
    expect(wallInstant('2026-10-20T13:09:00Z')?.toISOString()).toBe('2026-10-20T10:09:00.000Z');
    expect(wallInstant('2026-10-20T25:09:00Z')).toBeUndefined();
    expect(wallInstant(null)).toBeUndefined();
  });
});

describe('Ternopil outage rows (the former toe-parse cases)', () => {
  const ZBARAZH = { cityId: 383, streetId: 3752 };
  const NAHIRIANKA = { cityId: 22085, streetId: 41475 };

  it('the Збараж emergency counts between 03:31 and 13:00 for house 10 only', () => {
    const rows = accidentRows(ACC_383, ZBARAZH, TOE_SUB_REASON);
    expect(currentOutageOf(rows, '10', at('2026-10-20', 10))).toEqual({
      kind: 'emergency', text: 'Аварійне відключення', start: '03:31 20.10.2026', end: '13:00 20.10.2026',
    });
    expect(currentOutageOf(rows, '10', at('2026-10-20', 14))).toBeUndefined();
    expect(currentOutageOf(rows, '10', at('2026-10-20', 3, 30))).toBeUndefined();
    expect(currentOutageOf(rows, '1', at('2026-10-20', 10))).toBeUndefined();
  });

  it('never keeps koment', () => {
    const rows = accidentRows(ACC_383, ZBARAZH, TOE_SUB_REASON);
    expect(JSON.stringify(rows)).not.toContain('Пошкодження');
  });

  it('a planned row counts only while it runs', () => {
    const planned = plannedRows(PLANNED_22085, NAHIRIANKA);
    expect(currentOutageOf(planned, '1', at('2026-10-21', 9))).toEqual({
      kind: 'planned', text: 'Планові роботи', start: '08:00 21.10.2026', end: '17:00 21.10.2026',
    });
    expect(currentOutageOf(planned, '1', at('2026-10-20', 17, 30))).toBeUndefined();
  });

  it('emergency wins over planned', () => {
    const emergency = accidentRows(ACC_383, ZBARAZH, TOE_SUB_REASON);
    const planned = plannedRows(PLANNED_22085, NAHIRIANKA).map((r) => ({ ...r, houses: ['10'] }));
    expect(currentOutageOf([...emergency, ...planned], '10', at('2026-10-20', 10))?.kind).toBe('emergency');
    expect(currentOutageOf(planned, '10', at('2026-10-20', 10))?.kind).toBe('planned');
  });

  it('matches the house exactly in a comma list', () => {
    const body = structuredClone(ACC_383) as any;
    body['hydra:member'][0].buildingNames = ', 1, 1-Б, 10 , 12';
    const rows = accidentRows(body, ZBARAZH, TOE_SUB_REASON);
    expect(currentOutageOf(rows, '10', at('2026-10-20', 10))?.kind).toBe('emergency');
    expect(currentOutageOf(rows, '1-б', at('2026-10-20', 10))).toBeUndefined();
    expect(currentOutageOf(rows, '', at('2026-10-20', 10))).toBeUndefined();
  });

  it('an emergency without an end counts once it has started; a planned one without an end does not', () => {
    const body = structuredClone(ACC_383) as any;
    body['hydra:member'][0].datePlanIn = null;
    const rows = accidentRows(body, ZBARAZH, TOE_SUB_REASON);
    expect(currentOutageOf(rows, '10', at('2026-10-20', 23))).toEqual({
      kind: 'emergency', text: 'Аварійне відключення', start: '03:31 20.10.2026',
    });
    const planned = plannedRows(body, ZBARAZH);
    expect(currentOutageOf(planned, '10', at('2026-10-20', 10))).toBeUndefined();
  });

  it('switchSubReason 2 repeats the hourly schedule and is skipped; 1 and 3 are emergencies', () => {
    const withReason = (v: number) => {
      const body = structuredClone(ACC_383) as any;
      body['hydra:member'][0].switchSubReason = v;
      return currentOutageOf(accidentRows(body, ZBARAZH, TOE_SUB_REASON), '10', at('2026-10-20', 10));
    };
    expect(withReason(2)).toBeUndefined();
    expect(withReason(1)?.kind).toBe('emergency');
    expect(withReason(3)?.kind).toBe('emergency');
  });

  it('a row of another city or street never counts', () => {
    expect(accidentRows(ACC_383, { cityId: 383, streetId: 1 }, TOE_SUB_REASON)).toEqual([]);
    expect(accidentRows(ACC_383, { cityId: 1, streetId: 3752 }, TOE_SUB_REASON)).toEqual([]);
  });

  it('an outage answer of another shape throws', () => {
    expect(() => accidentRows({ 'hydra:member': null }, ZBARAZH, TOE_SUB_REASON)).toThrow(ShapeError);
    expect(() => plannedRows('<html>', ZBARAZH)).toThrow(ShapeError);
  });
});

describe('a ZTOE-like sub-reason', () => {
  const ZTOE: SubReason = (v) => {
    if (v === 0) return { kind: 'emergency', text: 'Аварійне відключення' };
    if (v === 1) return { kind: 'other', text: 'Відключення за операційною безпекою' };
    return undefined;
  };
  const PLACE = { cityId: 1, streetId: 2 };
  const row = (over: Record<string, unknown>) => ({
    city: { id: 1 }, street: { id: 2 }, buildingNames: '5', dateEvent: '2026-10-20T08:00:00Z', datePlanIn: null,
    switchSubReason: 0, ...over,
  });
  const body = (...rows: unknown[]) => ({ 'hydra:member': rows });
  const NOW = at('2026-10-20', 12);

  it('a running sub-1 row without datePlanIn counts', () => {
    const rows = accidentRows(body(row({ switchSubReason: 1 })), PLACE, ZTOE);
    expect(currentOutageOf(rows, '5', NOW)).toEqual({ kind: 'other', text: 'Відключення за операційною безпекою', start: '08:00 20.10.2026' });
  });

  it('a row the sub-reason skips is not read', () => {
    expect(accidentRows(body(row({ switchSubReason: 7 })), PLACE, ZTOE)).toEqual([]);
  });

  it('an emergency outranks a planned row, which outranks an other row, whatever their order', () => {
    const emergency = accidentRows(body(row({ switchSubReason: 0 })), PLACE, ZTOE);
    const other = accidentRows(body(row({ switchSubReason: 1 })), PLACE, ZTOE);
    const planned = plannedRows(body(row({ datePlanIn: '2026-10-20T17:00:00Z' })), PLACE);
    const kind = (rows: OutageRow[]) => currentOutageOf(rows, '5', NOW)?.kind;
    expect(kind([...other, ...planned, ...emergency])).toBe('emergency');
    expect(kind([...other, ...planned])).toBe('planned');
    expect(kind([...planned, ...other])).toBe('planned');
    expect(kind(other)).toBe('other');
  });

  it('sameHouse decides the house match', () => {
    const rows = accidentRows(body(row({ buildingNames: '5-А' })), PLACE, ZTOE);
    expect(currentOutageOf(rows, '5-а', NOW)).toBeUndefined();
    const lower = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    expect(currentOutageOf(rows, '5-а', NOW, lower)?.kind).toBe('emergency');
  });
});
