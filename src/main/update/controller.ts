import type { UpdateStatus } from '../../shared/types';
import type { Logger } from '../log';
import type { UpdateBackend } from './backend';

/** After the first schedule refresh has had its turn. */
export const FIRST_CHECK_DELAY_MS = 120_000;
export const CHECK_INTERVAL_MS = 21_600_000;

/**
 * The update's state machine and its schedule. Checks are quiet: a failure is one warning in the log and the next
 * interval tries again. Only a click (install) downloads; while a download or an install runs, nothing else does.
 */
export class UpdateController {
  private current: UpdateStatus = { phase: 'idle' };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: { backend: UpdateBackend; log: Logger; onChange(s: UpdateStatus): void }) {}

  start(): void {
    this.stop();
    const tick = (): void => {
      this.timer = setTimeout(tick, CHECK_INTERVAL_MS);
      void this.check();
    };
    this.timer = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): UpdateStatus {
    return this.current;
  }

  /** Never rejects. In `error` only a different (newer) version replaces the error mark. */
  async check(): Promise<void> {
    if (this.busy()) return;
    let version: string | null;
    try {
      version = await this.deps.backend.check();
    } catch (err) {
      this.deps.log.warn('update check failed', err);
      return;
    }
    if (this.busy()) return;
    const s = this.current;
    if (version === null) this.set({ phase: 'idle' });
    else if (!(s.phase === 'error' && s.version === version)) this.set({ phase: 'available', version });
  }

  /** The click. Never rejects: a failure becomes `error`, and the app keeps running. */
  async install(): Promise<void> {
    const s = this.current;
    if (s.phase !== 'available' && s.phase !== 'error') return;
    const { version } = s;
    const { backend, log } = this.deps;
    if (!backend.canInstall()) {
      log.info(`update ${version}: this copy can't replace itself; opening the release page`);
      backend.openManual(version);
      return;
    }
    this.set({ phase: 'downloading', version, percent: 0 });
    try {
      await backend.download(version, p => {
        const percent = Math.min(100, Math.max(0, Math.round(p)));
        const now = this.current;
        if (now.phase === 'downloading' && now.percent !== percent) this.set({ phase: 'downloading', version, percent });
      });
    } catch (err) {
      log.error(`update ${version}: download failed`, err);
      this.set({ phase: 'error', version });
      return;
    }
    this.set({ phase: 'installing', version });
    try {
      await backend.install();
    } catch (err) {
      log.error(`update ${version}: install failed to start`, err);
      this.set({ phase: 'error', version });
    }
  }

  private busy(): boolean {
    return this.current.phase === 'downloading' || this.current.phase === 'installing';
  }

  private set(next: UpdateStatus): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    this.deps.onChange(next);
  }
}
