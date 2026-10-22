// The schedule pages are saved answers of CEK's form (cek.md §1): queue=all for 15.01.2026 (a real outage day, all 12
// queues), queue=1.1 for that day, and queue=all for 20.10.2026 (quiet). The map page is the live page of 21.10.2026
// with its `const locations` object cut to 8 streets of 3 cities, the text around it and the \uXXXX escapes as served
// (cek.md §2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CEK_DTEK_NOTE, CekShapeError, cekLines, extractLocations, parseCekDay } from '../../src/main/providers/cek/parse';
import { QueueValueError } from '../../src/main/providers/lines';
import { ShapeError } from '../../src/main/providers/shape';
import type { Slot } from '../../src/shared/types';

const DIR = join(__dirname, '..', 'fixtures', 'cek');
const fx = (n: string): string => readFileSync(join(DIR, n), 'utf8');

const MAP_PAGE = fx('map-page.html');
const DAY = fx('cek-gpv-post-all-2026-01-15.html.txt');
const ONE = fx('cek-gpv-post-1.1-2026-01-15.html.txt');
const QUIET = fx('cek-gpv-post-all-2026-10-20-quiet.html.txt');
/** The dates the saved answers were asked for, as the form echoes them. */
const JAN15 = '2026-01-15';
const OCT20 = '2026-10-20';

/** `s` with the first match of `from` replaced; a `from` that is not there is a broken test. */
function swap(s: string, from: string | RegExp, to: string): string {
  if (typeof from === 'string' ? !s.includes(from) : !from.test(s)) throw new Error(`nothing to replace: ${String(from)}`);
  return s.replace(from, to);
}

const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
/** 48 slots, `off` in the given inclusive slot ranges. */
const offIn = (...ranges: [number, number][]): Slot[] =>
  Array.from({ length: 48 }, (_, k): Slot => (ranges.some(([a, b]) => k >= a && k <= b) ? 'off' : 'on'));
const line = (index: number, groupId: string) => ({ index, groupId, label: `Черга ${groupId}` });

describe('extractLocations', () => {
  const map = extractLocations(MAP_PAGE);

  it('reads the trimmed object of the live page, its escaped Cyrillic decoded', () => {
    // The page serves the names escaped: «м. Дніпро» is not written as such inside the object.
    expect(MAP_PAGE).toContain('const locations = {"\\u043c. \\u0414\\u043d\\u0456\\u043f\\u0440\\u043e":{');
    expect(Object.keys(map)).toEqual(['м. Дніпро', 'м. Жовті Води', 'с. Петриківка']);
    expect(Object.keys(map['м. Дніпро'])).toEqual([
      'ЖК "Грани"', 'пров. Тюленіна', 'вул. Філатова', 'вул. Робоча', 'вул. Національної Гвардії',
    ]);
    expect(Object.keys(map['м. Жовті Води'])).toEqual(['вул. Спортивна']);
    expect(map['с. Петриківка']).toEqual({ 'вул. Леваневського': { 'Усі дома': '4.1' }, 'вул. Будівельна': { 'Усі дома': '4.1' } });
    const houses = Object.values(map).flatMap((c) => Object.values(c)).flatMap((s) => Object.keys(s));
    expect(houses).toHaveLength(97);
  });

  it('keeps every value variant and every key as served', () => {
    expect(map['м. Дніпро']['ЖК "Грани"']).toEqual({ 'Усі будинки': 'Черга 3' });
    expect(map['м. Дніпро']['вул. Національної Гвардії']['9']).toBe('Група 3.1 (АТ "ДТЕК ДЕМ")');
    expect(map['м. Дніпро']['вул. Робоча'][' 162']).toBe('Черга 3.2');
    expect(map['м. Жовті Води']['вул. Спортивна']['19\r\n']).toBe('Черга 6.1');
    expect(map['м. Жовті Води']['вул. Спортивна']['2']).toBe('Черга 6.1 та 2.1');
    expect(map['м. Дніпро']['вул. Філатова']).toEqual(Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((h) => [h, 'Черга 1.1'])));
  });

  it('scans by braces outside strings: a brace or an escaped quote inside a name does not end the object', () => {
    const page = '<script> const x = {}; const locations = {"a}\\"":{"b{":{"1":"Черга 1.1"}}}; \nfunction filterCity() {}';
    expect(extractLocations(page)).toEqual({ 'a}"': { 'b{': { 1: 'Черга 1.1' } } });
  });

  it('throws a fixed-reason CekShapeError for a page without the object, a cut object or another shape', () => {
    const cut = MAP_PAGE.slice(0, MAP_PAGE.indexOf('const locations = ') + 5000);
    for (const [page, reason] of [
      ['<html>Технічні роботи</html>', 'no locations object'],
      ['const locations = [];', 'no locations object'],
      [cut, 'locations object never closes'],
      ['const locations = {"м. X":{"вул. Y":{"1":"Черга 1.1",}}};', 'locations object is not JSON'],
      ['const locations = {};', 'cities: none'],
      ['const locations = {"м. X":{}};', 'streets: none'],
      ['const locations = {"м. X":{"вул. Y":{}}};', 'houses: none'],
      ['const locations = {"м. X":{"вул. Y":{"1":11}}};', 'houses: a value is not text'],
      ['const locations = {"м. X":{"вул. Y":"Черга 1.1"}};', 'houses: not an object'],
      ['const locations = {"м. X":{"вул. Y":{"  ":"Черга 1.1"}}};', 'houses: a blank name'],
    ]) {
      let err: unknown;
      try {
        extractLocations(page);
      } catch (e) {
        err = e;
      }
      expect(err, reason).toBeInstanceOf(CekShapeError);
      expect(err, reason).toBeInstanceOf(ShapeError);
      expect((err as Error).message).toBe(reason);
    }
  });
});

