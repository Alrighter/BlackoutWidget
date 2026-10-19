import type { BleProblem } from '../../../../shared/ecoflow-ble';
import type { ActualLive } from '../../../../shared/ipc';
import type { Logger } from '../../../log';
import type { Fields } from './heartbeats';
import type { HostTimers } from './host';
import type { AdapterState, AdvertView, HostCommand, HostEvent, LinkState } from './messages';

/**
 * Main's side of the BLE host. It spawns the utilityProcess when a watch or a scan first needs it, respawns it after a
 * crash and replays the watch, and stops it once idle. It also keeps the live line of the watched station. Kept pure:
 * the process comes from `spawn`, so every policy here is tested with a fake port.
 *
 * Imports from host.ts and messages.ts are types only. A value import would pull the session and its crypto (the
 * ESM-only @noble/curves) into the main bundle.
 */

export const RESPAWN_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
export const HOST_FAIL_LIMIT = 3;
export const IDLE_STOP_MS = 60_000;
export const ADAPTER_UNREADY_MS = 10_000;
export const INV_SILENT_MS = 20_000;
export const SCAN_GRACE_MS = 5_000;
/** How often the inverter's silence is checked while connected. */
export const INV_CHECK_MS = 5_000;
/** A host that ran this long before it crashed was healthy: the next respawn starts the backoff over. */
export const HOST_STABLE_MS = 60_000;

export interface HostPort { post(cmd: HostCommand): void; onEvent(cb: (e: HostEvent) => void): void; onExit(cb: (code: number) => void): void; kill(): void }
export type LinkEvent = HostEvent | { ev: 'host-failed' };
export interface ScanOutcome { adverts: AdvertView[]; problem?: BleProblem }
export interface BleLinkLike {
  watch(sn: string, token: string): void; unwatch(): void;
  scan(ms: number): Promise<ScanOutcome>;
  connectedSn(): string | null;
  /** The last adapter state the link has seen; null before any. */
  adapterState(): AdapterState | null;
  /** True from `host-failed` until an adapter state other than 'unknown' arrives. */
  hostFailed(): boolean;
  onEvent(cb: (e: LinkEvent) => void): () => void;
}

/** The globals, looked up on each call. */
const GLOBAL_TIMERS: HostTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

type AdapterProblem = 'bt-off' | 'bt-denied' | 'bt-missing' | 'bt-unavailable';

function adapterProblem(state: AdapterState | null): AdapterProblem | undefined {
  switch (state) {
    case 'poweredOff': return 'bt-off';
    case 'unauthorized': return 'bt-denied';
    case 'unsupported': return 'bt-missing';
    case 'unknown': case 'resetting': return 'bt-unavailable';
    default: return undefined;
  }
}

const num = (v: number | string | undefined): number | undefined => (typeof v === 'number' ? v : undefined);

function sameLive(a: ActualLive | null, b: ActualLive | null): boolean {
  if (a === null || b === null) return a === b;
  const keys = Object.keys(a) as Array<keyof ActualLive>;
  return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}

interface PendingScan { ms: number; timer: unknown; resolve: (o: ScanOutcome) => void }

export class BleLink implements BleLinkLike {
  private readonly timers: HostTimers;
  private disposed = false;
  private suspended = false;
  private watched: { sn: string; token: string } | null = null;

  // --- The current host ---
  private port: HostPort | null = null;
  private spawnedAt = 0;
  private sawAdapter = false;
  private adapter: AdapterState | null = null;
  /** The adapter has been unknown/resetting for ADAPTER_UNREADY_MS. */
  private adapterUnready = false;
  private unreadyTimer: unknown = null;

  // --- Supervision ---
  private respawnTimer: unknown = null;
  private respawnIndex = 0;
  /** Hosts in a row that exited without ever posting `adapter`. */
  private deadInRow = 0;
  private failed = false;
  private idleTimer: unknown = null;

  private nextScanId = 1;
  private readonly scans = new Map<number, PendingScan>();

  // --- The watched station's current connection ---
  private link: LinkState | null = null;
  private beats: Partial<Record<'inv' | 'pd' | 'mppt', Fields>> = {};
  private invAt = 0;
  private invSilent = false;
  private invTimer: unknown = null;

