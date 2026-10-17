export type Slot = 'on' | 'off' | 'maybe-off' | 'unknown';
export interface DaySchedule { date: string /* YYYY-MM-DD Kyiv */; slots: Slot[] /* 48 */ }
export interface LineInfo { index: number; groupId: string; label: string }
/** `outageActive`: the source reports a current outage for the house, so its `lines` may list only the affected queues. */
export interface HouseInfo { house: string; lines: LineInfo[]; outageActive: boolean }
export interface Address { providerId: string; city: string; street: string; house: string; lineIndex: number; groupId: string }
/** `groups`: the queues the outage applies to (DTEK `sub_type_reason` while an outage is active); empty/absent = unknown. */
export interface CurrentOutage { kind: 'emergency' | 'other'; text: string; start?: string; end?: string; groups?: string[] }
export interface ScheduleSnapshot {
  providerId: string; address: Address; groupId: string; groupLabel: string;
  days: DaySchedule[]; sourceUpdatedAt?: string; fetchedAt: string /* ISO */;
  lines: LineInfo[]; currentOutage?: CurrentOutage;
  /** The source reported a current outage for the house: `lines` then lists the outage's queues, not the house's. */
  outageActive?: boolean;
}
export type WidgetStyle = 'compact' | 'ring' | 'timeline';
export interface WidgetPosition { x: number; y: number; displayId: number }
export interface Settings { address: Address | null; widgetStyle: WidgetStyle; autostart: boolean; widgetPosition: WidgetPosition | null }
export type RefreshPhase = 'idle' | 'refreshing' | 'ok' | 'error' | 'captcha';
export interface AppState { settings: Settings; snapshot: ScheduleSnapshot | null; phase: RefreshPhase; lastError?: string; lineChanged: boolean }
export type WidgetBackground = { kind: 'image'; dataUrl: string } | { kind: 'tint' };
export type EcoflowRegion = 'eu' | 'us';
