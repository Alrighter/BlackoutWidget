import { providerDisplayName } from '../../../shared/providers';
import { addDays, formatHM, kyivDateKey } from '../../../shared/time';
import type { Address, CurrentOutage, DaySchedule, HouseInfo, LineInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import type { HttpFetch } from '../http';
import { HttpSource, quietNote, sourceTexts } from '../http-source';
import { nameKey, normHouse, sameName } from '../names';
import type { ProviderError, ScheduleProvider } from '../types';
import { readGpvGrid } from './gpv-image';
import { housesOf, matchOutage, parseOutageTable, parseQueueTable, type QueueRow } from './html';
import { decodePng } from './png';
import { bareName, findSettlement, hasNamesake, operatorCity, voeSettlements } from './settlements';

const NAME = 'Волиньобленерго';
export const VOE_QUIET_NOTE = quietNote(NAME, 'опублікувало');

const API = 'https://api-voe-poweron.inneti.net';
const ARCHIVE_URL = `${API}/api/archive_gpv_graphs?page=1`;
const SITE = 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni';
const QUEUE_URL = `${SITE}/cherga/`;
const OUTAGE_URL = `${SITE}/chomu-nemaie-elektropostachannia/`;
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
const IMAGE_CACHE_SIZE = 4;

type Grid = Record<string, Slot[]>;

/** One published picture: `date` is `dateGraph`'s day (Kyiv wall time, whatever the offset says). */
interface ArchiveEntry { id: number; date: string; contentUrl?: string; uploadTimestamp?: string }

/** Where a saved city label points at the operator: the name its forms take, and the district to tell villages apart. */
interface OperatorPlace { city: string; raion?: string }

const allOn = (): Slot[] => Array<Slot>(48).fill('on');

const queueLabel = (groupId: string): string => (groupId === 'none' ? 'Не залучено до ГПВ' : `Черга ${groupId}`);

function isDateKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
}

/**
 * The archive page, newest first. Empty, a first entry that is not the newest (the highest id), or a newest entry
 * without a sane date means the source is dead or moved: page 1 in another order would hold old days, and every day
 * would read as quiet.
 */
function parseArchive(body: unknown, unreadable: (cause?: Record<string, unknown>) => ProviderError): ArchiveEntry[] {
  const members = (body as { 'hydra:member'?: unknown } | null)?.['hydra:member'];
  if (!Array.isArray(members) || members.length === 0) throw unreadable({ archive: 'empty' });
  const entries = members.map((m): ArchiveEntry => ({
    id: Number(m?.id),
    date: typeof m?.dateGraph === 'string' ? m.dateGraph.slice(0, 10) : '',
    contentUrl: typeof m?.imageUrl?.contentUrl === 'string' ? m.imageUrl.contentUrl : undefined,
    uploadTimestamp: typeof m?.imageUrl?.uploadTimestamp === 'string' ? m.imageUrl.uploadTimestamp : undefined,
  }));
  const newest = entries[0];
  // A NaN id anywhere makes Math.max NaN, so this fails closed too.
  if (newest.id !== Math.max(...entries.map((e) => e.id))) throw unreadable({ archive: 'not newest first', id: newest.id });
  if (!isDateKey(newest.date)) throw unreadable({ archive: 'newest dateGraph', value: newest.date });
  return entries;
}

/** The latest revision for a day: the highest id with that `dateGraph`. */
function pick(entries: ArchiveEntry[], date: string): ArchiveEntry | undefined {
  let best: ArchiveEntry | undefined;
  for (const e of entries) if (e.date === date && (!best || e.id > best.id)) best = e;
  return best;
}

/** 'HH:MM DD.MM.YYYY' in Kyiv time, like DTEK's `fact.update`. */
function kyivStamp(iso: string | undefined): string | undefined {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return undefined;
  const [y, m, day] = kyivDateKey(d).split('-');
  return `${formatHM(d)} ${day}.${m}.${y}`;
}

