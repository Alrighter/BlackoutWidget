export type Slot = 'on' | 'off' | 'maybe-off' | 'unknown';
export interface DaySchedule { date: string /* YYYY-MM-DD Kyiv */; slots: Slot[] /* 48 */ }
export interface LineInfo { index: number; groupId: string; label: string }
/** `outageActive`: the source reports a current outage for the house, so its `lines` may list only the affected queues. */
export interface HouseInfo {
  house: string; lines: LineInfo[]; outageActive: boolean;
  /** `lines` is not final: the source gives a house's lines only through `houseLines`, asked once the house is picked. */
  linesPending?: boolean;
  /** The source's own word on this house; the wizard shows it in place of the empty-lines note. */
  note?: string;
}
export interface Address { providerId: string; city: string; street: string; house: string; lineIndex: number; groupId: string }
/** `groups`: the queues the outage applies to (DTEK `sub_type_reason` while an outage is active); empty/absent = unknown. */
export interface CurrentOutage { kind: 'emergency' | 'planned' | 'other'; text: string; start?: string; end?: string; groups?: string[] }
export interface ScheduleSnapshot {
  providerId: string; address: Address; groupId: string; groupLabel: string;
  days: DaySchedule[]; sourceUpdatedAt?: string; fetchedAt: string /* ISO */;
  lines: LineInfo[]; currentOutage?: CurrentOutage;
  /** The source reported a current outage for the house: `lines` then lists the outage's queues, not the house's. */
  outageActive?: boolean;
  /** Shown under today's schedule only (a «quiet day»: the company published no schedule for today). */
  note?: string;
}
export type WidgetStyle = 'compact' | 'ring' | 'timeline';
export interface WidgetPosition { x: number; y: number; displayId: number }
export interface Settings {
  address: Address | null; widgetStyle: WidgetStyle; autostart: boolean; widgetPosition: WidgetPosition | null;
  actualSource: ActualSourceConfig | null; ecoflowClientId?: string;
  /** 32 upper-case hex characters, made once on the first account save; the middle of the app MQTT clientId. */
  ecoflowAppClientUuid?: string;
}
export type RefreshPhase = 'idle' | 'refreshing' | 'ok' | 'error' | 'captcha';
export interface AppState { settings: Settings; snapshot: ScheduleSnapshot | null; phase: RefreshPhase; lastError?: string; lineChanged: boolean; actual?: ActualStatus | null }
export type WidgetBackground = { kind: 'image'; dataUrl: string } | { kind: 'tint' };
export type EcoflowRegion = 'eu' | 'us';
export type ActualPower = 'on' | 'off' | 'unknown';
export interface ActualSegment { power: ActualPower; start: string; end?: string; startApprox?: boolean }
export interface ActualStatus {
  sourceLabel: string; power: ActualPower; since?: string; sinceApprox?: boolean;
  observedAt?: string; reason?: string; detail?: string;
  /** Segments of the last 7 days in time order; the last one is open (no `end`). */
  history: ActualSegment[];
}
export type ActualSourceConfig =
  | { id: 'ecoflow'; region: EcoflowRegion; deviceSn: string; deviceName: string; accessKeyHint: string }
  | { id: 'ecoflow-app'; region: EcoflowRegion; deviceSn: string; deviceName: string; accountHint: string }
  | { id: 'ecoflow-ble'; region: EcoflowRegion; deviceSn: string; deviceName: string; accountHint: string };
