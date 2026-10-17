import type { Address, HouseInfo, ScheduleSnapshot } from '../../shared/types';

export class ProviderError extends Error {}
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