/** Whether any of these rows is in the place's district. */
function hasRaion(rows: ReadonlyArray<{ raion: string }>, place: OperatorPlace): boolean {
  const { raion } = place;
  return !!raion && rows.some((r) => sameName(r.raion, raion));
}

/**
 * Rows of exactly this settlement (the forms match by substring). By district too when these rows have that district,
 * or when `raionKnown` (the operator files the name under it elsewhere): then rows of other districts never pass.
 */
function rowsOf<R extends { raion: string; settlement: string }>(all: R[], place: OperatorPlace, raionKnown = false): R[] {
  const same = all.filter((r) => sameName(r.settlement, place.city));
  const { raion } = place;
  if (!raion) return same;
  const inRaion = same.filter((r) => sameName(r.raion, raion));
  return inRaion.length > 0 || raionKnown ? inRaion : same;
}

export interface VoeDeps {
  fetch: HttpFetch;
  isOnline: () => boolean;
  log?: Logger;
  now?: () => Date;
}

/**
 * Volynoblenergo over plain HTTPS: the day pictures from the inneti archive, the queue lookup and the current
 * outages from energy.volyn.ua. No browser window, no captcha.
 */
export class VoeProvider implements ScheduleProvider {
  readonly id = 'voe';
  readonly displayName = providerDisplayName('voe');
  private readonly log: Logger;
  private readonly http: HttpSource;
  private readonly now: () => Date;
  /** Parsed day pictures by `contentUrl`, least recently used first. */
  private readonly grids = new Map<string, Grid>();
  /** The settlement's queue rows by city label; queues are fixed for a year, so for the whole run. */
  private readonly queues = new Map<string, QueueRow[]>();

  constructor(private readonly deps: VoeDeps) {
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.http = new HttpSource({
      fetch: deps.fetch, isOnline: deps.isOnline, log: this.log, tag: 'voe', texts: sourceTexts(NAME),
    });
  }

  listCities(): Promise<string[]> {
    return Promise.resolve(voeSettlements().map((s) => s.label));
  }

