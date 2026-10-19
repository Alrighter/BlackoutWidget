import type { BleProblem } from './ecoflow-ble';
import type {
  ActualPower, Address, AppState, DaySchedule, EcoflowRegion, HouseInfo, LineInfo, WidgetBackground, WidgetStyle,
} from './types';

export const IPC = {
  getState: 'state:get', state: 'state:changed', background: 'widget:background',
  listProviders: 'providers:list', listCities: 'addr:cities', listStreets: 'addr:streets', listHouses: 'addr:houses',
  previewLines: 'addr:preview-lines', saveAddress: 'settings:address', setWidgetStyle: 'settings:style',
  setAutostart: 'settings:autostart', refreshNow: 'refresh:now', solveCaptcha: 'captcha:solve',
  openMainWindow: 'window:open-main', widgetContextMenu: 'widget:context-menu', widgetDrag: 'widget:drag', navigate: 'window:navigate',
  widgetMoveMode: 'widget:move-mode', widgetMoveDone: 'widget:move-done',
  ecoflowTest: 'actual:ecoflow-test', ecoflowPreview: 'actual:ecoflow-preview', ecoflowSave: 'actual:ecoflow-save',
  actualDisconnect: 'actual:disconnect', openEcoflowHelp: 'actual:ecoflow-help', openDtekSite: 'addr:dtek-site',
} as const;

/** Message of the Error that main-process handlers throw when the source asks for a captcha (class is lost over IPC). */
export const CAPTCHA_MARKER = 'CAPTCHA_REQUIRED';

export type MainView = 'schedule' | 'settings' | 'setup';

/** Keys or the account travel renderer → main only in these calls; no result ever carries them back. */
export type EcoflowInput =
  | { mode: 'keys'; region: EcoflowRegion; accessKey: string; secretKey: string }
  | { mode: 'account'; region: EcoflowRegion; email: string; password: string };
export interface EcoflowDeviceView { sn: string; label: string; online: boolean }
export type EcoflowTestResult = { ok: true; devices: EcoflowDeviceView[] } | { ok: false; error: string };
export type EcoflowPreviewResult =
  | { ok: true; online: boolean; power: ActualPower; detail?: string; reason?: string; unsupported?: boolean }
  | { ok: false; error: string };
/** The live line of the Bluetooth source: link state plus the latest values the station has sent (absent = not sent yet). */
export interface ActualLive {
  link: 'searching' | 'connecting' | 'connected' | 'refused' | 'stalled' | 'unsupported' | Exclude<BleProblem, 'scan-failed'>;
  acInVolts?: number; acInHz?: number; inputWatts?: number; acOut?: boolean; soc?: number; invSilent?: boolean;
}
export type ActionResult = { ok: true } | { ok: false; error: string };

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
  /** Main process asks the open main window to switch its in-app view. */
  onNavigate(cb: (view: MainView) => void): () => void;
  widgetContextMenu(): void;
  widgetDrag(phase: 'start' | 'move' | 'end', screenX: number, screenY: number): void;
  /** Main switches the widget in/out of move mode (frame + «Готово» button). */
  onMoveMode(cb: (on: boolean) => void): () => void;
  /** The widget's «Готово» button: save the position and pin the widget again. */
  endMoveMode(): void;
  ecoflowTest(i: EcoflowInput): Promise<EcoflowTestResult>;
  /**
   * Keys: HTTP only, so it spends none of the account's daily clientIds. Account: one short MQTT session with a
   * throw-away clientId, signed in with the check's session when it is fresh (no HTTP call gives the readings).
   */
  ecoflowPreview(i: EcoflowInput, sn: string): Promise<EcoflowPreviewResult>;
  ecoflowSave(i: EcoflowInput, device: { sn: string; label: string }): Promise<ActionResult>;
  /** Forgets the source and its keys; the history and the clientId stay. */
  actualDisconnect(): Promise<void>;
  /** Opens the EcoFlow developer site (a fixed address) in the browser. */
  openEcoflowHelp(): void;
  /** Opens the DTEK outage schedule page (a fixed address) in the browser (D11). */
  openDtekSite(): void;
}

declare global { interface Window { api: RendererApi } }
