import type { Address, AppState, DaySchedule, HouseInfo, LineInfo, WidgetBackground, WidgetStyle } from './types';

export const IPC = {
  getState: 'state:get', state: 'state:changed', background: 'widget:background',
  listProviders: 'providers:list', listCities: 'addr:cities', listStreets: 'addr:streets', listHouses: 'addr:houses',
  previewLines: 'addr:preview-lines', saveAddress: 'settings:address', setWidgetStyle: 'settings:style',
  setAutostart: 'settings:autostart', refreshNow: 'refresh:now', solveCaptcha: 'captcha:solve',
  openMainWindow: 'window:open-main', widgetContextMenu: 'widget:context-menu', widgetDrag: 'widget:drag',
} as const;

export type MainView = 'schedule' | 'settings' | 'setup';

export interface RendererApi {
  getState(): Promise<AppState>;
  onState(cb: (s: AppState) => void): () => void;
  onBackground(cb: (b: WidgetBackground) => void): () => void;
  listProviders(): Promise<{ id: string; displayName: string }[]>;
  listCities(providerId: string): Promise<string[]>;
  listStreets(providerId: string, city: string): Promise<string[]>;
  listHouses(providerId: string, city: string, street: string): Promise<HouseInfo[]>;
  previewLines(providerId: string, city: string, street: string, house: string): Promise<{ line: LineInfo; today: DaySchedule | null }[]>;
  saveAddress(a: Address): Promise<void>;
  setWidgetStyle(s: WidgetStyle): Promise<void>;
  setAutostart(on: boolean): Promise<void>;
  refreshNow(): Promise<void>;
  solveCaptcha(): Promise<void>;
  openMainWindow(view?: MainView): void;
  widgetContextMenu(): void;
  widgetDrag(phase: 'start' | 'move' | 'end', screenX: number, screenY: number): void;
}

declare global { interface Window { api: RendererApi } }
