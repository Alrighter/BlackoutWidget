import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { HttpSource, sourceTexts, type PlainHttpDeps, type SourceInit } from '../http-source';
import { accidentRows, currentOutageOf, plannedRows, type OutageRow, type Place, type SubReason } from '../inneti';
import { queueLabel } from '../lines';
import { houseKey, nameKey, nameWords } from '../names';
import { addressNotFound, labeled, noGroup, resolveByLabel, sortedLabels, type Labeled } from '../resolve';
import { isInt, isObj } from '../shape';
import { addressSide, bestEffort, daysForLine, snapshotOf, type ScheduleDays } from '../snapshot';
import type { ScheduleProvider } from '../types';
import { decodeCp1251, parseOptions, parseResultRows, parseZtoeSchedule, ztoeHouses, ZtoeShapeError } from './page';
import { ztoeSettlements, type ZtoeSettlement } from './settlements';

const NAME = 'Житомиробленерго';

/** The schedule page; the address form posts to it too, and every answer is a whole windows-1251 page. */
const SITE = 'https://www.ztoe.com.ua/unhooking-search.php';
/** The operator's current-outage API (inneti): its ids are not the site's, so it is joined by name. */
const INNETI = 'https://api-ztoe-poweron.inneti.net/api';
const INNETI_GET: SourceInit = { method: 'GET', headers: { Accept: 'application/ld+json' } };
const MIN_GAP_MS = 1000;

/** `switchSubReason` 0 is an emergency and 1 an outage for operational security; 2 repeats the hourly schedule (skipped), as does anything else. */
export const ZTOE_SUB_REASON: SubReason = (v) => {
  if (v === 0) return { kind: 'emergency', text: 'Аварійне відключення' };
  if (v === 1) return { kind: 'other', text: 'Відключення за операційною безпекою' };
  return undefined;
};

/** A street of the form, or an inneti record: the id and the name. */
interface Rec { id: number; name: string }
const recName = (r: Rec): string => r.name;

/** An inneti dictionary (`pw_otgs`, `pw_cities`, `pw_streets`): each member's id and name; a member without a name never matches. */
function records(body: unknown, what: string): Rec[] {
  const list = isObj(body) ? body['hydra:member'] : undefined;
  if (!Array.isArray(list)) throw new ZtoeShapeError(`${what}: no member list`);
  const recs: Rec[] = [];
  for (const m of list) {
    if (!isObj(m) || !isInt(m.id)) throw new ZtoeShapeError(`${what}: row`);
    if (typeof m.name === 'string') recs.push({ id: m.id, name: m.name });
  }
  return recs;
}

/** A «с/рада» is a council's area, not a settlement inneti knows. */
const COUNCIL = /^с\/рада/iu;
const KIND = /^(?:(?:селище|село|смт|с-ще|місто)\s+|(?:с|м)\.\s*)/iu;

/** The settlement's name as inneti writes it, without «с.», «село», «селище», «смт», «м.», «місто» or «с-ще»; none for a «с/рада». */
function bareName(name: string): string | undefined {
  const n = name.trim();
  if (COUNCIL.test(n)) return undefined;
  return n.replace(KIND, '').trim() || undefined;
}

/** An inneti РЕМ («Хорошівський РЕМ») is the bundle's РЕМ («Хорошівський») by name. */
const sameRem = (otg: string, rem: string): boolean => nameKey(otg).replace(/\s*рем$/u, '') === nameKey(rem);

/**
 * A street's words, sorted and joined: inneti writes many streets in another order or with a number ending («вул.
 * Франка Івана», «1-й пров. Андріївський»). The words are the nameKey split on anything but letters, digits and ’,
 * without a «й», «ий», «а» or «я» right after a number.
 */
function streetWords(name: string): string {
  return nameWords(name).sort().join(' ');
}

export type ZtoeDeps = PlainHttpDeps;

/**
 * Житомиробленерго over plain HTTPS: the bundled settlements, then the site's address form (streets, then a street's
 * rows with each house's queues), the oblast-wide half-hourly schedule of the same page, and current outages from the
 * inneti API joined by name. No browser window, no cookies. On refresh the address side is soft for a queue line (the
 * schedule holds without it); for the 'none' line the rows are the only proof and stay hard.
 */
