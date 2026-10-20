import { ipcMain } from 'electron';
import { CAPTCHA_MARKER, IPC, type ActualLive, type MainView } from '../shared/ipc';
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
  solveCaptcha(providerId?: string): Promise<void>;
  widgetDrag(phase: DragPhase, screenX: number, screenY: number): void;
  widgetContextMenu(): void;
  /** The widget's «Готово» button. */
  endMoveMode(): void;
  actualActions: ActualActions;
  openEcoflowHelp(): void;
  /** The wizard's «Відкрити графік на сайті …» (D11): the address is looked up by provider id, the renderer never passes a URL. */
  openProviderSite(providerId: string): void;
  /** The saved settings, read on each call. */
  getSettings(): Settings;
  /** The Bluetooth link's live line; asked only while the saved source is `ecoflow-ble`. */
  bleLive: { getLive(): ActualLive | null };
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
  handle(IPC.solveCaptcha, (providerId?: unknown) => deps.solveCaptcha(typeof providerId === 'string' ? providerId : undefined));
  handle(IPC.ecoflowTest, (i: unknown) => deps.actualActions.test(i));
  // Nothing from the renderer is passed on.
  handle(IPC.ecoflowScan, () => deps.actualActions.scan());
  handle(IPC.ecoflowPreview, (i: unknown, sn: unknown) => deps.actualActions.preview(i, sn));
  handle(IPC.ecoflowSave, (i: unknown, device: unknown) => deps.actualActions.save(i, device));
  handle(IPC.actualDisconnect, () => deps.actualActions.disconnect());
  handle(IPC.getActualLive, () => (deps.getSettings().actualSource?.id === 'ecoflow-ble' ? deps.bleLive.getLive() : null));

  ipcMain.on(IPC.openMainWindow, (_e, view?: MainView) => deps.openMainWindow(view));
  ipcMain.on(IPC.widgetContextMenu, () => deps.widgetContextMenu());
  ipcMain.on(IPC.widgetDrag, (_e, phase: unknown, x: unknown, y: unknown) => {
    if (isDragPhase(phase) && isCoord(x) && isCoord(y)) deps.widgetDrag(phase, x, y);
  });
  ipcMain.on(IPC.widgetMoveDone, () => deps.endMoveMode());
  ipcMain.on(IPC.openEcoflowHelp, () => deps.openEcoflowHelp());
  ipcMain.on(IPC.openProviderSite, (_e, providerId: unknown) => { if (typeof providerId === 'string') deps.openProviderSite(providerId); });
}

export function broadcastState(state: AppState, targets: StateTarget[]): void {
  for (const t of targets) t.send(IPC.state, state);
}

export const LIVE_PUSH_MS = 1_000;

/**
 * The live line's push to one window: a value goes out at once when the last send is LIVE_PUSH_MS old, otherwise the
 * latest one goes out when it is, so the window always ends on the last value (null included). `dispose` drops a
 * pending send and its timer.
 */
export function throttleLive(target: StateTarget, ms = LIVE_PUSH_MS): { push(live: ActualLive | null): void; dispose(): void } {
  let sentAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Boxed, so that a pending null is told apart from nothing pending.
  let pending: { live: ActualLive | null } | null = null;
  let disposed = false;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { live } = pending;
    pending = null;
    sentAt = Date.now();
    target.send(IPC.actualLive, live);
  };
  return {
    push(live) {
      if (disposed) return;
      pending = { live };
      if (timer !== null) return;
      // At most `ms`: a clock set back would otherwise put the last send in the future and hold the line that long.
      const wait = Math.min(sentAt + ms - Date.now(), ms);
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    dispose() {
      disposed = true;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
