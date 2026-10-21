import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey } from '../../../shared/time';
import type { Address, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { HttpSource, quietNote, sourceTexts, type PlainHttpDeps, type SourceInit } from '../http-source';
import { daySlots, linesOf, queueLabel } from '../lines';
import { addressNotFound, noGroup, resolveByLabel, sortedLabels } from '../resolve';
import { addressSide, daysForLine, snapshotOf, type ScheduleDays } from '../snapshot';
import type { ScheduleProvider } from '../types';
import { cekLines, extractLocations, parseCekDay, type CekMap } from './parse';

const NAME = 'ЦЕК';

const SITE = 'https://cek.dp.ua/index.php/cpojivaham';
/** The address map: every city, street and house inlined in one page as `const locations = {…}`. */
const MAP = `${SITE}/pobutovi-spozhyvachi/viznachennya-chergy.html`;
/** The schedule form: POSTed with a date, it answers that day's tables of all 12 queues, or the quiet message. */
const FORM = `${SITE}/vidkliuchennia/2-uncategorised/921-grafik-pogodinikh-vidklyuchen.html`;
const FORM_POST: Omit<SourceInit, 'body'> = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
const MIN_GAP_MS = 1000;

/** «ЦЕК» is a компанія: the verb is feminine. */
export const CEK_QUIET_NOTE = quietNote(NAME, 'опублікувала');

const collator = new Intl.Collator('uk', { numeric: true });

/** One house from the values of its keys (keys that trim to one text): the union of their lines, and DTEK's note if given. */
function houseOf(house: string, values: readonly string[]): HouseInfo {
  const ids = new Set<string>();
  let note: string | undefined;
  for (const value of values) {
    const read = cekLines(value);
    for (const l of read.lines) ids.add(l.groupId);
    note ??= read.note;
  }
  // linesOf([]) would be the always-on line: a house without a CEK queue has no lines.
  return { house, lines: ids.size ? linesOf([...ids]) : [], outageActive: false, ...(note ? { note } : {}) };
}

/** A street's houses by trimmed key, in number order. Every value is read, so one unknown value throws for the street. */
function cekHouses(houses: Record<string, string>): HouseInfo[] {
  const byHouse = new Map<string, string[]>();
  for (const [key, value] of Object.entries(houses)) {
    const house = key.trim();
    byHouse.set(house, [...(byHouse.get(house) ?? []), value]);
  }
  return [...byHouse].map(([house, values]) => houseOf(house, values)).sort((a, b) => collator.compare(a.house, b.house));
}

/** The saved queue's slots of a day with tables; a queue the day has no block for has no outages. */
const queueSlots = (day: Record<string, Slot[]>, groupId: string): Slot[] =>
  (Object.hasOwn(day, groupId) ? day[groupId] : daySlots('on'));

/** A key of the map by its label: the exact key, else the only one of the same nameKey, else AddressNotFoundError. */
const keyOf = (keys: readonly string[], label: string): string => resolveByLabel(keys, keys, label, (k) => k, noGroup, NAME);

/**
 * ПЕЕМ «ЦЕК» over plain HTTPS from its own site: the address map page (read once per run) for cities, streets, houses
 * and their queues, and the schedule form asked for today and tomorrow. No update time, no current outage. On refresh
 * the address side is soft: every line is a queue of the form's tables.
 */
export class CekProvider implements ScheduleProvider {
  readonly id = 'cek';
  readonly displayName = providerDisplayName('cek');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  /** The map, kept for the run once read (by the wizard, or a refresh's first use). A failed read is not kept. */
  private map: CekMap | undefined;

  constructor(deps: PlainHttpDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'cek', texts: sourceTexts(NAME),
      minGapMs: MIN_GAP_MS, sleep: deps.sleep, clock: deps.clock,
    });
  }

  listCities(): Promise<string[]> {
    return this.http.serial('listCities', async () => sortedLabels(Object.keys(await this.locations())));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sortedLabels(Object.keys(this.streets(await this.locations(), city))));
  }

  /** Each house once (keys trimmed, two keys of one text merged), in number order; a DTEK house carries its note. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const houses = this.houses(await this.locations(), city, street);
      return this.http.read('map', () => cekHouses(houses));
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const checked = await addressSide(address.groupId, this.log, 'cek fetchSnapshot: address check', () => this.houseCheck(address));
      const lines = checked ?? [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
      const schedule = await daysForLine(lines, address.groupId, today, () => this.schedule(address.groupId, today));
      return snapshotOf({ providerId: this.id, address, now, groupLabel: queueLabel(address.groupId), lines, ...schedule });
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  /**
   * The saved house's lines from the run's map: only its own keys' values are read. A city, street or house the map
   * lacks is AddressNotFoundError; a DTEK house gives [] (the saved queue is then gone: today unknown).
   */
  private async houseCheck(address: Address): Promise<LineInfo[]> {
    const houses = this.houses(await this.locations(), address.city, address.street);
    const house = address.house.trim();
    const values = Object.entries(houses).filter(([key]) => key.trim() === house).map(([, value]) => value);
    if (values.length === 0) throw addressNotFound(NAME);
    return this.http.read('map', () => houseOf(house, values)).lines;
  }

  /**
   * Today's answer and tomorrow's. A quiet today is all `on` with the note (the page cannot tell a quiet day from an
   * unpublished one); a quiet tomorrow is left out.
   */
  private async schedule(groupId: string, today: string): Promise<ScheduleDays> {
    const tomorrow = addDays(today, 1);
    const todayTables = await this.day(today);
    const tomorrowTables = await this.day(tomorrow);
    const days: DaySchedule[] = [{ date: today, slots: todayTables ? queueSlots(todayTables, groupId) : daySlots('on') }];
    if (tomorrowTables) days.push({ date: tomorrow, slots: queueSlots(tomorrowTables, groupId) });
    return todayTables ? { days } : { days, note: CEK_QUIET_NOTE };
  }

  /** One date's answer of the form, for all queues at once; an answer for another date is unreadable. */
  private async day(date: string): Promise<Record<string, Slot[]> | undefined> {
    const body = new URLSearchParams({ queue: 'all', date }).toString();
    const html = await this.http.text(FORM, { ...FORM_POST, body });
    return this.http.read('schedule', () => parseCekDay(html, date));
  }

  private async locations(): Promise<CekMap> {
    if (this.map) return this.map;
    const html = await this.http.text(MAP);
    const map = this.http.read('map', () => extractLocations(html));
    this.map = map;
    return map;
  }

  private streets(map: CekMap, city: string): CekMap[string] {
    return map[keyOf(Object.keys(map), city)];
  }

  private houses(map: CekMap, city: string, street: string): Record<string, string> {
    const streets = this.streets(map, city);
    return streets[keyOf(Object.keys(streets), street)];
  }
}
