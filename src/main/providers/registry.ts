import { DTEK_SITES, DtekProvider } from './dtek';
import { NEUTRALIZE_TIMERS, READY_CHECK, isPagePollRequest } from './dtek/page-scripts';
import type { SessionOptions } from './browser-session';
import { providerSiteUrl } from '../../shared/providers';
import { silentLogger, type Logger } from '../log';
import { ProviderError, type PageSession, type ScheduleProvider } from './types';

export function createProviders(
  makeSession: (o: SessionOptions) => PageSession, log: Logger = silentLogger,
): ScheduleProvider[] {
  return DTEK_SITES.map(site => {
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
}

export function findProvider(list: ScheduleProvider[], id: string): ScheduleProvider {
  const p = list.find(x => x.id === id);
  if (!p) throw new ProviderError(`Невідомий провайдер: ${id}`);
  return p;
}
