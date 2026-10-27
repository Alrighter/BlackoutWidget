import type { UpdateInfo } from 'electron-updater';
import type { Logger } from '../log';
import { feedConfig, type FeedConfig } from './feed';

/** What both backends use of electron-updater's AppUpdater (tests pass a fake). */
export interface UpdaterLike {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowDowngrade: boolean; logger: unknown;
  setFeedURL(options: FeedConfig): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: UpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', cb: (p: { percent: number }) => void): unknown;
  on(event: 'error', cb: (e: Error) => void): unknown;
  off(event: 'download-progress', cb: (p: { percent: number }) => void): unknown;
  off(event: 'error', cb: (e: Error) => void): unknown;
}

/** Only on the click, never in the background or on quit; never an older version. */
export function configureUpdater(u: UpdaterLike, log: Logger, feed: string): void {
  u.autoDownload = false;
  u.autoInstallOnAppQuit = false;
  u.allowDowngrade = false;
  u.logger = {
    info: (m: unknown) => log.info(`updater: ${String(m)}`),
    warn: (m: unknown) => log.warn(`updater: ${String(m)}`),
    error: (m: unknown) => log.error(`updater: ${String(m)}`),
  };
  // Each error event also rejects the call it belongs to, and that call's caller logs it. Without a listener
  // EventEmitter would throw it instead, as an unhandled rejection where nobody waits.
  u.on('error', () => {});
  u.setFeedURL(feedConfig(feed));
}

/** The update info when the feed has a newer version, else null. */
export async function checkNewer(u: UpdaterLike): Promise<UpdateInfo | null> {
  const result = await u.checkForUpdates();
  return result?.isUpdateAvailable ? result.updateInfo : null;
}