  private live: ActualLive | null = null;
  private readonly eventCbs = new Set<(e: LinkEvent) => void>();
  private readonly liveCbs = new Set<(live: ActualLive | null) => void>();

  constructor(private readonly deps: { spawn(): HostPort; log: Logger; timers?: HostTimers }) {
    this.timers = deps.timers ?? GLOBAL_TIMERS;
  }

  // --- API ---

  /** The watch goes to the current host and to every host spawned after it. */
  watch(sn: string, token: string): void {
    if (this.disposed) return;
    this.watched = { sn, token };
    this.setLink(null);
    if (this.port) this.port.post({ cmd: 'watch', sn, token });
    else this.ensureHost();
    this.syncIdle();
    this.refresh();
  }

  unwatch(): void {
    if (!this.watched) return;
    this.watched = null;
    this.setLink(null);
    this.port?.post({ cmd: 'unwatch' });
    if (!this.port && this.scans.size === 0) this.respawnTimer = this.clear(this.respawnTimer);
    this.syncIdle();
    this.refresh();
  }

  scan(ms: number): Promise<ScanOutcome> {
    if (this.disposed) return Promise.resolve({ adverts: [], problem: 'scan-failed' });
    if (this.failed) {
      // One more host in the background, so that setup can recover once Bluetooth works again.
      this.ensureHost();
      return Promise.resolve({ adverts: [], problem: 'host-failed' });
    }
    return new Promise(resolve => {
      const id = this.nextScanId++;
      const timer = this.timers.setTimeout(() => this.settleScan(id, { adverts: [], problem: 'scan-failed' }), ms + SCAN_GRACE_MS);
      this.scans.set(id, { ms, timer, resolve });
      if (this.port) this.port.post({ cmd: 'scan', id, ms });
      else this.ensureHost();
      this.syncIdle();
    });
  }

  connectedSn(): string | null {
    return this.watched && this.link === 'connected' ? this.watched.sn : null;
  }

  adapterState(): AdapterState | null { return this.adapter; }

  hostFailed(): boolean { return this.failed; }

