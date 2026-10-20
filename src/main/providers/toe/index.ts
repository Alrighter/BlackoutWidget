import { Buffer } from 'node:buffer';
import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import type { HttpFetch } from '../http';
import { HttpSource, quietNote, sourceTexts, type SourceInit } from '../http-source';
import { NONE_GROUP, daySlots, linesOf, queueLabel } from '../lines';
import { addressNotFound, resolveByLabel, uniqueLabels } from '../resolve';
import type { ScheduleProvider } from '../types';
import {
  currentOutageOf, parseBuildingGroups, parseBuildingNames, parseCities, parseGpvCollection, parseOutageRows, parseStreets,
  queueSlots, wallStamp, ToeShapeError, type ToeCity, type ToeHouseRow, type ToeStreet,
} from './parse';

const NAME = 'Тернопільобленерго';
export const TOE_QUIET_NOTE = quietNote(NAME, 'опублікувало');

const API = 'https://api-poweron.toe.com.ua/api';
// Never an Origin: a wrong, `null` or `file://` Origin gets a 403 from the operator's Cloudflare rule.
const GET: SourceInit = { method: 'GET', headers: { Accept: 'application/ld+json' } };

/** A list with its labels, index-aligned: the order the API gave, which `resolveByLabel` needs. */
interface Labeled<T> { items: T[]; labels: string[] }
interface Place { cityId: number; streetId: number }

const sorted = (labels: string[]): string[] => [...labels].sort((a, b) => a.localeCompare(b, 'uk'));
const cityGroup = (c: ToeCity): string | undefined => (c.otg ? `${c.otg} громада` : undefined);
const noGroup = (): undefined => undefined;
/** Rows whose house text is blank cannot be asked about: the API matches the text exactly. */
const usable = (rows: ToeHouseRow[]): ToeHouseRow[] => rows.filter((r) => r.house.trim() !== '');

export interface ToeDeps {
  fetch: HttpFetch;
  isOnline: () => boolean;
  log?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

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
    return this.http.serial('listCities', async () => sorted((await this.cityList()).labels));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sorted((await this.streetList((await this.city(city)).id)).labels));
  }

  /** Each house once, its text byte for byte. One queue per house here; `houseLines` gives them all once it is picked. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const queues = new Map<string, string[]>();
      for (const r of usable(await this.houseRows(await this.place(city, street)))) {
        queues.set(r.house, [...(queues.get(r.house) ?? []), r.queue]);
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
      let days: DaySchedule[];
      let sourceUpdatedAt: string | undefined;
      let note: string | undefined;
      if (!lines.some((l) => l.groupId === address.groupId)) {
        // The saved queue is gone: the schedule call answers only for the house's queues now. The app asks to re-pick.
        days = [{ date: today, slots: daySlots('unknown') }];
      } else if (address.groupId === NONE_GROUP) {
        days = [{ date: today, slots: daySlots('on') }];
      } else {
        ({ days, sourceUpdatedAt, note } = await this.schedule(place, address, today));
      }
      const currentOutage = await this.currentOutage(place, address.house, now);
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

  /** Today (all on with the quiet note when nothing is published) and tomorrow when its member is there. */
  private async schedule(place: Place, address: Address, today: string): Promise<{ days: DaySchedule[]; sourceUpdatedAt?: string; note?: string }> {
    const tomorrow = addDays(today, 1);
    // The site's window. `time` must differ on every call: the edge cache keys on the URL only, not on X-debug-key.
    const url = `${API}/a_gpv_g?before=${tomorrow}T00:00:00%2B00:00&after=${addDays(today, -1)}T12:00:00%2B00:00`
      + `&time=${this.uniqueTime()}`;
    const key = Buffer.from(`${place.cityId}/${place.streetId}/${address.house}`, 'utf8').toString('base64');
    const body = await this.http.json(url, { ...GET, headers: { ...GET.headers, 'X-debug-key': key } });
    const byDate = this.read('a_gpv_g', () => parseGpvCollection(body));
    const todayDay = byDate.get(today);
    const tomorrowDay = byDate.get(tomorrow);
    const days: DaySchedule[] = [{
      date: today, slots: todayDay ? this.read('a_gpv_g', () => queueSlots(todayDay, address.groupId)) : daySlots('on'),
    }];
    if (tomorrowDay) days.push({ date: tomorrow, slots: this.read('a_gpv_g', () => queueSlots(tomorrowDay, address.groupId)) });
    if (!todayDay) return { days, note: TOE_QUIET_NOTE };
    return { days, sourceUpdatedAt: wallStamp(todayDay.dateCreate) };
  }

  /**
   * The house's queues from `building-groups`. Without a queue there, the house's row in `building-names` decides:
   * listed means the always-on line, missing means the house is gone (`[]`). Any odd answer is an error.
   */
  private async houseQueues(place: Place, house: string): Promise<LineInfo[]> {
    const url = `${API}/pw-accounts/building-groups?cityId=${place.cityId}&streetId=${place.streetId}`
      + `&buildingNames=${encodeURIComponent(house)}`;
    const body = await this.http.json(url, GET);
    const lines = linesOf(this.read('building-groups', () => parseBuildingGroups(body)));
    if (lines[0].groupId !== NONE_GROUP) return lines;
    return usable(await this.houseRows(place)).some((r) => r.house === house) ? lines : [];
  }

  /** Emergency, then planned works, running now for this house. A failure here never fails the snapshot. */
  private async currentOutage(place: Place, house: string, now: Date): Promise<CurrentOutage | undefined> {
    try {
      const query = `page=1&city.id=${place.cityId}&street.id=${place.streetId}`;
      const emergencyBody = await this.http.json(`${API}/pw_accidents?${query}`, GET);
      const emergency = this.read('pw_accidents', () => parseOutageRows(emergencyBody, 'emergency', place));
      const plannedBody = await this.http.json(`${API}/pw_accident_planeds?${query}`, GET);
      const planned = this.read('pw_accident_planeds', () => parseOutageRows(plannedBody, 'planned', place));
      return currentOutageOf(emergency, planned, house, now);
    } catch (e) {
      this.log.warn('toe fetchSnapshot: current outage lookup failed', e);
      return undefined;
    }
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
    const items = this.read('pw_cities', () => parseCities(body));
    this.cities = { items, labels: uniqueLabels(items, (c) => c.name, cityGroup) };
    return this.cities;
  }

  private async streetList(cityId: number): Promise<Labeled<ToeStreet>> {
    const cached = this.streets.get(cityId);
    if (cached) return cached;
    const body = await this.http.json(`${API}/pw_streets?pagination=false&city.id=${cityId}`, GET);
    const items = this.read('pw_streets', () => parseStreets(body));
    const list = { items, labels: uniqueLabels(items, (s) => s.name, noGroup) };
    this.streets.set(cityId, list);
    return list;
  }

  private async houseRows(place: Place): Promise<ToeHouseRow[]> {
    const body = await this.http.json(`${API}/pw-accounts/building-names?cityId=${place.cityId}&streetId=${place.streetId}`, GET);
    return this.read('building-names', () => parseBuildingNames(body));
  }

  /** A parser's shape error as «could not read»; its reason is ours, never response text. */
  private read<T>(what: string, parse: () => T): T {
    try {
      return parse();
    } catch (e) {
      if (e instanceof ToeShapeError) throw this.http.unreadable({ what, reason: e.message });
      throw e;
    }
  }

  /** Lower-case letters and digits, different on every call of this run and, by the random part, across installs. */
  private uniqueTime(): string {
    this.calls += 1;
    return `${this.clock().toString(36)}${this.calls.toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}
