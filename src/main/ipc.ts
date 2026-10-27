import { ipcMain, type WebContents } from 'electron';
import { CAPTCHA_MARKER, IPC, type ActualLive, type MainView } from '../shared/ipc';
import { kyivDateKey } from '../shared/time';
import type { AppState, DaySchedule, LineInfo, Settings, WidgetState } from '../shared/types';
import type { ActualActions } from './actual/actions';
import type { LocationActions } from './location-actions';
import { findProvider } from './providers/registry';
import { CaptchaRequiredError, type ScheduleProvider } from './providers/types';

/** What a widget's IPC may do: only to the widget that owns the calling window. */
export interface WidgetCalls {
  locationId: string;
  drag(phase: DragPhase, screenX: number, screenY: number): void;
  contextMenu(): void;
  /** The widget's «Готово» button. */
  endMoveMode(): void;
}

export interface IpcDeps {
  providers: ScheduleProvider[];
  /** The main window's state: every location, plus the actual-power status. A widget asking gets null. */
  getState(): AppState;
  /** One widget's state, or null for a location that is gone. */
  getWidgetState(locationId: string): WidgetState | null;
  /** Persists the patch, applies side effects (autostart) and republishes state. */
  updateSettings(patch: Partial<Omit<Settings, 'locations'>>): void;
  /** The main window's location calls; they check every argument themselves and throw what the window shows. */
  locations: LocationActions;
  /** Manual trigger: one location's scheduler, or every one without an id. */
  refresh(id?: string): void;
  /** The widget whose window sent the call, if any: a location id the widget renderer sends is never trusted. */
  widgets: { find(sender: WebContents): WidgetCalls | undefined };
  openMainWindow(view?: MainView, locationId?: string): void;
  /** Shows the given provider's verification window (else a location's; none without locations) and refreshes afterwards. */
  solveCaptcha(providerId?: string): Promise<void>;
  actualActions: ActualActions;
  openEcoflowHelp(): void;
  /** The wizard's «Відкрити графік на сайті …» (D11): the address is looked up by provider id, the renderer never passes a URL. */
  openProviderSite(providerId: string): void;
  /** The saved settings, read on each call. */
  getSettings(): Settings;
  /** The Bluetooth link's live line; asked only while the saved source is `ecoflow-ble`. */
  bleLive: { getLive(): ActualLive | null };
  /** The update button's click; never rejects (a failure is the error state). Nothing without an updater. */
  installUpdate(): Promise<void>;
}

/** One of the app's own windows; the hidden DTEK session window never gets app state. */
export interface StateTarget { send(channel: string, payload: unknown): void }

type DragPhase = 'start' | 'move' | 'end';

const isDragPhase = (v: unknown): v is DragPhase => v === 'start' || v === 'move' || v === 'end';
const isCoord = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isView = (v: unknown): v is MainView => v === 'schedule' || v === 'settings' || v === 'setup';

/** The house's lines: the provider's own answer when it has one, else the house's entry in the list. */
export async function houseLinesOf(provider: ScheduleProvider, city: string, street: string, house: string): Promise<LineInfo[]> {
  if (provider.houseLines) return provider.houseLines(city, street, house);
  return (await provider.listHouses(city, street)).find(h => h.house === house)?.lines ?? [];
}

export async function previewLines(
  provider: ScheduleProvider, city: string, street: string, house: string, now = new Date(),
): Promise<{ line: LineInfo; today: DaySchedule | null }[]> {
  const lines = await houseLinesOf(provider, city, street, house);
  const today = kyivDateKey(now);
  const out: { line: LineInfo; today: DaySchedule | null }[] = [];
  for (const line of lines) {
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
  // A widget's calls keep the event: the widget is the one that owns the sender.
  const widgetOf = (e: { sender: WebContents }) => deps.widgets.find(e.sender);

  // Every location's data, so the main window's only: a widget never receives another location's snapshot.
  ipcMain.handle(IPC.getState, e => (widgetOf(e) ? null : deps.getState()));
  ipcMain.handle(IPC.widgetGetState, e => {
    const widget = widgetOf(e);
    return widget ? deps.getWidgetState(widget.locationId) : null;
  });
  handle(IPC.listProviders, () => deps.providers.map(p => ({ id: p.id, displayName: p.displayName })));
  handle(IPC.listCities, (id: string) => markCaptcha(provider(id).listCities()));
  handle(IPC.listStreets, (id: string, city: string) => markCaptcha(provider(id).listStreets(city)));
  handle(IPC.listHouses, (id: string, city: string, street: string) => markCaptcha(provider(id).listHouses(city, street)));
  handle(IPC.houseLines, (id: string, city: string, street: string, house: string) =>
    markCaptcha(houseLinesOf(provider(id), city, street, house)));
  handle(IPC.previewLines, (id: string, city: string, street: string, house: string) =>
    markCaptcha(previewLines(provider(id), city, street, house)));
  // The location actions check what the window sends (ids, names, addresses, styles), so it goes on unchanged.
  handle(IPC.addLocation, (input: unknown) => { deps.locations.add(input); });
  handle(IPC.editLocation, (id: unknown, input: unknown) => deps.locations.edit(id, input));
  handle(IPC.renameLocation, (id: unknown, name: unknown) => deps.locations.rename(id, name));
  handle(IPC.deleteLocation, (id: unknown) => deps.locations.remove(id));
  handle(IPC.setWidgetStyle, (id: unknown, style: unknown) => deps.locations.setStyle(id, style));
  handle(IPC.setActualLocation, (id: unknown) => deps.locations.setActualLocation(id));
  handle(IPC.setAutostart, (on: boolean) => deps.updateSettings({ autostart: !!on }));
  handle(IPC.refreshNow, (id?: unknown) => deps.refresh(typeof id === 'string' ? id : undefined));
  handle(IPC.solveCaptcha, (providerId?: unknown) => deps.solveCaptcha(typeof providerId === 'string' ? providerId : undefined));
  handle(IPC.ecoflowTest, (i: unknown) => deps.actualActions.test(i));
  // Nothing from the renderer is passed on.
  handle(IPC.ecoflowScan, () => deps.actualActions.scan());
  handle(IPC.ecoflowPreview, (i: unknown, sn: unknown) => deps.actualActions.preview(i, sn));
  handle(IPC.ecoflowSave, (i: unknown, device: unknown) => deps.actualActions.save(i, device));
  handle(IPC.actualDisconnect, () => deps.actualActions.disconnect());
  handle(IPC.getActualLive, () => (deps.getSettings().actualSource?.id === 'ecoflow-ble' ? deps.bleLive.getLive() : null));
  // The main window's button only: a widget has none.
  ipcMain.handle(IPC.installUpdate, async e => { if (!widgetOf(e)) await deps.installUpdate(); });

  ipcMain.on(IPC.openMainWindow, (e, view?: unknown) => {
    const widget = widgetOf(e);
    // A widget's click opens the schedule on its own location; the main window keeps its selection.
    if (widget) deps.openMainWindow('schedule', widget.locationId);
    else deps.openMainWindow(isView(view) ? view : undefined, undefined);
  });
  ipcMain.on(IPC.widgetContextMenu, e => widgetOf(e)?.contextMenu());
  ipcMain.on(IPC.widgetDrag, (e, phase: unknown, x: unknown, y: unknown) => {
    if (isDragPhase(phase) && isCoord(x) && isCoord(y)) widgetOf(e)?.drag(phase, x, y);
  });
  ipcMain.on(IPC.widgetMoveDone, e => widgetOf(e)?.endMoveMode());
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
