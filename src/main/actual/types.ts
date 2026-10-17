import type { Logger } from '../log';
import type { ActualPower, ActualSourceConfig } from '../../shared/types';

export interface ActualReading { power: ActualPower; observedAt: string; reason?: string; detail?: string }
export interface ActualStateSource { start(onReading: (r: ActualReading) => void): void; stop(): void }
export interface ActualSourceFactory {
  id: string;
  displayName: string;
  create(config: ActualSourceConfig, secrets: Record<string, string>, ctx: { clientId: string; log: Logger }): ActualStateSource;
}
