import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import type { HttpFetch } from '../http';
import { HttpSource, quietNote, sourceTexts, type SourceInit } from '../http-source';
import { NONE_GROUP, daySlots, linesOf, queueLabel } from '../lines';
import { AddressNotFoundError, resolveByLabel, uniqueLabels } from '../resolve';
import { ProviderError, type ScheduleProvider } from '../types';
import { MkoeShapeError, mkoeDay } from './schedule';
import { mkoeSettlements, type MkoeSettlement } from './settlements';

const NAME = 'Миколаївобленерго';
export const MKOE_QUIET_NOTE = quietNote(NAME, 'опублікувало');

const API = 'https://off.energy.mk.ua/api';
const GET: SourceInit = { method: 'GET', headers: { Accept: 'application/json' } };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

function fail(reason: string): never {
  throw new MkoeShapeError(reason);
}

// --- Address records -------------------------------------------------------------------------------------------

/** A street or a house: the operator's id and the trimmed name. */
interface Rec { id: number; name: string }
/** One of a house's queues (`outage-queue`): type 1 ГАВ, 2 СГАВ, 3 ГПВ; `on` is `enabled` exactly 1. */
interface HouseQueue { id: number; typeId: number; name: string; deleted: 0 | 1; on: boolean }

/** A list of `{[idKey]: integer, [nameKey]: string}` rows; names are trimmed and empty ones dropped. */
function records(body: unknown, idKey: string, nameKey: string, what: string): Rec[] {
  if (!Array.isArray(body)) fail(`${what}: not a list`);
  const recs: Rec[] = [];
  for (const r of body) {
    if (!isObj(r) || !isInt(r[idKey]) || typeof r[nameKey] !== 'string') fail(`${what}: row`);
    const name = (r[nameKey] as string).trim();
    if (name !== '') recs.push({ id: r[idKey] as number, name });
  }
  return recs;
}

/** `addr/dom/{iddom}/outage-queue`: the house's queues of every type, as they come; `deleted` must be 0 or 1. */
function parseHouseQueues(body: unknown): HouseQueue[] {
  if (!Array.isArray(body)) fail('outage-queue: not a list');
  return body.map((r): HouseQueue => {
    const o = isObj(r) ? r.outage : undefined;
    if (!isObj(o) || !isInt(o.id) || !isInt(o.type_id) || typeof o.name !== 'string') fail('outage-queue: row');
    if (o.deleted !== 0 && o.deleted !== 1) fail('outage-queue: deleted');
    return { id: o.id, typeId: o.type_id, name: o.name.trim(), deleted: o.deleted, on: o.enabled === 1 };
  });
}

const QUEUE_NAME = /^\d+\.\d+$/;

/**
 * The house's lines: its live ГПВ queues by name («2.2»); none at all is the always-on line. A ГПВ row named outside
 * N.M or marked deleted, or a row of a type other than ГАВ, СГАВ or ГПВ, is a shape we do not know: then `unknown`
 * names it and `lines` holds only the queues that could be read, never the always-on line (which it cannot prove).
 */
function linesOfQueues(queues: HouseQueue[]): { lines: LineInfo[]; unknown?: string } {
  let unknown: string | undefined;
  const names: string[] = [];
  for (const q of queues) {
    if (q.typeId !== 1 && q.typeId !== 2 && q.typeId !== 3) unknown ??= 'type';
    else if (q.typeId !== 3) continue;
    else if (q.deleted !== 0) unknown ??= 'deleted';
    else if (!QUEUE_NAME.test(q.name)) unknown ??= 'queue name';
    else names.push(q.name);
  }
  if (unknown === undefined) return { lines: linesOf(names) };
  return { lines: names.length > 0 ? linesOf(names) : [], unknown };
}

// --- Current outage --------------------------------------------------------------------------------------------

/** The emergency queues, by `type_id`. A switched-on ГПВ queue is in the schedule already and is not one. */
const EMERGENCY: Record<number, string> = { 1: 'ГАВ', 2: 'СГАВ' };

/** A switched-on ГАВ or СГАВ queue of the house. There are no times. ГАВ before СГАВ, then by id, whatever the order. */
function currentOutageOf(queues: HouseQueue[]): CurrentOutage | undefined {
  const on = queues
    .filter((q) => q.on && q.deleted === 0 && Object.hasOwn(EMERGENCY, q.typeId))
    .sort((a, b) => a.typeId - b.typeId || a.id - b.id)[0];
  return on ? { kind: 'emergency', text: `Знеструмлення за ${EMERGENCY[on.typeId]} ${on.name}` } : undefined;
}

