import { createEcoflowAppFactory, createEcoflowBleFactory, createEcoflowFactory } from './ecoflow';
import type { FetchLike } from './ecoflow/api';
import type { BleLinkLike } from './ecoflow/ble/link';
import type { MqttConnect } from './ecoflow/source';
import type { ActualSourceFactory } from './types';

export function createActualSources(deps: { fetch: FetchLike; connect: MqttConnect; ble: BleLinkLike }): ActualSourceFactory[] {
  return [createEcoflowFactory(deps), createEcoflowAppFactory(deps), createEcoflowBleFactory(deps)];
}

export function findActualSource(list: ActualSourceFactory[], id: string): ActualSourceFactory {
  const f = list.find(x => x.id === id);
  if (!f) throw new Error(`Невідоме джерело фактичного стану: ${id}`);
  return f;
}
