import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  housesOf, isHouseNumber, matchOutage, parseOutageTable, parseQueueTable, type OutageRow,
} from '../../src/main/providers/voe/html';
import { kyivWallTimeToInstant } from '../../src/shared/time';

const cherga = readFileSync('tests/fixtures/voe/cherga-kovel-all.html', 'utf8');
const chomu = readFileSync('tests/fixtures/voe/chomu-nemaie-kovel.html', 'utf8');
const at = (h: number, m: number) => kyivWallTimeToInstant('2026-10-20', h * 60 + m);

describe('parseQueueTable', () => {
  const rows = parseQueueTable(cherga);

  it('reads every data row of the saved response', () => {
    expect(rows).toHaveLength(1908);
  });

  it('reads Cyrillic as UTF-8', () => {
    expect(rows.some((r) => r.settlement === 'Ковель')).toBe(true);
  });

  it('finds 300 distinct streets in Ковель', () => {
    const streets = new Set(rows.filter((r) => r.settlement === 'Ковель').map((r) => r.street));
    expect(streets.size).toBe(300);
  });

  it('parses a known row', () => {
    expect(rows).toContainEqual({
      raion: 'Ковельський', settlement: 'Ковель', street: 'Незалежності', houses: ['101', '101А', '89'], gpv: '2.2',
    });
  });

  it('writes a house letter in one form, once per row («12-A, 12-А, 12А» → «12А»)', () => {
    const row = rows.find((r) => r.street === 'Тараса Бульби-Боровця' && r.houses.includes('12А'))!;
    expect(row.houses).toEqual(['12А']);
  });

  it('drops junk house entries', () => {
    expect(rows.some((r) => r.houses.includes('<>'))).toBe(false);
    expect(rows.every((r) => r.houses.every(isHouseNumber))).toBe(true);
  });
});

describe('isHouseNumber', () => {
  it('keeps real house numbers', () => {
    for (const h of ['2А', '15/2', '7-А', '101']) expect(isHouseNumber(h)).toBe(true);
  });
  it('drops junk', () => {
    for (const h of ['<>', 'Адреса невідома', 'біля буд. 122', 'гараж 17', '142/', '62А/гараж 47']) {
      expect(isHouseNumber(h)).toBe(false);
    }
  });
});

describe('housesOf', () => {
  const rows = parseQueueTable(cherga).filter((r) => r.settlement === 'Ковель');
  const houses = housesOf(rows, 'Незалежності');

  it('lists a house in two queues, the real one first and none last', () => {
    expect(houses.find((h) => h.house === '25')).toEqual({
      house: '25',
      lines: [
        { index: 1, groupId: '4.2', label: 'Черга 4.2' },
        { index: 2, groupId: 'none', label: 'Не залучено до ГПВ' },
      ],
      outageActive: false,
    });
  });

  it('lists a house with one queue', () => {
    expect(houses.find((h) => h.house === '101А')?.lines).toEqual([{ index: 1, groupId: '2.2', label: 'Черга 2.2' }]);
  });

  it('sorts houses numerically', () => {
    const names = houses.map((h) => h.house);
    expect(names.indexOf('2')).toBeLessThan(names.indexOf('10'));
  });

  it('offers one house for a Latin and a Cyrillic letter (Грушевського: «2a, 2А»)', () => {
    const names = housesOf(rows, 'Грушевського').map((h) => h.house);
    expect(names.filter((h) => /^2(-?[AaАа])?$/.test(h))).toEqual(['2', '2А']);
  });

  it('offers one house for «12-A, 12-А, 12А» (Тараса Бульби-Боровця), in the form «12А»', () => {
    const list = housesOf(rows, 'Тараса Бульби-Боровця');
    expect(list.map((h) => h.house).filter((h) => /^12(-?[AaАа])?$/.test(h))).toEqual(['12', '12А']);
    expect(list.find((h) => h.house === '12А')?.lines).toEqual([{ index: 1, groupId: '1.1', label: 'Черга 1.1' }]);
  });

  it('finds a street by either apostrophe', () => {
    const rows2 = [
      { raion: 'Р', settlement: 'А', street: 'Левка Лук’яненка', houses: ['1'], gpv: '1.1' },
      { raion: 'Р', settlement: 'А', street: "Левка Лук'яненка", houses: ['2'], gpv: '1.2' },
    ];
    expect(housesOf(rows2, "Левка Лук'яненка").map((h) => h.house)).toEqual(['1', '2']);
  });
});