  onEvent(cb: (e: LinkEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => { this.eventCbs.delete(cb); };
  }

  /** System sleep. A host spawned meanwhile hears it before the watch. */
  suspend(): void {
    this.suspended = true;
    this.port?.post({ cmd: 'suspend' });
  }

  resume(): void {
    this.suspended = false;
    this.port?.post({ cmd: 'resume' });
  }

  /** Null while nothing is watched. */
  getLive(): ActualLive | null {
    return this.live;
  }

  onLive(cb: (live: ActualLive | null) => void): () => void {
    this.liveCbs.add(cb);
    return () => { this.liveCbs.delete(cb); };
  }

  /** Kills the host for good. Listeners are not called any more: the app is quitting. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.eventCbs.clear();
    this.liveCbs.clear();
    for (const id of [...this.scans.keys()]) this.settleScan(id, { adverts: [], problem: 'scan-failed' });
    this.respawnTimer = this.clear(this.respawnTimer);
    this.idleTimer = this.clear(this.idleTimer);
    this.watched = null;
    this.setLink(null);
    this.setAdapter(null);
    this.live = null;
    const port = this.port;
    this.port = null;
    port?.kill();
  }

  // --- The host process ---

  private ensureHost(): void {
    if (this.disposed || this.port || this.respawnTimer !== null) return;
    this.spawnHost();
  }

  private spawnHost(): void {
    this.respawnTimer = this.clear(this.respawnTimer);
    this.sawAdapter = false;
    this.spawnedAt = this.timers.now();
    // Failed: the failure was logged when it began, and a line per respawn (every 30 s) would roll the log.
    const quiet = this.failed;
    let port: HostPort;
    try {
      port = this.deps.spawn();
    } catch (e) {
      if (!quiet) this.deps.log.error('BLE host did not start', e);
      this.hostGone('did not start');
      return;
    }
    this.port = port;
    // HostPort has no unsubscribe: events and the exit of a host that is no longer current are dropped here.
    port.onEvent(e => { if (this.port === port) this.onHostEvent(e); });
    port.onExit(code => { if (this.port === port) this.hostGone(`exited (code ${code})`); });
    if (!quiet) this.deps.log.info('BLE host started');
    if (this.suspended) port.post({ cmd: 'suspend' });
    if (this.watched) port.post({ cmd: 'watch', sn: this.watched.sn, token: this.watched.token });
    for (const [id, s] of this.scans) port.post({ cmd: 'scan', id, ms: s.ms });
    this.syncIdle();
  }

  /** The current host is gone without being asked to stop: what it said goes with it, and another is due if needed. */
  private hostGone(what: string): void {
    // Already failed: this death is one of the respawns that are not logged.
    const quiet = this.failed;
    this.port = null;
    this.idleTimer = this.clear(this.idleTimer);
    const healthy = this.sawAdapter && this.timers.now() - this.spawnedAt >= HOST_STABLE_MS;
    if (!this.sawAdapter) this.deadInRow++;
    this.setAdapter(null);
    const w = this.watched;
    if (w && (this.link === 'connected' || this.link === 'connecting')) {
      // Subscribers hear the link go down; the next host reports its own.
      const state = this.link === 'connected' ? 'lost' : 'searching';
      this.setLink(state);
      this.emit({ ev: 'link', sn: w.sn, state, detail: 'host exited' });
    }
    if (!this.failed && this.deadInRow >= HOST_FAIL_LIMIT) {
      this.failed = true;
      this.deps.log.error(`BLE host failed: ${this.deadInRow} hosts in a row ended before reporting the adapter`);
      this.emit({ ev: 'host-failed' });
    }
    // Decided first, so that a scan pending at the death that fails the host already names that failure.
    const problem = this.failed ? 'host-failed' : 'scan-failed';
    for (const id of [...this.scans.keys()]) this.settleScan(id, { adverts: [], problem });
    if (healthy) this.respawnIndex = 0;
    if (w) {
      const ms = this.failed ? RESPAWN_MS[RESPAWN_MS.length - 1] : RESPAWN_MS[Math.min(this.respawnIndex, RESPAWN_MS.length - 1)];
      this.respawnIndex++;
      this.respawnTimer = this.timers.setTimeout(() => {
        this.respawnTimer = null;
        if (!this.disposed && !this.port && (this.watched || this.scans.size > 0)) this.spawnHost();
      }, ms);
      if (!quiet) this.deps.log.warn(`BLE host ${what}; restarting in ${ms / 1000} s`);
    } else if (!quiet) {
      this.deps.log.warn(`BLE host ${what}`);
    }
    this.refresh();
  }

  /** Idle: nothing watched and no scan pending for IDLE_STOP_MS. An expected exit: no respawn. */
  private syncIdle(): void {
    const idle = this.port !== null && !this.watched && this.scans.size === 0;
    if (!idle) {
      this.idleTimer = this.clear(this.idleTimer);
      return;
    }
    if (this.idleTimer !== null) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      const port = this.port;
      if (!port) return;
      this.port = null;
      this.respawnIndex = 0;
      this.setAdapter(null);
      port.kill();
      this.deps.log.info('BLE host stopped (idle)');
    }, IDLE_STOP_MS);
  }

  private onHostEvent(e: HostEvent): void {
    switch (e.ev) {
      case 'adapter':
        // BleHost posts 'unknown' from its constructor, before noble's bindings start: only a later state shows the
        // host got past the binding. One that dies before it still counts toward HOST_FAIL_LIMIT.
        if (e.state !== 'unknown') {
          this.sawAdapter = true;
          this.deadInRow = 0;
          if (this.failed) {
            this.failed = false;
            this.deps.log.info('BLE host is up again');
          }
        }
        this.setAdapter(e.state);
        break;
      case 'link':
        if (this.isWatched(e.sn)) this.setLink(e.state);
        break;
      case 'heartbeat':
        if (this.isWatched(e.sn) && this.link === 'connected') {
          this.beats[e.module] = e.fields;
          if (e.module === 'inv') {
            this.invAt = this.timers.now();
            this.invSilent = false;
          }
        }
        break;
      case 'scan-result': {
        const problem = adapterProblem(this.adapter);
        this.settleScan(e.id, problem ? { adverts: e.adverts, problem } : { adverts: e.adverts });
        break;
      }
      case 'log':
        this.deps.log[e.level](e.text);
        break;
      case 'probe-result':
        break;
    }
    this.emit(e);
    this.refresh();
  }

  private settleScan(id: number, outcome: ScanOutcome): void {
    const s = this.scans.get(id);
    if (!s) return;
    this.scans.delete(id);
    this.timers.clearTimeout(s.timer);
    s.resolve(outcome);
    this.syncIdle();
  }

  // --- State ---

  private isWatched(sn: string): boolean {
    return this.watched !== null && this.watched.sn === sn;
  }

  /** unknown/resetting count as a problem only once they have lasted ADAPTER_UNREADY_MS. */
  private setAdapter(state: AdapterState | null): void {
    this.adapter = state;
    if (state === 'unknown' || state === 'resetting') {
      if (this.unreadyTimer !== null || this.adapterUnready) return;
      this.unreadyTimer = this.timers.setTimeout(() => {
        this.unreadyTimer = null;
        this.adapterUnready = true;
        this.refresh();
      }, ADAPTER_UNREADY_MS);
      return;
    }
    this.unreadyTimer = this.clear(this.unreadyTimer);
    this.adapterUnready = false;
  }

  /** The values belong to one connection: they start empty on connected and are dropped when it ends. */
  private setLink(state: LinkState | null): void {
    const was = this.link;
    this.link = state;
    if (was === 'connected' && state !== 'connected') {
      this.beats = {};
      this.invSilent = false;
      this.invTimer = this.clear(this.invTimer);
    } else if (state === 'connected' && was !== 'connected') {
      this.beats = {};
      this.invAt = this.timers.now();
      this.invSilent = false;
      this.armInvCheck();
    }
  }

  private armInvCheck(): void {
    this.invTimer = this.timers.setTimeout(() => {
      this.invTimer = null;
      if (this.link !== 'connected') return;
      this.invSilent = this.timers.now() - this.invAt >= INV_SILENT_MS;
      this.refresh();
      this.armInvCheck();
    }, INV_CHECK_MS);
  }

  private liveLink(): ActualLive['link'] {
    if (this.failed) return 'host-failed';
    const problem = adapterProblem(this.adapter);
    if (problem === 'bt-unavailable') return this.adapterUnready ? problem : 'searching';
    if (problem) return problem;
    switch (this.link) {
      case null: case 'idle': case 'lost': case 'searching': return 'searching';
      default: return this.link;
    }
  }

  private computeLive(): ActualLive | null {
    if (!this.watched) return null;
    const link = this.liveLink();
    if (link !== 'connected') return { link };
    const { inv, pd, mppt } = this.beats;
    const live: ActualLive = { link };
    const mv = num(inv?.acInVol);
    if (mv !== undefined) live.acInVolts = Math.round(mv / 1000);
    const hz = num(inv?.acInFreq);
    if (hz !== undefined) live.acInHz = hz;
    const watts = num(inv?.inputWatts);
    if (watts !== undefined) live.inputWatts = watts;
    // MPPT first, then the inverter's own flag; neither sent means unknown, never «off».
    const acFlag = num(mppt?.cfgAcEnabled) ?? num(inv?.cfgAcEnabled);
    if (acFlag !== undefined) live.acOut = acFlag === 1;
    const soc = num(pd?.soc);
    if (soc !== undefined) live.soc = soc;
    live.invSilent = this.invSilent;
    return live;
  }

  /** Recomputes the live line and tells the listeners when it changed. */
  private refresh(): void {
    if (this.disposed) return;
    const next = this.computeLive();
    if (sameLive(this.live, next)) return;
    this.live = next;
    for (const cb of [...this.liveCbs]) this.safely(() => cb(next));
  }

  private emit(e: LinkEvent): void {
    for (const cb of [...this.eventCbs]) this.safely(() => cb(e));
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.deps.log.error('BLE link listener failed', e);
    }
  }

  private clear(timer: unknown): null {
    if (timer !== null) this.timers.clearTimeout(timer);
    return null;
  }
}
