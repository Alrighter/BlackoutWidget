export const INTERVAL_MS = 15 * 60_000, JITTER_MS = 60_000, MIN_GAP_MS = 5 * 60_000;
export const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
import type { Location } from '../shared/types';

export const STAGGER_MS = 30_000;
export type TriggerReason = 'resume' | 'online' | 'manual';
/**
 * 'ok' — success (or nothing to do); 'failed' — the attempt reached the source and failed (bound by the 5-min floor);
 * 'offline' — the source was never reached (no connection): plain quick backoff.
 */
export type RunOutcome = 'ok' | 'failed' | 'offline';

export class RefreshScheduler {
  private readonly random: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private lastStart: number | null = null;
  private lastOutcome: RunOutcome | null = null;
  private failures = 0;
  private running = false;
  private active = false;

  constructor(private readonly run: () => Promise<RunOutcome>, deps: { random?: () => number } = {}) {
    this.random = deps.random ?? Math.random;
  }

  start(delayMs = 0): void {
    if (this.active) return;
    this.active = true;
    this.schedule(delayMs);
  }

  trigger(reason: TriggerReason): void {
    if (!this.active || this.running) return;
    const now = Date.now();
    if (reason === 'manual') return this.schedule(0);
    // Coming back online right after a failure that never reached the source: nothing to protect, go now.
    const skipGap = reason === 'online' && this.lastOutcome === 'offline';
    const earliest = this.lastStart === null || skipGap ? now : this.lastStart + MIN_GAP_MS;
    const target = Math.max(now, earliest);
    if (this.timer === null || target < this.dueAt) this.schedule(target - now);
  }

  stop(): void {
    this.active = false;
    this.clear();
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    this.clear();
    this.dueAt = Date.now() + delay;
    this.timer = setTimeout(() => void this.execute(), delay);
  }

  private async execute(): Promise<void> {
    this.timer = null;
    if (!this.active || this.running) return;
    this.running = true;
    const started = Date.now();
    this.lastStart = started;
    let outcome: RunOutcome;
    // A throwing run is a bug, not a known offline state: treat it as having reached the source.
    try { outcome = await this.run(); } catch { outcome = 'failed'; }
    this.running = false;
    this.lastOutcome = outcome;
    if (!this.active) return;
    if (outcome === 'ok') {
      this.failures = 0;
      this.schedule(INTERVAL_MS + (this.random() * 2 - 1) * JITTER_MS);
      return;
    }
    this.failures++;
    const backoff = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
    // Anything that reached the source never runs again automatically within MIN_GAP_MS of its start.
    this.schedule(outcome === 'failed' ? Math.max(backoff, started + MIN_GAP_MS - Date.now()) : backoff);
  }
}

/** First-run delay per location: the n-th location on one provider waits n * step, so one source is never hit all at once. */
export function startDelays(locations: Location[], step = STAGGER_MS): Map<string, number> {
  const seen = new Map<string, number>();
  const delays = new Map<string, number>();
  for (const l of locations) {
    const n = seen.get(l.address.providerId) ?? 0;
    seen.set(l.address.providerId, n + 1);
    delays.set(l.id, n * step);
  }
  return delays;
}
