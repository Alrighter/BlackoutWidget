import { kyivWallTimeToInstant } from '../../../shared/time';
import type { CurrentOutage, Slot } from '../../../shared/types';

// Pure readers of the Тернопільобленерго API (api-poweron.toe.com.ua, API Platform / Hydra). Anything of an unknown
// shape throws ToeShapeError, whose message is a fixed reason of ours: never a value from the response.

export class ToeShapeError extends Error {
  override name = 'ToeShapeError';
}

function fail(reason: string): never {
  throw new ToeShapeError(reason);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `hydra:member` of a Hydra collection; `null` only where the API uses it for «nothing». */
function members(body: unknown, what: string, allowNull = false): unknown[] {
  const m = isObj(body) ? body['hydra:member'] : undefined;
  if (m === null && allowNull) return [];
  return Array.isArray(m) ? m : fail(`${what}: no member list`);
}

// --- Address lists ---------------------------------------------------------------------------------------------

export interface ToeCity { id: number; name: string; otg?: string }
export interface ToeStreet { id: number; name: string }
export interface ToeHouseRow { house: string; queue: string }

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** `pw_cities`: id, name and громада. Rows with an empty name are unusable and dropped; no city at all is unreadable. */
export function parseCities(body: unknown): ToeCity[] {
  const cities: ToeCity[] = [];
  for (const m of members(body, 'pw_cities')) {
    if (!isObj(m) || !isId(m.id)) fail('pw_cities: row');
    if (typeof m.name !== 'string' || m.name.trim() === '') continue;
    const otg = isObj(m.otg) && typeof m.otg.name === 'string' && m.otg.name.trim() !== '' ? m.otg.name : undefined;
    cities.push({ id: m.id, name: m.name, ...(otg ? { otg } : {}) });
  }
  return cities.length > 0 ? cities : fail('pw_cities: empty');
}

/** `pw_streets` of one city: id and name. */
export function parseStreets(body: unknown): ToeStreet[] {
  return members(body, 'pw_streets').map((m) => {
    if (!isObj(m) || !isId(m.id) || typeof m.name !== 'string') return fail('pw_streets: row');
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
    return { house: r.buildingName, queue: queue ?? '' };
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

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})/;

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
    if (!isObj(m) || typeof m.dateGraph !== 'string' || !DATE_KEY.test(m.dateGraph)) return fail('a_gpv_g: member date');
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

// --- Wall-clock stamps -----------------------------------------------------------------------------------------

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * 'HH:MM DD.MM.YYYY' from a stamp's digits. TOE writes Kyiv wall clock and labels it «Z» or «+00:00», as its own site
 * shows it: the digits are taken as written, never converted.
 */
export function wallStamp(iso: string | null | undefined): string | undefined {
  const m = typeof iso === 'string' ? WALL.exec(iso) : null;
  return m ? `${m[4]}:${m[5]} ${m[3]}.${m[2]}.${m[1]}` : undefined;
}

/** The instant of a stamp's digits read as Kyiv wall clock. */
function wallInstant(iso: string | null | undefined): Date | undefined {
  const m = typeof iso === 'string' ? WALL.exec(iso) : null;
  if (!m) return undefined;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return undefined;
  const d = kyivWallTimeToInstant(`${m[1]}-${m[2]}-${m[3]}`, h * 60 + mi);
  return Number.isNaN(d.getTime()) ? undefined : new Date(d.getTime() + s * 1000);
}

// --- Current outage (pw_accidents, pw_accident_planeds) -----------------------------------------------------------

export type OutageKind = 'emergency' | 'planned';
/** One outage row, reduced to what is needed. `koment` is never read. */
export interface OutageRow { kind: OutageKind; houses: string[]; start: string; end?: string }

const TEXT: Record<OutageKind, string> = { emergency: 'Аварійне відключення', planned: 'Планові роботи' };
/** `switchSubReason` 2 is the hourly schedule itself (the widget already shows it). */
const SCHEDULE_REASON = 2;

const idOf = (v: unknown): unknown => (isObj(v) ? v.id : undefined);

/**
 * The rows of one outage list that belong to this city and street (the query filters by them; a row of another place
 * never counts even if the filter were ignored). Only `city.id`, `street.id`, `buildingNames`, `dateEvent`,
 * `datePlanIn` and `switchSubReason` are read.
 */
export function parseOutageRows(body: unknown, kind: OutageKind, place: { cityId: number; streetId: number }): OutageRow[] {
  const rows: OutageRow[] = [];
  for (const m of members(body, kind)) {
    if (!isObj(m)) continue;
    if (idOf(m.city) !== place.cityId || idOf(m.street) !== place.streetId) continue;
    if (kind === 'emergency' && m.switchSubReason === SCHEDULE_REASON) continue;
    if (typeof m.buildingNames !== 'string' || typeof m.dateEvent !== 'string') continue;
    const end = typeof m.datePlanIn === 'string' ? m.datePlanIn : undefined;
    rows.push({
      kind, houses: m.buildingNames.split(',').map((h) => h.trim()).filter((h) => h !== ''),
      start: m.dateEvent, ...(end ? { end } : {}),
    });
  }
  return rows;
}

/** Running now: started, and not yet past its planned end. Only an emergency may have no end (it counts once started). */
function running(row: OutageRow, now: Date): boolean {
  const start = wallInstant(row.start);
  if (!start || start.getTime() > now.getTime()) return false;
  if (row.end === undefined) return row.kind === 'emergency';
  const end = wallInstant(row.end);
  return !!end && now.getTime() <= end.getTime();
}

/** The outage for this house now: an emergency wins over planned works. */
export function currentOutageOf(emergency: OutageRow[], planned: OutageRow[], house: string, now: Date): CurrentOutage | undefined {
  const row = [...emergency, ...planned].find((r) => house !== '' && r.houses.includes(house) && running(r, now));
  if (!row) return undefined;
  const start = wallStamp(row.start);
  const end = wallStamp(row.end);
  return { kind: row.kind, text: TEXT[row.kind], ...(start ? { start } : {}), ...(end ? { end } : {}) };
}
