import { Buffer } from 'node:buffer';
import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { HttpSource, quietNote, sourceTexts, type PlainHttpDeps, type SourceInit } from '../http-source';
import { accidentRows, currentOutageOf, plannedRows, wallStamp, type Place, type SubReason } from '../inneti';
import { NONE_GROUP, classifyQueue, daySlots, linesOf, queueLabel } from '../lines';
import { addressNotFound, labeled, noGroup, resolveByLabel, sortedLabels, type Labeled } from '../resolve';
import { bestEffort, daysForLine, snapshotOf, type ScheduleDays } from '../snapshot';
import type { ScheduleProvider } from '../types';
import {
  parseBuildingGroups, parseBuildingNames, parseCities, parseGpvCollection, parseStreets, queueSlots,
  type ToeCity, type ToeHouseRow, type ToeStreet,
} from './parse';

const NAME = 'Тернопільобленерго';
export const TOE_QUIET_NOTE = quietNote(NAME, 'опублікувало');

const API = 'https://api-poweron.toe.com.ua/api';
// Never an Origin: a wrong, `null` or `file://` Origin gets a 403 from the operator's Cloudflare rule.
const GET: SourceInit = { method: 'GET', headers: { Accept: 'application/ld+json' } };

/** `switchSubReason` 2 is the hourly schedule itself (the widget already shows it); every other value is an emergency. */
export const TOE_SUB_REASON: SubReason = (v) => (v === 2 ? undefined : { kind: 'emergency', text: 'Аварійне відключення' });

/** Ternopil's `chergGpv` values for a house outside the hourly schedule. */
const NOT_IN_SCHEDULE_VALUES = ['Не входить', '', null] as const;
/** A `chergGpv` as a classified id: «N.M» or the 'none' line; anything else throws (read as «could not read»). */
const queueId = (value: unknown): string => classifyQueue(value, NOT_IN_SCHEDULE_VALUES);
/** Whether any of these classified ids is an hourly-schedule queue («1.2»). */
const hasQueue = (ids: string[]): boolean => ids.some((id) => id !== NONE_GROUP);
const cityGroup = (c: ToeCity): string | undefined => (c.otg ? `${c.otg} громада` : undefined);
/** Rows whose house text is blank cannot be asked about: the API matches the text exactly. */
const usable = (rows: ToeHouseRow[]): ToeHouseRow[] => rows.filter((r) => r.house.trim() !== '');

export type ToeDeps = PlainHttpDeps;

/**
 * Тернопільобленерго over plain HTTPS (api-poweron.toe.com.ua): the address directory, each house's queues, the
 * half-hourly schedule of the house's key, and current emergency and planned outages. No browser window.
 */
export class ToeProvider implements ScheduleProvider {
  readonly id = 'toe';
  readonly displayName = providerDisplayName('toe');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  private readonly clock: () => number;
  private cities: Labeled<ToeCity> | undefined;
  /** Streets by city id; like the city list, kept for the run. */
  private readonly streets = new Map<number, Labeled<ToeStreet>>();
  private calls = 0;

