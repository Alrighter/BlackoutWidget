import { app, BrowserWindow, net, session as electronSession, type UploadData } from 'electron';
import { silentLogger, type Logger } from '../log';
import { isConnectivityError } from './net-errors';
import { CaptchaRequiredError, NetworkError, OFFLINE_MESSAGE, ProviderError, type PageSession } from './types';

export interface SessionOptions {
  url: string;
  partition: string;
  readyCheck: string;
  readyTimeoutMs?: number; // default 30000
  /** Only these hosts (and their subdomains) may be requested; everything else is cancelled. */
  allowedHosts?: string[];
  /** Script run after every page load and every successful ready check (e.g. to silence the page's own polling). */
  afterReady?: string;
  /** Requests for which this returns true are cancelled (e.g. the page's own background polling). */
  blockRequest?: (req: { method: string; url: string; body: string | null }) => boolean;
}

const ERR_ABORTED = -3; // Imperva reloads the page, which aborts the first navigation
const POLL_MS = 500;
const EVALUATE_TIMEOUT_MS = 30000;
const EVAL_GUARD_MS = 5000;

// Evidence the loaded document is the real DTEK / Imperva page, not a browser error page.
const REAL_PAGE_CHECK =
  "(() => { const h = document.documentElement ? document.documentElement.outerHTML : ''; return h.includes('_Incapsula_Resource') || /ДТЕК|dtek-/i.test(document.title + h); })()";

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function hostAllowed(host: string, allowed: string[]): boolean {
  return allowed.some(a => host === a || host.endsWith('.' + a));
}

/** The request body as text, when it was sent as bytes (a form / string body). */
function requestBody(data: UploadData[] | undefined): string | null {
  const chunks = (data ?? []).flatMap(d => (d.bytes ? [d.bytes] : []));
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
}

export class BrowserSession implements PageSession {
  private win: BrowserWindow | null = null;
  private loaded = false; // true after a successful ready, until a failure/reload
  private netError = false;
  private netFailure: unknown = undefined; // what the failed navigation reported, kept as the NetworkError cause
  private showing = false;
  private disposed = false;
  private quitting = false;
  private closedByUser: (() => void) | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly opts: SessionOptions, private readonly log: Logger = silentLogger) {
    app.on('before-quit', () => { this.quitting = true; });
  }

  ensureReady(): Promise<void> {
    if (!this.pending) {
      this.pending = this.doEnsureReady().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  async evaluate<T>(js: string): Promise<T> {
    if (!this.win || this.win.isDestroyed()) throw new ProviderError('Сторінка ДТЕК не завантажена');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderError('Сайт ДТЕК не відповідає')), EVALUATE_TIMEOUT_MS);
    });
    try {
      return (await Promise.race([this.win.webContents.executeJavaScript(js), timeout])) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async reload(): Promise<void> {
    // Never join another caller's quick-path check: wait it out, then force a fresh navigation.
    if (this.pending) await this.pending.catch(() => {});
    this.loaded = false;
    return this.ensureReady();
  }

  isOnline(): boolean {
    return net.isOnline();
  }

  async showForUser(): Promise<void> {
    const win = this.window();
    this.showing = true;
    win.show();
    const closed = new Promise<void>(resolve => { this.closedByUser = resolve; });
    try {
      // If the user closes the window, verification simply ends; the next call starts a fresh load.
      await Promise.race([this.ensureReady(), closed]);
    } finally {
      this.closedByUser = null;
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
    if (this.loaded && (await this.check(win))) {
      await this.runAfterReady(win); // the page may have reloaded itself since the last ready
      return;
    }

    // Always a fresh navigation after any failure; never poll a dead page.
    this.loaded = false;
    this.netError = false;
    this.netFailure = undefined;
    win.webContents.loadURL(this.opts.url).catch((e: { errno?: number; code?: string }) => {
      if (e?.errno === ERR_ABORTED || e?.code === 'ERR_ABORTED') return;
      this.netError = true;
      this.netFailure ??= { code: e?.errno, name: e?.code };
    });

    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 30000);
    while (this.showing || Date.now() < deadline) {
      if (this.netError) throw this.loadError();
      if (win.isDestroyed()) throw new ProviderError('Вікно ДТЕК закрито');
      if (await this.check(win)) {
        this.loaded = true;
        await this.runAfterReady(win);
        return;
      }
      await sleep(POLL_MS);
    }
    if (this.netError) throw this.loadError();
    if (!net.isOnline()) throw new NetworkError(OFFLINE_MESSAGE, { cause: 'net.isOnline() = false at the ready timeout' });
    // Captcha only when we are online AND the real page is what loaded.
    if (this.onSourceHost(win) && (await this.check(win, REAL_PAGE_CHECK))) {
      throw new CaptchaRequiredError('Сайт просить пройти перевірку');
    }
    // Online, but neither the page nor a verification showed up: the request may well have reached the site.
    throw new ProviderError(OFFLINE_MESSAGE, { cause: { url: win.isDestroyed() ? undefined : win.webContents.getURL() } });
  }

  /** NetworkError only for real connectivity failures; a failure after DTEK was contacted must obey the 5-minute floor. */
  private loadError(): ProviderError {
    const code = (this.netFailure as { code?: unknown } | undefined)?.code;
    return isConnectivityError(typeof code === 'number' ? code : 0, net.isOnline())
      ? new NetworkError(OFFLINE_MESSAGE, { cause: this.netFailure })
      : new ProviderError('Сайт ДТЕК повернув помилку', { cause: this.netFailure });
  }

  private async runAfterReady(win: BrowserWindow): Promise<void> {
    if (this.opts.afterReady && !win.isDestroyed()) await this.check(win, this.opts.afterReady);
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
    // The source page never needs camera, location, notifications, etc.
    ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    const allowed = this.opts.allowedHosts;
    const block = this.opts.blockRequest;
    if (allowed || block) {
      ses.webRequest.onBeforeRequest((details, cb) => {
        if (block) {
          const body = requestBody(details.uploadData);
          if (block({ method: details.method, url: details.url, body })) {
            this.log.info('blocked page-initiated request', { url: details.url, body: body?.slice(0, 120) });
            cb({ cancel: true });
            return;
          }
        }
        let cancel = false;
        // While the user is solving a verification, the site's own widgets must load.
        if (allowed && !this.showing) try {
          const u = new URL(details.url);
          if (/^(https?|wss?):$/.test(u.protocol)) cancel = !hostAllowed(u.hostname, allowed);
        } catch { /* leave non-parsable URLs alone */ }
        cb({ cancel });
      });
    }
    const win = new BrowserWindow({
      show: false, width: 1280, height: 900, title: 'ДТЕК — перевірка',
      // A never-shown window otherwise renders the whole site as if on screen: about 100 MB of GPU memory and some
      // renderer memory for a page nobody sees (smoke-memory). Shown for a verification, it paints as usual.
      paintWhenInitiallyHidden: false,
      webPreferences: { partition: this.opts.partition, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) {
        this.netError = true;
        this.netFailure = { code, desc, url };
      }
    });
    // Re-silence the page's own polling after every load, including reloads the page does by itself.
    win.webContents.on('did-finish-load', () => { void this.runAfterReady(win); });
    // The user closing the verification window must only hide it.
    win.on('close', e => {
      if (this.disposed || this.quitting) return;
      e.preventDefault();
      win.hide();
      this.showing = false;
      this.loaded = false;
      this.closedByUser?.();
    });
    this.win = win;
    this.loaded = false;
    return win;
  }
}
