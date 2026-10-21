import { providerDisplayName } from '../../../shared/providers';
import { addDays, kyivDateKey, kyivWallTimeToInstant } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { HttpSource, sourceTexts, type PlainHttpDeps, type SourceInit } from '../http-source';
import { wallInstant, wallStamp } from '../inneti';
import { daySlots } from '../lines';
import { houseKey, nameKey } from '../names';
import { addressNotFound, resolveByLabel, sortedLabels } from '../resolve';
import { addressSide, bestEffort, daysForLine, snapshotOf, type ScheduleDays } from '../snapshot';
import type { ScheduleProvider } from '../types';
import {
  cvoeHouses, cvoeStreets, groupLabel, groupLines, parseCvoePage, parseDistrictPage, parseOutageReply, placeWords, streetWords,
  type CvoeOutageRow, type CvoePage, type CvoeRow,
} from './parse';
import { cvoeSettlements, CVOE_DISTRICTS, type CvoeSettlement } from './settlements';

const NAME = 'Чернівціобленерго';

const SITE = 'https://oblenergo.cv.ua';
/** One day's table: today's, or the last one the operator left up. No date parameter exists. */
const SCHEDULE = `${SITE}/shutdowns/`;
/** Tomorrow's view, read only while the default page links to it. */
const NEXT = `${SITE}/shutdowns/?next`;
/** A district's every row (street, house, group; the oblast districts add the settlement): there is no smaller query. */
const districtPage = (district: number): string => `${SITE}/shutdowns-search/${district}/`;
/** The current-outage form: JSON whose `data` is an HTML table. */
const OUTAGES = `${SITE}/shutdowns/planovi_avarijni_result.php`;
const MIN_GAP_MS = 1000;

/** The outage form numbers the дільниці its own way: the search pages' id → the form's `v_diln`. */
const FORM_DISTRICT: Record<number, number> = { 1: 1, 2: 6, 3: 2, 4: 12, 5: 10, 6: 7, 7: 11, 8: 5, 9: 3, 10: 8, 11: 4, 12: 9 };
/** The form's two lists, asked in this order: an emergency wins, so the planned list is asked only without one. */
const OUTAGE_TYPES = [
  { vType: '0', kind: 'emergency', text: 'Аварійне відключення' },
  { vType: '1', kind: 'planned', text: 'Планові роботи' },
] as const;
/** The search is by substring: more pages than this is too wide to read, and gives no outage (logged). */
const MAX_PAGES = 5;
/** The form refuses a settlement or street shorter than this. */
const MIN_WORD = 3;
const FORM_POST: Omit<SourceInit, 'body'> = {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest' },
};

/** The page without a table, but with the operator's emergency banner: the schedule is void for everyone. */
const EMERGENCY_MODE: CurrentOutage = { kind: 'emergency', text: 'Аварійні відключення — графік не діє' };

type CvoeTable = Extract<CvoePage, { kind: 'table' }>;

/** 'YYYY-MM-DD' as 'DD.MM.YYYY'. */
const dmy = (dateKey: string): string => dateKey.split('-').reverse().join('.');

/** The note of a day the operator left an older table up: it names that table's date. */
export function cvoeStaleNote(dateKey: string): string {
  return `${NAME} не опублікувало графік на сьогодні (останній — на ${dmy(dateKey)}) — зазвичай це означає, що відключень за графіком немає`;
}

/** The settlement's дільниця as the bundle's labels carry it (the city has none). */
const districtGroup = (s: CvoeSettlement): string | undefined => (s.district === 1 ? undefined : `${CVOE_DISTRICTS[s.district]} дільниця`);

/** The longest word (the first of equal length); '' for none. */
const longest = (words: readonly string[]): string => words.reduce((a, w) => (w.length > a.length ? w : a), '');

/**
 * The form's search word: the longest piece of the words split at the apostrophe. nameKey writes it as ’ (U+2019),
 * the site only ever as ' (U+0027), so a search word holding one would never match.
 */
const searchWord = (words: readonly string[]): string => longest(words.flatMap((w) => w.split('’')));

/**
 * A table's «станом на» time as 'HH:MM DD.MM.YYYY'. The page gives no date for it: the table's date, or the day before
 * when that would put it after now (today's table, published the evening before).
 */
function updatedAt(table: CvoeTable, now: Date): string {
  const [h, m] = table.updatedHM.split(':').map(Number);
  const future = kyivWallTimeToInstant(table.date, h * 60 + m).getTime() > now.getTime();
  return `${table.updatedHM} ${dmy(future ? addDays(table.date, -1) : table.date)}`;
}

/** A reply stamp 'YYYY-MM-DD HH:MM:SS' is Kyiv wall clock: as the ISO-like form the wall-clock helpers read. */
const wallIso = (stamp: string): string => stamp.replace(' ', 'T');

