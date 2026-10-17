import type { Address, HouseInfo, ScheduleSnapshot } from '../../../shared/types';
import { CaptchaRequiredError, ProviderError, type PageSession, type ScheduleProvider } from '../types';
import {
  deriveLines, factToDays, parseCurrentOutage, parseHomeNumResponse, parseHouses,
  type DtekFact, type DtekHomeNumResponse,
} from './parse';
import { READ_CITIES, READ_FACT, getHomeNumScript, readStreetsScript } from './page-scripts';

interface FactState { fact: DtekFact; schNames: Record<string, string> }

export class DtekKremProvider implements ScheduleProvider {
  readonly id = 'dtek-krem';
  readonly displayName = 'ДТЕК Київські регіональні електромережі';
  private state: FactState | null = null;

  constructor(private readonly session: PageSession) {}

  listCities(): Promise<string[]> {
    return this.guard(async () => {
      await this.ready();
      return this.session.evaluate<string[]>(READ_CITIES);
    });
  }

  listStreets(city: string): Promise<string[]> {
    return this.guard(async () => {
      await this.ready();
      return this.session.evaluate<string[]>(readStreetsScript(city));
    });
  }

  listHouses(city: string, street: string): Promise<HouseInfo[]> {
    return this.guard(async () => {
      const resp = await this.homeNum(city, street);
      const { fact, schNames } = this.state!;
      return parseHouses(resp, fact, schNames);
    });
  }

  fetchSnapshot(address: Address): Promise<ScheduleSnapshot> {
    return this.guard(async () => {
      const resp = await this.homeNum(address.city, address.street);
      const { fact, schNames } = this.state!;
      const entry = resp.data[address.house];
      if (!entry) throw new ProviderError('Будинок не знайдено у відповіді ДТЕК');
      const lines = deriveLines(entry.sub_type_reason ?? [], fact, schNames);
      const groupId = lines[address.lineIndex - 1]?.groupId ?? address.groupId;
      return {
        providerId: this.id,
        address,
        groupId,
        groupLabel: schNames[groupId] ?? groupId,
        days: factToDays(fact, groupId),
        sourceUpdatedAt: fact.update,
        fetchedAt: new Date().toISOString(),
        lines,
        currentOutage: parseCurrentOutage(entry),
      };
    });
  }

  showVerification(): Promise<void> {
    return this.session.showForUser();
  }

  dispose(): void {
    this.session.dispose();
  }

  // Callers only ever see ProviderError / CaptchaRequiredError.
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ProviderError || e instanceof CaptchaRequiredError) throw e;
      throw new ProviderError(e instanceof Error ? e.message : String(e));
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
    for (let attempt = 0; ; attempt++) {
      const resp = await this.tryHomeNum(city, street, state.fact.update);
      if (resp) {
        if (resp.fact) {
          this.state = { fact: resp.fact, schNames: resp.preset?.sch_names ?? state.schNames };
        }
        return resp;
      }
      if (attempt >= 1) throw new ProviderError('Сайт ДТЕК повернув помилку');
      await this.session.reload();
      state = await this.readFact();
    }
  }

  private async tryHomeNum(city: string, street: string, updateFact: string): Promise<DtekHomeNumResponse | null> {
    const reply = await this.session.evaluate<{ status: number; body: string }>(getHomeNumScript(city, street, updateFact));
    if (reply.status !== 200) return null;
    try {
      return parseHomeNumResponse(JSON.parse(reply.body));
    } catch {
      return null;
    }
  }
}
