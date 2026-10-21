import type { AppState, Location, Settings } from '../shared/types';
import { guardedKeyed, type Keyed } from './keyed';

/** What the runtime asks of a widget's window. */
export interface PlaceableWindow { refit(): void; sync(): void; show(): void }

export interface LocationRuntimeDeps<S, W extends { window: PlaceableWindow }> {
  log: { error(message: string, err?: unknown): void };
  /** Builds a location's scheduler and starts it, its first run `delayMs` away. */
  createScheduler(id: string, delayMs: number): S;
  disposeScheduler(scheduler: S, id: string): void;
  /** Builds a location's widget; it is refit and shown by the reconcile that built it. */
  createWidget(id: string): W;
  disposeWidget(widget: W, id: string): void;
  /** The boot stagger: each location's first-run delay (scheduler.ts `startDelays`). */
  startDelays(locations: Location[]): Map<string, number>;
  /** True once the app is quitting: the widgets have closed for good. */
  quitting(): boolean;
}

/**
 * One scheduler and one widget per location, kept in step with the settings by `reconcile` (main calls it on every
 * publish). A location that reads again (a file locked at login) gets them back; a deleted one is gone for good,
 * since its id is gone from the file. A create that threw is tried again by the next reconcile.
 */
export class LocationRuntime<S, W extends { window: PlaceableWindow }> {
  /** Set by the first reconcile with real settings (the boot); each location's delay is used once. */
  private bootDelays: Map<string, number> | null = null;
  /** The widgets the running reconcile built and has not refit yet. */
  private readonly unplaced = new Set<string>();
  private readonly schedulerSet: Keyed<S | null>;
  private readonly widgetSet: Keyed<W | null>;

  constructor(private readonly deps: LocationRuntimeDeps<S, W>) {
    this.schedulerSet = guardedKeyed<S>(deps.log, 'scheduler', id => {
      // Taken before the create: a create that throws and is tried again later starts at once.
      const delay = this.bootDelays?.get(id) ?? 0;
      this.bootDelays?.delete(id);
      return deps.createScheduler(id, delay);
    }, (scheduler, id) => deps.disposeScheduler(scheduler, id));
    this.widgetSet = guardedKeyed<W>(deps.log, 'widget', id => {
      const widget = deps.createWidget(id);
      this.unplaced.add(id);
      return widget;
    }, (widget, id) => {
      this.unplaced.delete(id);
      deps.disposeWidget(widget, id);
    });
  }

  /**
   * Only real settings drive the schedulers and widgets: before the first successful read the store's fallback has
   * no locations, and that must neither build nor dispose anything. Nothing is built once the app is quitting.
   */
  reconcile(state: Pick<AppState, 'settings' | 'settingsLoaded'>): void {
    if (!state.settingsLoaded || this.deps.quitting()) return;
    const locations = state.settings.locations;
    this.bootDelays ??= this.deps.startDelays(locations);
    const ids = locations.map(l => l.id);
    this.schedulerSet.sync(ids);
    this.widgetSet.sync(ids);
    // A widget's constructor sees none of the siblings built in the same sync. So the new ones refit now, in
    // location order: a widget whose display is gone takes a free spot clear of every sibling, before its window
    // is built there.
    for (const [id, w] of this.liveWidgets()) {
      if (this.unplaced.delete(id)) this.safely(`widget: refit failed for location ${id}`, () => w.window.refit());
    }
    for (const [id, w] of this.liveWidgets()) {
      this.safely(`widget: could not be shown for location ${id}`, () => { w.window.sync(); w.window.show(); });
    }
  }

  scheduler(id: string): S | undefined { return this.schedulerSet.get(id) ?? undefined; }
  /** The schedulers that were built, in location order. */
  schedulers(): S[] { return this.schedulerSet.values().flatMap(s => (s === null ? [] : [s])); }
  widget(id: string): W | undefined { return this.widgetSet.get(id) ?? undefined; }
  /** The widgets that were built, in location order. */
  widgets(): W[] { return this.liveWidgets().map(([, w]) => w); }

  /** At quit: the widgets (each with its glass updater and pinner), then the schedulers. */
  clear(): void {
    this.widgetSet.clear();
    this.schedulerSet.clear();
  }

  private liveWidgets(): [string, W][] {
    return this.widgetSet.ids().flatMap(id => {
      const w = this.widgetSet.get(id);
      return w ? [[id, w] as [string, W]] : [];
    });
  }

  private safely(what: string, fn: () => void): void {
    try { fn(); } catch (err) { this.deps.log.error(what, err); }
  }
}

/**
 * Only a settings file that was read and has no locations is a new install: a locked one shows its note instead.
 * `settingsLoaded` is read after `getSettings()`, which is the read it reports on.
 */
export function opensSetupAtBoot(store: { getSettings(): Settings; readonly settingsLoaded: boolean }): boolean {
  const settings = store.getSettings();
  return store.settingsLoaded && settings.locations.length === 0;
}
