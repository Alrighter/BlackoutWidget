import { isRiver2Family } from '../../../../shared/ecoflow-ble';
import { parseAdvert, type EcoflowAdvert } from './advert';
import { decodeHeartbeat, heartbeatOf, type Fields, type Module } from './heartbeats';
import type { AdapterState, AdvertView, HostCommand, HostEvent, LinkState } from './messages';
import type { Packet } from './protocol';
import { EcoflowBleSession, SessionError, type SessionOptions } from './session';

/**
 * The BLE host's decisions, kept pure: it reaches noble only through `BleCentral`/`BlePeripheral`, which the host
 * process entry implements, so the policy below is tested with fakes.
 *
 * One watched station, rescanned before every attempt. A failed attempt or a lost link backs off 5 s up to 60 s; a
 * refusal pauses 30 min; three stalls in a row pause 5 min; an unsupported advert is never connected to; a link that
 * carries no packet for 60 s is dropped and tried again after the 60 s cap. The host writes nothing of its own: every
 * write is built by EcoflowBleSession, whose allow-list keeps the station read-only.
 */

export const SCAN_FIND_MS = 15_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
export const STALL_LIMIT = 3;
export const STALL_PAUSE_MS = 300_000;
export const REFUSED_PAUSE_MS = 1_800_000;
export const UNSUPPORTED_RECHECK_MS = 1_800_000;
export const BAD_FRAME_LIMIT = 10;
/**
 * A connected link with no packet of any module for this long has gone mute (the station kept GATT, stopped
 * streaming). The inverter alone may be silent: it says nothing while the AC output is off.
 */
export const SILENT_LINK_MS = 60_000;
/** How often a connected link's silence is checked. */
export const SILENT_CHECK_MS = 10_000;

export interface BleChannel { write(data: Buffer): Promise<void> }

export interface BlePeripheral {
  readonly id: string;
  connect(): Promise<void>; cancelConnect(): void; disconnect(): Promise<void>;
  onceDisconnect(cb: () => void): void;
  /** Finds write 0002 + notify 0003 (or the Nordic UART pair), subscribes; null when the pair is absent. */
  openChannel(onNotify: (data: Buffer) => void): Promise<BleChannel | null>;
}

export interface BleCentral {
  readonly state: AdapterState;
  onState(cb: (s: AdapterState) => void): void;
  /**
   * Reports every advert, repeats included (noble's allowDuplicates): the scan is shared, so a listener that joins a
   * running scan must still see the stations reported before it joined.
   */
  startScan(onAdvert: (a: { peripheral: BlePeripheral; manufacturerData?: Buffer; rssi: number }) => void): Promise<void>;
  stopScan(): Promise<void>;
}

export interface HostTimers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(t: unknown): void; now(): number }

/** The globals, looked up on each call. */
const GLOBAL_TIMERS: HostTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

type Forwarded = 'inv' | 'pd' | 'mppt';
/** Main reads the grid from these; ems/bms would only add chatter on the port. */
const isForwarded = (m: Module | null): m is Forwarded => m === 'inv' || m === 'pd' || m === 'mppt';

interface Hit { peripheral: BlePeripheral; advert: EcoflowAdvert; rssi: number }
interface Watch { sn: string; token: string }

/** A step that failed in a way the backoff covers. `detail` is log-safe. */
class AttemptFailed extends Error {
  constructor(readonly detail: string) { super(detail); }
}

/** One connection attempt (or probe), holding everything it needs released, so that ending it is one call. */
interface Attempt {
  phase: 'search' | 'connect' | 'session' | 'connected';
  peripheral?: BlePeripheral;
  /** The peripheral reported the link down: no disconnect() is owed. */
  linkDown: boolean;
  badFrames: number;
  /** When the last packet of any module arrived; counted from `connected`. */
  dataAt: number;
  /** Heartbeats that came with the auth reply, passed on once `connected` is posted. */
  early: Map<Forwarded, Fields>;
  cleanups: Array<() => void>;
  done: boolean;
}

