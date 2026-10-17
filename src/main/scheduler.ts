export const INTERVAL_MS = 15 * 60_000, JITTER_MS = 60_000, MIN_GAP_MS = 5 * 60_000;
export const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
export type TriggerReason = 'resume' | 'online' | 'manual';

export class RefreshScheduler {
  private readonly random: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private lastStart: number | null = null;
  private failures = 0;
  private running = false;
  private active = false;

  constructor(private readonly run: () => Promise<boolean>, deps: { random?: () => number } = {}) {
    this.random = deps.random ?? Math.random;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule(0);
  }

  trigger(reason: TriggerReason): void {
    if (!this.active || this.running) return;
    const now = Date.now();
    if (reason === 'manual') return this.schedule(0);
    const earliest = this.lastStart === null ? now : this.lastStart + MIN_GAP_MS;
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
    this.lastStart = Date.now();
    let ok = false;
    try { ok = await this.run(); } catch { ok = false; }
    this.running = false;
    if (!this.active) return;
    if (ok) {
      this.failures = 0;
      this.schedule(INTERVAL_MS + (this.random() * 2 - 1) * JITTER_MS);
    } else {
      this.failures++;
      this.schedule(BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)]);
    }
  }
}
