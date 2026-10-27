import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { UpdateInfo } from 'electron-updater';
import type { Logger } from '../log';
import { DOWNLOAD_STALL_MS, type UpdateBackend } from './backend';
import { downloadBase, releasePage } from './feed';
import { HELPER_SCRIPT, helperArgs } from './mac-helper';
import { checkNewer, type UpdaterLike } from './updater';

export interface MacBackendDeps {
  updater: UpdaterLike; feed: string; exePath: string; tempDir: string; helperLog: string; pid: number;
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  /** Stdout; rejects on a non-zero exit. */
  exec(cmd: string, args: string[]): Promise<string>;
  spawnDetached(cmd: string, args: string[]): void;
  quit(): void; openExternal(url: string): void; log: Logger;
  /** Tests shorten it; DOWNLOAD_STALL_MS otherwise. */
  stallMs?: number;
}

const APP_NAME = 'Blackout Widget.app';

/**
 * macOS: Squirrel.Mac refuses an ad-hoc signed app, so electron-updater only checks latest-mac.yml. This downloads the
 * release's zip, verifies its size and sha512 against the yml, unpacks it with ditto and checks the bundle's version.
 * The swap itself is the helper's (mac-helper.ts), after the app has quit. Until then the running app is untouched.
 */
export class MacBackend implements UpdateBackend {
  private info: UpdateInfo | null = null;
  private staged: string | null = null;

  constructor(private readonly d: MacBackendDeps) {}

  async check(): Promise<string | null> {
    this.info = await checkNewer(this.d.updater);
    return this.info?.version ?? null;
  }

  /** A `.app` whose folder this user can write: not the mounted dmg, not a dev run. */
  canInstall(): boolean {
    const bundle = this.bundle();
    if (!bundle.endsWith('.app')) return false;
    try {
      accessSync(dirname(bundle), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  openManual(version: string): void {
    this.d.openExternal(releasePage(version));
  }

  async download(version: string, onProgress: (percent: number) => void): Promise<void> {
    const info = this.info;
    if (info?.version !== version) throw new Error(`the feed did not offer ${version}`);
    const file = info.files.find(f => f.url.endsWith('.zip'));
    if (!file) throw new Error(`latest-mac.yml of ${version} lists no zip`);
    this.staged = null;
    // Whatever an earlier download left (a failed one, or a staged app the helper has since moved) goes first.
    rmSync(this.root(), { recursive: true, force: true });
    const dir = join(this.root(), version);
    mkdirSync(dir, { recursive: true });
    try {
      const zip = join(dir, basename(file.url));
      await this.fetchVerified(downloadBase(this.d.feed, version) + file.url, zip, file.size, file.sha512, onProgress);
      const appDir = join(dir, 'app');
      mkdirSync(appDir);
      await this.d.exec('ditto', ['-x', '-k', zip, appDir]);
      rmSync(zip, { force: true });
      const entries = readdirSync(appDir);
      if (entries.length !== 1 || entries[0] !== APP_NAME) throw new Error(`the zip holds ${entries.join(', ') || 'nothing'}, not ${APP_NAME}`);
      const app = join(appDir, APP_NAME);
      const plist = join(app, 'Contents', 'Info.plist');
      const got = (await this.d.exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist])).trim();
      if (got !== version) throw new Error(`the unpacked app is ${got}, not ${version}`);
      try {
        await this.d.exec('xattr', ['-dr', 'com.apple.quarantine', app]);
      } catch (err) {
        this.d.log.warn('update: could not clear the quarantine attribute', err);
      }
      this.staged = app;
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async install(): Promise<void> {
    if (!this.staged) throw new Error('no update has been downloaded');
    const script = join(this.root(), 'swap.sh');
    writeFileSync(script, HELPER_SCRIPT, { mode: 0o755 });
    this.d.spawnDetached('/bin/sh', [
      script, ...helperArgs({ pid: this.d.pid, bundle: this.bundle(), staged: this.staged, log: this.d.helperLog }),
    ]);
    this.d.quit();
  }

  /** `<bundle>/Contents/MacOS/<exe>`, three levels up. */
  private bundle(): string {
    return resolve(this.d.exePath, '../../..');
  }

  private root(): string {
    return join(this.d.tempDir, 'blackout-widget-update');
  }

  private async fetchVerified(
    url: string, file: string, size: number | undefined, sha512: string, onProgress: (percent: number) => void,
  ): Promise<void> {
    // No data for stallMs (before the headers or mid-body) aborts the request and the write.
    const stallMs = this.d.stallMs ?? DOWNLOAD_STALL_MS;
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error(`the download stalled: no data for ${stallMs / 1000} s`)), stallMs);
    };
    const hash = createHash('sha512');
    let received = 0;
    arm();
    try {
      const res = await this.d.fetch(url, { signal: stall.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const total = size ?? Number(res.headers.get('content-length') ?? 0);
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            arm();
            hash.update(chunk);
            received += chunk.length;
            if (total > 0) onProgress(Math.min(100, (received / total) * 100));
            yield chunk;
          }
        },
        createWriteStream(file),
        { signal: stall.signal },
      );
    } catch (err) {
      throw stall.signal.aborted ? stall.signal.reason : err;
    } finally {
      clearTimeout(timer);
    }
    if (size !== undefined && received !== size) throw new Error(`the download is ${received} bytes, the feed's size is ${size}`);
    if (hash.digest('base64') !== sha512) throw new Error(`the download's sha512 differs from the feed's`);
  }
}
