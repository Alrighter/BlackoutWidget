import type { Address, AppState, RefreshPhase, ScheduleSnapshot } from '../shared/types';
import { CaptchaRequiredError, NetworkError } from './providers/types';
import type { ScheduleProvider } from './providers/types';
import type { RunOutcome } from './scheduler';
import type { AppStore } from './store';

export class RefreshService {
  private phase: RefreshPhase = 'idle';
  private lastError: string | undefined;
  private listeners = new Set<(s: AppState) => void>();
  private inFlight: Promise<RunOutcome> | null = null;

  constructor(private readonly deps: { store: AppStore; getProvider(id: string): ScheduleProvider }) {}

  getState(): AppState {
    const settings = this.deps.store.getSettings();
    const a = settings.address;
    // A snapshot cached for another address must never be shown as this one's schedule.
    const stored = this.deps.store.getSnapshot();
    const snapshot = stored && sameAddress(a, stored.address) ? stored : null;
    // During a reported outage the source lists only the outage's queues, so a missing queue proves nothing then.
    const lineChanged = !!a && !!snapshot && !snapshot.outageActive && !snapshot.lines.some(l => l.groupId === a.groupId);
    const state: AppState = { settings, snapshot, phase: this.phase, lineChanged };
    if (this.lastError !== undefined) state.lastError = this.lastError;
    return state;
  }

  onState(cb: (s: AppState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * 'ok' = success or nothing to do (no address); 'offline' = the source was never reached (NetworkError);
   * 'failed' = any other failure. Never runs two requests in parallel.
   */
  refresh(): Promise<RunOutcome> {
    if (this.inFlight) return this.inFlight;
    const p = this.runLoop().finally(() => { this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  async setAddress(a: Address): Promise<void> {
    this.deps.store.updateSettings({ address: a });
    this.deps.store.setSnapshot(null);
    this.lastError = undefined;
    // Joins an in-flight run if any; that run notices the address changed and refetches.
    await this.refresh();
  }

  private async runLoop(): Promise<RunOutcome> {
    for (;;) {
      const r = await this.doRefresh();
      if (r !== 'stale') return r;
    }
  }

  private async doRefresh(): Promise<RunOutcome | 'stale'> {
    const address = this.deps.store.getSettings().address;
    if (!address) {
      this.phase = 'idle';
      this.lastError = undefined;
      this.emit();
      return 'ok';
    }
    this.phase = 'refreshing';
    this.emit();
    let snapshot: ScheduleSnapshot | undefined;
    let error: unknown;
    try {
      snapshot = await this.deps.getProvider(address.providerId).fetchSnapshot(address);
    } catch (err) {
      error = err;
    }
    if (!sameAddress(this.deps.store.getSettings().address, address)) return 'stale';
    if (snapshot) {
      this.deps.store.setSnapshot(snapshot);
      this.phase = 'ok';
      this.lastError = undefined;
      this.emit();
      return 'ok';
    }
    this.phase = error instanceof CaptchaRequiredError ? 'captcha' : 'error';
    this.lastError = error instanceof Error ? error.message : String(error);
    this.emit();
    return error instanceof NetworkError ? 'offline' : 'failed';
  }

  private emit(): void {
    const s = this.getState();
    for (const cb of [...this.listeners]) {
      try { cb(s); } catch (err) { console.error('RefreshService listener failed', err); }
    }
  }
}

function sameAddress(a: Address | null, b: Address): boolean {
  return !!a && a.providerId === b.providerId && a.city === b.city && a.street === b.street
    && a.house === b.house && a.lineIndex === b.lineIndex && a.groupId === b.groupId;
}
