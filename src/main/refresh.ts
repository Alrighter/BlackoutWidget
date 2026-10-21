import { sameAddress } from '../shared/locations';
import type { LocationState, RefreshPhase } from '../shared/types';
import { CaptchaRequiredError, NetworkError } from './providers/types';
import type { ScheduleProvider } from './providers/types';
import type { RunOutcome } from './scheduler';
import type { AppStore } from './store';

interface Progress { phase: RefreshPhase; lastError?: string }

export class RefreshService {
  private progress = new Map<string, Progress>();
  private inFlight = new Map<string, Promise<RunOutcome>>();
  private listeners = new Set<() => void>();

  constructor(private readonly deps: { store: AppStore; getProvider(id: string): ScheduleProvider }) {}

  /** One entry per location, in settings order. `actual` is not set here: main adds it for the EcoFlow location. */
  getStates(): LocationState[] {
    return this.deps.store.getSettings().locations.map(location => {
      const a = location.address;
      // A snapshot cached for another address must never be shown as this one's schedule.
      const stored = this.deps.store.getSnapshot(location.id);
      const snapshot = stored && sameAddress(a, stored.address) ? stored : null;
      // During a reported outage the source lists only the outage's queues, so a missing queue proves nothing then.
      const lineChanged = !!snapshot && !snapshot.outageActive && !snapshot.lines.some(l => l.groupId === a.groupId);
      const p = this.progress.get(location.id);
      const state: LocationState = { location, snapshot, phase: p?.phase ?? 'idle', lineChanged };
      if (p?.lastError !== undefined) state.lastError = p.lastError;
      return state;
    });
  }

  /** Called when any location's state changed; read the new state with getStates(). */
  onState(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * 'ok' = success or nothing to do (no such location); 'offline' = the source was never reached (NetworkError);
   * 'failed' = any other failure. Never runs two requests for one location in parallel.
   */
  refresh(id: string): Promise<RunOutcome> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = this.runLoop(id).finally(() => { this.inFlight.delete(id); });
    this.inFlight.set(id, p);
    return p;
  }

  /** The location's address was just changed in the store: forget what was known for the old one and fetch again. */
  async addressChanged(id: string): Promise<void> {
    try { this.deps.store.setSnapshot(id, null); } catch { /* a snapshot for another address is never shown anyway */ }
    this.progress.delete(id);
    // Joins an in-flight run if any; that run notices the address changed and refetches.
    await this.refresh(id);
  }

  /** The location was deleted. */
  forget(id: string): void {
    this.progress.delete(id);
  }

  private async runLoop(id: string): Promise<RunOutcome> {
    for (;;) {
      const r = await this.doRefresh(id);
      if (r !== 'stale') return r;
    }
  }

  private async doRefresh(id: string): Promise<RunOutcome | 'stale'> {
    const location = this.deps.store.getLocation(id);
    if (!location) return 'ok';
    const address = location.address;
    this.progress.set(id, { phase: 'refreshing' });
    this.emit();
    let snapshot;
    let error: unknown;
    try {
      snapshot = await this.deps.getProvider(address.providerId).fetchSnapshot(address);
    } catch (err) {
      error = err;
    }
    const now = this.deps.store.getLocation(id);
    if (!now) { this.progress.delete(id); return 'ok'; }
    if (!sameAddress(now.address, address)) return 'stale';
    if (snapshot) {
      try {
        this.deps.store.setSnapshot(id, snapshot);
      } catch (err) {
        return this.fail(id, err);
      }
      this.progress.set(id, { phase: 'ok' });
      this.emit();
      return 'ok';
    }
    return this.fail(id, error);
  }

  private fail(id: string, error: unknown): RunOutcome {
    this.progress.set(id, { phase: error instanceof CaptchaRequiredError ? 'captcha' : 'error', lastError: error instanceof Error ? error.message : String(error) });
    this.emit();
    return error instanceof NetworkError ? 'offline' : 'failed';
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch (err) { console.error('RefreshService listener failed', err); }
    }
  }
}