const newAttempt = (): Attempt => ({
  phase: 'search', linkDown: false, badFrames: 0, dataAt: 0, early: new Map(), cleanups: [], done: false,
});

/** The SN as logs and details may show it. */
const short = (sn: string): string => `${sn.slice(0, 4)}…`;

const noop = () => {};

/** A failure as a log-safe detail. A station that goes quiet after the key exchange has stalled (B§4.4). */
function failure(e: unknown): { detail: string; stall: boolean } {
  if (e instanceof AttemptFailed) return { detail: e.detail, stall: false };
  if (e instanceof SessionError) {
    if (e.kind === 'timeout') return { detail: `no reply in ${e.stage}`, stall: e.stage === 'auth-status' || e.stage === 'auth' };
    return { detail: `${e.stage} failed`, stall: false };
  }
  // The class only: the message may carry data.
  return { detail: `unexpected error (${e instanceof Error ? e.name : typeof e})`, stall: false };
}

export class BleHost {
  private adapter: AdapterState;
  private readonly listeners = new Set<(hit: Hit) => void>();
  private scanning = false;
  private scanGen = 0;
  private suspended = false;

  private watched: Watch | null = null;
  private link: LinkState | null = null;
  private attempt: Attempt | null = null;
  /** The timer that starts the next attempt (a backoff or a pause). */
  private wake: { timer: unknown } | null = null;
  /** The end of a refused, stalled or unsupported pause: it outlives an adapter outage, a backoff does not. */
  private pausedUntil = 0;
  private backoffIndex = 0;
  private stalls = 0;

  constructor(private readonly central: BleCentral, private readonly post: (e: HostEvent) => void, private readonly timers: HostTimers = GLOBAL_TIMERS) {
    this.adapter = central.state;
    post({ ev: 'adapter', state: this.adapter });
    central.onState(s => this.onAdapter(s));
  }

  handle(cmd: HostCommand): void {
    switch (cmd.cmd) {
      case 'watch': return this.watch(cmd.sn, cmd.token);
      case 'unwatch': return this.unwatch();
      case 'scan': return this.scan(cmd.id, cmd.ms);
      case 'probe': return void this.probe(cmd.id);
      case 'suspend': return this.suspend();
      case 'resume': return this.resume();
    }
  }

  // --- Commands ---

  /** Any watch, of a new station or the same one, starts over at once: saving the source again restarts it. */
  private watch(sn: string, token: string): void {
    this.endAttempt();
    this.clearPause();
    this.watched = { sn, token };
    this.link = null;
    this.backoffIndex = 0;
    this.stalls = 0;
    this.tryStart();
  }

  private unwatch(): void {
    if (!this.watched) return;
    this.endAttempt();
    this.clearPause();
    this.setLink('idle');
    this.watched = null;
    this.link = null;
  }

  private suspend(): void {
    this.suspended = true;
    this.clearPause();
    this.interrupt('suspend');
    this.syncScan();
  }

  /** Starts over at once, with no backoff and no pause. */
  private resume(): void {
    this.suspended = false;
    this.syncScan();
    if (this.attempt) return;
    this.clearPause();
    this.backoffIndex = 0;
    this.stalls = 0;
    this.tryStart();
  }

  /** Collects adverts for `ms`, one entry per SN with its last RSSI. The watch's own scan carries on alongside. */
  private scan(id: number, ms: number): void {
    // No scan can run: answer at once, and main names the adapter problem.
    if (this.adapter === 'poweredOff' || this.adapter === 'unauthorized' || this.adapter === 'unsupported') {
      this.post({ ev: 'scan-result', id, adverts: [] });
      return;
    }
    const seen = new Map<string, AdvertView>();
    const off = this.listen(({ advert, rssi }) => {
      seen.set(advert.sn, { sn: advert.sn, soc: advert.soc, rssi, encryptType: advert.encryptType });
    });
    this.timers.setTimeout(() => {
      off();
      this.post({ ev: 'scan-result', id, adverts: [...seen.values()] });
    }, ms);
  }

