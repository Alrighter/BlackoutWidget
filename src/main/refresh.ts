import type { Address, AppState, RefreshPhase, ScheduleSnapshot } from '../shared/types';
import { CaptchaRequiredError } from './providers/types';
import type { ScheduleProvider } from './providers/types';
import type { AppStore } from './store';

export class RefreshService {
  private phase: RefreshPhase = 'idle';
  private lastError: string | undefined;
  private listeners = new Set<(s: AppState) => void>();
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly deps: { store: AppStore; getProvider(id: string): ScheduleProvider }) {}

  getState(): AppState {
    const settings = this.deps.store.getSettings();
    const snapshot = this.deps.store.getSnapshot();
    const a = settings.address;
    const lineChanged = !!a && !!snapshot && snapshot.lines[a.lineIndex - 1]?.groupId !== a.groupId;
    const state: AppState = { settings, snapshot, phase: this.phase, lineChanged };
    if (this.lastError !== undefined) state.lastError = this.lastError;
    return state;
  }

  onState(cb: (s: AppState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** true = success or nothing to do (no address). Never runs two requests in parallel. */
  refresh(): Promise<boolean> {
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

  private async runLoop(): Promise<boolean> {
    for (;;) {
      const r = await this.doRefresh();
      if (r !== 'stale') return r;
    }
  }

  private async doRefresh(): Promise<boolean | 'stale'> {
    const address = this.deps.store.getSettings().address;
    if (!address) {
      this.phase = 'idle';
      this.lastError = undefined;
      this.emit();
      return true;
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
      return true;
    }
    this.phase = error instanceof CaptchaRequiredError ? 'captcha' : 'error';
    this.lastError = error instanceof Error ? error.message : String(error);
    this.emit();
    return false;
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
