import { DTEK_SITES, DtekProvider } from './dtek';
import { NEUTRALIZE_TIMERS, READY_CHECK, isPagePollRequest } from './dtek/page-scripts';
import type { SessionOptions } from './browser-session';
import type { HttpFetch } from './http';
import { LoeProvider } from './loe';
import { MkoeProvider } from './mkoe';
import { ToeProvider } from './toe';
import { VoeProvider } from './voe';
import { PROVIDERS, providerSiteUrl } from '../../shared/providers';
import type { Logger } from '../log';
import { ProviderError, type PageSession, type ScheduleProvider } from './types';

/** What the plain-HTTP providers need from main: the fetch and the OS-level connectivity hint. */
export interface ProviderHttp { fetch: HttpFetch; isOnline: () => boolean }

/** The providers in the order of `PROVIDERS` (the wizard's card order). A new source is one `PROVIDERS` entry and one line in `make`. */
export function createProviders(
  makeSession: (o: SessionOptions) => PageSession, log: Logger, http: ProviderHttp,
): ScheduleProvider[] {
  const dtek = (id: string): ScheduleProvider => {
    const site = DTEK_SITES.find(s => s.id === id)!;
    const url = providerSiteUrl(id)!;
    return new DtekProvider(site, makeSession({
      url,
      partition: `persist:${id}`,
      readyCheck: READY_CHECK,
      allowedHosts: [new URL(url).hostname.replace(/^www\./, '')],
      afterReady: NEUTRALIZE_TIMERS,
      blockRequest: isPagePollRequest,
    }), log);
  };
  const make: Record<string, () => ScheduleProvider> = {
    'voe': () => new VoeProvider({ fetch: http.fetch, isOnline: http.isOnline, log }),
    'loe': () => new LoeProvider({ fetch: http.fetch, isOnline: http.isOnline, log }),
    'mkoe': () => new MkoeProvider({ fetch: http.fetch, isOnline: http.isOnline, log }),
    'toe': () => new ToeProvider({ fetch: http.fetch, isOnline: http.isOnline, log }),
  };
  for (const site of DTEK_SITES) make[site.id] = () => dtek(site.id);
  return Object.keys(PROVIDERS).map(id => {
    const build = make[id];
    if (!build) throw new ProviderError(`Невідомий провайдер: ${id}`);
    return build();
  });
}

export function findProvider(list: ScheduleProvider[], id: string): ScheduleProvider {
  const p = list.find(x => x.id === id);
  if (!p) throw new ProviderError(`Невідомий провайдер: ${id}`);
  return p;
}
