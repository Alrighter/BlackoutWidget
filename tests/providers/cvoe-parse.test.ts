import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CvoeShapeError, parseCvoePage, parseDistrictPage, groupLines, groupLabel, cvoeStreets, cvoeHouses,
  parseOutageReply, streetWords, placeWords, type CvoeRow,
} from '../../src/main/providers/cvoe/parse';
import { ShapeError } from '../../src/main/providers/shape';

const DIR = join(__dirname, '..', 'fixtures', 'cvoe');
const fx = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const NEXT = fx('schedule_2025-11-05_next-view_with-outages_from-sso-notifier-MIT.html');
const TODAY = fx('schedule_2025-10-31_today-only_from-sso-notifier-MIT.html');
const LIVE = fx('schedule_2026-10-20_live_table-dated-18.10_all-on.html');
const EMERGENCY = fx('schedule_emergency-mode_no-gsv_from-sso-notifier-MIT.html');
const D1 = fx('search_d1_Chernivtsi-city_TRIMMED-first-1500-of-25964-rows.html');
const D3 = fx('search_d3_Hertsa_TRIMMED-first-1500-of-6817-rows.html');
const D8 = fx('search_d8_Novoselytsia_TRIMMED-first-1200-of-28164-rows.html');
const PLANNED = JSON.parse(fx('current_planned_2026-10-21_cherniv_Cher-vul_page1.json')) as unknown;
const EMPTY = JSON.parse(fx('current_empty_nothing-found.json')) as unknown;
const REQUIRED = JSON.parse(fx('current_required-error.json')) as unknown;

function table(html: string) {
  const p = parseCvoePage(html);
  if (p.kind !== 'table') throw new Error('expected a table');
  return p;
}