  /** Each street once, in the operator's first spelling: two apostrophes or a look-alike letter make no second street. */
  listStreets(city: string): Promise<string[]> {
    return this.http.serial('listStreets', async () => {
      const byKey = new Map<string, string>();
      for (const r of await this.queueRows(city)) if (!byKey.has(nameKey(r.street))) byKey.set(nameKey(r.street), r.street);
      return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'uk'));
    });
  }

  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.http.serial('listHouses', async () => housesOf(await this.queueRows(city), street));
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.http.serial('fetchSnapshot', async () => {
      const now = this.now();
      const today = kyivDateKey(now);
      const entries = parseArchive(
        await this.http.json(ARCHIVE_URL, { method: 'GET', headers: { Accept: 'application/ld+json' } }), this.http.unreadable.bind(this.http),
      );
      const todayEntry = pick(entries, today);
      const tomorrowEntry = pick(entries, addDays(today, 1));
      // Nothing published for today: power is on by schedule. Tomorrow without a picture is simply left out.
      const days: DaySchedule[] = [{ date: today, slots: todayEntry ? await this.slots(todayEntry, address.groupId) : allOn() }];
      if (tomorrowEntry) days.push({ date: tomorrowEntry.date, slots: await this.slots(tomorrowEntry, address.groupId) });
      const sourceUpdatedAt = kyivStamp(todayEntry?.uploadTimestamp);
      let queue: QueueRow[] | undefined;
      try {
        queue = await this.queueRows(address.city);
      } catch (e) {
        this.log.warn('voe fetchSnapshot: queue lookup failed, keeping the saved line', e);
      }
      const lines = this.lines(address, queue);
      const currentOutage = await this.currentOutage(address, now, queue ?? []);
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
        ...(todayEntry ? {} : { note: VOE_QUIET_NOTE }),
      };
    });
  }

  showVerification(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {}

  private async slots(entry: ArchiveEntry, groupId: string): Promise<Slot[]> {
    if (groupId === 'none') return allOn(); // not in the hourly schedule: the picture says nothing about it
    const row = (await this.grid(entry))[groupId];
    if (!row) throw this.http.unreadable({ groupId, date: entry.date });
    return row;
  }

  private async grid(entry: ArchiveEntry): Promise<Grid> {
    const path = entry.contentUrl;
    // A path on the API host only: never let the archive point the download elsewhere.
    if (!path || !path.startsWith('/') || path.startsWith('//')) throw this.http.unreadable({ date: entry.date, contentUrl: path });
    const hit = this.grids.get(path);
    if (hit) {
      this.grids.delete(path);
      this.grids.set(path, hit);
      return hit;
    }
    const bytes = await this.http.bytes(`${API}${path}`);
    const grid = readGpvGrid(decodePng(new Uint8Array(bytes)));
    this.grids.set(path, grid);
    while (this.grids.size > IMAGE_CACHE_SIZE) this.grids.delete(this.grids.keys().next().value!);
    return grid;
  }

  /** The house's queues from the operator; the saved line when the lookup failed (`queue` undefined) or lacks the house. */
  private lines(address: Address, queue: QueueRow[] | undefined): LineInfo[] {
    const saved = [{ index: address.lineIndex, groupId: address.groupId, label: queueLabel(address.groupId) }];
    if (!queue) return saved;
    const house = housesOf(queue, address.street).find((h) => h.house === normHouse(address.house));
    if (!house) {
      this.log.warn('voe fetchSnapshot: no queue row for the saved house, keeping the saved line', {
        city: address.city, street: address.street, house: address.house,
      });
      return saved;
    }
    return house.lines;
  }

  /**
   * The outage listed for the saved house. For same-named villages the district decides: when the operator files the
   * name under the saved district (in its queue table, or in these outage rows), rows of other districts never match.
   * The queue table counts too because a quiet district has no outage rows while its namesake may have one.
   * The street is left blank, as the browser form allows: the whole settlement comes back, and the street is matched
   * here, so a different apostrophe or look-alike letter in the operator's outage rows cannot hide the outage.
   */
  private async currentOutage(address: Address, now: Date, queue: QueueRow[]): Promise<CurrentOutage | undefined> {
    const place = this.place(address.city);
    if (!place.city) return undefined;
    try {
      const html = await this.http.text(OUTAGE_URL, {
        method: 'POST', headers: FORM_HEADERS,
        body: new URLSearchParams({ formCity: place.city, formStreet: '', searchForm: 'searchFromForm' }).toString(),
      });
      const rows = rowsOf(parseOutageTable(html), place, hasRaion(queue, place));
      return matchOutage(rows, { settlement: place.city, street: address.street, house: address.house }, now);
    } catch (e) {
      this.log.warn('voe fetchSnapshot: current outage lookup failed', e);
      return undefined;
    }
  }

  private place(label: string): OperatorPlace {
    const s = findSettlement(label);
    // A label missing from the bundled list (the list was regenerated) still works by its bare name.
    if (!s) return { city: bareName(label) };
    // Only for a name the operator knows in several districts does the district tell places apart. For a unique name
    // it would only add risk: a row the operator files under another district must still count.
    return hasNamesake(s) ? { city: operatorCity(s), raion: s.raion } : { city: operatorCity(s) };
  }

  private async queueRows(label: string): Promise<QueueRow[]> {
    const cached = this.queues.get(label);
    if (cached) return cached;
    const place = this.place(label);
    if (!place.city) return [];
    const html = await this.http.text(QUEUE_URL, {
      method: 'POST', headers: FORM_HEADERS,
      body: new URLSearchParams({ formCity: place.city, formStreet: '%' }).toString(),
    });
    const rows = rowsOf(parseQueueTable(html), place);
    // An empty answer may be a glitch or a changed page: ask again next time.
    if (rows.length > 0) this.queues.set(label, rows);
    return rows;
  }
}
