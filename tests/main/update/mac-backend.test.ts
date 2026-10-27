import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateInfo } from 'electron-updater';
import type { Logger } from '../../../src/main/log';
import { MacBackend, type MacBackendDeps } from '../../../src/main/update/mac-backend';
import { HELPER_SCRIPT } from '../../../src/main/update/mac-helper';
import type { UpdaterLike } from '../../../src/main/update/updater';

const ZIP = Buffer.from('PK fake zip '.repeat(5000));
const ZIP_NAME = 'Blackout-Widget-1.0.2-arm64.zip';
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('base64');

const infoFor = (o: { sha?: string; size?: number } = {}): UpdateInfo => ({
  version: '1.0.2', releaseDate: '2026-10-27T00:00:00.000Z', path: ZIP_NAME, sha512: sha512(ZIP),
  files: [
    { url: ZIP_NAME, sha512: o.sha ?? sha512(ZIP), size: o.size ?? ZIP.length },
    { url: 'Blackout-Widget-1.0.2-arm64.dmg', sha512: 'x', size: 1 },
  ],
}) as UpdateInfo;

/** A body in 4 chunks; `failAfter` errors the stream once that many chunks have gone out. */
function body(data: Buffer, failAfter?: number): ReadableStream<Uint8Array> {
  const step = Math.ceil(data.length / 4); let i = 0;
  return new ReadableStream({
    pull(c) {
      if (failAfter !== undefined && i === failAfter) { c.error(new Error('ECONNRESET')); return; }
      if (i * step >= data.length) { c.close(); return; }
      c.enqueue(new Uint8Array(data.subarray(i * step, (i + 1) * step))); i++;
    },
  });
}

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = false; autoInstallOnAppQuit = false; allowDowngrade = false; logger: unknown = null;
  setFeedURL = vi.fn(); downloadUpdate = vi.fn(async () => []); quitAndInstall = vi.fn();
  checkForUpdates = vi.fn<UpdaterLike['checkForUpdates']>(async () => ({ isUpdateAvailable: true, updateInfo: infoFor() }));
}

/**
 * A backend over real temp dirs. The fake `ditto` unpacks a `<appName>` whose plist `plutil` reads as `plistVersion`;
 * every command is recorded.
 */
function setup(o: { appName?: string; plistVersion?: string; response?: () => Response; exePath?: string; stallMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bw-mac-'));
  const tempDir = join(root, 'tmp'); mkdirSync(tempDir);
  const apps = join(root, 'Applications'); mkdirSync(apps);
  const commands: string[][] = [];
  const updater = new FakeUpdater();
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: MacBackendDeps = {
    updater, feed: '', tempDir, pid: 4242,
    exePath: o.exePath ?? join(apps, 'Blackout Widget.app', 'Contents', 'MacOS', 'Blackout Widget'),
    helperLog: join(root, 'userData', 'logs', 'update-helper.log'),
    fetch: vi.fn(async () => (o.response ? o.response() : new Response(body(ZIP)))),
    exec: vi.fn(async (cmd: string, args: string[]) => {
      commands.push([cmd, ...args]);
      if (cmd === 'ditto') mkdirSync(join(args[3], o.appName ?? 'Blackout Widget.app', 'Contents'), { recursive: true });
      if (cmd === 'plutil') return `${o.plistVersion ?? '1.0.2'}\n`;
      return '';
    }),
    spawnDetached: vi.fn(), quit: vi.fn(), openExternal: vi.fn(), log,
    ...(o.stallMs === undefined ? {} : { stallMs: o.stallMs }),
  };
  const versionDir = join(tempDir, 'blackout-widget-update', '1.0.2');
  return { b: new MacBackend(deps), deps, updater, commands, versionDir, apps, root };
}

test('check returns the newer version from the feed and keeps its info', async () => {
  const { b, updater } = setup();
  await expect(b.check()).resolves.toBe('1.0.2');
  updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: false, updateInfo: infoFor() });
  await expect(b.check()).resolves.toBeNull();
});

test('download streams the zip, reports percent, verifies, unpacks, checks the plist version, clears quarantine', async () => {
  const { b, deps, commands, versionDir } = setup();
  await b.check();
  const seen: number[] = [];
  await b.download('1.0.2', p => seen.push(p));
  expect(deps.fetch).toHaveBeenCalledWith(`https://github.com/Alrighter/BlackoutWidget/releases/download/v1.0.2/${ZIP_NAME}`, { signal: expect.any(AbortSignal) });
  expect(seen.at(-1)).toBe(100);
  expect(seen.length).toBeGreaterThan(1);
  const appDir = join(versionDir, 'app'); const app = join(appDir, 'Blackout Widget.app');
  expect(commands).toEqual([
    ['ditto', '-x', '-k', join(versionDir, ZIP_NAME), appDir],
    ['plutil', '-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')],
    ['xattr', '-dr', 'com.apple.quarantine', app],
  ]);
  expect(existsSync(app)).toBe(true);
});

test('a quarantine attribute that can\'t be cleared is only logged', async () => {
  const { b, deps } = setup();
  vi.mocked(deps.exec).mockImplementation(async (cmd, args) => {
    if (cmd === 'ditto') mkdirSync(join(args[3], 'Blackout Widget.app', 'Contents'), { recursive: true });
    if (cmd === 'plutil') return '1.0.2';
    if (cmd === 'xattr') throw new Error('xattr: no such xattr');
    return '';
  });
  await b.check();
  await expect(b.download('1.0.2', () => {})).resolves.toBeUndefined();
  expect(deps.log.warn).toHaveBeenCalled();
});