describe('parseOutageTable and matchOutage', () => {
  const rows = parseOutageTable(chomu);
  const now = at(10, 0);

  it('converts the dates', () => {
    expect(rows.find((r) => r.street === 'Андрія Малишка')).toMatchObject({
      settlement: 'Ковель', type: 'Аварійне вимкнення', start: '20.10.2026 09:50', end: '20.10.2026 11:51',
    });
  });

  it('reads the district from the first column', () => {
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.raion === 'Ковельський')).toBe(true);
  });

  it('matches the emergency in Ковель', () => {
    expect(matchOutage(rows, { settlement: 'Ковель', street: 'Самійла Величка', house: '7А' }, now)).toEqual({
      kind: 'emergency', text: 'Аварійний випадок в мережах', start: '20.10.2026 09:50', end: '20.10.2026 11:51',
    });
  });

  it('matches the planned outage in Воля-Ковельська', () => {
    const o = matchOutage(rows, { settlement: 'Воля-Ковельська', street: 'Воля', house: '28А' }, now);
    expect(o?.kind).toBe('planned');
    expect(o?.text).toBe('Планові ремонтні роботи');
  });

  it('ignores a house that is not in the list', () => {
    expect(matchOutage(rows, { settlement: 'Ковель', street: 'Самійла Величка', house: '2' }, now)).toBeUndefined();
  });

  it('matches the settlement exactly', () => {
    expect(matchOutage(rows, { settlement: 'Ковель', street: 'Воля', house: '28А' }, now)).toBeUndefined();
  });

  it('returns nothing once the outage ended and none follows', () => {
    expect(matchOutage(rows, { settlement: 'Ковель', street: 'Самійла Величка', house: '7А' }, at(12, 0))).toBeUndefined();
  });

  it('returns an outage that starts later today', () => {
    const o = matchOutage(rows, { settlement: 'Ковель', street: 'Самійла Величка', house: '7А' }, at(8, 0));
    expect(o?.kind).toBe('emergency');
  });

  it('prefers emergency over planned when both are active', () => {
    const mk = (type: string, reason: string) => ({
      raion: 'Р', settlement: 'А', street: 'Б', houses: ['1'], type, reason, start: '20.10.2026 09:00', end: '20.10.2026 12:00',
    });
    const o = matchOutage([mk('Планове вимкнення', 'p'), mk('Аварійне вимкнення', 'e')], { settlement: 'А', street: 'Б', house: '1' }, now);
    expect(o?.text).toBe('e');
  });

  it('skips schedule-type rows and maps unknown types to other', () => {
    const mk = (type: string) => ({
      raion: 'Р', settlement: 'А', street: 'Б', houses: ['1'], type, reason: 'r', start: '20.10.2026 09:00', end: '20.10.2026 12:00',
    });
    const addr = { settlement: 'А', street: 'Б', house: '1' };
    expect(matchOutage([mk('Відключення за графіком')], addr, now)).toBeUndefined();
    expect(matchOutage([mk('Щось інше')], addr, now)?.kind).toBe('other');
  });

  describe('names written differently by the operator', () => {
    const row = (over: Partial<OutageRow>): OutageRow => ({
      raion: 'Ковельський', settlement: 'Ковель', street: 'Самійла Величка', houses: ['7А'],
      type: 'Аварійне вимкнення', reason: 'r', start: '20.10.2026 09:00', end: '20.10.2026 12:00', ...over,
    });

    it('matches a house saved as «2А» to an outage row listing «2a»', () => {
      expect(matchOutage([row({ houses: ['2a'] })], { settlement: 'Ковель', street: 'Самійла Величка', house: '2А' }, now)?.kind)
        .toBe('emergency');
    });

    it('matches «12А» to «12-A» in a parsed outage table', () => {
      const parsed = parseOutageTable(chomu.replace('<td>16, 1, 1В, 6, 7А,', '<td>16, 1, 1В, 6, 12-A, 7А,'));
      expect(matchOutage(parsed, { settlement: 'Ковель', street: 'Самійла Величка', house: '12А' }, now)?.kind).toBe('emergency');
    });

    it('matches a street saved with U+2019 to an outage row written with U+0027', () => {
      const rows2 = [row({ street: "В'ячеслава Хурсенка" })];
      expect(matchOutage(rows2, { settlement: 'Ковель', street: 'В’ячеслава Хурсенка', house: '7А' }, now)?.kind).toBe('emergency');
    });

    it('matches a settlement with an apostrophe or a Latin look-alike letter', () => {
      const addr = { settlement: 'В’язівне', street: 'Самійла Величка', house: '7А' };
      expect(matchOutage([row({ settlement: "В'язівне" })], addr, now)?.kind).toBe('emergency');
      expect(matchOutage([row({ settlement: 'В’язiвне' /* Latin i */ })], addr, now)?.kind).toBe('emergency');
    });
  });

  it('reads reworded outage types by their stem', () => {
    const mk = (type: string) => ({
      raion: 'Р', settlement: 'А', street: 'Б', houses: ['1'], type, reason: 'r', start: '20.10.2026 09:00', end: '20.10.2026 12:00',
    });
    const addr = { settlement: 'А', street: 'Б', house: '1' };
    const kind = (type: string) => matchOutage([mk(type)], addr, now)?.kind;
    expect(kind('Аварійне відключення')).toBe('emergency');
    expect(kind('аварійне вимкнення')).toBe('emergency');
    expect(kind('Екстрене відключення')).toBe('emergency');
    // Unscheduled is not planned, though the word holds «планов»: no «Планове» badge for it.
    expect(kind('Позапланове вимкнення')).toBe('emergency');
    expect(kind('планове вимкнення (ремонт)')).toBe('planned');
    expect(kind('Планове відключення')).toBe('planned');
    expect(kind('Застосування графіків обмеження')).toBeUndefined();
  });
});