/** Started (start ≤ now) and not yet over (now < end). */
function running(row: CvoeOutageRow, now: Date): boolean {
  const start = wallInstant(wallIso(row.start));
  const end = wallInstant(wallIso(row.end));
  return !!start && !!end && start.getTime() <= now.getTime() && now.getTime() < end.getTime();
}

/**
 * Чернівціобленерго over plain HTTPS: the bundled settlements, then the district's search page (every row of the
 * district, read once per run) for streets, houses and their groups, the one-day schedule page (and tomorrow's view when
 * linked), and the current-outage form. Each table's own date decides its day: an older table is a quiet day unless its
 * ?next holds today's, a later one is unreadable. On refresh the address side is soft (every line is a group of the
 * oblast-wide table).
 */
export class CvoeProvider implements ScheduleProvider {
  readonly id = 'cvoe';
  readonly displayName = providerDisplayName('cvoe');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  /** A district's parsed rows, kept for the run once read (the city page alone is 1.5 MB). A failed read is not kept. */
  private readonly districts = new Map<number, CvoeRow[]>();

  constructor(deps: PlainHttpDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'cvoe', texts: sourceTexts(NAME),
      minGapMs: MIN_GAP_MS, sleep: deps.sleep, clock: deps.clock,
    });
  }

  /** The bundled settlements (labels unique and sorted): no request. */
  listCities(): Promise<string[]> {
    return this.http.serial('listCities', async () => cvoeSettlements().map((s) => s.label));
  }

  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => sortedLabels(cvoeStreets(await this.settlementRows(this.settlement(city)))));
  }

  /** Each house once (its spellings merged, «буд.» dropped), in number order, with all its groups as lines. */
  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => {
      const rows = await this.streetRows(this.settlement(city), street);
      return this.http.read('district', () => cvoeHouses(rows));
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const settlement = this.settlement(address.city);
      const checked = await addressSide(address.groupId, this.log, 'cvoe fetchSnapshot: address check', () => this.houseCheck(settlement, address));
      const lines = checked ?? [{ index: address.lineIndex, groupId: address.groupId, label: groupLabel(address.groupId) }];
      let emergency = false;
      const schedule = await daysForLine(lines, address.groupId, today, async () => {
        const page = await this.page(SCHEDULE);
        if (page.kind === 'table') return this.days(page, address.groupId, today, now);
        emergency = true;
        return { days: [{ date: today, slots: daySlots('unknown') }] };
      });
      const currentOutage = emergency
        ? EMERGENCY_MODE
        : await bestEffort(this.log, 'cvoe fetchSnapshot: current outage lookup', () => this.currentOutage(settlement, address, today, now));
      return snapshotOf({ providerId: this.id, address, now, groupLabel: groupLabel(address.groupId), lines, currentOutage, ...schedule });
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  /**
   * The saved house's lines from the run's district rows: the street found by nameKey, the house by houseKey (so «12А» is
   * the row written «буд. 12 а»), every group of its rows. A street or house the rows lack is AddressNotFoundError.
   */
  private async houseCheck(settlement: CvoeSettlement, address: Address): Promise<LineInfo[]> {
    const key = houseKey(address.house);
    const rows = (await this.streetRows(settlement, address.street)).filter((r) => houseKey(r.house) === key);
    if (rows.length === 0) throw addressNotFound(NAME);
    return this.http.read('district', () => groupLines(rows.map((r) => r.group)));
  }

  /**
   * The day by each table's own date. The default page dated today gives the group's slots, its «станом на» time, and
   * tomorrow from ?next when linked (a ?next of any other date, or without a table, is ignored). An older default page
   * with a ?next link means a newer table exists (just after midnight, say): a ?next dated today is today's schedule,
   * one dated tomorrow leaves today the quiet day and gives tomorrow, any other is unreadable. An older page without the
   * link is the one the operator left up: a quiet day with the dated note. A later one has never been seen: unreadable.
   */
  private async days(page: CvoeTable, groupId: string, today: string, now: Date): Promise<ScheduleDays> {
    const slots = this.slots(page, groupId);
    if (page.date > today) throw this.http.unreadable({ what: 'schedule', reason: 'table dated after today' });
    const tomorrow = addDays(today, 1);
    if (page.date === today) {
      const days: DaySchedule[] = [{ date: today, slots }];
      if (page.nextLink) {
        const next = await this.page(NEXT);
        if (next.kind === 'table' && next.date === tomorrow) days.push({ date: tomorrow, slots: this.slots(next, groupId) });
      }
      return { days, sourceUpdatedAt: updatedAt(page, now) };
    }
    const quiet: DaySchedule = { date: today, slots: daySlots('on') };
    if (!page.nextLink) return { days: [quiet], note: cvoeStaleNote(page.date) };
    const next = await this.page(NEXT);
    if (next.kind !== 'table') throw this.http.unreadable({ what: 'schedule', reason: 'next view without a table' });
    if (next.date === today) return { days: [{ date: today, slots: this.slots(next, groupId) }], sourceUpdatedAt: updatedAt(next, now) };
    if (next.date === tomorrow) return { days: [quiet, { date: tomorrow, slots: this.slots(next, groupId) }], note: cvoeStaleNote(page.date) };
    throw this.http.unreadable({ what: 'schedule', reason: 'next table of another date' });
  }

  /** The group's 48 cells; a group the table lacks is unreadable, on a quiet day too (never all `on`). */
  private slots(page: CvoeTable, groupId: string): Slot[] {
    if (!Object.hasOwn(page.groups, groupId)) throw this.http.unreadable({ what: 'schedule', reason: 'no such group' });
    return page.groups[groupId];
  }

  private async page(url: string): Promise<CvoePage> {
    const html = await this.http.text(url);
    return this.http.read('schedule', () => parseCvoePage(html));
  }

  /**
   * An emergency, else planned works, running now for this house. The form searches by substring, so it is asked with
   * the search word of the settlement and of the street (and the house's leading digits), and a row counts only when
   * its settlement and street have the saved words and one of its houses is the saved one.
   */
  private async currentOutage(settlement: CvoeSettlement, address: Address, today: string, now: Date): Promise<CurrentOutage | undefined> {
    const place = placeWords(settlement.name);
    const street = streetWords(address.street);
    const city = searchWord(place);
    const streetWord = searchWord(street);
    if (city.length < MIN_WORD || streetWord.length < MIN_WORD) return undefined;
    const digits = /^\d+/.exec(address.house.trim())?.[0];
    const house = houseKey(address.house);
    const fields: Record<string, string> = {
      v_diln: String(FORM_DISTRICT[settlement.district]), v_city: city, v_street: streetWord,
      ...(digits ? { v_house: digits } : {}),
      v_date: dmy(today), v_sort_field: '4', v_sort_type: '0',
    };
    for (const type of OUTAGE_TYPES) {
      const row = (await this.outageRows({ v_type: type.vType, ...fields })).find((r) =>
        placeWords(r.settlement).join(' ') === place.join(' ') && streetWords(r.street).join(' ') === street.join(' ')
        && r.houses.some((h) => houseKey(h) === house) && running(r, now));
      if (row) {
        const start = wallStamp(wallIso(row.start));
        const end = wallStamp(wallIso(row.end));
        return { kind: type.kind, text: type.text, ...(start ? { start } : {}), ...(end ? { end } : {}) };
      }
    }
    return undefined;
  }

  /** Every page of one search: page 1 says how many there are. */
  private async outageRows(fields: Record<string, string>): Promise<CvoeOutageRow[]> {
    const first = await this.outagePage(fields, 1);
    if (first.pages > MAX_PAGES) throw this.http.unreadable({ what: 'outages', reason: 'too many pages' });
    const rows = [...first.rows];
    for (let page = 2; page <= first.pages; page++) rows.push(...(await this.outagePage(fields, page)).rows);
    return rows;
  }

  /** A validation reply, or one without rows and without «Нічого не знайдено», is unreadable: unknown, never «no outage». */
  private async outagePage(fields: Record<string, string>, page: number): Promise<{ rows: CvoeOutageRow[]; pages: number }> {
    const body = new URLSearchParams({ ...fields, v_page: String(page) }).toString();
    const reply = await this.http.json(OUTAGES, { ...FORM_POST, body });
    return this.http.read('outages', () => parseOutageReply(reply));
  }

  private settlement(label: string): CvoeSettlement {
    const list = cvoeSettlements();
    return resolveByLabel(list, list.map((s) => s.label), label, (s) => s.name, districtGroup, NAME);
  }

  /** The settlement's rows: the whole city page for district 1, else the district's rows naming it (by nameKey). */
  private async settlementRows(settlement: CvoeSettlement): Promise<CvoeRow[]> {
    const rows = await this.districtRows(settlement.district);
    if (settlement.district === 1) return rows;
    const name = nameKey(settlement.name);
    return rows.filter((r) => r.settlement !== undefined && nameKey(r.settlement) === name);
  }

  /** The street's rows, found by nameKey; none is AddressNotFoundError. */
  private async streetRows(settlement: CvoeSettlement, street: string): Promise<CvoeRow[]> {
    const key = nameKey(street);
    const rows = (await this.settlementRows(settlement)).filter((r) => nameKey(r.street) === key);
    if (rows.length === 0) throw addressNotFound(NAME);
    return rows;
  }

  private async districtRows(district: number): Promise<CvoeRow[]> {
    const cached = this.districts.get(district);
    if (cached) return cached;
    const html = await this.http.text(districtPage(district));
    const rows = this.http.read('district', () => parseDistrictPage(html, district));
    this.districts.set(district, rows);
    return rows;
  }
}