// --- The provider ----------------------------------------------------------------------------------------------

/**
 * A list with its labels, index-aligned as `resolveByLabel` needs, in id order: the « (2)» of a repeated label then
 * follows the record, so a saved label never moves to a namesake when the API lists them in another order.
 */
interface Labeled<T> { items: T[]; labels: string[] }

const sorted = (labels: string[]): string[] => [...labels].sort((a, b) => a.localeCompare(b, 'uk'));
const byId = <T extends { id: number }>(items: T[]): T[] => [...items].sort((a, b) => a.id - b.id);
const houseOrder = new Intl.Collator('uk', { numeric: true });
const recName = (r: Rec): string => r.name;
const noGroup = (): undefined => undefined;
/** Only the kind of a non-provider error goes to the log: an error's message may quote a response. */
const loggable = (e: unknown): unknown => (e instanceof ProviderError ? e : { error: e instanceof Error ? e.name : typeof e });

export interface MkoeDeps {
  fetch: HttpFetch;
  isOnline: () => boolean;
  log?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/**
 * Миколаївобленерго over plain HTTPS (off.energy.mk.ua): the bundled settlements, then streets and houses, each house's
 * queues, the oblast-wide half-hourly schedule (three joined answers) and switched-on ГАВ/СГАВ queues. No browser window.
 * On refresh the address side is soft for a queue line (the schedule holds without it); for the 'none' line the house
 * list is the only proof and stays hard.
 */
export class MkoeProvider implements ScheduleProvider {
  readonly id = 'mkoe';
  readonly displayName = providerDisplayName('mkoe');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  /** Streets by settlement id, houses by street id; kept for the run (a refresh asks for the house list again). */
  private readonly streets = new Map<number, Labeled<Rec>>();
  private readonly houses = new Map<number, Labeled<Rec>>();