describe('parseCvoePage', () => {
  it('reads the ?next view', () => {
    const p = table(NEXT);
    expect(p.date).toBe('2025-11-05');
    expect(p.updatedHM).toBe('20:00');
    const all = Object.values(p.groups).flat();
    expect(all.filter(s => s === 'off')).toHaveLength(52);
    expect(all.filter(s => s === 'maybe-off')).toHaveLength(22);
    const g12 = p.groups['12'];
    expect(g12[30]).toBe('maybe-off');
    expect(g12.slice(31, 36).every(s => s === 'off')).toBe(true);
    expect(g12[36]).toBe('maybe-off');
    expect(p.nextLink).toBe(false);
  });

  it('reads the today-only view and sees the next link', () => {
    const p = table(TODAY);
    expect(p.nextLink).toBe(false);
    expect(p.groups['12'][27]).toBe('maybe-off');
    expect(table(TODAY.replace('<b>31.10.2025</b>', '<b>31.10.2025</b><a href="/shutdowns/?next">01.11.2025</a>')).nextLink).toBe(true);
  });

  it('reads the live page', () => {
    const p = table(LIVE);
    expect(p.date).toBe('2026-10-18');
    expect(Object.keys(p.groups)).toHaveLength(12);
    expect(Object.values(p.groups).flat().every(s => s === 'on')).toBe(true);
  });

  it('reads emergency mode', () => {
    expect(parseCvoePage(EMERGENCY)).toEqual({ kind: 'emergency' });
  });

  it('throws on a shape it does not know, with a fixed reason', () => {
    const cuts: Array<[string, string]> = [
      ['47 cells', NEXT.replace('<u>з</u>', '')],
      ['a wrong cell tag', NEXT.replace('<u>з</u>', '<b>з</b>')],
      ['no inf7', NEXT.replace('id="inf7"', 'id="infx7"')],
      ['both shapes', NEXT.replace('<article class="wrap_article wrap_article_v2">', '<article class="wrap_article wrap_article_v2 wrap_article_v2_emergency">')],
      ['neither shape', '<html><body>hello</body></html>'],
    ];
    for (const [, html] of cuts) {
      let err: unknown;
      try { parseCvoePage(html); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(CvoeShapeError);
      expect(err).toBeInstanceOf(ShapeError);
      expect((err as Error).message).not.toMatch(/<|hello/);
    }
  });
});

describe('parseDistrictPage', () => {
  it('reads district 3 with the settlement', () => {
    const rows = parseDistrictPage(D3, 3);
    expect(rows.length).toBeGreaterThan(1000);
    expect(rows[0]).toEqual({ settlement: 'с. Остриця', street: 'вул. Кишинівська', house: 'буд. 12', group: '1' });
  });

  it('reads the city without a settlement', () => {
    const rows = parseDistrictPage(D1, 1);
    expect(rows[0]).toEqual({ street: '1-й ПРОВ.ТАДЖИЦЬКИЙ', house: '1', group: '8' });
    expect(rows.every(r => r.settlement === undefined)).toBe(true);
  });

  it('reads district 8', () => {
    expect(parseDistrictPage(D8, 8).length).toBeGreaterThan(1000);
  });

  it('throws on a row of another shape, an empty container and a missing container', () => {
    expect(() => parseDistrictPage(D3.replace('<div><s>с. Остриця</s><p>вул. Кишинівська</p><b>буд. 12</b><u>1</u></div>', '<div><p>x</p></div>'), 3)).toThrow(CvoeShapeError);
    expect(() => parseDistrictPage('<div id="obl_tbl" class="res_tbl"><div class="h_line"><s>a</s></div></div>', 3)).toThrow(CvoeShapeError);
    expect(() => parseDistrictPage(D3, 1)).toThrow(CvoeShapeError);
  });

  it('keeps an odd group raw', () => {
    const rows = parseDistrictPage(D3.replace('<b>буд. 12</b><u>1</u>', '<b>буд. 12</b><u>А</u>'), 3);
    expect(rows[0].group).toBe('А');
  });
});

describe('groupLines', () => {
  it('lists distinct groups in numeric order', () => {
    expect(groupLines(['8', '12', '8'])).toEqual([
      { index: 1, groupId: '8', label: 'Група 8' },
      { index: 2, groupId: '12', label: 'Група 12' },
    ]);
    expect(groupLabel('3')).toBe('Група 3');
  });
  it('throws on anything but an integer 1-12', () => {
    for (const g of ['13', 'А', '', '8.1', '0', '08']) expect(() => groupLines([g])).toThrow(CvoeShapeError);
  });
});

describe('streets and houses', () => {
  const row = (street: string, house: string, group: string): CvoeRow => ({ street, house, group });
  it('shows the commonest spelling of a street', () => {
    const rows = [row('вул. Франка', '1', '1'), row('вул. франка', '2', '1'), row('вул. франка', '3', '1'), row('вул. Зелена', '1', '1')];
    expect(cvoeStreets(rows)).toEqual(['вул. Зелена', 'вул. франка']);
    expect(cvoeStreets([row('Aa', '1', '1'), row('Аа', '2', '1')])).toEqual(['Aa']);
  });
  it('merges the spellings of one house', () => {
    const rows = [row('s', 'буд. 12А', '8'), row('s', '12 а', '12'), row('s', 'буд. 12-А', '8')];
    expect(cvoeHouses(rows)).toEqual([{
      house: '12А', outageActive: false,
      lines: [{ index: 1, groupId: '8', label: 'Група 8' }, { index: 2, groupId: '12', label: 'Група 12' }],
    }]);
  });
  it('orders houses numerically', () => {
    const rows = [row('s', 'буд. 10', '1'), row('s', 'буд. 2', '1')];
    expect(cvoeHouses(rows).map(h => h.house)).toEqual(['2', '10']);
  });
  it('a bad group breaks the street', () => {
    expect(() => cvoeHouses([row('s', '1', 'А')])).toThrow(CvoeShapeError);
  });
});

describe('parseOutageReply', () => {
  it('reads the planned reply', () => {
    const { rows, pages } = parseOutageReply(PLANNED);
    const r = rows.find(x => x.street === 'вул. КАДЕНЮКА ЛЕОНІДА');
    expect(r).toBeDefined();
    expect(r!.settlement).toBe('м. Чернівці');
    expect(r!.houses).toContain('буд. 22А');
    expect(r!.start).toBe('2026-10-21 09:00:00');
    expect(r!.end).toBe('2026-10-21 20:00:00');
    expect(pages).toBe(6);
  });
  it('reads the empty reply', () => {
    expect(parseOutageReply(EMPTY)).toEqual({ rows: [], pages: 1 });
  });
  it('throws on the validation reply and on other shapes', () => {
    expect(() => parseOutageReply(REQUIRED)).toThrow(CvoeShapeError);
    expect(() => parseOutageReply(null)).toThrow(CvoeShapeError);
    expect(() => parseOutageReply('x')).toThrow(CvoeShapeError);
    expect(() => parseOutageReply({ data: '<tbody></tbody>' })).toThrow(CvoeShapeError);
    const bad = JSON.parse(JSON.stringify(PLANNED).replace('2026-10-21 09:00:00', 'вчора')) as unknown;
    expect(() => parseOutageReply(bad)).toThrow(CvoeShapeError);
  });
});

describe('word sets', () => {
  it('matches a street across the two forms', () => {
    expect(streetWords('вул. КАДЕНЮКА ЛЕОНІДА')).toEqual(streetWords('КАДЕНЮКА ЛЕОНІДА'));
    expect(streetWords('вул. КАДЕНЮКА ЛЕОНІДА')).not.toEqual(streetWords('вул. КАДЕНЮКА ЛЕОНІДА ПРОВ.'));
    expect(streetWords('ПРОВ. КАДЕНЮКА ЛЕОНІДА')).toEqual(streetWords('вул. КАДЕНЮКА ЛЕОНІДА ПРОВ.'));
    expect(streetWords('КАДЕНЮКА ЛЕОНІДА')).toEqual(streetWords('КАДЕНЮКА ЛЕОНIДА'));
  });
  it('drops the settlement prefix', () => {
    expect(placeWords('м. Чернівці')).toEqual(['чернівці']);
    expect(placeWords('с. Нова Жучка')).toEqual(['жучка', 'нова']);
  });
});
