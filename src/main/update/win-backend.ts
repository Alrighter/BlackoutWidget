import type { Logger } from '../log';
import type { UpdateBackend } from './backend';
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

  async download(_version: string, onProgress: (percent: number) => void): Promise<void> {
    const progress = (p: { percent: number }): void => onProgress(p.percent);
    this.u.on('download-progress', progress);
    try {
      await this.u.downloadUpdate();
    } finally {
      this.u.off('download-progress', progress);
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
