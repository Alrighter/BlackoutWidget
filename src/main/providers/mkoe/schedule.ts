import { formatHM, kyivDateKey } from '../../../shared/time';
import type { Slot } from '../../../shared/types';
import { daySlots } from '../lines';

/**
 * A Миколаївобленерго answer of a shape we do not know. The message is a fixed reason of ours, never response text.
 * No day with outages has been seen live yet (mykolaiv.md §1.6), so only the documented shape is taken.
 */
export class MkoeShapeError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function fail(reason: string): never {
  throw new MkoeShapeError(reason);
}

/** The hourly-schedule queues the operator has (`outage-queue/by-type/3`); all twelve must be there. */
const QUEUE_NAMES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];

/** A series `type` and its strength: when entries overlap on a slot, the stronger wins. Anything else is unreadable. */
const TYPES: Record<string, { rank: number; slot: Slot }> = {
  SURE_OFF: { rank: 3, slot: 'off' },
  OFF: { rank: 2, slot: 'off' },
  PROBABLY_OFF: { rank: 1, slot: 'maybe-off' },
};

/** An instant with its zone (`Z` or an offset): a bare wall time would be read in the machine's zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function instant(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !INSTANT.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

interface Entry { slot: number; queueId: number; type: string; updatedAt?: Date }
interface Row { date: string; entries: Entry[] }

/** `schedule/time-series`: exactly 48 half-hour rows with the ids 1-48 (id N starts at (N-1)·30 min). */
function checkTimeSeries(body: unknown): void {
  if (!Array.isArray(body) || body.length !== 48) fail('time-series: not 48 rows');
  const ids = new Set(body.map((r) => (isObj(r) && isInt(r.id) ? r.id : NaN)));
  for (let id = 1; id <= 48; id++) if (!ids.has(id)) fail('time-series: ids not 1-48');
}

/** `outage-queue/by-type/3`: name → id over the rows with `deleted` 0 (it must be 0 or 1). All twelve names, each once. */
function queueIds(body: unknown): Map<string, number> {
  if (!Array.isArray(body)) fail('by-type/3: not a list');
  const ids = new Map<string, number>();
  for (const r of body) {
    if (!isObj(r) || !isInt(r.id) || typeof r.name !== 'string') fail('by-type/3: row');
    if (r.deleted !== 0 && r.deleted !== 1) fail('by-type/3: deleted');
    if (r.deleted === 1) continue;
    if (ids.has(r.name)) fail('by-type/3: a name twice');
    ids.set(r.name, r.id);
  }
  for (const name of QUEUE_NAMES) if (!ids.has(name)) fail('by-type/3: a queue missing');
  return ids;
}

/** One series entry: an integer slot 1-48, an integer queue id and a known type. Only `updated_at` is optional. */
function entryOf(e: unknown): Entry {
  if (!isObj(e)) fail('active: series entry');
  if (!isInt(e.time_series_id) || e.time_series_id < 1 || e.time_series_id > 48) fail('active: slot outside 1-48');
  if (!isInt(e.outage_queue_id)) fail('active: queue id');
  if (typeof e.type !== 'string' || !Object.hasOwn(TYPES, e.type)) fail('active: unknown type');
  const updatedAt = instant(e.updated_at);
  return { slot: e.time_series_id, queueId: e.outage_queue_id, type: e.type, ...(updatedAt ? { updatedAt } : {}) };
}

/** `v2/schedule/active`: a list of rows, each the Kyiv day starting at `from`. A missing `series` is an empty one. */
function rowsOf(body: unknown): Row[] {
  if (!Array.isArray(body)) fail('active: not a list');
  return body.map((r): Row => {
    if (!isObj(r)) fail('active: row');
    const from = instant(r.from);
    if (!from) fail('active: from');
    if (r.series !== undefined && !Array.isArray(r.series)) fail('active: series');
    return { date: kyivDateKey(from), entries: (r.series ?? []).map(entryOf) };
  });
}

/** 'HH:MM DD.MM.YYYY' of an instant, in Kyiv time. */
function kyivStamp(d: Date): string {
  const [y, m, day] = kyivDateKey(d).split('-');
  return `${formatHM(d)} ${day}.${m}.${y}`;
}

/**
 * One Kyiv day's slots for one queue name from the joined answers; throws on any unknown shape or type.
 * The dictionaries and every row are checked first, so a quiet answer never skips the checks.
 * undefined = no schedule row for that date. A day with rows but none for this queue is all on.
 */
export function mkoeDay(
  active: unknown, timeSeries: unknown, queues: unknown, date: string, queueName: string,
): { slots: Slot[]; updatedAt?: string } | undefined {
  checkTimeSeries(timeSeries);
  const queueId = queueIds(queues).get(queueName);
  const rows = rowsOf(active);
  if (queueId === undefined) fail('no such queue');
  const mine = rows.filter((r) => r.date === date);
  if (mine.length === 0) return undefined;
  const rank = Array<number>(48).fill(0);
  const slots = daySlots('on');
  let newest: Date | undefined;
  for (const e of mine.flatMap((r) => r.entries)) {
    if (e.updatedAt && (!newest || e.updatedAt.getTime() > newest.getTime())) newest = e.updatedAt;
    if (e.queueId !== queueId) continue;
    const t = TYPES[e.type];
    if (t.rank > rank[e.slot - 1]) {
      rank[e.slot - 1] = t.rank;
      slots[e.slot - 1] = t.slot;
    }
  }
  return { slots, ...(newest ? { updatedAt: kyivStamp(newest) } : {}) };
}
