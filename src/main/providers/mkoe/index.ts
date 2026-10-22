import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { HttpSource, quietNote, sourceTexts, type PlainHttpDeps, type SourceInit } from '../http-source';
import { NONE_GROUP, daySlots, linesOf, queueLabel } from '../lines';
import { labeled, noGroup, resolveByLabel, sortedLabels, type Labeled } from '../resolve';
import { isInt, isObj } from '../shape';
import { addressSide, daysForLine, snapshotOf, type ScheduleDays } from '../snapshot';
import type { ScheduleProvider } from '../types';
import { MkoeShapeError, mkoeDay } from './schedule';
import { mkoeSettlements, type MkoeSettlement } from './settlements';

const NAME = 'Миколаївобленерго';
export const MKOE_QUIET_NOTE = quietNote(NAME, 'опублікувало');
/** Why today is unknown when the house's queues came in a shape we do not know (R11/R13). */
export const MKOE_ODD_QUEUES_NOTE = `${NAME} повідомило черги будинку в незнайомому вигляді — графік на сьогодні невідомий`;

const API = 'https://off.energy.mk.ua/api';
const GET: SourceInit = { method: 'GET', headers: { Accept: 'application/json' } };

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

const houseOrder = new Intl.Collator('uk', { numeric: true });
const recName = (r: Rec): string => r.name;

export type MkoeDeps = PlainHttpDeps;

/**
 * Миколаївобленерго over plain HTTPS (off.energy.mk.ua): the bundled settlements, then streets and houses, each house's
 * queues, the oblast-wide half-hourly schedule (three joined answers) and switched-on ГАВ/СГАВ queues. No browser window.
 * On refresh the address side is soft for a queue line (the schedule holds without it); for the 'none' line the house
 * list and the house's queues are the only proof and stay hard.
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
    return this.http.serial('listStreets', async () => sortedLabels((await this.streetList(this.settlement(city).id)).labels));
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
      const queues = iddom === undefined ? undefined : await this.checkedHouseQueues(address, iddom);
      const read = queues ? linesOfQueues(queues) : undefined;
      const lines = read
        ? read.lines
        : [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
      const currentOutage = queues ? currentOutageOf(queues) : undefined;
      let schedule: ScheduleDays;
      if (read?.unknown !== undefined) {
        // The house's queues came in a shape we do not know: neither its line nor the always-on line is proven.
        this.log.warn('mkoe fetchSnapshot: house queues of an unknown shape', { what: 'outage-queue', reason: read.unknown });
        schedule = { days: [{ date: today, slots: daySlots('unknown') }], note: MKOE_ODD_QUEUES_NOTE };
      } else {
        schedule = await daysForLine(lines, address.groupId, today, () => this.schedule(address.groupId, today));
      }
      return snapshotOf({ providerId: this.id, address, now, groupLabel: queueLabel(address.groupId), lines, currentOutage, ...schedule });
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
  private houseCheck(address: Address): Promise<number | undefined> {
    return addressSide(address.groupId, this.log, 'mkoe fetchSnapshot: address check', async () => {
      const list = await this.houseList(await this.streetId(address.city, address.street), true);
      return this.house(list, address.house).id;
    });
  }

  /**
   * The house's queues for the lines and the current outage. For a queue line a failure keeps the saved line and drops
   * the outage. For the 'none' line this answer is the only proof that the house is still outside the schedule (the
   * house list proves only that it exists), so there the failure fails the snapshot.
   */
  private checkedHouseQueues(address: Address, iddom: number): Promise<HouseQueue[] | undefined> {
    return addressSide(address.groupId, this.log, 'mkoe fetchSnapshot: house queues', () => this.houseQueues(iddom));
  }

  /**
   * Today (all on with the quiet note when it has no row) and tomorrow when it has one, for the saved queue name. The
   * three answers are read one after another, every refresh: the dictionaries are the guard a quiet `[]` cannot give.
   */
  private async schedule(groupId: string, today: string): Promise<ScheduleDays> {
    const tomorrow = addDays(today, 1);
    const active = await this.http.json(`${API}/v2/schedule/active`, GET);
    const timeSeries = await this.http.json(`${API}/schedule/time-series`, GET);
    const queues = await this.http.json(`${API}/outage-queue/by-type/3`, GET);
    const day = (date: string) => this.http.read('schedule', () => mkoeDay(active, timeSeries, queues, date, groupId));
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
    const list = labeled(this.http.read('addr/street', () => records(body, 'idstreet', 'nazstreet', 'street')), recName);
    this.streets.set(nsId, list);
    return list;
  }

  /** `fresh`: ask again even when the run has the list (a refresh's house check must be a live answer). */
  private async houseList(streetId: number, fresh = false): Promise<Labeled<Rec>> {
    const cached = this.houses.get(streetId);
    if (cached && !fresh) return cached;
    const body = await this.http.json(`${API}/addr/street/${streetId}/dom`, GET);
    const list = labeled(this.http.read('addr/dom', () => records(body, 'iddom', 'nazdom', 'dom')), recName);
    this.houses.set(streetId, list);
    return list;
  }

  private async houseQueues(iddom: number): Promise<HouseQueue[]> {
    const body = await this.http.json(`${API}/addr/dom/${iddom}/outage-queue`, GET);
    return this.http.read('outage-queue', () => parseHouseQueues(body));
  }
}