  /** Smoke check without the account: the first EcoFlow station nearby, through the handshake to its auth status. */
  private async probe(id: number): Promise<void> {
    const a = newAttempt();
    let tag = '';
    try {
      const hit = await this.find(a, () => true);
      if (!hit) throw new AttemptFailed('no EcoFlow station found');
      tag = `${short(hit.advert.sn)} `;
      const started = this.timers.now();
      let status = '';
      await this.open(a, hit.peripheral, {
        stopAfterAuthStatus: true,
        onPacket: p => { if (p.src === 0x35 && p.cmdSet === 0x35 && p.cmdId === 0x89) status = p.payload.toString('hex'); },
      }, () => { a.linkDown = true; });
      this.post({ ev: 'probe-result', id, ok: true, detail: `${tag}auth-status ${status} in ${this.timers.now() - started} ms` });
    } catch (e) {
      this.post({ ev: 'probe-result', id, ok: false, detail: tag + failure(e).detail });
    } finally {
      this.end(a);
    }
  }

  // --- The adapter ---

  private onAdapter(state: AdapterState): void {
    if (state === this.adapter) return;
    this.adapter = state;
    this.post({ ev: 'adapter', state });
    if (state === 'poweredOn') {
      const left = this.pausedUntil - this.timers.now();
      if (left > 0) this.sleep(left);
      this.syncScan();
      this.tryStart();
      return;
    }
    // Noble stops scanning with the adapter. Nothing runs until it is back.
    this.scanning = false;
    this.scanGen++;
    this.clearWake();
    this.interrupt(`adapter ${state}`);
  }

  // --- Attempts ---

  private tryStart(): void {
    if (!this.watched || this.suspended || this.attempt || this.wake || this.adapter !== 'poweredOn') return;
    const a = newAttempt();
    this.attempt = a;
    void this.run(a, this.watched);
  }

  private async run(a: Attempt, w: Watch): Promise<void> {
    try {
      this.setLink('searching');
      const hit = await this.find(a, advert => advert.sn === w.sn);
      if (a.done) return;
      if (!hit) throw new AttemptFailed('not found');
      const river2 = isRiver2Family(w.sn);
      if (!river2 || hit.advert.encryptType !== 7) {
        this.end(a);
        this.setLink('unsupported', river2 ? `encrypt type ${hit.advert.encryptType}` : 'not a RIVER 2');
        this.pause(UNSUPPORTED_RECHECK_MS);
        return;
      }
      this.setLink('connecting');
      await this.open(a, hit.peripheral, {
        token: w.token,
        onPacket: p => this.onPacket(a, w, p),
        onBadFrame: () => this.onBadFrame(a),
      }, () => this.onLinkDown(a));
      if (a.done) return;
      a.phase = 'connected';
      this.backoffIndex = 0;
      this.stalls = 0;
      this.setLink('connected');
      a.dataAt = this.timers.now();
      this.checkSilence(a);
      for (const [module, fields] of a.early) this.post({ ev: 'heartbeat', sn: w.sn, module, fields });
      a.early.clear();
    } catch (e) {
      if (!a.done) this.failed(a, e);
    }
  }

  /** Waits up to SCAN_FIND_MS for an advert that `match`es; null when none came or the attempt ended. */
  private find(a: Attempt, match: (advert: EcoflowAdvert) => boolean): Promise<Hit | null> {
    return new Promise(resolve => {
      let off = noop;
      let timer: unknown;
      const finish = (hit: Hit | null) => {
        off();
        this.timers.clearTimeout(timer);
        resolve(hit);
      };
      a.cleanups.push(() => finish(null));
      timer = this.timers.setTimeout(() => finish(null), SCAN_FIND_MS);
      off = this.listen(hit => { if (match(hit.advert)) finish(hit); });
    });
  }

