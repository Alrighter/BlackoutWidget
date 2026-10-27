import type { UpdateStatus } from '../../shared/types';
import type { Logger } from '../log';
import { UpdateController } from './controller';
import { UPDATE_FEED } from './feed';
import { MacBackend, type MacBackendDeps } from './mac-backend';
import { configureUpdater, type UpdaterLike } from './updater';
import { WinBackend } from './win-backend';

/** What node's spawn returns, as far as the helper's start uses it. */
interface SpawnedLike { pid?: number; unref(): void; on(event: 'error', cb: (err: Error) => void): unknown }

/**
 * MacBackendDeps.spawnDetached: the swap helper in its own session, outliving the app. Throws when it did not start,
 * so install() fails before the app quits and the running app stays.
 */
export function detachedSpawner(
  spawn: (cmd: string, args: string[], o: { detached: true; stdio: 'ignore' }) => SpawnedLike, log: Logger,
): (cmd: string, args: string[]) => void {
  return (cmd, args) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', err => log.error('update: the swap helper failed', err));
    if (child.pid === undefined) throw new Error(`the swap helper did not start (${cmd})`);
    child.unref();
  };
}

/** The update controller over this platform's backend; null where the app has no updater (Linux dev runs). */
export function createUpdates(o: {
  platform: NodeJS.Platform; log: Logger; onChange(s: UpdateStatus): void; updater: UpdaterLike;
  mac: Omit<MacBackendDeps, 'updater' | 'feed' | 'log'>; openExternal(url: string): void;
}): UpdateController | null {
  const { platform, log, updater } = o;
  if (platform !== 'win32' && platform !== 'darwin') return null;
  log.info(`update feed: ${UPDATE_FEED || 'GitHub releases of Alrighter/BlackoutWidget'}`);
  configureUpdater(updater, log, UPDATE_FEED);
  const backend = platform === 'win32'
    ? new WinBackend(updater, o.openExternal, log)
    : new MacBackend({ ...o.mac, updater, feed: UPDATE_FEED, log });
  return new UpdateController({ backend, log, onChange: o.onChange });
}