  constructor(deps: MkoeDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'mkoe', texts: sourceTexts(NAME),
      sleep: deps.sleep, clock: deps.clock,
    });
  }

  /** The bundled settlements (labels unique and sorted): no request. */
  listCities(): Promise<string[]> {
    return this.http.serial('listCities', async () => mkoeSettlements().map((s) => s.label));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sorted((await this.streetList(this.settlement(city).id)).labels));
  }

  /** Each house once, in number order. Its queues come only per house, through `houseLines`. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const list = await this.houseList(await this.streetId(city, street));
      return [...list.labels].sort(houseOrder.compare)
        .map((house): HouseInfo => ({ house, lines: [], outageActive: false, linesPending: true }));
    });
  }

  houseLines(city: string, street: string, house: string): Promise<LineInfo[]> {
    return this.http.serial('houseLines', async () => {
      const found = this.house(await this.houseList(await this.streetId(city, street)), house);
      const { lines, unknown } = linesOfQueues(await this.houseQueues(found.id));
      if (unknown !== undefined) throw this.http.unreadable({ what: 'outage-queue', reason: unknown });
      return lines;
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const iddom = await this.houseCheck(address);
      const queues = iddom === undefined ? undefined : await this.softHouseQueues(iddom);
      const read = queues ? linesOfQueues(queues) : undefined;
      const lines = read
        ? read.lines
        : [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
      const currentOutage = queues ? currentOutageOf(queues) : undefined;
      let days: DaySchedule[];
      let sourceUpdatedAt: string | undefined;
      let note: string | undefined;
      if (read?.unknown !== undefined) {
        // The house's queues came in a shape we do not know: neither its line nor the always-on line is proven.
        this.log.warn('mkoe fetchSnapshot: house queues of an unknown shape', { what: 'outage-queue', reason: read.unknown });
        days = [{ date: today, slots: daySlots('unknown') }];
      } else if (!lines.some((l) => l.groupId === address.groupId)) {
        // The operator moved the house to another queue (or in or out of the schedule): the app asks to pick again.
        days = [{ date: today, slots: daySlots('unknown') }];
      } else if (address.groupId === NONE_GROUP) {
        days = [{ date: today, slots: daySlots('on') }];
      } else {
        ({ days, sourceUpdatedAt, note } = await this.schedule(address.groupId, today));
      }
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
   * The saved house's id from a fresh house list. A label or house the operator no longer has is AddressNotFoundError.
   * For a queue line any other failure only costs the check (undefined: the saved line stays, no current outage): the
   * oblast-wide schedule still holds. The 'none' line has no schedule behind it, so there the failure fails the snapshot.
   */
  private async houseCheck(address: Address): Promise<number | undefined> {
    try {
      const list = await this.houseList(await this.streetId(address.city, address.street), true);
      return this.house(list, address.house).id;
    } catch (e) {
      if (e instanceof AddressNotFoundError || address.groupId === NONE_GROUP) throw e;
      this.log.warn('mkoe fetchSnapshot: address check failed, keeping the saved line', loggable(e));
      return undefined;
    }
  }

  /** The house's queues for the lines and the current outage. A failure keeps the saved line and drops the outage. */
  private async softHouseQueues(iddom: number): Promise<HouseQueue[] | undefined> {
    try {
      return await this.houseQueues(iddom);
    } catch (e) {
      this.log.warn('mkoe fetchSnapshot: house queues failed, keeping the saved line', loggable(e));
      return undefined;
    }
  }

  /**
   * Today (all on with the quiet note when it has no row) and tomorrow when it has one, for the saved queue name. The
   * three answers are read one after another, every refresh: the dictionaries are the guard a quiet `[]` cannot give.
   */
  private async schedule(groupId: string, today: string): Promise<{ days: DaySchedule[]; sourceUpdatedAt?: string; note?: string }> {
    const tomorrow = addDays(today, 1);
    const active = await this.http.json(`${API}/v2/schedule/active`, GET);
    const timeSeries = await this.http.json(`${API}/schedule/time-series`, GET);
    const queues = await this.http.json(`${API}/outage-queue/by-type/3`, GET);
    const day = (date: string) => this.read('schedule', () => mkoeDay(active, timeSeries, queues, date, groupId));
    const todayDay = day(today);
    const tomorrowDay = day(tomorrow);
    const days: DaySchedule[] = [{ date: today, slots: todayDay ? todayDay.slots : daySlots('on') }];
    if (tomorrowDay) days.push({ date: tomorrow, slots: tomorrowDay.slots });
    if (!todayDay) return { days, note: MKOE_QUIET_NOTE };
    return { days, ...(todayDay.updatedAt ? { sourceUpdatedAt: todayDay.updatedAt } : {}) };
  }

  private settlement(label: string): MkoeSettlement {
    const list = mkoeSettlements();
    return resolveByLabel(list, list.map((s) => s.label), label, (s) => s.name, (s) => s.filii, NAME);
  }

  private async streetId(city: string, street: string): Promise<number> {
    const list = await this.streetList(this.settlement(city).id);
    return resolveByLabel(list.items, list.labels, street, recName, noGroup, NAME).id;
  }

  private house(list: Labeled<Rec>, label: string): Rec {
    return resolveByLabel(list.items, list.labels, label, recName, noGroup, NAME);
  }

  private async streetList(nsId: number): Promise<Labeled<Rec>> {
    const cached = this.streets.get(nsId);
    if (cached) return cached;
    const body = await this.http.json(`${API}/addr/ns/${nsId}/street`, GET);
    const items = byId(this.read('addr/street', () => records(body, 'idstreet', 'nazstreet', 'street')));
    const list = { items, labels: uniqueLabels(items, recName, noGroup) };
    this.streets.set(nsId, list);
    return list;
  }

  /** `fresh`: ask again even when the run has the list (a refresh's house check must be a live answer). */
  private async houseList(streetId: number, fresh = false): Promise<Labeled<Rec>> {
    const cached = this.houses.get(streetId);
    if (cached && !fresh) return cached;
    const body = await this.http.json(`${API}/addr/street/${streetId}/dom`, GET);
    const items = byId(this.read('addr/dom', () => records(body, 'iddom', 'nazdom', 'dom')));
    const list = { items, labels: uniqueLabels(items, recName, noGroup) };
    this.houses.set(streetId, list);
    return list;
  }

  private async houseQueues(iddom: number): Promise<HouseQueue[]> {
    const body = await this.http.json(`${API}/addr/dom/${iddom}/outage-queue`, GET);
    return this.read('outage-queue', () => parseHouseQueues(body));
  }

  /** A shape error as «could not read»; its reason is ours, never response text. */
  private read<T>(what: string, parse: () => T): T {
    try {
      return parse();
    } catch (e) {
      if (e instanceof MkoeShapeError) throw this.http.unreadable({ what, reason: e.message });
      throw e;
    }
  }
}
