import { providerDisplayName, providerSingleCity } from '../../../shared/providers';
import { kyivDateKey } from '../../../shared/time';
import type { Address, HouseInfo, ScheduleSnapshot, Slot } from '../../../shared/types';
import { silentLogger, type Logger } from '../../log';
import {
  CaptchaRequiredError, NetworkError, OFFLINE_MESSAGE, ProviderError, type PageSession, type ScheduleProvider,
} from '../types';
import {
  DTEK_QUIET_NOTE, deriveLines, factToDays, hasActiveOutage, hasOutageFields, isQuietToday, parseCurrentOutage, parseHomeNumResponse, parseHouses,
  queueLabelFromId, type DtekFact, type DtekHomeNumResponse,
} from './parse';
import { READ_CITIES, READ_FACT, getHomeNumScript, readStreetsScript } from './page-scripts';

interface FactState { fact: DtekFact; schNames: Record<string, string> }

export interface DtekSite { id: string; cityLevel: boolean }

/** The four DTEK sites that run the same /ua/shutdowns page; Kyiv city has no city level. */
export const DTEK_SITES: ReadonlyArray<DtekSite> = [
  { id: 'dtek-kem', cityLevel: false },
  { id: 'dtek-dnem', cityLevel: true },
  { id: 'dtek-krem', cityLevel: true },
  { id: 'dtek-oem', cityLevel: true },
];

export class DtekProvider implements ScheduleProvider {
  readonly id: string;
  readonly displayName: string;
  private state: FactState | null = null;

  constructor(
    private readonly site: DtekSite, private readonly session: PageSession, private readonly log: Logger = silentLogger,
  ) {
    this.id = site.id;
    this.displayName = providerDisplayName(site.id);
  }

  listCities(): Promise<string[]> {
    return this.serial('listCities', async () => {
      if (!this.site.cityLevel) return [providerSingleCity(this.id) ?? ''];
      await this.ready();
      return this.session.evaluate<string[]>(READ_CITIES);
    });
  }

  listStreets(city: string): Promise<string[]> {
    return this.serial('listStreets', async () => {
      await this.ready();
      return this.session.evaluate<string[]>(readStreetsScript(this.site.cityLevel ? city : null));
    });
  }

  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.serial('listHouses', async () => {
      const resp = await this.homeNum(city, street);
      const { fact, schNames } = this.state!;
      return parseHouses(resp, fact, schNames);
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.serial('fetchSnapshot', async () => {
      const resp = await this.homeNum(address.city, address.street);
      const { fact, schNames } = this.state!;
      const entry = resp.data[address.house];
      if (!entry) throw new ProviderError('Будинок не знайдено у відповіді ДТЕК');
      // These fields have never been seen filled (spec §4.3): keep the raw values for later parsing work.
      if (hasOutageFields(entry)) this.log.info(`${this.id}: outage fields for house`, { house: address.house, entry });
      const lines = deriveLines(entry.sub_type_reason ?? [], fact, schNames);
      // Always the saved queue: during an outage `lines` lists only the outage's queues (see hasActiveOutage).
      const groupId = address.groupId;
      const unknownStatuses = new Set<string>();
      let days = factToDays(fact, groupId, s => unknownStatuses.add(s));
      // Nothing published for today: power is on by schedule. Tomorrow without a schedule is simply left out.
      const todayKey = kyivDateKey(new Date());
      const quiet = isQuietToday(fact, todayKey);
      if (quiet) {
        days = [{ date: todayKey, slots: Array<Slot>(48).fill('on') }, ...days].sort((a, b) => a.date.localeCompare(b.date));
      }
      for (const s of unknownStatuses) this.log.warn(`${this.id}: unknown hour status`, { groupId, status: s });
      return {
        providerId: this.id,
        address,
        groupId,
        groupLabel: schNames[groupId] ?? queueLabelFromId(groupId),
        days,
        sourceUpdatedAt: fact.update,
        fetchedAt: new Date().toISOString(),
        lines,
        outageActive: hasActiveOutage(entry),
        currentOutage: parseCurrentOutage(entry),
        ...(quiet ? { note: DTEK_QUIET_NOTE } : {}),
      };
    });
  }

  showVerification(): Promise<void> {
    return this.session.showForUser();
  }

  dispose(): void {
    this.session.dispose();
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