describe('cekLines', () => {
  it('reads every value variant of the map', () => {
    expect(cekLines('Черга 5.2')).toEqual({ lines: [line(1, '5.2')] });
    expect(cekLines('Черга 6.1 та 2.1')).toEqual({ lines: [line(1, '2.1'), line(2, '6.1')] });
    expect(cekLines('Черга 2')).toEqual({ lines: [line(1, '2.1'), line(2, '2.2')] });
    expect(cekLines('4.1')).toEqual({ lines: [line(1, '4.1')] });
    expect(cekLines(' Черга 1.1\r\n')).toEqual({ lines: [line(1, '1.1')] });
  });

  it('a house DTEK switches has no lines and the note pointing to DTEK', () => {
    expect(cekLines('Група 3.1 (АТ "ДТЕК ДЕМ")')).toEqual({ lines: [], note: CEK_DTEK_NOTE });
    expect(cekLines('Група 5.1 (АТ "ДТЕК ДЕМ")')).toEqual({ lines: [], note: CEK_DTEK_NOTE });
    expect(CEK_DTEK_NOTE).toBe('Цей будинок відключає ДТЕК — оберіть «ДТЕК Дніпровські електромережі»');
  });

  it('anything else is a QueueValueError, never the always-on line', () => {
    for (const value of [
      'Черга 7.1', 'Черга 1.3', 'черга 1.1', 'Черга', 'Черга 0.1', 'Черга 7', 'Черга 1.1 та 7.2', '7.1', '',
      'Група 7.1 (АТ "ДТЕК ДЕМ")', 'Група 3.1', 'Не входить до ГПВ',
    ]) {
      expect(() => cekLines(value), value).toThrow(QueueValueError);
    }
  });
});

