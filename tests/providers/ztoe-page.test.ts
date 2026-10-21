import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  decodeCp1251, parseZtoeSchedule, parseOptions, parseResultRows, ztoeHouses, ZtoeShapeError,
} from '../../src/main/providers/ztoe/page';
import { QueueValueError } from '../../src/main/providers/lines';
import { ShapeError } from '../../src/main/providers/shape';
import { decodeEntities, htmlText } from '../../src/main/providers/html';

const DIR = join(__dirname, '..', 'fixtures', 'ztoe');
function fx(name: string): string {
  const b = readFileSync(join(DIR, name));
  return decodeCp1251(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
}
const LIVE = 'unhooking-search-2026-10-20-1728-live-cp1251.html';
const TWO_DAYS = 'unhooking-search-2026-10-13-two-days-wayback-cp1251.html';
const QUIET = 'unhooking-search-2026-04-26-quiet-day-wayback-cp1251.html';
const KYIVSKA = 'address-result-zhytomyr-kyivska-all-cp1251.html';

const offCount = (s: ReturnType<typeof parseZtoeSchedule>): number =>
  [...s.days.values()].reduce((n, d) => n + Object.values(d).reduce((m, slots) => m + slots.filter(x => x === 'off').length, 0), 0);

describe('html helpers', () => {
  it('decodes the entities the operator uses', () => {
    expect(decodeEntities('a&amp;b &lt;c&gt; &quot;d&quot;&nbsp;e &#039;f&#8217; &#x41;')).toBe('a&b <c> "d" e \'f’ A');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&#99999999;')).toBe('&#99999999;');
  });
  it('reads a fragment as text', () => {
    expect(htmlText(' <b>a</b><br>\n b  &amp;<br/> c ')).toBe('a b & c');
  });
});

describe('parseZtoeSchedule', () => {
  it('reads the 20.10 live page', () => {
    const s = parseZtoeSchedule(fx(LIVE));
    expect(s.updatedAt).toBe('17:00 20.10.2026');
    expect([...s.days.keys()]).toEqual(['2026-10-20']);
    const day = s.days.get('2026-10-20')!;
    expect(Object.keys(day)).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']);
    const off = new Set([28, 29, 30, 31, 32, 33, 44, 45, 46, 47]);
    expect(day['1.1']).toHaveLength(48);
    day['1.1'].forEach((slot, i) => expect(slot).toBe(off.has(i) ? 'off' : 'on'));
    expect(offCount(s)).toBe(118);
  });
  it('takes the banner without its heading and the search caption', () => {
    const b = parseZtoeSchedule(fx(LIVE)).banner!;
    expect(b.startsWith('На 12:30 20.10.2026р. НЕК "Укренерго"')).toBe(true);
    expect(b.endsWith('з 22:00 до 24:00 - 1,0 черга')).toBe(true);
    expect(b).not.toMatch(/<|&quot;|Пошук черги|УВАГА/);
  });
  it('reads the two-day 13.10 page', () => {
    const s = parseZtoeSchedule(fx(TWO_DAYS));
    expect([...s.days.keys()]).toEqual(['2026-10-13', '2026-10-14']);
    expect(s.updatedAt).toBe('22:30 13.10.2026');
    expect(offCount(s)).toBe(230);
  });
  it('reads the quiet 26.04 day', () => {
    const s = parseZtoeSchedule(fx(QUIET));
    expect(offCount(s)).toBe(0);
    expect([...s.days.values()].flatMap(d => Object.values(d)).flat().filter(x => x === 'on')).toHaveLength(576);
    expect(s.banner).toContain('не надходило');
  });
  it('reads the schedule inside an address page', () => {
    expect(parseZtoeSchedule(fx('post-rem5-ns16205-cp1251.html')).days.size).toBeGreaterThan(0);
  });

  describe('fails closed', () => {
    const live = fx(LIVE);
    const afterLabel = live.indexOf('color:black;">1.1</b>');
    const swap = (s: string, a: string, b: string): string => s.replace(a, '@@').replace(b, a).replace('@@', b);

    it('on a row of 47 cells', () => {
      const html = live.slice(0, afterLabel) + live.slice(afterLabel).replace('background: #ffffff', 'background: white');
      expect(() => parseZtoeSchedule(html)).toThrow(ZtoeShapeError);
    });
    it('on a colour it does not know', () => {
      const html = live.slice(0, afterLabel) + live.slice(afterLabel).replace('background: #ffffff', 'background: #ff0000');
      expect(() => parseZtoeSchedule(html)).toThrow(ZtoeShapeError);
    });
    it('on rows out of order', () => {
      const html = swap(live, 'color:black;">1.1</b>', 'color:black;">1.2</b>');
      expect(() => parseZtoeSchedule(html)).toThrow(ZtoeShapeError);
    });
    it('on a missing stamp, such as mojibake', () => {
      expect(() => parseZtoeSchedule(live.replace('Дата оновлення', 'Дата'))).toThrow(ZtoeShapeError);
    });
    it('on the same date twice', () => {
      const html = fx(TWO_DAYS).replace('>14.10.2026</b>', '>13.10.2026</b>');
      expect(() => parseZtoeSchedule(html)).toThrow(ZtoeShapeError);
    });
    it('on a page with no date table', () => {
      expect(() => parseZtoeSchedule('<h4>Дата оновлення інформації - 17:00 20.10.2026</h4>')).toThrow(ZtoeShapeError);
    });
    it('with a fixed message that is a ShapeError', () => {
      try {
        parseZtoeSchedule(live.replace('Дата оновлення', 'Дата'));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(ShapeError);
        expect((e as Error).message).not.toContain('Дата');
      }
    });
  });
});

describe('parseOptions', () => {
  it('lists the streets of Березівка in page order', () => {
    expect(parseOptions(fx('post-rem5-ns16205-cp1251.html'), 'vulica_id')).toEqual([
      { id: 168893, name: 'вул. Вишнева' },
      { id: 168894, name: 'вул. Садова' },
      { id: 168895, name: 'вул. Центральна' },
      { id: 169498, name: 'КТП-2' },
    ]);
  });
  it('lists the 19 РЕМ and the settlements of one', () => {
    const rems = parseOptions(fx(LIVE), 'rem_id');
    expect(rems).toHaveLength(19);
    expect(rems[0]).toEqual({ id: 1, name: 'Андрушівський' });
    expect(parseOptions(fx('post-rem5-ns16205-cp1251.html'), 'naspunkt_id').some(o => o.id === 16205)).toBe(true);
  });
  it('throws on a disabled select', () => {
    expect(() => parseOptions(fx(LIVE), 'vulica_id')).toThrow(ZtoeShapeError);
  });
  it('throws on a missing select and gives [] for a select with only the placeholder', () => {
    expect(() => parseOptions('<html></html>', 'rem_id')).toThrow(ZtoeShapeError);
    expect(parseOptions('<select name="vulica_id"><option value="0">Оберіть</option></select>', 'vulica_id')).toEqual([]);
  });
});

const row = (houses: string, q: string, s: string, note = 'побутові споживачі'): string =>
  `<tr><td>Р</td><td>М</td><td>вул.</td><td>${houses}</td><td>${q}</td><td>${s}</td><td>${note}</td></tr>`;
const page = (n: number, rows: string[]): string =>
  `<b>За Вашим запитом знайдено записів: ${n}</b><table><tr><td>РЕМ</td><td>Населений пункт</td><td>Назва</td><td>Будинки</td><td>Черга</td><td>Підчерга</td><td>Примітка</td></tr>${rows.join('')}</table>`;

describe('parseResultRows', () => {
  it('reads all 77 rows of Київська', () => {
    expect(parseResultRows(fx(KYIVSKA))).toHaveLength(77);
  });
  it('refuses a paged result', () => {
    expect(() => parseResultRows(fx('address-result-zhytomyr-kyivska-first10-cp1251.html'))).toThrow(ZtoeShapeError);
  });
  it('reads the captured live Березівка page', () => {
    expect(parseResultRows(fx('post-rem5-ns16205-st168893-all-cp1251.html'))).toEqual([
      expect.objectContaining({ queue: '5.1', household: true }),
      { houses: ['18'], queue: '5.1', household: false },
    ]);
  });
  it('splits houses on commas and drops empties', () => {
    expect(parseResultRows(page(1, [row('1, 2А,, 3 ', '5', '1')]))[0]).toEqual({ houses: ['1', '2А', '3'], queue: '5.1', household: true });
  });
  it('needs the count line to match the rows', () => {
    expect(() => parseResultRows(page(2, [row('1', '5', '1')]))).toThrow(ZtoeShapeError);
    expect(() => parseResultRows('<table></table>')).toThrow(ZtoeShapeError);
    expect(parseResultRows(page(0, []))).toEqual([]);
  });
  it('throws on an unknown note', () => {
    expect(() => parseResultRows(page(1, [row('1', '5', '1', 'інше')]))).toThrow(ZtoeShapeError);
  });
  it('throws QueueValueError on a queue cell it does not know', () => {
    expect(() => parseResultRows(page(1, [row('1', '5а', '1')]))).toThrow(QueueValueError);
    expect(() => parseResultRows(page(1, [row('1', '5', 'В цей час не вимикається, за винятком випадків аварійних відключень')]))).toThrow(QueueValueError);
  });
});

describe('ztoeHouses', () => {
  const houses = ztoeHouses(parseResultRows(fx(KYIVSKA)));
  const get = (h: string) => houses.find(x => x.house === h);
  const ids = (h: string) => get(h)?.lines.map(l => l.groupId);

  it('gives a house its household queues', () => {
    expect(ids('84')).toEqual(['1.1']);
    expect(ids('56')).toEqual(['3.1', '6.2']);
    expect(ids('1')).toEqual(['1.1', '1.2', '5.2']);
  });
  it('falls back to the legal rows of a house with no household row', () => {
    expect(ids('77')).toEqual(['1.1', '3.2']);
  });
  it('gives the none line to a house that is not switched', () => {
    expect(ids('72')).toEqual(['none']);
  });
  it('merges «91-А» and «91А» under the first spelling', () => {
    expect(get('91-А')?.lines.map(l => l.groupId)).toEqual(['none']);
    expect(get('91А')).toBeUndefined();
  });
  it('orders houses naturally and marks none active', () => {
    const names = houses.map(h => h.house);
    expect(names).toEqual([...names].sort(new Intl.Collator('uk', { numeric: true }).compare));
    expect(houses.every(h => !h.outageActive)).toBe(true);
  });
  it('reads Березівка 18 from its legal row', () => {
    const rows = parseResultRows(fx('address-result-berezivka-vyshneva-cp1251.html'));
    expect(ztoeHouses(rows).find(h => h.house === '18')?.lines.map(l => l.groupId)).toEqual(['5.1']);
  });
});