export class ZtoeProvider implements ScheduleProvider {
  readonly id = 'ztoe';
  readonly displayName = providerDisplayName('ztoe');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  /** Streets by settlement id, kept for the run. */
  private readonly streets = new Map<number, Labeled<Rec>>();
  /** A street's houses with their lines, by street id, kept for the run (the wizard's previews ask again). A refresh's house check never reads it. */
  private readonly houses = new Map<number, HouseInfo[]>();
  /**
   * inneti's РЕМ list, and each street's inneti places (one city, one or more spellings of the street; null: none) by
   * settlement id and the street's words, kept for the run. A failed read is not kept.
   */
  private otgs: Rec[] | undefined;
  private readonly places = new Map<string, Place[] | null>();

  constructor(deps: ZtoeDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'ztoe', texts: sourceTexts(NAME),
      minGapMs: MIN_GAP_MS, sleep: deps.sleep, clock: deps.clock,
    });
  }

  /** The bundled settlements (labels unique and sorted): no request. */
  listCities(): Promise<string[]> {
    return this.http.serial('listCities', async () => ztoeSettlements().map((s) => s.label));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sortedLabels((await this.streetList(this.settlement(city))).labels));
  }

  /** Each house once (its spellings merged), in number order, with the queues of all its rows. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const settlement = this.settlement(city);
      const streetId = await this.streetId(settlement, street);
      let list = this.houses.get(streetId);
      if (!list) {
        list = await this.houseList(settlement, streetId);
        this.houses.set(streetId, list);
      }
      return [...list];
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const settlement = this.settlement(address.city);
      const checked = await addressSide(address.groupId, this.log, 'ztoe fetchSnapshot: address check', () => this.houseCheck(settlement, address));
      const lines = checked ?? [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
      const schedule = await daysForLine(lines, address.groupId, today, () => this.schedule(address.groupId, today));
      const currentOutage = await bestEffort(this.log, 'ztoe fetchSnapshot: current outage lookup', () => this.currentOutage(settlement, address, now));
      return snapshotOf({ providerId: this.id, address, now, groupLabel: queueLabel(address.groupId), lines, currentOutage, ...schedule });
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  /**
   * The saved house's lines from the street's rows, asked again (never the wizard's list). The house is found by
   * houseKey, so «91А» is the row written «91-А». A street or house the lists lack is AddressNotFoundError.
   */
  private async houseCheck(settlement: ZtoeSettlement, address: Address): Promise<LineInfo[]> {
    const houses = await this.houseList(settlement, await this.streetId(settlement, address.street));
    const key = houseKey(address.house);
    const found = houses.find((h) => houseKey(h.house) === key);
    if (!found) throw addressNotFound(NAME);
    return found.lines;
  }

  /**
   * Today's table and tomorrow's when there. Today's is required: just after midnight the page may still hold only
   * yesterday's, which is unreadable, never a quiet day. An all-white table is plain `on`; the banner is the note.
   */
  private async schedule(groupId: string, today: string): Promise<ScheduleDays> {
    const html = decodeCp1251(await this.http.bytes(SITE));
    const page = this.http.read('schedule', () => parseZtoeSchedule(html));
    const todayTable = page.days.get(today);
    if (!todayTable) throw this.http.unreadable({ what: 'schedule', reason: 'no table for today' });
    const days: DaySchedule[] = [{ date: today, slots: this.slots(todayTable, groupId) }];
    const tomorrow = addDays(today, 1);
    const tomorrowTable = page.days.get(tomorrow);
    if (tomorrowTable) days.push({ date: tomorrow, slots: this.slots(tomorrowTable, groupId) });
    return { days, sourceUpdatedAt: page.updatedAt, note: page.banner };
  }

  private slots(table: Record<string, Slot[]>, groupId: string): Slot[] {
    if (!Object.hasOwn(table, groupId)) throw this.http.unreadable({ what: 'schedule', reason: 'no such queue' });
    return table[groupId];
  }

  /** Emergency, operational-security and planned outages running now for this house, over every spelling of its street. */
  private async currentOutage(settlement: ZtoeSettlement, address: Address, now: Date): Promise<CurrentOutage | undefined> {
    const places = await this.streetPlaces(settlement, streetWords(this.streetName(settlement, address.street)));
    if (!places) return undefined;
    const rows: OutageRow[] = [];
    for (const place of places) {
      const query = `page=1&city.id=${place.cityId}&street.id=${place.streetId}`;
      const accidentsBody = await this.http.json(`${INNETI}/pw_accidents?${query}`, INNETI_GET);
      rows.push(...this.http.read('pw_accidents', () => accidentRows(accidentsBody, place, ZTOE_SUB_REASON)));
      const plannedBody = await this.http.json(`${INNETI}/pw_accident_planeds?${query}`, INNETI_GET);
      rows.push(...this.http.read('pw_accident_planeds', () => plannedRows(plannedBody, place)));
    }
    return currentOutageOf(rows, address.house, now, (a, b) => houseKey(a) === houseKey(b));
  }

  /**
   * The street's name on the site, from the run's street list: a label such as «вул. X (2)» would add a word. The
   * saved label itself when the list could not be read.
   */
  private streetName(settlement: ZtoeSettlement, label: string): string {
    const list = this.streets.get(settlement.id);
    return list ? resolveByLabel(list.items, list.labels, label, recName, noGroup, NAME).name : label;
  }

  /** The street's inneti places (or their absence), kept for the run once read. */
  private async streetPlaces(settlement: ZtoeSettlement, words: string): Promise<Place[] | undefined> {
    const key = `${settlement.id}/${words}`;
    if (this.places.has(key)) return this.places.get(key) ?? undefined;
    const found = await this.findPlaces(settlement, words);
    this.places.set(key, found ?? null);
    return found;
  }

  /**
   * The join by name: the РЕМ's otg; its cities of the settlement's bare name (the API's `name` filter also matches a
   * part of a name, so only an equal name counts); their streets with the street's words. Every such street of one
   * city counts (inneti holds some streets in two spellings); streets in two or more cities, or none, are no place.
   */
  private async findPlaces(settlement: ZtoeSettlement, words: string): Promise<Place[] | undefined> {
    const bare = bareName(settlement.name);
    if (!bare) return undefined;
    const otg = (await this.otgList()).find((o) => sameRem(o.name, settlement.rem));
    if (!otg) return undefined;
    const citiesBody = await this.http.json(
      `${INNETI}/pw_cities?pagination=false&otg.id=${otg.id}&name=${encodeURIComponent(bare)}`, INNETI_GET,
    );
    const cities = this.http.read('pw_cities', () => records(citiesBody, 'pw_cities')).filter((c) => nameKey(c.name) === nameKey(bare));
    const places: Place[] = [];
    for (const city of cities) {
      const body = await this.http.json(`${INNETI}/pw_streets?pagination=false&city.id=${city.id}`, INNETI_GET);
      for (const s of this.http.read('pw_streets', () => records(body, 'pw_streets'))) {
        if (streetWords(s.name) === words) places.push({ cityId: city.id, streetId: s.id });
      }
    }
    return places.length > 0 && places.every((p) => p.cityId === places[0].cityId) ? places : undefined;
  }

  private async otgList(): Promise<Rec[]> {
    if (this.otgs) return this.otgs;
    const body = await this.http.json(`${INNETI}/pw_otgs?pagination=false`, INNETI_GET);
    this.otgs = this.http.read('pw_otgs', () => records(body, 'pw_otgs'));
    return this.otgs;
  }

  private settlement(label: string): ZtoeSettlement {
    const list = ztoeSettlements();
    return resolveByLabel(list, list.map((s) => s.label), label, (s) => s.name, (s) => `${s.rem} РЕМ`, NAME);
  }

  private async streetId(settlement: ZtoeSettlement, street: string): Promise<number> {
    const list = await this.streetList(settlement);
    return resolveByLabel(list.items, list.labels, street, recName, noGroup, NAME).id;
  }

  private async streetList(settlement: ZtoeSettlement): Promise<Labeled<Rec>> {
    const cached = this.streets.get(settlement.id);
    if (cached) return cached;
    const html = await this.form({ rem_id: String(settlement.remId), naspunkt_id: String(settlement.id) });
    const list = labeled(this.http.read('vulica_id', () => parseOptions(html, 'vulica_id')), recName);
    this.streets.set(settlement.id, list);
    return list;
  }

  /** Every row of the street (`all=1`: without it the page shows the first 10) as houses with their lines. */
  private async houseList(settlement: ZtoeSettlement, streetId: number): Promise<HouseInfo[]> {
    const html = await this.form({
      rem_id: String(settlement.remId), naspunkt_id: String(settlement.id), vulica_id: String(streetId), all: '1',
    });
    return ztoeHouses(this.http.read('result', () => parseResultRows(html)));
  }

  /** The address form, posted statelessly: every level's ids again, the answer a whole windows-1251 page. */
  private async form(fields: Record<string, string>): Promise<string> {
    const body = new URLSearchParams(fields).toString();
    return decodeCp1251(await this.http.bytes(SITE, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    }));
  }
}