  constructor(deps: ToeDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.clock = deps.clock ?? Date.now;
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'toe', texts: sourceTexts(NAME),
      sleep: deps.sleep, clock: deps.clock,
    });
  }

  listCities(): Promise<string[]> {
    return this.http.serial('listCities', async () => sortedLabels((await this.cityList()).labels));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sortedLabels((await this.streetList((await this.city(city)).id)).labels));
  }

  /** Each house once, its text byte for byte. One queue per house here; `houseLines` gives them all once it is picked. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const queues = new Map<string, string[]>();
      for (const r of usable(await this.houseRows(await this.place(city, street)))) {
        queues.set(r.house, [...(queues.get(r.house) ?? []), this.http.read('building-names', () => queueId(r.queue))]);
      }
      return [...queues].map(([house, q]): HouseInfo => ({ house, lines: linesOf(q), outageActive: false, linesPending: true }));
    });
  }

  houseLines(city: string, street: string, house: string): Promise<LineInfo[]> {
    return this.http.serial('houseLines', async () => this.houseQueues(await this.place(city, street), house));
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const place = await this.place(address.city, address.street);
      // The fail-closed guard: the house and its queues, before the schedule (whose empty answer proves nothing).
      const lines = await this.houseQueues(place, address.house);
      if (lines.length === 0) throw addressNotFound(NAME);
      const schedule = await daysForLine(lines, address.groupId, today, () => this.schedule(place, address, today));
      const currentOutage = await bestEffort(this.log, 'toe fetchSnapshot: current outage lookup', () => this.currentOutage(place, address.house, now));
      return snapshotOf({ providerId: this.id, address, now, groupLabel: queueLabel(address.groupId), lines, currentOutage, ...schedule });
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  /** Today (all on with the quiet note when nothing is published) and tomorrow when its member is there. */
  private async schedule(place: Place, address: Address, today: string): Promise<ScheduleDays> {
    const tomorrow = addDays(today, 1);
    // The site's window. `time` must differ on every call: the edge cache keys on the URL only, not on X-debug-key.
    const url = `${API}/a_gpv_g?before=${tomorrow}T00:00:00%2B00:00&after=${addDays(today, -1)}T12:00:00%2B00:00`
      + `&time=${this.uniqueTime()}`;
    const key = Buffer.from(`${place.cityId}/${place.streetId}/${address.house}`, 'utf8').toString('base64');
    const body = await this.http.json(url, { ...GET, headers: { ...GET.headers, 'X-debug-key': key } });
    const byDate = this.http.read('a_gpv_g', () => parseGpvCollection(body));
    const todayDay = byDate.get(today);
    const tomorrowDay = byDate.get(tomorrow);
    const days: DaySchedule[] = [{
      date: today, slots: todayDay ? this.http.read('a_gpv_g', () => queueSlots(todayDay, address.groupId)) : daySlots('on'),
    }];
    if (tomorrowDay) days.push({ date: tomorrow, slots: this.http.read('a_gpv_g', () => queueSlots(tomorrowDay, address.groupId)) });
    if (!todayDay) return { days, note: TOE_QUIET_NOTE };
    return { days, sourceUpdatedAt: wallStamp(todayDay.dateCreate) };
  }

  /**
   * The house's queues from `building-groups`. Without a queue there, the house's row in `building-names` decides:
   * listed without a queue means the always-on line, missing means the house is gone (`[]`). Listed with a queue
   * contradicts the check, so neither answer is trusted. Any odd answer, a queue value of an unknown shape included
   * (in either list), is an error.
   */
  private async houseQueues(place: Place, house: string): Promise<LineInfo[]> {
    const url = `${API}/pw-accounts/building-groups?cityId=${place.cityId}&streetId=${place.streetId}`
      + `&buildingNames=${encodeURIComponent(house)}`;
    const body = await this.http.json(url, GET);
    const groups = this.http.read('building-groups', () => parseBuildingGroups(body).map(queueId));
    if (hasQueue(groups)) return linesOf(groups);
    const rows = usable(await this.houseRows(place)).filter((r) => r.house === house);
    if (rows.length === 0) return [];
    if (hasQueue(this.http.read('building-names', () => rows.map((r) => queueId(r.queue))))) {
      throw this.http.unreadable({ what: 'building-groups', reason: 'no queue while building-names has one' });
    }
    return linesOf([]);
  }

  /** Emergency, then planned works, running now for this house. */
  private async currentOutage(place: Place, house: string, now: Date): Promise<CurrentOutage | undefined> {
    const query = `page=1&city.id=${place.cityId}&street.id=${place.streetId}`;
    const emergencyBody = await this.http.json(`${API}/pw_accidents?${query}`, GET);
    const emergency = this.http.read('pw_accidents', () => accidentRows(emergencyBody, place, TOE_SUB_REASON));
    const plannedBody = await this.http.json(`${API}/pw_accident_planeds?${query}`, GET);
    const planned = this.http.read('pw_accident_planeds', () => plannedRows(plannedBody, place));
    return currentOutageOf([...emergency, ...planned], house, now);
  }

  private async place(city: string, street: string): Promise<Place> {
    const cityId = (await this.city(city)).id;
    const streets = await this.streetList(cityId);
    const found = resolveByLabel(streets.items, streets.labels, street, (s) => s.name, noGroup, NAME);
    return { cityId, streetId: found.id };
  }

  private async city(label: string): Promise<ToeCity> {
    const cities = await this.cityList();
    return resolveByLabel(cities.items, cities.labels, label, (c) => c.name, cityGroup, NAME);
  }

  private async cityList(): Promise<Labeled<ToeCity>> {
    if (this.cities) return this.cities;
    const body = await this.http.json(`${API}/pw_cities?pagination=false&otg.id=`, GET);
    this.cities = labeled(this.http.read('pw_cities', () => parseCities(body)), (c) => c.name, cityGroup);
    return this.cities;
  }

  private async streetList(cityId: number): Promise<Labeled<ToeStreet>> {
    const cached = this.streets.get(cityId);
    if (cached) return cached;
    const body = await this.http.json(`${API}/pw_streets?pagination=false&city.id=${cityId}`, GET);
    const list = labeled(this.http.read('pw_streets', () => parseStreets(body)), (s) => s.name);
    this.streets.set(cityId, list);
    return list;
  }

  private async houseRows(place: Place): Promise<ToeHouseRow[]> {
    const body = await this.http.json(`${API}/pw-accounts/building-names?cityId=${place.cityId}&streetId=${place.streetId}`, GET);
    return this.http.read('building-names', () => parseBuildingNames(body));
  }

  /** Lower-case letters and digits, different on every call of this run and, by the random part, across installs. */
  private uniqueTime(): string {
    this.calls += 1;
    return `${this.clock().toString(36)}${this.calls.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}
