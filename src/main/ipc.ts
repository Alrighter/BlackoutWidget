import { ipcMain } from 'electron';
import { CAPTCHA_MARKER, IPC, type MainView } from '../shared/ipc';
import { kyivDateKey } from '../shared/time';
import type { Address, AppState, DaySchedule, LineInfo, Settings, WidgetStyle } from '../shared/types';
import type { ActualActions } from './actual/actions';
import { findProvider } from './providers/registry';
import { CaptchaRequiredError, type ScheduleProvider } from './providers/types';
import type { TriggerReason } from './scheduler';

export interface IpcDeps {
  providers: ScheduleProvider[];
  service: { setAddress(a: Address): Promise<void> };
  /** The state the windows get: schedule state plus the actual-power status. */
  getState(): AppState;
  scheduler: { trigger(reason: TriggerReason): void };
  /** Persists the patch, applies side effects (autostart) and republishes state. */
  updateSettings(patch: Partial<Settings>): void;
  openMainWindow(view?: MainView): void;
  /** Shows the verification window (saved address's provider, else the first one) and refreshes afterwards. */
  solveCaptcha(): Promise<void>;
  widgetDrag(phase: DragPhase, screenX: number, screenY: number): void;
  widgetContextMenu(): void;
  /** The widget's «Готово» button. */
  endMoveMode(): void;
  actualActions: ActualActions;
  openEcoflowHelp(): void;
}

/** One of the app's own windows; the hidden DTEK session window never gets app state. */
export interface StateTarget { send(channel: string, payload: unknown): void }

type DragPhase = 'start' | 'move' | 'end';

const STYLES: WidgetStyle[] = ['compact', 'ring', 'timeline'];
const isDragPhase = (v: unknown): v is DragPhase => v === 'start' || v === 'move' || v === 'end';
const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export async function previewLines(
  provider: ScheduleProvider, city: string, street: string, house: string, now = new Date(),
): Promise<{ line: LineInfo; today: DaySchedule | null }[]> {
  const info = (await provider.listHouses(city, street)).find(h => h.house === house);
  if (!info) return [];
  const today = kyivDateKey(now);
  const out: { line: LineInfo; today: DaySchedule | null }[] = [];
  for (const line of info.lines) {
    const snap = await provider.fetchSnapshot({
      providerId: provider.id, city, street, house, lineIndex: line.index, groupId: line.groupId,
    });
    out.push({ line, today: snap.days.find(d => d.date === today) ?? null });
  }
  return out;
}

/** Error classes do not survive ipcRenderer.invoke, so a captcha is flagged by its message. */
async function markCaptcha<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    throw e instanceof CaptchaRequiredError ? new Error(CAPTCHA_MARKER) : e;
  }
}

export function registerIpc(deps: IpcDeps): void {
  const provider = (id: string) => findProvider(deps.providers, id);
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle(IPC.getState, () => deps.getState());
  handle(IPC.listProviders, () => deps.providers.map(p => ({ id: p.id, displayName: p.displayName })));
  handle(IPC.listCities, (id: string) => markCaptcha(provider(id).listCities()));
  handle(IPC.listStreets, (id: string, city: string) => markCaptcha(provider(id).listStreets(city)));
  handle(IPC.listHouses, (id: string, city: string, street: string) => markCaptcha(provider(id).listHouses(city, street)));
  handle(IPC.previewLines, (id: string, city: string, street: string, house: string) =>
    markCaptcha(previewLines(provider(id), city, street, house)));
  handle(IPC.saveAddress, (a: Address) => deps.service.setAddress(a));
  handle(IPC.setWidgetStyle, (s: WidgetStyle) => {
    if (!STYLES.includes(s)) throw new Error(`Невідомий стиль: ${String(s)}`);
    deps.updateSettings({ widgetStyle: s });
  });
  handle(IPC.setAutostart, (on: boolean) => deps.updateSettings({ autostart: !!on }));
  handle(IPC.refreshNow, () => deps.scheduler.trigger('manual'));
  handle(IPC.solveCaptcha, () => deps.solveCaptcha());
  handle(IPC.ecoflowTest, (i: unknown) => deps.actualActions.test(i));
  handle(IPC.ecoflowPreview, (i: unknown, sn: unknown) => deps.actualActions.preview(i, sn));
  handle(IPC.ecoflowSave, (i: unknown, device: unknown) => deps.actualActions.save(i, device));
  handle(IPC.actualDisconnect, () => deps.actualActions.disconnect());

  ipcMain.on(IPC.openMainWindow, (_e, view?: MainView) => deps.openMainWindow(view));
  ipcMain.on(IPC.widgetContextMenu, () => deps.widgetContextMenu());
  ipcMain.on(IPC.widgetDrag, (_e, phase: unknown, x: unknown, y: unknown) => {
    if (isDragPhase(phase) && isCoord(x) && isCoord(y)) deps.widgetDrag(phase, x, y);
  });
  ipcMain.on(IPC.widgetMoveDone, () => deps.endMoveMode());
  ipcMain.on(IPC.openEcoflowHelp, () => deps.openEcoflowHelp());
}

export function broadcastState(state: AppState, targets: StateTarget[]): void {
  for (const t of targets) t.send(IPC.state, state);
}
