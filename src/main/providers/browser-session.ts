import { BrowserWindow, session as electronSession } from 'electron';
import { CaptchaRequiredError, ProviderError, type PageSession } from './types';

export interface SessionOptions {
  url: string;
  partition: string;
  readyCheck: string;
  readyTimeoutMs?: number; // default 30000
  /** Only these hosts (and their subdomains) may be requested; everything else is cancelled. */
  allowedHosts?: string[];
  /** Script run once after each successful ready (e.g. to silence the page's own polling). */
  afterReady?: string;
}

const ERR_ABORTED = -3; // Imperva reloads the page, which aborts the first navigation
const POLL_MS = 500;
const EVAL_GUARD_MS = 5000;
const OFFLINE_MESSAGE = 'Немає з’єднання з сайтом ДТЕК';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some(a => host === a || host.endsWith('.' + a));
}

export class BrowserSession implements PageSession {
  private win: BrowserWindow | null = null;
  private loaded = false; // true after a successful ready, until a failure/reload
  private netError = false;
  private showing = false;
  private disposed = false;
  private pending: Promise<void> | null = null;

  constructor(private readonly opts: SessionOptions) {}

  ensureReady(): Promise<void> {
    if (!this.pending) {
      this.pending = this.doEnsureReady().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async evaluate<T>(js: string): Promise<T> {
    if (!this.win || this.win.isDestroyed()) throw new ProviderError('Сторінка ДТЕК не завантажена');
    return (await this.win.webContents.executeJavaScript(js)) as T;
  }

  reload(): Promise<void> {
    this.loaded = false;
    return this.ensureReady();
  }

  async showForUser(): Promise<void> {
    const win = this.window();
    this.showing = true;
    win.show();
    try {
      await this.ensureReady();
    } finally {
      this.showing = false;
      if (!win.isDestroyed()) win.hide();
    }
  }

  dispose(): void {
    this.disposed = true;
    const win = this.win;
    this.win = null;
    this.loaded = false;
    if (win && !win.isDestroyed()) { win.removeAllListeners('close'); win.destroy(); }
  }

  private async doEnsureReady(): Promise<void> {
    if (this.disposed) throw new ProviderError('Сесію закрито');
    const win = this.window();
    if (this.loaded && (await this.check(win))) return;

    // Always a fresh navigation after any failure; never poll a dead page.
    this.loaded = false;
    this.netError = false;
    win.webContents.loadURL(this.opts.url).catch((e: { errno?: number; code?: string }) => {
      if (e?.errno === ERR_ABORTED || e?.code === 'ERR_ABORTED') return;
      this.netError = true;
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 30000);
    while (this.showing || Date.now() < deadline) {
      if (this.netError) throw new ProviderError(OFFLINE_MESSAGE);
      if (win.isDestroyed()) throw new ProviderError('Вікно ДТЕК закрито');
      if (await this.check(win)) {
        this.loaded = true;
        if (this.opts.afterReady) await this.check(win, this.opts.afterReady);
        return;
      }
      await sleep(POLL_MS);
    }
    if (this.netError) throw new ProviderError(OFFLINE_MESSAGE);
    if (this.onSourceHost(win)) throw new CaptchaRequiredError('Сайт просить пройти перевірку');
    throw new ProviderError('Не вдалося завантажити сторінку ДТЕК');
  }

  /** Runs a boolean-ish script; a rejection (e.g. mid-reload) means "not yet". */
  private async check(win: BrowserWindow, script = this.opts.readyCheck): Promise<boolean> {
    try {
      const run = win.webContents.executeJavaScript(script);
      const guard = sleep(EVAL_GUARD_MS).then(() => false);
      return !!(await Promise.race([run, guard]));
    } catch {
      return false;
    }
  }

  private onSourceHost(win: BrowserWindow): boolean {
    try {
      const host = new URL(win.webContents.getURL()).hostname;
      return hostAllowed(host, [new URL(this.opts.url).hostname.replace(/^www\./, '')]);
    } catch {
      return false;
    }
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = electronSession.fromPartition(this.opts.partition);
    const allowed = this.opts.allowedHosts;
    if (allowed) {
      ses.webRequest.onBeforeRequest((details, cb) => {
        let cancel = false;
        try {
          const u = new URL(details.url);
          if (/^(https?|wss?):$/.test(u.protocol)) cancel = !hostAllowed(u.hostname, allowed);
        } catch { /* leave non-parsable URLs alone */ }
        cb({ cancel });
      });
    }
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900, title: 'ДТЕК — перевірка',
      webPreferences: { partition: this.opts.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) this.netError = true;
    });
    // The user closing the verification window must only hide it.
    win.on('close', e => { if (!this.disposed) { e.preventDefault(); win.hide(); } });
    this.win = win;
    this.loaded = false;
    return win;
  }
}