describe('parseCekDay', () => {
  it('reads all 12 queues of 15.01.2026: an interval is off, the rest on, 23:59 is the end of the day', () => {
    const day = parseCekDay(DAY, JAN15)!;
    expect(Object.keys(day).sort()).toEqual(QUEUES);
    // 1.1: 02:00–05:30, 09:00–16:00, 19:30–23:59.
    expect(day['1.1']).toEqual(offIn([4, 10], [18, 31], [39, 47]));
    // 2.1: 00:00–05:30, 09:00–16:00, 23:30–23:59.
    expect(day['2.1']).toEqual(offIn([0, 10], [18, 31], [47, 47]));
    // 1.2: 02:00–05:30, 09:00–16:00, 19:30–22:30, 23:30–23:59.
    expect(day['1.2']).toEqual(offIn([4, 10], [18, 31], [39, 44], [47, 47]));
    for (const q of QUEUES) expect(day[q]).toHaveLength(48);
  });

  it('the quiet page is undefined; the single-queue page has only 1.1', () => {
    expect(parseCekDay(QUIET, OCT20)).toBeUndefined();
    const one = parseCekDay(ONE, JAN15)!;
    expect(Object.keys(one)).toEqual(['1.1']);
    expect(one['1.1']).toEqual(parseCekDay(DAY, JAN15)!['1.1']);
  });

  it('an interval off the half-hour grid makes each half-hour it touches off', () => {
    const page = swap(swap(DAY, '<td>02:00:00</td>', '<td>02:10:00</td>'), '<td>05:30:00</td>', '<td>05:31:00</td>');
    expect(parseCekDay(page, JAN15)!['1.1']).toEqual(offIn([4, 11], [18, 31], [39, 47]));
  });

  it('a row inside an HTML comment does not count', () => {
    const page = swap(DAY, 'id="tableView_1.1" style="display: block;">', 'id="tableView_1.1" style="display: block;"><!--<tr><td>00:00:00</td><td>01:00:00</td></tr>-->');
    expect(parseCekDay(page, JAN15)!['1.1']).toEqual(offIn([4, 10], [18, 31], [39, 47]));
  });

  it('reads only an answer whose date field echoes the asked date (M1)', () => {
    const INPUT = '<input type="date" id="date" name="date" value="2026-10-20" required>';
    const cases: Record<string, [string, string, string]> = {
      // A quiet answer of another day must never read as a quiet today.
      'the quiet answer for another date': [QUIET, '2026-10-21', 'answer for another date'],
      'tables for another date': [DAY, '2026-01-16', 'answer for another date'],
      'no date field': [swap(QUIET, INPUT, ''), OCT20, 'no date echoed'],
      'the date field only inside a comment': [swap(QUIET, INPUT, `<!--${INPUT}-->`), OCT20, 'no date echoed'],
      'a date field without a value': [swap(QUIET, INPUT, '<input type="date" id="date" name="date" required>'), OCT20, 'no date echoed'],
      'another input holding the date': [swap(QUIET, INPUT, '<input type="date" id="day" name="date" value="2026-10-20" required>'), OCT20, 'no date echoed'],
    };
    for (const [name, [page, date, reason]] of Object.entries(cases)) {
      let err: unknown;
      try {
        parseCekDay(page, date);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(CekShapeError);
      expect((err as Error).message, name).toBe(reason);
    }
    // The field is found by its id, whatever the order of its attributes.
    expect(parseCekDay(swap(QUIET, INPUT, '<input value="2026-10-20" name="date" id="date" type="date">'), OCT20)).toBeUndefined();
  });

  it('throws a fixed-reason CekShapeError for every other shape (Review Focus 5)', () => {
    const block = /<div class="form-container tableView" id="tableView_1\.1"[\s\S]*?<\/table>/.exec(ONE)![0];
    const NO_FORM = 'no queue form';
    const BAD_TIME = 'bad time';
    const NOT_BEFORE = 'interval does not start before its end';
    const NOT_PAIRS = 'queue rows are not one time pair each';
    // [page, reason, the asked date: 15.01.2026 unless given]
    const cases: Record<string, [string, string, string?]> = {
      'the quiet page without the sentinel': [swap(QUIET, 'На цей день відключень немає.', ''), 'neither the quiet message nor tables', OCT20],
      'the quiet page with a block': [swap(QUIET, '<div class="form-container">', `${block}<div class="form-container">`), 'both the quiet message and tables', OCT20],
      'no heading': [swap(DAY, ' id="heading"', ''), 'no heading'],
      'no select': [swap(DAY, '<select id="queue"', '<select id="date-picker"'), NO_FORM],
      'a queue missing from the select': [swap(DAY, '<option value="6.2" >', '<option value="7.2" >'), NO_FORM],
      'an option outside the select only': [swap(swap(DAY, '<option value="6.2" >', ''), '</select>', '</select><option value="6.2" >'), NO_FORM],
      'the form only': ['<form method="post"></form>', NO_FORM],
      'an end of 25:00:00': [swap(DAY, '<td>16:00:00</td>', '<td>25:00:00</td>'), BAD_TIME],
      'an end of 24:00:00': [swap(DAY, '<td>16:00:00</td>', '<td>24:00:00</td>'), BAD_TIME],
      'a minute of 60': [swap(DAY, '<td>16:00:00</td>', '<td>15:60:00</td>'), BAD_TIME],
      // 23:59 is the end of the day, but only once the time itself reads.
      'an end of 23:59:99': [swap(DAY, '<td>23:59:00</td>', '<td>23:59:99</td>'), BAD_TIME],
      'start equal to end': [swap(DAY, '<td>05:30:00</td>', '<td>02:00:00</td>'), NOT_BEFORE],
      'start after end': [swap(DAY, '<td>05:30:00</td>', '<td>01:30:00</td>'), NOT_BEFORE],
      'a row without a time pair': [swap(DAY, '<td>09:00:00</td>', '<td>9:00</td>'), NOT_PAIRS],
      'a block without rows': [swap(ONE, /<tr>\s*<td>[\s\S]*?<\/tr>/g, ''), NOT_PAIRS],
      'a block without its table': [swap(ONE, '</table>', ''), 'queue block is not a table'],
      'tableView_7.1': [swap(DAY, 'id="tableView_6.2"', 'id="tableView_7.1"'), 'unknown queue block'],
      'an odd block id': [swap(DAY, 'id="tableView_6.2"', 'id="tableView_6.2a"'), 'unknown queue block'],
      'a block given twice': [swap(DAY, 'id="tableView_6.2"', 'id="tableView_6.1"'), 'queue block given twice'],
    };
    for (const [name, [page, reason, date = JAN15]] of Object.entries(cases)) {
      let err: unknown;
      try {
        parseCekDay(page, date);
      } catch (e) {
        err = e;
      }
      expect(err, name).toBeInstanceOf(CekShapeError);
      expect((err as Error).message, name).toBe(reason);
    }
  });
});
