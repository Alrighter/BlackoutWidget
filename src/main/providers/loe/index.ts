import { providerDisplayName } from '../../../shared/providers';
import { addDays, formatHM, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import type { HttpFetch } from '../http';
import { HttpSource, quietNote, sourceTexts, type SourceInit } from '../http-source';
import { NONE_GROUP, daySlots, linesOf, queueLabel } from '../lines';
import { AddressNotFoundError, addressNotFound, resolveByLabel, uniqueLabels } from '../resolve';
import { ProviderError, type ScheduleProvider } from '../types';
import {
  LoeShapeError, archiveHtmls, archiveRevision, itemRevision, latestRevisions, menuItemHtml, type LoeRevision,
} from './schedule';

const NAME = 'Львівобленерго';
const TEXTS = sourceTexts(NAME);
export const LOE_QUIET_NOTE = quietNote(NAME, 'опублікувало');

/** The CMS with the schedule text, and the address and outage API. */
const CMS = 'https://api.loe.lviv.ua/api';
const API = 'https://power-api.loe.lviv.ua/api';
const GET: SourceInit = { method: 'GET', headers: { Accept: 'application/ld+json' } };
/** One burst of requests once got a Cloudflare 429: every LOE request starts at least this long after the last one. */
const MIN_GAP_MS = 1500;
/** Besides 429 (HttpSource): Cloudflare's challenge (403) and a busy origin (503) are the site not answering us. */
const NOT_ANSWERING = new Set([403, 503]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The rows of a list the API gives either as a plain array or as Hydra (`hydra:member`), depending on the cache variant. */
function members(body: unknown, what: string): unknown[] {
  if (Array.isArray(body)) return body;
  const m = isObj(body) ? body['hydra:member'] : undefined;
  return Array.isArray(m) ? m : fail(`${what}: no member list`);
}

function fail(reason: string): never {
  throw new LoeShapeError(reason);
}

// --- Address records -------------------------------------------------------------------------------------------

interface LoeCity { id: number; name: string; otg?: string }
interface LoeStreet { id: number; name: string }
interface LoeAccount { house: string; queue: string }

/** `pw_cities`: id, name and громада of the Lviv-oblast rows (`codeOtg` UA46…); no such row at all is unreadable. */
function parseCities(body: unknown): LoeCity[] {
  const cities: LoeCity[] = [];
  for (const m of members(body, 'pw_cities')) {
    if (!isObj(m) || !isId(m.id)) fail('pw_cities: row');
    if (typeof m.codeOtg !== 'string' || !m.codeOtg.startsWith('UA46')) continue;
    if (typeof m.name !== 'string' || m.name.trim() === '') continue;
    const otg = isObj(m.otg) && typeof m.otg.name === 'string' && m.otg.name.trim() !== '' ? m.otg.name.trim() : undefined;
    cities.push({ id: m.id, name: m.name.trim(), ...(otg ? { otg } : {}) });
  }
  return cities.length > 0 ? cities : fail('pw_cities: empty');
}

/** `pw_streets` of one city: id and trimmed name. A city with no streets (renamed Червоноград) is `[]`. */
function parseStreets(body: unknown): LoeStreet[] {
  const streets: LoeStreet[] = [];
  for (const m of members(body, 'pw_streets')) {
    if (!isObj(m) || !isId(m.id) || typeof m.name !== 'string') fail('pw_streets: row');
    if (m.name.trim() !== '') streets.push({ id: m.id, name: m.name.trim() });
  }
  return streets;
}

/** `pw_accounts`: one row per customer account. Only the house text (byte for byte) and its ГПВ queue are read. */
function parseAccounts(body: unknown): LoeAccount[] {
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
/** An instant with its offset, as the API writes it («2026-10-20T13:09:00+03:00»). Without one it is not trusted. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function instant(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !INSTANT.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const houseTokens = (s: string): string[] => s.split(',').map((t) => t.trim()).filter((t) => t !== '');
const idOf = (v: unknown): unknown => (isObj(v) ? v.id : undefined);

/**
 * The rows of this city and street (the query filters by them; a row of another place never counts even if the filter
 * were ignored). Only `city.id`, `street.id`, `typeOff`, `buildingNames`, `dateEvent` and `datePlanIn` are read; a row
 * of an unknown `typeOff` or without a start is skipped.
 */
function parseAccidents(body: unknown, place: Place): Accident[] {
  const rows: Accident[] = [];
  for (const m of members(body, 'pw_accidents')) {
    if (!isObj(m) || idOf(m.city) !== place.cityId || idOf(m.street) !== place.streetId) continue;
    const type = typeof m.typeOff === 'number' && Object.hasOwn(TYPE_OFF, String(m.typeOff)) ? TYPE_OFF[String(m.typeOff)] : undefined;
    const start = instant(m.dateEvent);
    if (!type || !start || typeof m.buildingNames !== 'string') continue;
    const end = instant(m.datePlanIn);
    rows.push({ ...type, houses: houseTokens(m.buildingNames), start, ...(end ? { end } : {}) });
  }
  return rows;
}

/** 'HH:MM DD.MM.YYYY' of an instant, in Kyiv time. */
function kyivStamp(d: Date): string {
  const [y, m, day] = kyivDateKey(d).split('-');
  return `${formatHM(d)} ${day}.${m}.${y}`;
}

/** The outage for this house now: started, and before its end if it has one. An emergency wins, then planned works. */
function currentOutageOf(rows: Accident[], house: string, now: Date): CurrentOutage | undefined {
  const mine = houseTokens(house);
  const row = rows
    .filter((r) => r.houses.some((h) => mine.includes(h)))
    .filter((r) => r.start.getTime() <= now.getTime() && (!r.end || now.getTime() < r.end.getTime()))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];
  if (!row) return undefined;
  return { kind: row.kind, text: row.text, start: kyivStamp(row.start), ...(row.end ? { end: kyivStamp(row.end) } : {}) };
}

// --- The provider ----------------------------------------------------------------------------------------------

/**
 * A list with its labels, index-aligned as `resolveByLabel` needs, in id order: the « (2)» of a repeated label then
 * follows the record, so a saved label never moves to a namesake when the API lists them in another order.
 */
interface Labeled<T> { items: T[]; labels: string[] }
interface Place { cityId: number; streetId: number }

const sorted = (labels: string[]): string[] => [...labels].sort((a, b) => a.localeCompare(b, 'uk'));
const byId = <T extends { id: number }>(items: T[]): T[] => [...items].sort((a, b) => a.id - b.id);
const houseOrder = new Intl.Collator('uk', { numeric: true });
const cityGroup = (c: LoeCity): string | undefined => (c.otg ? `${c.otg} громада` : undefined);
const noGroup = (): undefined => undefined;
/** Only the kind of a non-provider error goes to the log: an error's message may quote a response. */
const loggable = (e: unknown): unknown => (e instanceof ProviderError ? e : { error: e instanceof Error ? e.name : typeof e });

export interface LoeDeps {
  fetch: HttpFetch;
  isOnline: () => boolean;
  log?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/**
 * Львівобленерго over plain HTTPS: the schedule text of the CMS (Today, Tomorrow and the archive), the address directory
 * with every house's queues, and current outages. The schedule is oblast-wide, so on refresh the address side is soft
 * for a queue line; for the 'none' line it is the only proof and stays hard.
 */
export class LoeProvider implements ScheduleProvider {
  readonly id = 'loe';
  readonly displayName = providerDisplayName('loe');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  private readonly clock: () => number;
  private cities: Labeled<LoeCity> | undefined;
  /** Streets by city id; like the city list, kept for the run. */
  private readonly streets = new Map<number, Labeled<LoeStreet>>();

  constructor(deps: LoeDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.clock = deps.clock ?? Date.now;
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'loe', texts: TEXTS,
      minGapMs: MIN_GAP_MS, sleep: deps.sleep, clock: deps.clock,
    });
  }

  listCities(): Promise<string[]> {
    return this.http.serial('listCities', async () => sorted((await this.cityList()).labels));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sorted((await this.streetList((await this.city(city)).id)).labels));
  }

  /** Each house once, its text byte for byte, with the distinct queues of all its accounts. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const place = await this.place(city, street);
      const queues = new Map<string, string[]>();
      for (const r of await this.accounts(`${API}/pw_accounts?pagination=false&city.id=${place.cityId}&street.id=${place.streetId}`)) {
        if (r.house.trim() !== '') queues.set(r.house, [...(queues.get(r.house) ?? []), r.queue]);
      }
      return [...queues.keys()].sort(houseOrder.compare)
        .map((house): HouseInfo => ({ house, lines: linesOf(queues.get(house)!), outageActive: false }));
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const checked = await this.houseCheck(address);
      const lines = checked?.lines ?? [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
      let days: DaySchedule[];
      let sourceUpdatedAt: string | undefined;
      let note: string | undefined;
      if (!lines.some((l) => l.groupId === address.groupId)) {
        // The operator moved the house to another queue: the app asks to pick the line again.
        days = [{ date: today, slots: daySlots('unknown') }];
      } else if (address.groupId === NONE_GROUP) {
        days = [{ date: today, slots: daySlots('on') }];
      } else {
        ({ days, sourceUpdatedAt, note } = await this.schedule(address.groupId, today));
      }
      const currentOutage = checked ? await this.currentOutage(checked.place, address.house, now) : undefined;
      return {
        providerId: this.id,
        address,
        groupId: address.groupId,
        groupLabel: queueLabel(address.groupId),
        days,
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
        fetchedAt: now.toISOString(),
        lines,
        ...(currentOutage ? { currentOutage } : {}),
        ...(note ? { note } : {}),
      };
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  /**
   * The saved house's queues from its own accounts (`buildingName` matches exactly). A label or house the operator no
   * longer has is AddressNotFoundError. For a queue line any other failure only costs the check: the oblast-wide
   * schedule still holds, and the saved line stays (undefined here). The 'none' line has no schedule behind it, so
   * there the check is the only proof and its failure fails the snapshot.
   */
  private async houseCheck(address: Address): Promise<{ place: Place; lines: LineInfo[] } | undefined> {
    try {
      const place = await this.place(address.city, address.street);
      const url = `${API}/pw_accounts?pagination=false&city.id=${place.cityId}&street.id=${place.streetId}`
        + `&buildingName=${encodeURIComponent(address.house)}`;
      const rows = (await this.accounts(url)).filter((r) => r.house === address.house);
      if (rows.length === 0) throw addressNotFound(NAME);
      return { place, lines: linesOf(rows.map((r) => r.queue)) };
    } catch (e) {
      if (e instanceof AddressNotFoundError || address.groupId === NONE_GROUP) throw e;
      this.log.warn('loe fetchSnapshot: address check failed, keeping the saved line', loggable(e));
      return undefined;
    }
  }

  /**
   * Today (all on with the quiet note when no revision is headed today) and tomorrow when it has one. The Today and
   * Tomorrow items are read every time; the archive only when neither gives today. Per day the latest revision wins.
   */
  private async schedule(groupId: string, today: string): Promise<{ days: DaySchedule[]; sourceUpdatedAt?: string; note?: string }> {
    const tomorrow = addDays(today, 1);
    const dates = [today, tomorrow];
    const revisions: LoeRevision[] = [];
    for (const [id, name] of [[238, 'Today'], [256, 'Tomorrow']] as const) {
      const body = await this.get(`${CMS}/menu_items/${id}`);
      const revision = this.read(`menu_items/${id}`, () => itemRevision(menuItemHtml(body, name)));
      if (revision) revisions.push(revision);
    }
    if (!revisions.some((r) => r.date === today)) {
      // Cloudflare keeps the menu up to 2 h: the time makes the URL new.
      const body = await this.get(`${CMS}/menus?page=1&type=photo-grafic&_=${this.clock()}`);
      for (const html of this.read('menus', () => archiveHtmls(body))) {
        const revision = this.read('menus', () => archiveRevision(html, dates));
        if (revision) revisions.push(revision);
      }
    }
    const picked = latestRevisions(revisions, dates);
    const todayRev = picked.get(today);
    const tomorrowRev = picked.get(tomorrow);
    const days: DaySchedule[] = [{ date: today, slots: todayRev ? this.slots(todayRev, groupId) : daySlots('on') }];
    if (tomorrowRev) days.push({ date: tomorrow, slots: this.slots(tomorrowRev, groupId) });
    return todayRev ? { days, sourceUpdatedAt: todayRev.updatedAt } : { days, note: LOE_QUIET_NOTE };
  }

  private slots(revision: LoeRevision, groupId: string): Slot[] {
    if (!Object.hasOwn(revision.groups, groupId)) throw this.http.unreadable({ what: 'schedule', reason: 'no such group' });
    return revision.groups[groupId];
  }

  /** The outage running now for this house. A failure here never fails the snapshot. */
  private async currentOutage(place: Place, house: string, now: Date): Promise<CurrentOutage | undefined> {
    try {
      const body = await this.get(`${API}/pw_accidents?page=1&city.id=${place.cityId}&street.id=${place.streetId}`);
      return currentOutageOf(this.read('pw_accidents', () => parseAccidents(body, place)), house, now);
    } catch (e) {
      this.log.warn('loe fetchSnapshot: current outage lookup failed', loggable(e));
      return undefined;
    }
  }

  private async place(city: string, street: string): Promise<Place> {
    const cityId = (await this.city(city)).id;
    const streets = await this.streetList(cityId);
    const found = resolveByLabel(streets.items, streets.labels, street, (s) => s.name, noGroup, NAME);
    return { cityId, streetId: found.id };
  }

  private async city(label: string): Promise<LoeCity> {
    const cities = await this.cityList();
    return resolveByLabel(cities.items, cities.labels, label, (c) => c.name, cityGroup, NAME);
  }

  private async cityList(): Promise<Labeled<LoeCity>> {
    if (this.cities) return this.cities;
    const body = await this.get(`${API}/pw_cities?pagination=false&otg.id=`);
    const items = byId(this.read('pw_cities', () => parseCities(body)));
    this.cities = { items, labels: uniqueLabels(items, (c) => c.name, cityGroup) };
    return this.cities;
  }

  private async streetList(cityId: number): Promise<Labeled<LoeStreet>> {
    const cached = this.streets.get(cityId);
    if (cached) return cached;
    const body = await this.get(`${API}/pw_streets?pagination=false&city.id=${cityId}`);
    const items = byId(this.read('pw_streets', () => parseStreets(body)));
    const list = { items, labels: uniqueLabels(items, (s) => s.name, noGroup) };
    this.streets.set(cityId, list);
    return list;
  }

  private async accounts(url: string): Promise<LoeAccount[]> {
    const body = await this.get(url);
    return this.read('pw_accounts', () => parseAccounts(body));
  }

  /** Every LOE request: JSON over GET, with 403 and 503 read as «не відповідає» (the cause, url and status, kept). */
  private async get(url: string): Promise<unknown> {
    try {
      return await this.http.json(url, GET);
    } catch (e) {
      if (e instanceof ProviderError && isObj(e.cause) && typeof e.cause.status === 'number' && NOT_ANSWERING.has(e.cause.status)) {
        throw new ProviderError(TEXTS.noAnswer, { cause: e.cause });
      }
      throw e;
    }
  }

  /** A reader's shape error as «could not read»; its reason is ours, never response text. */
  private read<T>(what: string, parse: () => T): T {
    try {
      return parse();
    } catch (e) {
      if (e instanceof LoeShapeError) throw this.http.unreadable({ what, reason: e.message });
      throw e;
    }
  }
}
