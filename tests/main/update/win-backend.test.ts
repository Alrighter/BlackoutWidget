import { EventEmitter } from 'node:events';
import type { UpdateInfo } from 'electron-updater';
import type { Logger } from '../../../src/main/log';
import type { FeedConfig } from '../../../src/main/update/feed';
import { configureUpdater, type UpdaterLike } from '../../../src/main/update/updater';
import { WinBackend } from '../../../src/main/update/win-backend';

const info = (version: string): UpdateInfo =>
  ({ version, files: [], path: '', sha512: '', releaseDate: '2026-10-27T00:00:00.000Z' }) as UpdateInfo;

/** electron-updater's AppUpdater as far as the backends use it: an EventEmitter with the four calls as spies. */
class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true; autoInstallOnAppQuit = true; allowDowngrade = true; logger: unknown = null;
  setFeedURL = vi.fn<(o: FeedConfig) => void>();
  checkForUpdates = vi.fn<UpdaterLike['checkForUpdates']>(async () => null);
  downloadUpdate = vi.fn<() => Promise<unknown>>(async () => []);
  quitAndInstall = vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>();
}

const logger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

test('configureUpdater sets no auto download, no install on quit, no downgrade, the feed, and a logger that writes to log', () => {
  const u = new FakeUpdater(); const log = logger();
  configureUpdater(u, log, '');
  expect([u.autoDownload, u.autoInstallOnAppQuit, u.allowDowngrade]).toEqual([false, false, false]);
  expect(u.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'Alrighter', repo: 'BlackoutWidget' });
  (u.logger as Logger).warn('x');
  expect(log.warn).toHaveBeenCalledWith('updater: x');
  (u.logger as Logger).error('y');
  expect(log.error).toHaveBeenCalledWith('updater: y');

  const t = new FakeUpdater();
  configureUpdater(t, log, 'https://example.test/feed');
  expect(t.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://example.test/feed' });
});

test('an error event never throws: the call it belongs to rejects and its caller logs it', () => {
  const u = new FakeUpdater();
  configureUpdater(u, logger(), '');
  expect(() => u.emit('error', new Error('boom'))).not.toThrow();
});

test('check returns the newer version or null; a rejection propagates', async () => {
  const u = new FakeUpdater(); const b = new WinBackend(u, vi.fn(), logger());
  u.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: info('1.0.2') });
  await expect(b.check()).resolves.toBe('1.0.2');
  u.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: info('1.0.0') });
  await expect(b.check()).resolves.toBeNull();
  u.checkForUpdates.mockResolvedValueOnce(null);
  await expect(b.check()).resolves.toBeNull();
  u.checkForUpdates.mockRejectedValueOnce(new Error('rate limited'));
  await expect(b.check()).rejects.toThrow('rate limited');
});

test('download forwards download-progress percents and removes its listener afterwards', async () => {
  const u = new FakeUpdater(); const b = new WinBackend(u, vi.fn(), logger());
  u.downloadUpdate.mockImplementationOnce(async () => {
    u.emit('download-progress', { percent: 12.5 }); u.emit('download-progress', { percent: 100 }); return [];
  });
  const seen: number[] = [];
  await b.download('1.0.2', p => seen.push(p));
  expect(seen).toEqual([12.5, 100]);
  expect(u.listenerCount('download-progress')).toBe(0);

  u.downloadUpdate.mockRejectedValueOnce(new Error('ECONNRESET'));
  await expect(b.download('1.0.2', () => {})).rejects.toThrow('ECONNRESET');
  expect(u.listenerCount('download-progress')).toBe(0);
});

test('install calls quitAndInstall(true, true)', async () => {
  const u = new FakeUpdater(); const b = new WinBackend(u, vi.fn(), logger());
  await b.install();
  expect(u.quitAndInstall).toHaveBeenCalledWith(true, true);
});

test('install rejects when the updater reports it could not start the installer', async () => {
  const u = new FakeUpdater(); const b = new WinBackend(u, vi.fn(), logger());
  u.quitAndInstall.mockImplementationOnce(() => { u.emit('error', new Error('No valid update available')); });
  await expect(b.install()).rejects.toThrow('No valid update available');
});

test('an installer error after the quit has started reaches the log', async () => {
  const u = new FakeUpdater(); const log = logger(); const b = new WinBackend(u, vi.fn(), log);
  await b.install();
  u.emit('error', new Error('spawn EPERM'));
  expect(log.error).toHaveBeenCalledWith('update: the installer failed to start', expect.any(Error));
});

test('canInstall is true; openManual opens releasePage(version)', () => {
  const open = vi.fn(); const b = new WinBackend(new FakeUpdater(), open, logger());
  expect(b.canInstall()).toBe(true);
  b.openManual('1.0.2');
  expect(open).toHaveBeenCalledWith('https://github.com/Alrighter/BlackoutWidget/releases/tag/v1.0.2');
});
