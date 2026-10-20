import type { Address, HouseInfo, LineInfo, ScheduleSnapshot } from '../../shared/types';

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
  isOnline(): boolean; // the OS-level connectivity hint (electron net.isOnline())
  showForUser(): Promise<void>; // shows the window, resolves when the page is ready again
  dispose(): void;
}

export interface ScheduleProvider {
  id: string;
  displayName: string;
  listCities(): Promise<string[]>;
  listStreets(city: string): Promise<string[]>;
  listHouses(city: string, street: string): Promise<HouseInfo[]>;
  /** Sources whose `listHouses` marks houses `linesPending` give the picked house's lines here (one request per house). */
  houseLines?(city: string, street: string, house: string): Promise<LineInfo[]>;
  fetchSnapshot(address: Address): Promise<ScheduleSnapshot>;
  showVerification(): Promise<void>;
  dispose(): void;
}
