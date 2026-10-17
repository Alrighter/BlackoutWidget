import { DtekKremProvider } from './dtek-krem';
import { DTEK_URL, NEUTRALIZE_TIMERS, READY_CHECK } from './dtek-krem/page-scripts';
import type { SessionOptions } from './browser-session';
import { ProviderError, type PageSession, type ScheduleProvider } from './types';

export function createProviders(makeSession: (o: SessionOptions) => PageSession): ScheduleProvider[] {
  return [
    new DtekKremProvider(makeSession({
      url: DTEK_URL,
      partition: 'persist:dtek-krem',
      readyCheck: READY_CHECK,
      allowedHosts: ['dtek-krem.com.ua'],
      afterReady: NEUTRALIZE_TIMERS,
    })),
  ];
}

export function findProvider(list: ScheduleProvider[], id: string): ScheduleProvider {
  const p = list.find(x => x.id === id);
  if (!p) throw new ProviderError(`Невідомий провайдер: ${id}`);
  return p;
}
