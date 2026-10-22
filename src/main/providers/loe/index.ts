import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { HttpSource, quietNote, sourceTexts, type PlainHttpDeps, type SourceInit } from '../http-source';
import { daySlots, linesOf, queueLabel } from '../lines';
import { addressNotFound, labeled, noGroup, resolveByLabel, sortedLabels, type Labeled } from '../resolve';
import { isObj } from '../shape';
import { addressSide, bestEffort, daysForLine, snapshotOf, type ScheduleDays } from '../snapshot';
import { ProviderError, type ScheduleProvider } from '../types';
import {
  currentOutageOf, parseAccidents, parseAccounts, parseCities, parseStreets, queueId,
  type LoeAccount, type LoeCity, type LoeStreet, type Place,
} from './parse';
import { archiveHtmls, archiveRevision, itemRevision, latestRevisions, menuItemHtml, type LoeRevision } from './schedule';

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

const houseOrder = new Intl.Collator('uk', { numeric: true });
const cityGroup = (c: LoeCity): string | undefined => (c.otg ? `${c.otg} громада` : undefined);

export type LoeDeps = PlainHttpDeps;

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
  /**
   * A street's houses with their lines, by «cityId/streetId», kept for the run: the wizard's line previews ask for the
   * list again and must not download the whole street again. A refresh's house check never reads it.
   */
  private readonly houses = new Map<string, HouseInfo[]>();

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
    return this.http.serial('listCities', async () => sortedLabels((await this.cityList()).labels));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sortedLabels((await this.streetList((await this.city(city)).id)).labels));
  }

  /** Each house once, its text byte for byte, with the distinct queues of all its accounts. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => [...await this.streetHouses(await this.place(city, street))]);
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const checked = await addressSide(address.groupId, this.log, 'loe fetchSnapshot: address check', () => this.houseCheck(address));
      const lines = checked?.lines ?? [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
      const schedule = await daysForLine(lines, address.groupId, today, () => this.schedule(address.groupId, today));
      const currentOutage = checked
        ? await bestEffort(this.log, 'loe fetchSnapshot: current outage lookup', () => this.currentOutage(checked.place, address.house, now))
        : undefined;
      return snapshotOf({ providerId: this.id, address, now, groupLabel: queueLabel(address.groupId), lines, currentOutage, ...schedule });
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  /**
   * The saved house's queues from its own accounts (`buildingName` matches exactly). A label or house the operator no
   * longer has is AddressNotFoundError (`addressSide` lets it through; for a queue line any other failure only costs
   * the check, for the 'none' line it fails the snapshot).
   */
  private async houseCheck(address: Address): Promise<{ place: Place; lines: LineInfo[] }> {
    const place = await this.place(address.city, address.street);
    const url = `${API}/pw_accounts?pagination=false&city.id=${place.cityId}&street.id=${place.streetId}`
      + `&buildingName=${encodeURIComponent(address.house)}`;
    const rows = (await this.accounts(url)).filter((r) => r.house === address.house);
    if (rows.length === 0) throw addressNotFound(NAME);
    return { place, lines: this.lines(rows.map((r) => r.queue)) };
  }

  /**
   * Today (all on with the quiet note when no revision is headed today) and tomorrow when it has one. The Today and
   * Tomorrow items are read every time; the archive only when neither gives today. Per day the latest revision wins.
   */
  private async schedule(groupId: string, today: string): Promise<ScheduleDays> {
    const tomorrow = addDays(today, 1);
    const dates = [today, tomorrow];
    const revisions: LoeRevision[] = [];
    for (const [id, name] of [[238, 'Today'], [256, 'Tomorrow']] as const) {
      const body = await this.get(`${CMS}/menu_items/${id}`);
      const revision = this.http.read(`menu_items/${id}`, () => itemRevision(menuItemHtml(body, name)));
      if (revision) revisions.push(revision);
    }
    if (!revisions.some((r) => r.date === today)) {
      // Cloudflare keeps the menu up to 2 h: the time makes the URL new.
      const body = await this.get(`${CMS}/menus?page=1&type=photo-grafic&_=${this.clock()}`);
      for (const html of this.http.read('menus', () => archiveHtmls(body))) {
        const revision = this.http.read('menus', () => archiveRevision(html, dates));
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

  /** The outage running now for this house. */
  private async currentOutage(place: Place, house: string, now: Date): Promise<CurrentOutage | undefined> {
    const body = await this.get(`${API}/pw_accidents?page=1&city.id=${place.cityId}&street.id=${place.streetId}`);
    return currentOutageOf(this.http.read('pw_accidents', () => parseAccidents(body, place)), house, now);
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
    this.cities = labeled(this.http.read('pw_cities', () => parseCities(body)), (c) => c.name, cityGroup);
    return this.cities;
  }

  private async streetList(cityId: number): Promise<Labeled<LoeStreet>> {
    const cached = this.streets.get(cityId);
    if (cached) return cached;
    const body = await this.get(`${API}/pw_streets?pagination=false&city.id=${cityId}`);
    const list = labeled(this.http.read('pw_streets', () => parseStreets(body)), (s) => s.name);
    this.streets.set(cityId, list);
    return list;
  }

  /** The street's houses (rows with an empty house are skipped), in house order; kept only once every queue was read. */
  private async streetHouses(place: Place): Promise<HouseInfo[]> {
    const key = `${place.cityId}/${place.streetId}`;
    const cached = this.houses.get(key);
    if (cached) return cached;
    const queues = new Map<string, string[]>();
    for (const r of await this.accounts(`${API}/pw_accounts?pagination=false&city.id=${place.cityId}&street.id=${place.streetId}`)) {
      if (r.house.trim() !== '') queues.set(r.house, [...(queues.get(r.house) ?? []), r.queue]);
    }
    const list = [...queues.keys()].sort(houseOrder.compare)
      .map((house): HouseInfo => ({ house, lines: this.lines(queues.get(house)!), outageActive: false }));
    this.houses.set(key, list);
    return list;
  }

  private async accounts(url: string): Promise<LoeAccount[]> {
    const body = await this.get(url);
    return this.http.read('pw_accounts', () => parseAccounts(body));
  }

  /** A house's lines from its accounts' `chergGpv`: distinct queues, else the 'none' line; an unknown value is unreadable. */
  private lines(queues: string[]): LineInfo[] {
    return this.http.read('pw_accounts', () => linesOf(queues.map(queueId)));
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
}
