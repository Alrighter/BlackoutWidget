import type { HouseInfo, LineInfo, Slot } from '../../../shared/types';
import { htmlText } from '../html';
import { houseKey, nameKey, nameWords } from '../names';
import { isObj, ShapeError } from '../shape';

/** The answer is not one we know. The message is a fixed reason of ours, never a piece of the response. */
export class CvoeShapeError extends ShapeError {
  override name = 'CvoeShapeError';
}

export type CvoePage =
  | { kind: 'table'; date: string; updatedHM: string; groups: Record<string, Slot[]>; nextLink: boolean }
  | { kind: 'emergency' };

const DATE = /<ul>\s*<p>\s*(\d{2})\.(\d{2})\.(\d{4})/;
const UPDATED = /станом на\s*<b>(\d{2}:\d{2})<\/b>/;
const INF = /<div id="inf(\d+)" data-id="(\d+)">([\s\S]*?)<\/div>/g;
const CELLS = /<u>з<\/u>|<o>в<\/o>|<s>мз<\/s>/g;
const CELL_SLOT: Record<string, Slot> = { '<u>з</u>': 'on', '<o>в</o>': 'off', '<s>мз</s>': 'maybe-off' };
const EMERGENCY = /<article\b[^>]*\bclass="[^"]*\bwrap_article_v2_emergency\b/;

function dateKey(d: string, m: string, y: string): string {
  const iso = `${y}-${m}-${d}`;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== iso) throw new CvoeShapeError('bad date');
  return iso;
}

function cells(body: string): Slot[] {
  const tokens = body.match(CELLS) ?? [];
  if (tokens.length !== 48 || body.replace(CELLS, '').trim() !== '') throw new CvoeShapeError('group is not 48 cells');
  return tokens.map(t => CELL_SLOT[t]);
}

export function parseCvoePage(html: string): CvoePage {
  const gsv = html.search(/\bid="gsv"/);
  const emergency = EMERGENCY.test(html);
  if (gsv < 0) {
    if (emergency) return { kind: 'emergency' };
    throw new CvoeShapeError('page is neither a table nor emergency mode');
  }
  if (emergency) throw new CvoeShapeError('page is both a table and emergency mode');

  const block = html.slice(gsv);
  const d = DATE.exec(block);
  if (!d) throw new CvoeShapeError('no date');
  const date = dateKey(d[1], d[2], d[3]);
  const aStart = html.search(/\bid="gsv_a"/);
  const updated = aStart < 0 ? null : UPDATED.exec(html.slice(aStart));
  if (!updated) throw new CvoeShapeError('no update time');

  const groups: Record<string, Slot[]> = {};
  for (const m of block.matchAll(INF)) {
    if (m[1] !== m[2] || groups[m[1]]) throw new CvoeShapeError('group ids disagree');
    groups[m[1]] = cells(m[3]);
  }
  const ids = Object.keys(groups);
  if (ids.length !== 12 || Array.from({ length: 12 }, (_, i) => String(i + 1)).some(id => !groups[id])) {
    throw new CvoeShapeError('groups are not 1 … 12');
  }
  return { kind: 'table', date, updatedHM: updated[1], groups, nextLink: html.includes('href="/shutdowns/?next"') };
}

export interface CvoeRow { settlement?: string; street: string; house: string; group: string }

const CITY_ROW = /^<div><p>([\s\S]*?)<\/p><b>([\s\S]*?)<\/b><u>([\s\S]*?)<\/u><\/div>/;
const OBL_ROW = /^<div><s>([\s\S]*?)<\/s><p>([\s\S]*?)<\/p><b>([\s\S]*?)<\/b><u>([\s\S]*?)<\/u><\/div>/;
/** The footer after the rows; its <b> holds the count of rows left out, empty when the page holds them all. */
const H_TOTAL = /^<div class="h_total">\s*<p>[^<]*<b>([\s\S]*?)<\/b>/;

export function parseDistrictPage(html: string, district: number): CvoeRow[] {
  const city = district === 1;
  const head = html.search(city ? /\bid="city_tbl"/ : /\bid="obl_tbl"/);
  if (head < 0) throw new CvoeShapeError('no result table');
  const line = /<div class="h_line">[\s\S]*?<\/div>/.exec(html.slice(head));
  if (!line) throw new CvoeShapeError('no result table header');
  let rest = html.slice(head + line.index + line[0].length);
  const rows: CvoeRow[] = [];
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (!rest.startsWith('<div>')) break;
    const m = (city ? CITY_ROW : OBL_ROW).exec(rest);
    if (!m) throw new CvoeShapeError('unknown row shape');
    rest = rest.slice(m[0].length);
    rows.push(city
      ? { street: htmlText(m[1]), house: htmlText(m[2]), group: htmlText(m[3]) }
      : { settlement: htmlText(m[1]), street: htmlText(m[2]), house: htmlText(m[3]), group: htmlText(m[4]) });
  }
  if (rest.startsWith('<div class="h_total">')) {
    // The live pages close the row list with «ще знайдено рядків <b></b>»: anything in the <b> means the page cut the list.
    const total = H_TOTAL.exec(rest);
    if (!total || total[1].trim() !== '') throw new CvoeShapeError('row list cut short');
  } else if (/^<div\b/.test(rest)) {
    throw new CvoeShapeError('unknown row shape');
  } else if (!rest.startsWith('</div>')) {
    // Only the footer or the container's end may follow the rows: anything else would end the list unseen.
    throw new CvoeShapeError('unknown content after the rows');
  }
  if (!rows.length) throw new CvoeShapeError('no rows');
  return rows;
}

