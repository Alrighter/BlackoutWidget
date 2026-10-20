import { DTEK_SITES, DtekProvider } from './dtek';
import { NEUTRALIZE_TIMERS, READY_CHECK, isPagePollRequest } from './dtek/page-scripts';
import type { SessionOptions } from './browser-session';
import type { HttpFetch } from './http';
import { VoeProvider } from './voe';
import { providerSiteUrl } from '../../shared/providers';
import type { Logger } from '../log';
import { ProviderError, type PageSession, type ScheduleProvider } from './types';

/** What the plain-HTTP providers need from main: the fetch and the OS-level connectivity hint. */
export interface ProviderHttp { fetch: HttpFetch; isOnline: () => boolean }

/** Kyiv city first, then the oblasts alphabetically: Volyn, Dnipro, Kyiv oblast, Odesa. */
export function createProviders(
  makeSession: (o: SessionOptions) => PageSession, log: Logger, http: ProviderHttp,
): ScheduleProvider[] {
  const [kyivCity, ...dtekRegions] = DTEK_SITES.map(site => {
    const url = providerSiteUrl(site.id)!;
    return new DtekProvider(site, makeSession({
      url,
      partition: `persist:${site.id}`,
      readyCheck: READY_CHECK,
      allowedHosts: [new URL(url).hostname.replace(/^www\./, '')],
      afterReady: NEUTRALIZE_TIMERS,
      blockRequest: isPagePollRequest,
    }), log);
  });
  return [kyivCity, new VoeProvider({ fetch: http.fetch, isOnline: http.isOnline, log }), ...dtekRegions];
}

export function findProvider(list: ScheduleProvider[], id: string): ScheduleProvider {
  const p = list.find(x => x.id === id);
  if (!p) throw new ProviderError(`Невідомий провайдер: ${id}`);
  return p;
}
