import { CancellationToken } from 'electron-updater';
import type { Logger } from '../log';
import { DOWNLOAD_STALL_MS, type UpdateBackend } from './backend';
import { releasePage } from './feed';
import { checkNewer, type UpdaterLike } from './updater';

/**
 * electron-updater's NSIS updater: the per-user oneClick installer runs silently and starts the app again. It is
 * unsigned and there is no publisherName, so no Authenticode check; the download is verified by the sha512 in
 * latest.yml.
 */
export class WinBackend implements UpdateBackend {
  constructor(
    private readonly u: UpdaterLike, private readonly openExternal: (url: string) => void, private readonly log: Logger,
    private readonly stallMs = DOWNLOAD_STALL_MS,
  ) {}

  async check(): Promise<string | null> {
    return (await checkNewer(this.u))?.version ?? null;
  }

  canInstall(): boolean {
    return true;
  }

  openManual(version: string): void {
    this.openExternal(releasePage(version));
  }

  /** Cancelled after `stallMs` without a progress event; electron-updater then removes the partial file. */
  async download(_version: string, onProgress: (percent: number) => void): Promise<void> {
    const token = new CancellationToken();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => { clearTimeout(timer); timer = setTimeout(() => token.cancel(), this.stallMs); };
    const progress = (p: { percent: number }): void => { arm(); onProgress(p.percent); };
    this.u.on('download-progress', progress);
    arm();
    try {
      await this.u.downloadUpdate(token);
    } catch (err) {
      if (token.cancelled) throw new Error(`the download stalled: no data for ${this.stallMs / 1000} s`, { cause: err });
      throw err;
    } finally {
      clearTimeout(timer);
      this.u.off('download-progress', progress);
      token.dispose();
    }
  }

  /**
   * quitAndInstall reports a failure to start only as an error event: one during the call means the app keeps
   * running. One after it (the installer's spawn failing while the app quits) is logged.
   */
  async install(): Promise<void> {
    let failed: Error | null = null;
    const during = (e: Error): void => { failed ??= e; };
    this.u.on('error', during);
    try {
      this.u.quitAndInstall(true, true);
    } finally {
      this.u.off('error', during);
    }
    if (failed) throw failed;
    this.u.on('error', e => this.log.error('update: the installer failed to start', e));
  }
}
