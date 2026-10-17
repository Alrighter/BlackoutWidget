import { createEcoflowFactory } from './ecoflow';
import type { FetchLike } from './ecoflow/api';
import type { MqttConnect } from './ecoflow/source';
import type { ActualSourceFactory } from './types';

export function createActualSources(deps: { fetch: FetchLike; connect: MqttConnect }): ActualSourceFactory[] {
  return [createEcoflowFactory(deps)];
}

export function findActualSource(list: ActualSourceFactory[], id: string): ActualSourceFactory {
  const f = list.find(x => x.id === id);
  if (!f) throw new Error(`Невідоме джерело фактичного стану: ${id}`);
  return f;
}