test('a wrong sha512 rejects before unpacking and removes the download', async () => {
  const { b, updater, commands, versionDir } = setup();
  updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: infoFor({ sha: sha512(Buffer.from('other')) }) });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow(/sha512/);
  expect(commands).toEqual([]);
  expect(existsSync(versionDir)).toBe(false);
});

test('a size that differs from the feed rejects', async () => {
  const { b, updater, versionDir } = setup();
  updater.checkForUpdates.mockResolvedValueOnce({ isUpdateAvailable: true, updateInfo: infoFor({ size: ZIP.length + 1 }) });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow(/size/);
  expect(existsSync(versionDir)).toBe(false);
});

test('a 404 rejects', async () => {
  const { b, commands, versionDir } = setup({ response: () => new Response('Not Found', { status: 404 }) });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow(/404/);
  expect(commands).toEqual([]);
  expect(existsSync(versionDir)).toBe(false);
});

test('a stream that errors mid-body rejects and leaves no partial file', async () => {
  const { b, commands, versionDir } = setup({ response: () => new Response(body(ZIP, 2)) });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow('ECONNRESET');
  expect(commands).toEqual([]);
  expect(existsSync(versionDir)).toBe(false);
});

test('a zip with another app name rejects', async () => {
  const { b, versionDir } = setup({ appName: 'Other.app' });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow(/Blackout Widget\.app/);
  expect(existsSync(versionDir)).toBe(false);
});

test('a plist version that differs rejects', async () => {
  const { b, versionDir } = setup({ plistVersion: '1.0.1' });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow(/1\.0\.1/);
  expect(existsSync(versionDir)).toBe(false);
});

test('a download of a version the last check did not find rejects', async () => {
  const { b, deps } = setup();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow();
  await b.check();
  await expect(b.download('1.0.3', () => {})).rejects.toThrow();
  expect(deps.fetch).not.toHaveBeenCalled();
});

test('canInstall: true for a .app in a writable folder, false outside a .app', () => {
  expect(setup().b.canInstall()).toBe(true);
  const { b } = setup({ exePath: join(tmpdir(), 'bw-dev', 'node_modules', 'electron', 'dist', 'electron') });
  expect(b.canInstall()).toBe(false);
});

test.skipIf(process.platform === 'win32')('canInstall: false when the bundle\'s folder is not writable', () => {
  const { b, apps } = setup();
  chmodSync(apps, 0o555);
  try {
    expect(b.canInstall()).toBe(false);
  } finally {
    chmodSync(apps, 0o755);
  }
});

test('install writes the helper, spawns /bin/sh with pid, bundle, staged app and log, then quits', async () => {
  const { b, deps, versionDir, apps } = setup();
  await b.check();
  await b.download('1.0.2', () => {});
  await b.install();
  const script = join(deps.tempDir, 'blackout-widget-update', 'swap.sh');
  expect(readFileSync(script, 'utf8')).toBe(HELPER_SCRIPT);
  expect(deps.spawnDetached).toHaveBeenCalledWith('/bin/sh', [
    script, '4242', join(apps, 'Blackout Widget.app'), join(versionDir, 'app', 'Blackout Widget.app'), deps.helperLog,
  ]);
  expect(deps.quit).toHaveBeenCalledTimes(1);
});

test('install before a download rejects and does not quit', async () => {
  const { b, deps } = setup();
  await expect(b.install()).rejects.toThrow();
  expect(deps.spawnDetached).not.toHaveBeenCalled();
  expect(deps.quit).not.toHaveBeenCalled();
});

test('a new download clears what an earlier one left', async () => {
  const { b, deps } = setup();
  const stale = join(deps.tempDir, 'blackout-widget-update', '1.0.1');
  mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, 'old.zip'), 'x');
  await b.check();
  await b.download('1.0.2', () => {});
  expect(readdirSync(join(deps.tempDir, 'blackout-widget-update'))).toEqual(['1.0.2']);
});

test('openManual opens the release page', () => {
  const { b, deps } = setup();
  b.openManual('1.0.2');
  expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/Alrighter/BlackoutWidget/releases/tag/v1.0.2');
});

/** One chunk, then silence: a connection that stalls (mobile data) instead of failing. */
function stalls(data: Buffer): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(c) {
      if (sent) return new Promise<void>(() => {});
      sent = true; c.enqueue(new Uint8Array(data.subarray(0, 1000)));
    },
  });
}

test('a download that stalls fails after the stall time and leaves no partial file', async () => {
  const { b, commands, versionDir } = setup({ response: () => new Response(stalls(ZIP)), stallMs: 50 });
  await b.check();
  await expect(b.download('1.0.2', () => {})).rejects.toThrow(/stalled/);
  expect(commands).toEqual([]);
  expect(existsSync(versionDir)).toBe(false);
});

test('the fetch gets an abort signal for the stall', async () => {
  const { b, deps } = setup();
  await b.check();
  await b.download('1.0.2', () => {});
  expect(vi.mocked(deps.fetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});
