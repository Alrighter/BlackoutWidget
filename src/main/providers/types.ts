import type { Address, HouseInfo, ScheduleSnapshot } from '../../shared/types';

/** Shown when the source could not be reached at all (also the message of NetworkError). */
export const OFFLINE_MESSAGE = 'Немає з’єднання з сайтом ДТЕК';

export class ProviderError extends Error {}
/** The request never reached the source (no connection): retried on quick backoff, not bound by the 5-min floor. */
export class NetworkError extends ProviderError {}
export class CaptchaRequiredError extends Error {}

export interface PageSession {
  ensureReady(): Promise<void>; // throws CaptchaRequiredError on timeout
  evaluate<T>(js: string): Promise<T>;
  reload(): Promise<void>;
  showForUser(): Promise<void>; // shows the window, resolves when the page is ready again
  dispose(): void;
}

export interface ScheduleProvider {
  id: string;
  displayName: string;
  listCities(): Promise<string[]>;
  listStreets(city: string): Promise<string[]>;
  listHouses(city: string, street: string): Promise<HouseInfo[]>;
  fetchSnapshot(address: Address): Promise<ScheduleSnapshot>;
  showVerification(): Promise<void>;
  dispose(): void;
}
