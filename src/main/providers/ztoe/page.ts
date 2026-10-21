import type { HouseInfo, Slot } from '../../../shared/types';
import { htmlText } from '../html';
import { linesOf, NONE_GROUP, QueueValueError } from '../lines';
import { houseKey } from '../names';
import { ShapeError } from '../shape';

/** The page is not one we know. The message is a fixed reason of ours, never a piece of the response. */
export class ZtoeShapeError extends ShapeError {
  override name = 'ZtoeShapeError';
}

export function decodeCp1251(bytes: ArrayBuffer): string {
  return new TextDecoder('windows-1251').decode(bytes);
}

export interface ZtoeSchedule {
  /** 'HH:MM DD.MM.YYYY', as the operator stamps the page. */
  updatedAt: string;
  banner?: string;
  /** YYYY-MM-DD → queue «N.M» → 48 slots. */
  days: Map<string, Record<string, Slot[]>>;
}

const STAMP = /Дата оновлення інформації\s*-\s*(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/;
const DATE_CELL = /<b style="font-size:12pt;">(\d{2})\.(\d{2})\.(\d{4})<\/b>/;
const QUEUE_LABEL = /color:black;">(\d+\.\d+)<\/b>/;
const CELL_COLOUR = /background:\s*(#[0-9a-f]+)/gi;
const LABELS = Array.from({ length: 12 }, (_, i) => `${(i >> 1) + 1}.${(i & 1) + 1}`);
const COLOURS: Record<string, Slot> = { '#ffffff': 'on', '#ff3333': 'off' };

const BANNER_HEAD = 'УВАГА! ВАЖЛИВА ІНФОРМАЦІЯ!';
const BANNER_TAIL = 'Пошук черги та підчерги за адресою';

function dateKey(d: string, m: string, y: string): string {
  const iso = `${y}-${m}-${d}`;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) throw new ZtoeShapeError('bad date');
  return iso;
}

function parseDay(table: string): Record<string, Slot[]> {
  const day: Record<string, Slot[]> = {};
  const labels: string[] = [];
  for (const row of table.split(/<tr[\s>]/i).slice(1)) {
    const label = QUEUE_LABEL.exec(row)?.[1];
    const colours = [...row.matchAll(CELL_COLOUR)].map(m => m[1].toLowerCase());
    if (!label) {
      if (colours.length) throw new ZtoeShapeError('coloured cells without a queue');
      continue;
    }
    if (colours.length !== 48) throw new ZtoeShapeError('queue row is not 48 cells');
    labels.push(label);
    day[label] = colours.map((c): Slot => {
      const slot = COLOURS[c];
      if (!slot) throw new ZtoeShapeError('unknown cell colour');
      return slot;
    });
  }
  if (labels.length !== LABELS.length || labels.some((l, i) => l !== LABELS[i])) throw new ZtoeShapeError('queue rows are not 1.1 … 6.2');
  return day;
}

function parseBanner(html: string): string | undefined {
  for (const m of html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)) {
    const text = htmlText(m[1]);
    if (!text.startsWith(BANNER_HEAD)) continue;
    let body = text.slice(BANNER_HEAD.length).trim();
    if (body.endsWith(BANNER_TAIL)) body = body.slice(0, -BANNER_TAIL.length).trim();
    return body || undefined;
  }
  return undefined;
}

/**
 * The schedule page, or the address form's answer (it carries the same tables). Fails closed: a missing stamp (which
 * mojibake also causes), no date table, a repeated date, rows other than 1.1 … 6.2 in order, a row that is not 48 cells
 * or a colour other than white and red is a ZtoeShapeError, never a quiet day.
 */