  /**
   * Connects, cancelling a connect that hangs, opens the channel and runs the session until it resolves. Throws
   * AttemptFailed or the session's SessionError; returns early once the attempt has ended.
   */
  private async open(a: Attempt, p: BlePeripheral, options: Omit<SessionOptions, 'write'>, onLinkDown: () => void): Promise<void> {
    a.peripheral = p;
    a.phase = 'connect';
    const connecting = p.connect();
    // A connect that completes after we gave up on it is closed again.
    connecting.then(() => { if (a.done) void p.disconnect().catch(noop); }, noop);
    await this.within(a, connecting, 'connect timeout', 'connect failed');
    if (a.done) return;
    a.phase = 'session';
    p.onceDisconnect(onLinkDown);
    let session: EcoflowBleSession | null = null;
    const channel = await this.within(a, p.openChannel(data => session?.handle(data)), 'channel timeout', 'no channel');
    if (a.done) return;
    if (!channel) throw new AttemptFailed('no channel');
    session = new EcoflowBleSession({ ...options, write: data => channel.write(data) });
    await session.start();
  }

  /** `work`, bounded by CONNECT_TIMEOUT_MS: a GATT step that hangs fails the attempt rather than holding it. */
  private within<T>(a: Attempt, work: Promise<T>, timeoutDetail: string, errorDetail: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(new AttemptFailed(timeoutDetail)), CONNECT_TIMEOUT_MS);
      const clear = () => this.timers.clearTimeout(timer);
      a.cleanups.push(clear);
      work.then(v => { clear(); resolve(v); }, () => { clear(); reject(new AttemptFailed(errorDetail)); });
    });
  }

  private onPacket(a: Attempt, w: Watch, p: Packet): void {
    if (a.done) return;
    a.badFrames = 0;
    a.dataAt = this.timers.now();
    const module = heartbeatOf(p);
    if (!isForwarded(module)) return;
    const fields = decodeHeartbeat(module, p.payload);
    if (a.phase === 'connected') this.post({ ev: 'heartbeat', sn: w.sn, module, fields });
    else a.early.set(module, fields);
  }

  /** Undecodable frames in a row: the key no longer matches, so the link is dropped and made again. */
  private onBadFrame(a: Attempt): void {
    if (a.done || ++a.badFrames < BAD_FRAME_LIMIT) return;
    this.failed(a, new AttemptFailed(`${BAD_FRAME_LIMIT} bad frames`));
  }

  private onLinkDown(a: Attempt): void {
    if (a.done) return;
    a.linkDown = true;
    this.failed(a, new AttemptFailed('disconnected'));
  }

  /**
   * Every SILENT_CHECK_MS while connected: a link with no packet for SILENT_LINK_MS is dropped. The retry waits the
   * backoff cap, so a station that takes the login and then says nothing is not handshaked again every few seconds.
   * One timer at a time, released with the attempt.
   */
  private checkSilence(a: Attempt): void {
    let timer: unknown;
    const check = () => {
      if (a.done) return;
      if (this.timers.now() - a.dataAt >= SILENT_LINK_MS) {
        this.backoffIndex = BACKOFF_MS.length - 1;
        this.failed(a, new AttemptFailed(`no data for ${SILENT_LINK_MS / 1000} s`));
        return;
      }
      timer = this.timers.setTimeout(check, SILENT_CHECK_MS);
    };
    a.cleanups.push(() => this.timers.clearTimeout(timer));
    timer = this.timers.setTimeout(check, SILENT_CHECK_MS);
  }

  /** Ends a failed attempt and decides when to try again. */
  private failed(a: Attempt, e: unknown): void {
    if (e instanceof SessionError && e.kind === 'refused') {
      this.end(a);
      this.setLink('refused', `auth code ${e.code}`);
      this.pause(REFUSED_PAUSE_MS);
      return;
    }
    const { detail, stall } = failure(e);
    const wasConnected = this.end(a);
    if (stall && ++this.stalls >= STALL_LIMIT) {
      this.stalls = 0;
      this.setLink('stalled', detail);
      this.pause(STALL_PAUSE_MS);
      return;
    }
    this.setLink(wasConnected ? 'lost' : 'searching', detail);
    const ms = BACKOFF_MS[this.backoffIndex];
    this.backoffIndex = Math.min(this.backoffIndex + 1, BACKOFF_MS.length - 1);
    this.sleep(ms);
  }

  /** Ends the current attempt for a reason of our own (suspend, adapter gone); what comes next is the caller's call. */
  private interrupt(detail: string): void {
    if (!this.attempt) return;
    const wasConnected = this.end(this.attempt);
    this.setLink(wasConnected ? 'lost' : 'searching', detail);
  }

  private endAttempt(): void {
    if (this.attempt) this.end(this.attempt);
  }

  /** Ends an attempt once: drops its scan listener and timers and lets go of the station. Says whether it was connected. */
  private end(a: Attempt): boolean {
    if (a.done) return false;
    a.done = true;
    if (this.attempt === a) this.attempt = null;
    for (const cleanup of a.cleanups.splice(0)) cleanup();
    const p = a.peripheral;
    if (p && a.phase === 'connect') p.cancelConnect();
    else if (p && !a.linkDown) void p.disconnect().catch(noop);
    return a.phase === 'connected';
  }

  // --- Waiting ---

  private sleep(ms: number): void {
    this.clearWake();
    const timer = this.timers.setTimeout(() => {
      this.wake = null;
      this.tryStart();
    }, ms);
    this.wake = { timer };
  }

  private pause(ms: number): void {
    this.pausedUntil = this.timers.now() + ms;
    this.sleep(ms);
  }

  private clearWake(): void {
    if (this.wake) this.timers.clearTimeout(this.wake.timer);
    this.wake = null;
  }

  private clearPause(): void {
    this.clearWake();
    this.pausedUntil = 0;
  }

  // --- The shared scan ---

  private listen(fn: (hit: Hit) => void): () => void {
    this.listeners.add(fn);
    this.syncScan();
    return () => { if (this.listeners.delete(fn)) this.syncScan(); };
  }

  /** One noble scan for every listener: on while anyone listens and the adapter can scan. */
  private syncScan(): void {
    const want = this.listeners.size > 0 && this.adapter === 'poweredOn' && !this.suspended;
    if (want === this.scanning) return;
    this.scanning = want;
    const gen = ++this.scanGen;
    if (!want) {
      this.central.stopScan().catch(noop);
      return;
    }
    this.central.startScan(a => this.onAdvert(a)).catch(() => {
      if (gen !== this.scanGen) return;
      this.scanning = false;
      this.log('warn', 'scan did not start');
    });
  }

  private onAdvert(a: { peripheral: BlePeripheral; manufacturerData?: Buffer; rssi: number }): void {
    if (!this.scanning) return;
    const advert = parseAdvert(a.manufacturerData);
    if (!advert) return;
    const hit: Hit = { peripheral: a.peripheral, advert, rssi: a.rssi };
    for (const fn of [...this.listeners]) fn(hit);
  }

  // --- Events ---

  /** Posts a change of the watched station's link state, with its log line. A repeat of the current state is dropped. */
  private setLink(state: LinkState, detail?: string): void {
    if (!this.watched || state === this.link) return;
    this.link = state;
    const { sn } = this.watched;
    this.post(detail ? { ev: 'link', sn, state, detail } : { ev: 'link', sn, state });
    const warn = state === 'lost' || state === 'refused' || state === 'stalled' || state === 'unsupported';
    this.log(warn ? 'warn' : 'info', `${short(sn)} ${state}${detail ? ` (${detail})` : ''}`);
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    this.post({ ev: 'log', level, text });
  }
}
