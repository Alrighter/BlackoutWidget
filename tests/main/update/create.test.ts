import { EventEmitter } from 'node:events';
import type { Logger } from '../../../src/main/log';
import { createUpdates } from '../../../src/main/update';
import { UpdateController } from '../../../src/main/update/controller';
import { MacBackend } from '../../../src/main/update/mac-backend';
import type { UpdaterLike } from '../../../src/main/update/updater';
import { WinBackend } from '../../../src/main/update/win-backend';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true; autoInstallOnAppQuit = true; allowDowngrade = true; logger: unknown = null;
  setFeedURL = vi.fn(); downloadUpdate = vi.fn(async () => []); quitAndInstall = vi.fn();
  checkForUpdates = vi.fn<UpdaterLike['checkForUpdates']>(async () => null);
}

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const mac = {
  exePath: '/Applications/Blackout Widget.app/Contents/MacOS/Blackout Widget', tempDir: '/tmp', helperLog: '/u/logs/update-helper.log', pid: 1,
  fetch: vi.fn(), exec: vi.fn(), spawnDetached: vi.fn(), quit: vi.fn(), openExternal: vi.fn(),
};
const make = (platform: NodeJS.Platform, updater = new FakeUpdater()) =>
  createUpdates({ platform, log, onChange: vi.fn(), updater, mac, openExternal: vi.fn() });

/** The controller's backend, as the controller holds it. */
const backendOf = (c: UpdateController | null) => (c as unknown as { deps: { backend: unknown } }).deps.backend;

test('win32 gives a controller over WinBackend, darwin over MacBackend, linux null', () => {
  const win = make('win32');
  expect(win).toBeInstanceOf(UpdateController);
  expect(backendOf(win)).toBeInstanceOf(WinBackend);
  const darwin = make('darwin');
  expect(darwin).toBeInstanceOf(UpdateController);
  expect(backendOf(darwin)).toBeInstanceOf(MacBackend);
  expect(make('linux')).toBeNull();
});

test('configureUpdater ran with UPDATE_FEED', () => {
  const u = new FakeUpdater();
  make('win32', u);
  expect(u.autoDownload).toBe(false);
  expect(u.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'Alrighter', repo: 'BlackoutWidget' });
});

test('the feed in use is logged once at start', () => {
  vi.mocked(log.info).mockClear();
  make('darwin');
  expect(log.info).toHaveBeenCalledWith('update feed: GitHub releases of Alrighter/BlackoutWidget');
});

test('linux leaves the updater alone', () => {
  const u = new FakeUpdater();
  make('linux', u);
  expect(u.setFeedURL).not.toHaveBeenCalled();
});
