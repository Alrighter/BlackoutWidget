import type { UpdateStatus } from '../../shared/types';
import type { Logger } from '../log';
import { UpdateController } from './controller';
import { UPDATE_FEED } from './feed';
import { MacBackend, type MacBackendDeps } from './mac-backend';
import { configureUpdater, type UpdaterLike } from './updater';
import { WinBackend } from './win-backend';

/** The update controller over this platform's backend; null where the app has no updater (Linux dev runs). */
export function createUpdates(o: {
  platform: NodeJS.Platform; log: Logger; onChange(s: UpdateStatus): void; updater: UpdaterLike;
  mac: Omit<MacBackendDeps, 'updater' | 'feed' | 'log'>; openExternal(url: string): void;
}): UpdateController | null {
  const { platform, log, updater } = o;
  if (platform !== 'win32' && platform !== 'darwin') return null;
  configureUpdater(updater, log, UPDATE_FEED);
  const backend = platform === 'win32'
    ? new WinBackend(updater, o.openExternal, log)
    : new MacBackend({ ...o.mac, updater, feed: UPDATE_FEED, log });
  return new UpdateController({ backend, log, onChange: o.onChange });
}