export const groupLabel = (groupId: string): string => `Група ${groupId}`;

/** Distinct groups as lines «Група N»; each must be an integer 1–12, anything else throws. Numeric order, index from 1. */
export function groupLines(groups: readonly string[]): LineInfo[] {
  for (const g of groups) if (!/^(?:[1-9]|1[0-2])$/.test(g)) throw new CvoeShapeError('unknown group value');
  return [...new Set(groups)].sort((a, b) => Number(a) - Number(b))
    .map((groupId, i) => ({ index: i + 1, groupId, label: groupLabel(groupId) }));
}

const collator = new Intl.Collator('uk', { numeric: true });

/** Streets of one settlement: grouped by nameKey; shown as the spelling with the most rows (ties: first seen). */
export function cvoeStreets(rows: readonly CvoeRow[]): string[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = nameKey(r.street);
    const spellings = byKey.get(key) ?? new Map<string, number>();
    spellings.set(r.street, (spellings.get(r.street) ?? 0) + 1);
    byKey.set(key, spellings);
  }
  const shown = [...byKey.values()].map(spellings => {
    let best = '';
    let count = 0;
    for (const [s, n] of spellings) if (n > count) { best = s; count = n; }
    return best;
  });
  return shown.sort(collator.compare);
}

const BARE = /^\s*(?:буд|сад)(?:\.|\s+|(?=\d)|$)\s*/iu;

/** Houses of one street: grouped by houseKey; shown as the first spelling without «буд.»/«сад.»; lines via groupLines. */
export function cvoeHouses(rows: readonly CvoeRow[]): HouseInfo[] {
  const byKey = new Map<string, { house: string; groups: Set<string> }>();
  for (const r of rows) {
    const key = houseKey(r.house);
    const entry = byKey.get(key) ?? { house: r.house.replace(BARE, '').trim(), groups: new Set<string>() };
    entry.groups.add(r.group);
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map(e => ({ house: e.house, lines: groupLines([...e.groups]), outageActive: false }))
    .sort((a, b) => collator.compare(a.house, b.house));
}

export interface CvoeOutageRow { settlement: string; street: string; houses: string[]; start: string; end: string }

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ADDRESS = /^([\s\S]*?),\s*<br\s*\/?>\s*<span>([\s\S]*?)<\/span>\s*$/;

/** The current-outage reply: rows and the last page number. «Нічого не знайдено» → no rows; required_error or anything else throws. */
export function parseOutageReply(body: unknown): { rows: CvoeOutageRow[]; pages: number } {
  if (!isObj(body) || typeof body.data !== 'string' || !body.data.includes('<tbody')) {
    throw new CvoeShapeError('reply is not a table');
  }
  const rows: CvoeOutageRow[] = [];
  let pages = 1;
  let empty = false;
  for (const tr of body.data.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const inner = tr[1];
    if (inner.includes('empty_shutdowns')) {
      if (!inner.includes('Нічого не знайдено')) throw new CvoeShapeError('unknown empty row');
      empty = true;
      continue;
    }
    if (inner.includes('shop_pages')) {
      for (const p of inner.matchAll(/data-page="(\d+)"/g)) pages = Math.max(pages, Number(p[1]));
      continue;
    }
    const tds = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (tds.length !== 6) throw new CvoeShapeError('row is not 6 cells');
    const addr = ADDRESS.exec(tds[3]);
    if (!addr) throw new CvoeShapeError('unknown address cell');
    const houses = htmlText(addr[2]).split(',').map(h => h.trim()).filter(Boolean);
    const start = tds[4].trim();
    const end = tds[5].trim();
    if (!STAMP.test(start) || !STAMP.test(end) || !houses.length) throw new CvoeShapeError('bad outage row');
    rows.push({ settlement: htmlText(tds[2]), street: htmlText(addr[1]), houses, start, end });
  }
  if (empty && rows.length) throw new CvoeShapeError('empty marker among rows');
  if (!empty && !rows.length) throw new CvoeShapeError('reply holds no rows');
  return { rows, pages };
}

/** Word sets for matching across the two forms: nameKey, via nameWords (digits kept). */
export function streetWords(s: string): string[] {
  const w = nameWords(s);
  if (w[0] === 'вул' || w[0] === 'вулиця') w.shift();
  return w.sort();
}

const PLACE_PREFIX = new Set(['м', 'с', 'смт', 'селище', 'село', 'місто', 'ще']);

export function placeWords(s: string): string[] {
  const w = nameWords(s);
  while (w.length && PLACE_PREFIX.has(w[0])) w.shift();
  return w.sort();
}
