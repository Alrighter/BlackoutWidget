import type { CurrentOutage } from '../../../shared/types';
import { kyivStamp } from '../../../shared/time';
import { classifyQueue } from '../lines';
import { instant, isInt, isObj } from '../shape';
import { LoeShapeError } from './schedule';

// Pure readers of Львівобленерго's address and outage API (power-api.loe.lviv.ua). Anything of an unknown shape throws
// LoeShapeError, whose message is a fixed reason of ours: never a value from the response.

export interface Place { cityId: number; streetId: number }

function fail(reason: string): never {
  throw new LoeShapeError(reason);
}

/** The rows of a list the API gives either as a plain array or as Hydra (`hydra:member`), depending on the cache variant. */
function members(body: unknown, what: string): unknown[] {
  if (Array.isArray(body)) return body;
  const m = isObj(body) ? body['hydra:member'] : undefined;
  return Array.isArray(m) ? m : fail(`${what}: no member list`);
}

// --- Address records -------------------------------------------------------------------------------------------

export interface LoeCity { id: number; name: string; otg?: string }
export interface LoeStreet { id: number; name: string }
export interface LoeAccount { house: string; queue: string }

/** `pw_cities`: id, name and громада of the Lviv-oblast rows (`codeOtg` UA46…); no such row at all is unreadable. */
export function parseCities(body: unknown): LoeCity[] {
  const cities: LoeCity[] = [];
  for (const m of members(body, 'pw_cities')) {
    if (!isObj(m) || !isInt(m.id)) fail('pw_cities: row');
    if (typeof m.codeOtg !== 'string' || !m.codeOtg.startsWith('UA46')) continue;
    if (typeof m.name !== 'string' || m.name.trim() === '') continue;
    const otg = isObj(m.otg) && typeof m.otg.name === 'string' && m.otg.name.trim() !== '' ? m.otg.name.trim() : undefined;
    cities.push({ id: m.id, name: m.name.trim(), ...(otg ? { otg } : {}) });
  }
  return cities.length > 0 ? cities : fail('pw_cities: empty');
}

/** `pw_streets` of one city: id and trimmed name. A city with no streets (renamed Червоноград) is `[]`. */
export function parseStreets(body: unknown): LoeStreet[] {
  const streets: LoeStreet[] = [];
  for (const m of members(body, 'pw_streets')) {
    if (!isObj(m) || !isInt(m.id) || typeof m.name !== 'string') fail('pw_streets: row');
    if (m.name.trim() !== '') streets.push({ id: m.id, name: m.name.trim() });
  }
  return streets;
}

/** Lviv's only `chergGpv` for a house outside the hourly schedule (never empty: lviv.md, 0 of 7,560 rows). */
const NOT_IN_SCHEDULE_VALUES = ['Не входить'] as const;
/** A `chergGpv` as a classified id: «N.M» or the 'none' line; anything else throws (read as «could not read»). */
export const queueId = (value: string): string => classifyQueue(value, NOT_IN_SCHEDULE_VALUES);

/** `pw_accounts`: one row per customer account. Only the house text (byte for byte) and its ГПВ queue are read. */
export function parseAccounts(body: unknown): LoeAccount[] {
  return members(body, 'pw_accounts').map((m) => {
    if (!isObj(m) || typeof m.buildingName !== 'string' || typeof m.chergGpv !== 'string') return fail('pw_accounts: row');
    return { house: m.buildingName, queue: m.chergGpv };
  });
}

// --- Current outage --------------------------------------------------------------------------------------------

/** One `pw_accidents` row, reduced to what is needed. `koment` is never read. */
interface Accident { kind: CurrentOutage['kind']; text: string; houses: string[]; start: Date; end?: Date }

const TYPE_OFF: Record<string, { kind: CurrentOutage['kind']; text: string }> = {
  0: { kind: 'planned', text: 'Планове вимкнення' },
  1: { kind: 'emergency', text: 'Аварійне вимкнення' },
  2: { kind: 'other', text: 'Оперативні перемикання' },
  30: { kind: 'other', text: 'Можливе аварійне вимкнення' },
};
const RANK: Record<CurrentOutage['kind'], number> = { emergency: 0, planned: 1, other: 2 };

const houseTokens = (s: string): string[] => s.split(',').map((t) => t.trim()).filter((t) => t !== '');
const idOf = (v: unknown): unknown => (isObj(v) ? v.id : undefined);

/**
 * The rows of this city and street (the query filters by them; a row of another place never counts even if the filter
 * were ignored). Only `city.id`, `street.id`, `typeOff`, `buildingNames`, `dateEvent` and `datePlanIn` are read; a row
 * of an unknown `typeOff`, without a start, or with a `datePlanIn` that is not null but not an instant is skipped (an end
 * we cannot read must not turn the row into an open-ended outage).
 */
export function parseAccidents(body: unknown, place: Place): Accident[] {
  const rows: Accident[] = [];
  for (const m of members(body, 'pw_accidents')) {
    if (!isObj(m) || idOf(m.city) !== place.cityId || idOf(m.street) !== place.streetId) continue;
    const type = typeof m.typeOff === 'number' && Object.hasOwn(TYPE_OFF, String(m.typeOff)) ? TYPE_OFF[String(m.typeOff)] : undefined;
    const start = instant(m.dateEvent);
    if (!type || !start || typeof m.buildingNames !== 'string') continue;
    const end = instant(m.datePlanIn);
    if (!end && m.datePlanIn !== null && m.datePlanIn !== undefined) continue;
    rows.push({ ...type, houses: houseTokens(m.buildingNames), start, ...(end ? { end } : {}) });
  }
  return rows;
}

/** The outage for this house now: started, and before its end if it has one. An emergency wins, then planned works. */
export function currentOutageOf(rows: Accident[], house: string, now: Date): CurrentOutage | undefined {
  const mine = houseTokens(house);
  const row = rows
    .filter((r) => r.houses.some((h) => mine.includes(h)))
    .filter((r) => r.start.getTime() <= now.getTime() && (!r.end || now.getTime() < r.end.getTime()))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];
  if (!row) return undefined;
  return { kind: row.kind, text: row.text, start: kyivStamp(row.start), ...(row.end ? { end: kyivStamp(row.end) } : {}) };
}
