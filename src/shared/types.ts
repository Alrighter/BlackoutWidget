export type Slot = 'on' | 'off' | 'maybe-off' | 'unknown';
export interface DaySchedule { date: string /* YYYY-MM-DD Kyiv */; slots: Slot[] /* 48 */ }
export interface LineInfo { index: number; groupId: string; label: string }
export interface HouseInfo { house: string; lines: LineInfo[] }
export interface Address { providerId: string; city: string; street: string; house: string; lineIndex: number; groupId: string }
export interface CurrentOutage { kind: 'emergency' | 'other'; text: string; start?: string; end?: string }
export interface ScheduleSnapshot {
  providerId: string; address: Address; groupId: string; groupLabel: string;
  days: DaySchedule[]; sourceUpdatedAt?: string; fetchedAt: string /* ISO */;
  lines: LineInfo[]; currentOutage?: CurrentOutage;
}
export type WidgetStyle = 'compact' | 'ring' | 'timeline';
export interface WidgetPosition { x: number; y: number; displayId: number }
export interface Settings { address: Address | null; widgetStyle: WidgetStyle; autostart: boolean; widgetPosition: WidgetPosition | null }
export type RefreshPhase = 'idle' | 'refreshing' | 'ok' | 'error' | 'captcha';
export interface AppState { settings: Settings; snapshot: ScheduleSnapshot | null; phase: RefreshPhase; lastError?: string; lineChanged: boolean }
export type WidgetBackground = { kind: 'image'; dataUrl: string } | { kind: 'tint' };
