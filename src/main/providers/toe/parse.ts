import type { Slot } from '../../../shared/types';
import { isInt, isObj, ShapeError, type Obj } from '../shape';

// Pure readers of the Тернопільобленерго API (api-poweron.toe.com.ua, API Platform / Hydra). Anything of an unknown
// shape throws ToeShapeError, whose message is a fixed reason of ours: never a value from the response.

export class ToeShapeError extends ShapeError {
  override name = 'ToeShapeError';
}

function fail(reason: string): never {
  throw new ToeShapeError(reason);
}

/** `hydra:member` of a Hydra collection; `null` only where the API uses it for «nothing». */
function members(body: unknown, what: string, allowNull = false): unknown[] {
  const m = isObj(body) ? body['hydra:member'] : undefined;
  if (m === null && allowNull) return [];
  return Array.isArray(m) ? m : fail(`${what}: no member list`);
}

// --- Address lists ---------------------------------------------------------------------------------------------

export interface ToeCity { id: number; name: string; otg?: string }
export interface ToeStreet { id: number; name: string }
/** `queue` is `chergGpv` as written (missing → undefined): the provider classifies it, so a missing one is never «empty». */
export interface ToeHouseRow { house: string; queue: string | null | undefined }

/** `pw_cities`: id, name and громада. Rows with an empty name are unusable and dropped; no city at all is unreadable. */
export function parseCities(body: unknown): ToeCity[] {
  const cities: ToeCity[] = [];
  for (const m of members(body, 'pw_cities')) {
    if (!isObj(m) || !isInt(m.id)) fail('pw_cities: row');
    if (typeof m.name !== 'string' || m.name.trim() === '') continue;
    const otg = isObj(m.otg) && typeof m.otg.name === 'string' && m.otg.name.trim() !== '' ? m.otg.name : undefined;
    cities.push({ id: m.id, name: m.name, ...(otg ? { otg } : {}) });
  }
  return cities.length > 0 ? cities : fail('pw_cities: empty');
}

/** `pw_streets` of one city: id and name. */
export function parseStreets(body: unknown): ToeStreet[] {
  return members(body, 'pw_streets').map((m) => {
    if (!isObj(m) || !isInt(m.id) || typeof m.name !== 'string') return fail('pw_streets: row');
    return { id: m.id, name: m.name };
  });
}

/** `pw-accounts/building-names`: only the house text (byte for byte) and its hourly-schedule queue are read. */
export function parseBuildingNames(body: unknown): ToeHouseRow[] {
  const rows = isObj(body) ? body.buildingNames : undefined;
  if (!Array.isArray(rows)) fail('building-names: no list');
  return rows.map((r) => {
    if (!isObj(r) || typeof r.buildingName !== 'string') return fail('building-names: row');
    const queue = r.chergGpv;
    if (queue !== null && queue !== undefined && typeof queue !== 'string') return fail('building-names: queue');
    return { house: r.buildingName, queue };
  });
}

/** `pw-accounts/building-groups` of one house: its queues as written («1.2», «Не входить», …). */
export function parseBuildingGroups(body: unknown): string[] {
  const groups = isObj(body) ? body.buildingGroups : undefined;
  if (!Array.isArray(groups)) fail('building-groups: no list');
  return groups.map((g) => (isObj(g) && typeof g.chergGpv === 'string' ? g.chergGpv : fail('building-groups: row')));
}

// --- Schedule (a_gpv_g) ----------------------------------------------------------------------------------------

/** One published day: `date` is `dateGraph`'s date part, a Kyiv date whatever its «Z» says. */
export interface GpvDay { id: number; date: string; dateCreate: string; queues: Obj }

/**
 * `dateGraph` as every observed value writes it: a date at midnight, labelled «Z» or «+00:00». Anything else (a real
 * instant such as «…16T21:00:00Z», another offset, a bare date) would move the member to another day: unreadable.
 */
const DATE_GRAPH = /^\d{4}-\d{2}-\d{2}T00:00:00(?:Z|\+00:00)$/;

const later = (a: GpvDay, b: GpvDay): boolean => a.dateCreate > b.dateCreate || (a.dateCreate === b.dateCreate && a.id > b.id);

/**
 * The `a_gpv_g` collection, one member per date: for the same date the later `dateCreate`, then the larger id, wins.
 * `hydra:member` `null` is no day at all. `[]` is unreadable: the API gives it for a missing or wrong key, an unknown
 * house or «Не входить», never for a house that passed the `building-groups` check (it is read only after one).
 * A member that cannot be dated or has no `dataJson` object is unreadable, never skipped: skipping it would turn a
 * renamed field into a quiet day.
 */
export function parseGpvCollection(body: unknown): Map<string, GpvDay> {
  if (!isObj(body) || body['@type'] !== 'hydra:Collection' || typeof body['hydra:totalItems'] !== 'number') {
    fail('a_gpv_g: not a collection');
  }
  const list = members(body, 'a_gpv_g', true);
  if (body['hydra:member'] !== null && list.length === 0) fail('a_gpv_g: empty member list');
  const byDate = new Map<string, GpvDay>();
  for (const m of list) {
    if (!isObj(m) || typeof m.dateGraph !== 'string' || !DATE_GRAPH.test(m.dateGraph)) return fail('a_gpv_g: member date');
    if (!isObj(m.dataJson)) return fail('a_gpv_g: member data');
    const day: GpvDay = {
      id: typeof m.id === 'number' ? m.id : -1,
      date: m.dateGraph.slice(0, 10),
      dateCreate: typeof m.dateCreate === 'string' ? m.dateCreate : '',
      queues: m.dataJson,
    };
    const seen = byDate.get(day.date);
    if (!seen || later(day, seen)) byDate.set(day.date, day);
  }
  return byDate;
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** The 48 slot keys, each the start of its half hour: «00:00» … «23:30». */
const SLOT_KEYS = Array.from({ length: 48 }, (_, i) => `${pad(Math.floor(i / 2))}:${i % 2 ? '30' : '00'}`);
const STATES: Record<string, Slot> = { 0: 'on', 1: 'off', 10: 'maybe-off' };

/** The day's 48 slots of `groupId` (a `#…` key suffix ignored). A missing or doubled queue or any odd slot throws. */
export function queueSlots(day: GpvDay, groupId: string): Slot[] {
  const keys = Object.keys(day.queues).filter((k) => k.split('#')[0] === groupId);
  if (keys.length !== 1) fail(keys.length ? 'a_gpv_g: queue twice' : 'a_gpv_g: queue missing');
  const queue = day.queues[keys[0]];
  const times = isObj(queue) ? queue.times : undefined;
  if (!isObj(times)) fail('a_gpv_g: no times');
  const t = times;
  if (Object.keys(t).length !== 48 || !SLOT_KEYS.every((k) => Object.hasOwn(t, k))) fail('a_gpv_g: slot keys');
  return SLOT_KEYS.map((k) => {
    const v = t[k];
    return typeof v === 'string' && Object.hasOwn(STATES, v) ? STATES[v] : fail('a_gpv_g: slot value');
  });
}
