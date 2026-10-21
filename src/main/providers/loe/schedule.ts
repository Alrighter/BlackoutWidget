import type { Slot } from '../../../shared/types';
import { isObj, ShapeError, type Obj } from '../shape';

// Pure readers of Львівобленерго's schedule text (api.loe.lviv.ua, the CMS behind poweron.loe.lviv.ua). Anything of an
// unknown shape throws LoeShapeError, whose message is a fixed reason of ours: never a value from the response.

export class LoeShapeError extends ShapeError {
  override name = 'LoeShapeError';
}

function fail(reason: string): never {
  throw new LoeShapeError(reason);
}

/** One published revision: the day it is for (the heading), its «станом на» stamp, and every group's 48 slots. */
export interface LoeRevision { date: string /* YYYY-MM-DD */; updatedAt: string /* 'HH:MM DD.MM.YYYY' */; groups: Record<string, Slot[]> }

const GROUPS = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

const HEADING = /^Графік погодинних відключень на (\d{2})\.(\d{2})\.(\d{4})$/;
const STAMP = /^Інформація станом на (\d{2}):(\d{2}) (\d{2})\.(\d{2})\.(\d{4})$/;
const RANGE_TEXT = 'з \\d{2}:\\d{2} до \\d{2}:\\d{2}';
const LINE = new RegExp(`^Група (\\d\\.\\d)\\. (?:(Електроенергія є)|Електроенергії немає (${RANGE_TEXT}(?:, ${RANGE_TEXT})*))\\.$`);
const RANGE = /^з (\d{2}):(\d{2}) до (\d{2}):(\d{2})$/;

