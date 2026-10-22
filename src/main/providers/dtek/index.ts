import { providerDisplayName, providerSingleCity } from '../../../shared/providers';
import { kyivDateKey } from '../../../shared/time';
import type { Address, HouseInfo, ScheduleSnapshot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import { loggable } from '../http-source';
import { AddressNotFoundError } from '../resolve';
import {
  CaptchaRequiredError, NetworkError, OFFLINE_MESSAGE, ProviderError, type PageSession, type ScheduleProvider,
} from '../types';
import {
  FEEDS_FAILED_TEXT, HOUSE_CHECK_MS, HOUSE_MISSING_SURFACE_MS, PAGE_GAP_MS, PAGE_LINGER_MS, PAGE_REFRESH_LINGER_MS,
  type FeedResult, type ScheduleFeed,
} from './feeds';
import {
  deriveLines, factDays, hasActiveOutage, hasOutageFields, parseCurrentOutage, parseHomeNumResponse, parseHouses,
  queueLabelFromId, type DtekFact, type DtekHomeNumResponse,
} from './parse';
import { READ_CITIES, READ_FACT, getHomeNumScript, readStreetsScript } from './page-scripts';
import { feedSnapshot, houseCheckDue, houseMissingSurfaces, keepPrevious, pageAllowed, pageCause } from './route';

export { FEEDS_FAILED_TEXT };

interface FactState { fact: DtekFact; schNames: Record<string, string> }

export interface DtekSite { id: string; cityLevel: boolean }

/** The four DTEK sites that run the same /ua/shutdowns page; Kyiv city has no city level. */
export const DTEK_SITES: ReadonlyArray<DtekSite> = [
  { id: 'dtek-kem', cityLevel: false },
  { id: 'dtek-dnem', cityLevel: true },
  { id: 'dtek-krem', cityLevel: true },
  { id: 'dtek-oem', cityLevel: true },
];

export interface DtekOptions {
  /** Tried in order on a refresh. None: every refresh reads the page, as before the feeds. */
  feeds?: ScheduleFeed[];
  /** After a wizard step or a verification. */
  lingerMs?: number;
  /** After a refresh; default the shorter of PAGE_REFRESH_LINGER_MS and `lingerMs`. */
  refreshLingerMs?: number;
  pageGapMs?: number;
  houseCheckMs?: number;
}

/** Why a refresh uses the page (spec §Behaviour, steps 1, 3 and 4). */
type PageReason = 'house check' | 'emergency' | 'fallback';

export class DtekProvider implements ScheduleProvider {
  readonly id: string;
  readonly displayName: string;
  private state: FactState | null = null;
  private readonly feeds: ScheduleFeed[];
  private readonly lingerMs: number;
  private readonly refreshLingerMs: number;
  private readonly pageGapMs: number;
  private readonly houseCheckMs: number;
  /** When a page use last found the window closed, so opened it (the budget; in memory, per site). */
  private lastPageOpenAt: number | null = null;
  /** Page uses running now: the linger is armed when the last one ends. */
  private pageUses = 0;
  private linger: ReturnType<typeof setTimeout> | undefined;
  /** When the armed (or just paused) linger releases the page: a later, shorter use never brings it forward. */
  private lingerUntil: number | undefined;

  constructor(
    private readonly site: DtekSite, private readonly session: PageSession, private readonly log: Logger = silentLogger,
    opts: DtekOptions = {},
  ) {
    this.id = site.id;
    this.displayName = providerDisplayName(site.id);
    this.feeds = opts.feeds ?? [];
    this.lingerMs = opts.lingerMs ?? PAGE_LINGER_MS;
    this.refreshLingerMs = opts.refreshLingerMs ?? Math.min(PAGE_REFRESH_LINGER_MS, this.lingerMs);
    this.pageGapMs = opts.pageGapMs ?? PAGE_GAP_MS;
    this.houseCheckMs = opts.houseCheckMs ?? HOUSE_CHECK_MS;
  }

  listCities(): Promise<string[]> {
    return this.serial('listCities', async () => {
      if (!this.site.cityLevel) return [providerSingleCity(this.id) ?? ''];
      return this.usePage(async () => {
        await this.ready();
        return this.session.evaluate<string[]>(READ_CITIES);
      });
    });
  }

  listStreets(city: string): Promise<string[]> {
    return this.serial('listStreets', () => this.usePage(async () => {
      await this.ready();
      return this.session.evaluate<string[]>(readStreetsScript(this.site.cityLevel ? city : null));
    }));
  }

  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.serial('listHouses', () => this.usePage(async () => {
      const resp = await this.homeNum(city, street);
      const { fact, schNames } = this.state!;
      return parseHouses(resp, fact, schNames);
    }));
  }

  fetchSnapshot(address: Address, previous: ScheduleSnapshot | null = null): Promise<ScheduleSnapshot> {
    return this.serial('fetchSnapshot', () => this.route(address, previous));
  }

  showVerification(): Promise<void> {
    // Not serialized: it runs while a refresh waits on ensureReady. Its end arms the linger like any page use.
    return this.usePage(() => this.session.showForUser());
  }

  dispose(): void {
    clearTimeout(this.linger);
    this.session.dispose();
  }

  /**
   * Spec §Behaviour. 1: the house check, when due and the page is allowed (a house missing past 48 h is thrown at once).
   * 2: the feeds in order; the first usable answer wins. 3: a YASNO emergency asks the page. 4: no feed usable: the
   * page's error, the page, `previous` while it is younger than the page budget, or FEEDS_FAILED_TEXT.
   * A page failure is held while a feed may still answer, so guard() logs a refresh's error once, as before the feeds.
   */
  private async route(address: Address, previous: ScheduleSnapshot | null): Promise<ScheduleSnapshot> {
    let failed: { reason: PageReason; error: unknown } | undefined; // the page was tried in this run and failed
    const tryPage = async (reason: PageReason): Promise<ScheduleSnapshot | undefined> => {
      try {
        return await this.pageFor(address, reason);
      } catch (e) {
        failed = { reason, error: e };
        return undefined;
      }
    };

    if (houseCheckDue(previous, this.houseCheckMs) && this.pageAllowed()) {
      const snap = await tryPage('house check');
      if (snap) return snap;
      // The page answered without the house: after 48 h with no good check the address needs re-picking, so say so.
      if (failed?.error instanceof AddressNotFoundError && houseMissingSurfaces(previous, HOUSE_MISSING_SURFACE_MS)) {
        throw failed.error;
      }
    }

    let offline = this.feeds.length > 0; // every feed failed for lack of a connection
    for (const feed of this.feeds) {
      let result: FeedResult;
      try {
        result = await feed.read(address.groupId, new Date());
      } catch (e) {
        this.log.warn(`${this.id}: ${feed.tag} failed`, loggable(e));
        offline &&= e instanceof NetworkError;
        continue;
      }
      offline = false;
      if (result.usable) {
        if (failed) this.log.warn(`${this.id}: the page failed (${failed.reason}), using ${feed.tag}`, pageCause(failed.error));
        return feedSnapshot(this.id, address, previous, result.answer);
      }
      this.log.warn(`${this.id}: ${feed.tag} unusable`, { reason: result.reason });
      if (result.emergency && !failed && this.pageAllowed()) {
        const snap = await tryPage('emergency');
        if (snap) return snap;
      }
    }

    if (failed) throw failed.error;
    if (this.pageAllowed()) return this.pageFor(address, 'fallback');
    // Only the budget refused the page, and its next turn comes before `previous` is old: no banner meanwhile.
    if (keepPrevious(previous, this.pageGapMs)) {
      this.log.warn(`${this.id}: no usable feed, the page is not due yet; keeping the last schedule`);
      return previous;
    }
    throw offline ? new NetworkError(FEEDS_FAILED_TEXT) : new ProviderError(FEEDS_FAILED_TEXT);
  }

  /** Evaluated at the moment the page would be used. With no feeds the page is the only source: no budget. */
  private pageAllowed(): boolean {
    return this.feeds.length === 0 || pageAllowed(this.session.isOpen(), this.lastPageOpenAt, this.pageGapMs);
  }

  private pageFor(address: Address, reason: PageReason): Promise<ScheduleSnapshot> {
    // With no feeds there is no choice to explain: the log stays as it was before them.
    if (this.feeds.length > 0) this.log.info(`${this.id}: using the page`, { reason });
    return this.usePage(() => this.pageSnapshot(address), this.refreshLingerMs);
  }

  /** Today's page refresh: the house's lines and outage, and the days, from one getHomeNum. */
  private async pageSnapshot(address: Address): Promise<ScheduleSnapshot> {
    const resp = await this.homeNum(address.city, address.street);
    const { fact, schNames } = this.state!;
    const entry = resp.data[address.house];
    if (!entry) throw new AddressNotFoundError('Будинок не знайдено у відповіді ДТЕК');
    // These fields have never been seen filled (spec §4.3): keep the raw values for later parsing work.
    if (hasOutageFields(entry)) this.log.info(`${this.id}: outage fields for house`, { house: address.house, entry });
    const lines = deriveLines(entry.sub_type_reason ?? [], fact, schNames);
    // Always the saved queue: during an outage `lines` lists only the outage's queues (see hasActiveOutage).
    const groupId = address.groupId;
    const unknownStatuses = new Set<string>();
    const { days, note } = factDays(fact, groupId, kyivDateKey(new Date()), s => unknownStatuses.add(s));
    for (const s of unknownStatuses) this.log.warn(`${this.id}: unknown hour status`, { groupId, status: s });
    const now = new Date().toISOString();
    return {
      providerId: this.id,
      address,
      groupId,
      groupLabel: schNames[groupId] ?? queueLabelFromId(groupId),
      days,
      sourceUpdatedAt: fact.update,
      fetchedAt: now,
      lines,
      outageActive: hasActiveOutage(entry),
      currentOutage: parseCurrentOutage(entry),
      ...(note ? { note } : {}),
      houseCheckedAt: now,
    };
  }

  /**
   * Every page operation goes through here. It stops the linger while it runs. Finding the window closed means this use
   * opens it, which counts toward the budget whether or not the open succeeds. When the last running use ends, a success
   * arms the linger and a failure releases at once: a window whose load failed still counts as open, and a use inside
   * the linger would load DTEK again past the budget. With no feeds the page stays, as before them. `lingerMs`: a
   * wizard step's or a verification's by default; a refresh passes its shorter one.
   */
  private async usePage<T>(fn: () => Promise<T>, lingerMs = this.lingerMs): Promise<T> {
    clearTimeout(this.linger);
    this.linger = undefined;
    if (!this.session.isOpen()) this.lastPageOpenAt = Date.now();
    this.pageUses++;
    let ok = false;
    try {
      const value = await fn();
      ok = true;
      return value;
    } finally {
      if (--this.pageUses === 0 && this.feeds.length > 0) {
        if (ok) this.armLinger(lingerMs);
        else this.releasePage();
      }
    }
  }

  private armLinger(ms: number): void {
    const until = Math.max(Date.now() + ms, this.lingerUntil ?? 0);
    const timer = setTimeout(() => this.releasePage(), until - Date.now());
    timer.unref?.();
    this.linger = timer;
    this.lingerUntil = until;
  }

  private releasePage(): void {
    this.linger = undefined;
    this.lingerUntil = undefined;
    this.session.release();
    this.state = null; // the next open reads the fact afresh
  }

  // One operation at a time: no parallel requests to the source; a failure doesn't break the chain.
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.guard(op, fn));
    this.tail = run.catch(() => {});
    return run;
  }

  // Callers only ever see ProviderError (incl. NetworkError) / CaptchaRequiredError; every failure is logged.
  private async guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = e instanceof ProviderError || e instanceof CaptchaRequiredError
        ? e
        : new ProviderError('Не вдалося отримати дані з сайту ДТЕК', { cause: e });
      if (err instanceof CaptchaRequiredError) this.log.warn(`${this.id} ${op}: verification required`, err);
      else this.log.error(`${this.id} ${op} failed`, err);
      throw err;
    }
  }

  private async ready(): Promise<FactState> {
    await this.session.ensureReady();
    return this.state ?? (await this.readFact());
  }

  private async readFact(): Promise<FactState> {
    this.state = await this.session.evaluate<FactState>(READ_FACT);
    return this.state;
  }

  private async homeNum(city: string, street: string): Promise<DtekHomeNumResponse> {
    let state = await this.ready();
    const statuses: number[] = [];
    for (let attempt = 0; ; attempt++) {
      const { resp, status } = await this.tryHomeNum(city, street, state.fact.update);
      if (resp) {
        if (resp.fact) {
          this.state = { fact: resp.fact, schNames: resp.preset?.sch_names ?? state.schNames };
        }
        return resp;
      }
      statuses.push(status);
      if (attempt >= 1) {
        // status 0 = the in-page fetch itself failed (no response). The reload in between succeeded, so DTEK was
        // reached: unless the machine is really offline, this is a timeout/reset that must obey the 5-minute floor.
        if (statuses.every(s => s === 0)) {
          if (!this.session.isOnline()) throw new NetworkError(OFFLINE_MESSAGE, { cause: { statuses } });
          throw new ProviderError('Сайт ДТЕК не відповідає', { cause: { statuses } });
        }
        throw new ProviderError('Сайт ДТЕК повернув помилку', { cause: { statuses } });
      }
      await this.session.reload();
      state = await this.readFact();
    }
  }

  private async tryHomeNum(
    city: string, street: string, updateFact: string,
  ): Promise<{ resp: DtekHomeNumResponse | null; status: number }> {
    const reply = await this.session.evaluate<{ status: number; body: string }>(getHomeNumScript(this.site.cityLevel ? city : null, street, updateFact));
    if (reply.status !== 200) return { resp: null, status: reply.status };
    try {
      return { resp: parseHomeNumResponse(JSON.parse(reply.body)), status: reply.status };
    } catch {
      return { resp: null, status: reply.status };
    }
  }
}
