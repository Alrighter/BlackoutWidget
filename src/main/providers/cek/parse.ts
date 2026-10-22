import type { LineInfo, Slot } from '../../../shared/types';
import { linesOf, QueueValueError } from '../lines';
import { isObj, ShapeError } from '../shape';

/** The answer is not one we know. The message is a fixed reason of ours, never a piece of the response. */
export class CekShapeError extends ShapeError {
  override name = 'CekShapeError';
}

/** The address map as served: city → street → house → the queue value (keys untrimmed). */
export type CekMap = Record<string, Record<string, Record<string, string>>>;

const LOCATIONS = 'const locations = ';

/** Where the JSON object opening at `open` ends: braces counted outside strings, a string's escapes skipped. */
function objectEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return i + 1;
    }
  }
  throw new CekShapeError('locations object never closes');
}

/** An object's entries, none of them blank-named; an empty object or anything else throws. */
function entriesOf(v: unknown, what: string): [string, unknown][] {
  if (!isObj(v)) throw new CekShapeError(`${what}: not an object`);
  const entries = Object.entries(v);
  if (entries.length === 0) throw new CekShapeError(`${what}: none`);
  if (entries.some(([k]) => k.trim() === '')) throw new CekShapeError(`${what}: a blank name`);
  return entries;
}

/** The `const locations = {…}` object of the map page: a brace-and-string-aware scan, then JSON.parse; shape city→street→house→string, none empty. */
export function extractLocations(html: string): CekMap {
  const at = html.indexOf(LOCATIONS);
  const open = at + LOCATIONS.length;
  if (at < 0 || html[open] !== '{') throw new CekShapeError('no locations object');
  let map: unknown;
  try {
    map = JSON.parse(html.slice(open, objectEnd(html, open)));
  } catch (e) {
    if (e instanceof CekShapeError) throw e;
    // The parser's message quotes the text: only a fixed reason goes on.
    throw new CekShapeError('locations object is not JSON');
  }
  for (const [, streets] of entriesOf(map, 'cities')) {
    for (const [, houses] of entriesOf(streets, 'streets')) {
      for (const [, value] of entriesOf(houses, 'houses')) {
        if (typeof value !== 'string') throw new CekShapeError('houses: a value is not text');
      }
    }
  }
  return map as CekMap;
}

export const CEK_DTEK_NOTE = 'Цей будинок відключає ДТЕК — оберіть «ДТЕК Дніпровські електромережі»';

/** The map's value forms (cek.md §2.3) and the queue ids each names; queues are n.m with n 1–6 and m 1–2. */
const VALUES: [RegExp, (m: RegExpExecArray) => string[]][] = [
  [/^Черга ([1-6]\.[12])$/, (m) => [m[1]]],
  [/^Черга ([1-6]\.[12]) та ([1-6]\.[12])$/, (m) => [m[1], m[2]]],
  // The whole queue: both of its halves.
  [/^Черга ([1-6])$/, (m) => [`${m[1]}.1`, `${m[1]}.2`]],
  [/^([1-6]\.[12])$/, (m) => [m[1]]],
];
/** A house DTEK DNEM switches: it is on DTEK's schedule, not CEK's. */
const DTEK_GROUP = /^Група [1-6]\.[12] \(АТ "ДТЕК ДЕМ"\)$/;

/** One map value as lines; `note` set for a house DTEK switches (then lines []). Unknown value → QueueValueError. */
export function cekLines(value: string): { lines: LineInfo[]; note?: string } {
  const v = value.trim();
  if (DTEK_GROUP.test(v)) return { lines: [], note: CEK_DTEK_NOTE };
  for (const [re, ids] of VALUES) {
    const m = re.exec(v);
    if (m) return { lines: linesOf(ids(m)) };
  }
  throw new QueueValueError();
}

const QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
/** The answer for a day without outages, and for a day not published yet: the page cannot tell them apart. */
const QUIET = 'На цей день відключень немає.';
const SELECT = /<select id="queue"[^>]*>([\s\S]*?)<\/select>/;
const OPTION = /<option\b[^>]*\bvalue="([^"]*)"/g;
const BLOCK = /\bid="tableView_([^"]*)"/g;
/** The form's date field, found by its id: the answer echoes the date it was asked for in its value. */
const DATE_FIELD = /<input\b[^>]*\bid="date"[^>]*>/;
const VALUE = /\bvalue="([^"]*)"/;
const PAIR = /<td>(\d\d):(\d\d):(\d\d)<\/td>\s*<td>(\d\d):(\d\d):(\d\d)<\/td>/g;

/** Minutes of the day of HH:MM:SS; an hour past 23, or a minute or second past 59, throws. */
function minutes(h: string, m: string, s: string): number {
  if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) throw new CekShapeError('bad time');
  return Number(h) * 60 + Number(m);
}

/** One row's [start, end) in minutes; an end of 23:59 is the end of the day, once its seconds read too. */
function interval(p: RegExpExecArray | RegExpMatchArray): [number, number] {
  const start = minutes(p[1], p[2], p[3]);
  const until = minutes(p[4], p[5], p[6]);
  const end = until === 23 * 60 + 59 ? 24 * 60 : until;
  if (start >= end) throw new CekShapeError('interval does not start before its end');
  return [start, end];
}

/** A queue block's 48 slots: each data row (the <tr>s after </thead>) holds exactly one start/end pair, at least one row. */
function blockSlots(block: string): Slot[] {
  const head = block.indexOf('</thead>');
  const end = block.indexOf('</table>');
  if (head < 0 || end < head) throw new CekShapeError('queue block is not a table');
  const body = block.slice(head, end);
  const rows = body.split(/<tr\b/).slice(1);
  const pairs = [...body.matchAll(PAIR)];
  if (rows.length === 0 || pairs.length !== rows.length || rows.some((r) => [...r.matchAll(PAIR)].length !== 1)) {
    throw new CekShapeError('queue rows are not one time pair each');
  }
  const intervals = pairs.map(interval);
  return Array.from({ length: 48 }, (_, k): Slot =>
    (intervals.some(([a, b]) => a < 30 * k + 30 && 30 * k < b) ? 'off' : 'on'));
}

/**
 * The form's answer for `date` (YYYY-MM-DD): queue id → 48 slots, or undefined for the quiet sentinel. The answer must
 * echo that date in its date field: an answer for another day, or without the field, throws.
 */
export function parseCekDay(html: string, date: string): Record<string, Slot[]> | undefined {
  // The page comments rows and cells out (<!--<td>2026-01-15</td>-->): nothing commented counts.
  const page = html.replace(/<!--[\s\S]*?-->/g, '');
  const select = SELECT.exec(page);
  const options = new Set(select ? [...select[1].matchAll(OPTION)].map((m) => m[1]) : []);
  if (!select || QUEUES.some((q) => !options.has(q))) throw new CekShapeError('no queue form');
  if (!/\bid="heading"/.test(page)) throw new CekShapeError('no heading');
  const field = DATE_FIELD.exec(page);
  const echoed = field ? VALUE.exec(field[0]) : null;
  if (!echoed) throw new CekShapeError('no date echoed');
  if (echoed[1] !== date) throw new CekShapeError('answer for another date');

  const blocks = [...page.matchAll(BLOCK)];
  const quiet = page.includes(QUIET);
  if (quiet && blocks.length) throw new CekShapeError('both the quiet message and tables');
  if (quiet) return undefined;
  if (!blocks.length) throw new CekShapeError('neither the quiet message nor tables');

  const day: Record<string, Slot[]> = {};
  blocks.forEach((m, i) => {
    const id = m[1];
    if (!QUEUES.includes(id)) throw new CekShapeError('unknown queue block');
    if (Object.hasOwn(day, id)) throw new CekShapeError('queue block given twice');
    // A block runs to the next one: a block without its own </table> never reads the next block's rows.
    day[id] = blockSlots(page.slice(m.index, i + 1 < blocks.length ? blocks[i + 1].index : page.length));
  });
  return day;
}
