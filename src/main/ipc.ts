import { BrowserWindow, ipcMain } from 'electron';
import { IPC, type MainView } from '../shared/ipc';
import { kyivDateKey } from '../shared/time';
import type { Address, AppState, DaySchedule, LineInfo, Settings, WidgetStyle } from '../shared/types';
import { findProvider } from './providers/registry';
import type { ScheduleProvider } from './providers/types';
import type { TriggerReason } from './scheduler';

export interface IpcDeps {
  providers: ScheduleProvider[];
  service: { getState(): AppState; setAddress(a: Address): Promise<void> };
  scheduler: { trigger(reason: TriggerReason): void };
  /** Persists the patch, applies side effects (autostart) and republishes state. */
  updateSettings(patch: Partial<Settings>): void;
  openMainWindow(view?: MainView): void;
}

const STYLES: WidgetStyle[] = ['compact', 'ring', 'timeline'];

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

export function registerIpc(deps: IpcDeps): void {
  const provider = (id: string) => findProvider(deps.providers, id);
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle(IPC.getState, () => deps.service.getState());
  handle(IPC.listProviders, () => deps.providers.map(p => ({ id: p.id, displayName: p.displayName })));
  handle(IPC.listCities, (id: string) => provider(id).listCities());
  handle(IPC.listStreets, (id: string, city: string) => provider(id).listStreets(city));
  handle(IPC.listHouses, (id: string, city: string, street: string) => provider(id).listHouses(city, street));
  handle(IPC.previewLines, (id: string, city: string, street: string, house: string) =>
    previewLines(provider(id), city, street, house));
  handle(IPC.saveAddress, (a: Address) => deps.service.setAddress(a));
  handle(IPC.setWidgetStyle, (s: WidgetStyle) => {
    if (!STYLES.includes(s)) throw new Error(`Невідомий стиль: ${String(s)}`);
    deps.updateSettings({ widgetStyle: s });
  });
  handle(IPC.setAutostart, (on: boolean) => deps.updateSettings({ autostart: !!on }));
  handle(IPC.refreshNow, () => deps.scheduler.trigger('manual'));
  handle(IPC.solveCaptcha, async () => {
    const address = deps.service.getState().settings.address;
    if (!address) return;
    await provider(address.providerId).showVerification();
    deps.scheduler.trigger('manual');
  });

  ipcMain.on(IPC.openMainWindow, (_e, view?: MainView) => deps.openMainWindow(view));
  // Widget window (context menu, dragging) is wired in Task 10.
  ipcMain.on(IPC.widgetContextMenu, () => {});
  ipcMain.on(IPC.widgetDrag, () => {});
}

export function broadcastState(state: AppState): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.state, state);
  }
}