export function parseZtoeSchedule(html: string): ZtoeSchedule {
  const stamp = STAMP.exec(html);
  if (!stamp) throw new ZtoeShapeError('no update stamp');
  const days = new Map<string, Record<string, Slot[]>>();
  for (const table of html.split(/<table/i)) {
    const d = DATE_CELL.exec(table);
    if (!d) continue;
    const key = dateKey(d[1], d[2], d[3]);
    if (days.has(key)) throw new ZtoeShapeError('a date twice');
    days.set(key, parseDay(table));
  }
  if (!days.size) throw new ZtoeShapeError('no date table');
  return { updatedAt: `${stamp[1]}:${stamp[2]} ${stamp[3]}.${stamp[4]}.${stamp[5]}`, banner: parseBanner(html), days };
}

/** The options of one select of the address form, without the «Оберіть …» placeholder (value 0). A missing or disabled select throws. */
export function parseOptions(html: string, select: 'rem_id' | 'naspunkt_id' | 'vulica_id'): { id: number; name: string }[] {
  const m = new RegExp(String.raw`<select\s+name="${select}"([^>]*)>([\s\S]*?)</select>`, 'i').exec(html);
  if (!m || /\bdisabled\b/i.test(m[1])) throw new ZtoeShapeError('select missing or disabled');
  const out: { id: number; name: string }[] = [];
  for (const o of m[2].matchAll(/<option\s+value="(\d+)"[^>]*>([^<]*)/gi)) {
    const id = Number(o[1]);
    if (id !== 0) out.push({ id, name: htmlText(o[2]) });
  }
  return out;
}

export interface ZtoeRow {
  houses: string[];
  /** 'N.M' or 'none' (not switched, except in an emergency). */
  queue: string;
  /** false: the row is for legal entities. */
  household: boolean;
}

const NOT_SWITCHED = 'В цей час не вимикається, за винятком випадків аварійних відключень';
const HOUSEHOLD = 'побутові споживачі';
const LEGAL = 'непобутові (юридичні) споживачі';

function queueOf(q: string, s: string): string {
  if (/^\d+$/.test(q) && /^\d+$/.test(s)) return `${q}.${s}`;
  if (q === NOT_SWITCHED && s === NOT_SWITCHED) return NONE_GROUP;
  throw new QueueValueError();
}

/** The rows of an address answer fetched with `all=1`: a pager, or a count that is not the rows we read, throws. */
export function parseResultRows(html: string): ZtoeRow[] {
  const count = /За Вашим запитом знайдено записів:\s*(\d+)/.exec(html);
  if (!count) throw new ZtoeShapeError('no record count');
  if (/name\s*=\s*["']?all["']?[\s/>]/i.test(html)) throw new ZtoeShapeError('result is paged');
  const rows: ZtoeRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => htmlText(c[1]));
    if (cells.length !== 7 || (cells[0] === 'РЕМ' && cells[4] === 'Черга')) continue;
    if (cells[6] !== HOUSEHOLD && cells[6] !== LEGAL) throw new ZtoeShapeError('unknown note');
    rows.push({
      houses: cells[3].split(',').map(h => h.trim()).filter(Boolean),
      queue: queueOf(cells[4], cells[5]),
      household: cells[6] === HOUSEHOLD,
    });
  }
  if (rows.length !== Number(count[1])) throw new ZtoeShapeError('record count differs from the rows');
  return rows;
}

const collator = new Intl.Collator('uk', { numeric: true });

/**
 * The houses of a street, one per houseKey, shown as first written. A house's lines are the queues of its household
 * rows, or of its legal rows when it has no household row; no queue at all is the 'none' line.
 */
export function ztoeHouses(rows: readonly ZtoeRow[]): HouseInfo[] {
  const byKey = new Map<string, { shown: string; household: string[]; legal: string[] }>();
  for (const row of rows) {
    for (const h of row.houses) {
      const key = houseKey(h);
      let e = byKey.get(key);
      if (!e) byKey.set(key, (e = { shown: h, household: [], legal: [] }));
      (row.household ? e.household : e.legal).push(row.queue);
    }
  }
  return [...byKey.values()]
    .map((e): HouseInfo => ({ house: e.shown, lines: linesOf(e.household.length ? e.household : e.legal), outageActive: false }))
    .sort((a, b) => collator.compare(a.house, b.house));
}
