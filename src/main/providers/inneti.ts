import { kyivWallTimeToInstant } from '../../shared/time';
import type { CurrentOutage } from '../../shared/types';
import { isObj, ShapeError } from './shape';

// Pure readers of the inneti «poweron» APIs (Тернопільобленерго, Житомиробленерго): Hydra lists whose outage stamps are
// Kyiv wall clock labelled Z or +00:00. Anything of an unknown shape throws ShapeError, whose message is a fixed reason
// of ours: never a value from the response.

export interface Place { cityId: number; streetId: number }
export interface OutageRow { kind: CurrentOutage['kind']; text: string; houses: string[]; start: string; end?: string }
/** How a source reads a `pw_accidents` row's `switchSubReason`: its kind and text, or undefined to skip the row. */
export type SubReason = (value: unknown) => Pick<OutageRow, 'kind' | 'text'> | undefined;

function fail(reason: string): never {
  throw new ShapeError(reason);
}

/** `hydra:member` of an outage list. */
function members(body: unknown, what: string): unknown[] {
  const m = isObj(body) ? body['hydra:member'] : undefined;
  return Array.isArray(m) ? m : fail(`${what}: no member list`);
}

const idOf = (v: unknown): unknown => (isObj(v) ? v.id : undefined);

/**
 * The rows of one outage list that belong to this city and street (the query filters by them; a row of another place
 * never counts even if the filter were ignored). Only `city.id`, `street.id`, `buildingNames`, `dateEvent` and
 * `datePlanIn` are read, and `read` says what each row is (undefined skips it).
 */
function rowsOf(
  body: unknown, what: string, place: Place, read: (m: Record<string, unknown>) => Pick<OutageRow, 'kind' | 'text'> | undefined,
): OutageRow[] {
  const rows: OutageRow[] = [];
  for (const m of members(body, what)) {
    if (!isObj(m)) continue;
    if (idOf(m.city) !== place.cityId || idOf(m.street) !== place.streetId) continue;
    const type = read(m);
    if (!type) continue;
    if (typeof m.buildingNames !== 'string' || typeof m.dateEvent !== 'string') continue;
    const end = typeof m.datePlanIn === 'string' ? m.datePlanIn : undefined;
    rows.push({
      ...type, houses: m.buildingNames.split(',').map((h) => h.trim()).filter((h) => h !== ''),
      start: m.dateEvent, ...(end ? { end } : {}),
    });
  }
  return rows;
}

/** `pw_accidents`: each row's kind and text come from the source's `subReason`. `koment` is never read. */
export function accidentRows(body: unknown, place: Place, subReason: SubReason): OutageRow[] {
  return rowsOf(body, 'pw_accidents', place, (m) => subReason(m.switchSubReason));
}

/** `pw_accident_planeds`: planned works. */
export function plannedRows(body: unknown, place: Place): OutageRow[] {
  return rowsOf(body, 'pw_accident_planeds', place, () => ({ kind: 'planned', text: 'Планові роботи' }));
}

// --- Wall-clock stamps -----------------------------------------------------------------------------------------

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * 'HH:MM DD.MM.YYYY' from a stamp's digits. The operator writes Kyiv wall clock and labels it «Z» or «+00:00», as its own
 * site shows it: the digits are taken as written, never converted.
 */
export function wallStamp(iso: string | null | undefined): string | undefined {
  const m = typeof iso === 'string' ? WALL.exec(iso) : null;
  return m ? `${m[4]}:${m[5]} ${m[3]}.${m[2]}.${m[1]}` : undefined;
}

/** The instant of a stamp's digits read as Kyiv wall clock. */
export function wallInstant(iso: string | null | undefined): Date | undefined {
  const m = typeof iso === 'string' ? WALL.exec(iso) : null;
  if (!m) return undefined;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return undefined;
  const d = kyivWallTimeToInstant(`${m[1]}-${m[2]}-${m[3]}`, h * 60 + mi);
  return Number.isNaN(d.getTime()) ? undefined : new Date(d.getTime() + s * 1000);
}

// --- Current outage --------------------------------------------------------------------------------------------

const RANK: Record<CurrentOutage['kind'], number> = { emergency: 0, planned: 1, other: 2 };

/** Started, and not yet past its planned end. A row without an end counts once started, unless it is planned. */
function running(row: OutageRow, now: Date): boolean {
  const start = wallInstant(row.start);
  if (!start || start.getTime() > now.getTime()) return false;
  if (row.end === undefined) return row.kind !== 'planned';
  const end = wallInstant(row.end);
  return !!end && now.getTime() <= end.getTime();
}

/** The outage for this house now; an emergency wins over planned works, which win over `other`. `sameHouse` compares house texts. */
export function currentOutageOf(
  rows: readonly OutageRow[], house: string, now: Date, sameHouse: (a: string, b: string) => boolean = (a, b) => a === b,
): CurrentOutage | undefined {
  const row = rows
    .filter((r) => house !== '' && r.houses.some((h) => sameHouse(h, house)) && running(r, now))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];
  if (!row) return undefined;
  const start = wallStamp(row.start);
  const end = wallStamp(row.end);
  return { kind: row.kind, text: row.text, ...(start ? { start } : {}), ...(end ? { end } : {}) };
}