/** The text lines of the HTML: every tag ends a line; spaces are collapsed; empty lines are dropped. */
function textLines(rawHtml: string): string[] {
  return rawHtml
    .replace(/<[^>]*>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of a day that exists, else undefined. */
function dateKey(dd: string, mm: string, yyyy: string): string | undefined {
  const [d, m, y] = [Number(dd), Number(mm), Number(yyyy)];
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function headingDate(line: string | undefined): string | undefined {
  const m = line === undefined ? null : HEADING.exec(line);
  return m ? dateKey(m[1], m[2], m[3]) : undefined;
}

/** Minutes from 00:00 of «HH:MM»: minutes are 00 or 30, hours 00-23, and 24:00 only where `end` allows it. */
function minutes(hh: string, mm: string, end: boolean): number {
  const [h, m] = [Number(hh), Number(mm)];
  if ((m !== 0 && m !== 30) || h > 24 || (h === 24 && (!end || m !== 0))) fail('text: time');
  return h * 60 + m;
}

/** 48 slots of one group line: each range «з S до E» is off in [S/30, E/30); ranges are non-empty and ascending. */
function groupSlots(ranges: string | undefined): Slot[] {
  const slots = Array<Slot>(48).fill('on');
  if (ranges === undefined) return slots;
  let previousEnd = 0;
  for (const range of ranges.split(', ')) {
    const m = RANGE.exec(range) ?? fail('text: group line');
    const start = minutes(m[1], m[2], false);
    const end = minutes(m[3], m[4], true);
    if (end <= start) fail('text: empty range');
    if (start < previousEnd) fail('text: range order');
    previousEnd = end;
    slots.fill('off', start / 30, end / 30);
  }
  return slots;
}

/**
 * Strict: the heading «Графік погодинних відключень на DD.MM.YYYY», «Інформація станом на HH:MM DD.MM.YYYY», then
 * exactly the 12 groups 1.1…6.2, each «Електроенергія є.» or «Електроенергії немає з HH:MM до HH:MM[, …].».
 * Throws on any deviation.
 */
export function parseLoeRevision(rawHtml: string): LoeRevision {
  const lines = textLines(rawHtml);
  if (lines.length !== 2 + GROUPS.length) fail('text: lines');
  const date = headingDate(lines[0]) ?? fail('text: heading');
  const s = STAMP.exec(lines[1]) ?? fail('text: stamp');
  if (Number(s[1]) > 23 || Number(s[2]) > 59 || !dateKey(s[3], s[4], s[5])) fail('text: stamp');
  const groups: Record<string, Slot[]> = {};
  for (const line of lines.slice(2)) {
    const m = LINE.exec(line) ?? fail('text: group line');
    const group = m[1];
    if (!GROUPS.includes(group)) fail('text: unknown group');
    if (Object.hasOwn(groups, group)) fail('text: group twice');
    groups[group] = groupSlots(m[3]);
  }
  return { date, updatedAt: `${s[1]}:${s[2]} ${s[3]}.${s[4]}.${s[5]}`, groups };
}

/** The heading date only, or undefined when the heading cannot be read. */
export function loeHeadingDate(rawHtml: string): string | undefined {
  return headingDate(textLines(rawHtml)[0]);
}

// --- The CMS items ---------------------------------------------------------------------------------------------

const MENU = '/api/menus/9';

/**
 * `menu_items/238` (Today) or `/256` (Tomorrow): its `rawHtml`, once the item is the one we know. A picture without
 * text is a schedule we cannot read, never an empty item; a description alone (a cancellation notice) stays empty.
 */
export function menuItemHtml(body: unknown, name: 'Today' | 'Tomorrow'): string {
  if (!isObj(body) || body.name !== name || body.menu !== MENU) fail(`menu item: ${name}`);
  const { rawHtml, description, imageUrl } = body;
  if (typeof rawHtml !== 'string' || typeof description !== 'string' || typeof imageUrl !== 'string') {
    fail(`menu item: ${name} fields`);
  }
  if (rawHtml === '' && imageUrl !== '') fail(`menu item: ${name} image only`);
  return rawHtml;
}

/** `menus?type=photo-grafic`: the `rawHtml` of each child of the «Arhiv» item, '' where a child has none (image-only years). */
export function archiveHtmls(body: unknown): string[] {
  const menus = isObj(body) ? body['hydra:member'] : undefined;
  if (!Array.isArray(menus)) fail('menus: no member list');
  const archives = menus.flatMap((m) => (isObj(m) && Array.isArray(m.menuItems) ? m.menuItems : []))
    .filter((i): i is Obj => isObj(i) && i.name === 'Arhiv');
  if (archives.length !== 1) fail('menus: archive');
  const children = archives[0].children;
  if (!Array.isArray(children)) fail('menus: archive children');
  return children.map((c) => {
    if (!isObj(c)) return fail('menus: archive item');
    if (c.rawHtml === undefined || c.rawHtml === null) return '';
    return typeof c.rawHtml === 'string' ? c.rawHtml : fail('menus: archive item text');
  });
}

// --- Picking the revision --------------------------------------------------------------------------------------

/** The Today or Tomorrow item's revision: none when it is empty, otherwise parsed strictly whatever its date. */
export function itemRevision(rawHtml: string): LoeRevision | undefined {
  return rawHtml === '' ? undefined : parseLoeRevision(rawHtml);
}

/**
 * An archive item's revision when it is headed one of `dates`. Any other item (empty, image-only, unheaded, or for
 * another day such as the 2024 placeholder) is skipped without reading its lines.
 */
export function archiveRevision(rawHtml: string, dates: readonly string[]): LoeRevision | undefined {
  const date = loeHeadingDate(rawHtml);
  return date !== undefined && dates.includes(date) ? parseLoeRevision(rawHtml) : undefined;
}

/** «HH:MM DD.MM.YYYY» as «YYYY-MM-DD HH:MM», which sorts in time order. */
const stampKey = (updatedAt: string): string =>
  `${updatedAt.slice(12, 16)}-${updatedAt.slice(9, 11)}-${updatedAt.slice(6, 8)} ${updatedAt.slice(0, 5)}`;

/** Per date of `dates`, the revision with the latest «станом на»; on a tie the first one read stays. */
export function latestRevisions(revisions: readonly LoeRevision[], dates: readonly string[]): Map<string, LoeRevision> {
  const picked = new Map<string, LoeRevision>();
  for (const r of revisions) {
    if (!dates.includes(r.date)) continue;
    const seen = picked.get(r.date);
    if (!seen || stampKey(r.updatedAt) > stampKey(seen.updatedAt)) picked.set(r.date, r);
  }
  return picked;
}
