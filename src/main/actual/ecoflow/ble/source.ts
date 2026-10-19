import { BLE_REASON } from '../../../../shared/ecoflow-ble';
import type { Logger } from '../../../log';
import type { ActualReading, ActualStateSource } from '../../types';
import { detectGrid } from '../grid';
import { INV_SILENT_MS, type BleLinkLike, type LinkEvent } from './link';
import type { HostTimers } from './host';
import type { AdapterState, LinkState } from './messages';

/** At most one grid reading per this long, unless the power changes. */
export const READING_MS = 10_000;
/** A not-connected state is reported only once it has held this long (counted from start or from the drop). */
export const LINK_GRACE_MS = 30_000;
/** An unknown reason is reported again this often while it holds. */
export const REASON_REPEAT_MS = 60_000;
/** How often the clocks above are looked at. */
const CHECK_MS = 1_000;

const GLOBAL_TIMERS: HostTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function adapterReason(state: AdapterState | null): string | undefined {
  switch (state) {
    case 'poweredOff': return BLE_REASON['bt-off'];
    case 'unauthorized': return BLE_REASON['bt-denied'];
    case 'unsupported': return BLE_REASON['bt-missing'];
    case 'unknown': case 'resetting': return BLE_REASON['bt-unavailable'];
    default: return undefined;
  }
}

/**
 * Reads one station over Bluetooth through the main-process link. The inverter heartbeat gives the grid verdict; every
 * kind of silence or failure is `unknown`, never `off`.
 */
export class EcoflowBleSource implements ActualStateSource {
  private readonly timers: HostTimers;
  private readonly now: () => number;
  private onReading: ((r: ActualReading) => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private timer: unknown;
  private stopped = false;

  private connected = false;
  private linkState: LinkState | null = null;
  private adapter: AdapterState | null = null;
  private hostFailed = false;
  /** Start of the current not-connected stretch. */
  private graceFrom = 0;
  private invAt = 0;
  private cfgAcEnabled: number | undefined;

  private lastPower: ActualReading['power'] | undefined;
  private lastGridAt = 0;
  private lastReason: string | undefined;
  private lastReasonAt = 0;

  constructor(
    private readonly cfg: { sn: string; token: string },
    private readonly link: BleLinkLike,
    private readonly deps: { log: Logger; now?: () => number; timers?: HostTimers },
  ) {
    this.timers = deps.timers ?? GLOBAL_TIMERS;
    this.now = deps.now ?? (() => this.timers.now());
  }

  start(onReading: (r: ActualReading) => void): void {
    this.onReading = onReading;
    this.stopped = false;
    const t = this.now();
    this.graceFrom = t;
    if (this.link.connectedSn() === this.cfg.sn) {
      this.connected = true;
      this.linkState = 'connected';
      this.invAt = t;
    }
    this.unsubscribe = this.link.onEvent(e => this.onEvent(e));
    this.link.watch(this.cfg.sn, this.cfg.token);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.onReading = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.link.unwatch();
  }

  private schedule(): void {
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      this.evaluate();
      this.schedule();
    }, CHECK_MS);
  }

  private onEvent(e: LinkEvent): void {
    if (this.stopped) return;
    switch (e.ev) {
      case 'adapter':
        this.adapter = e.state;
        if (e.state !== 'unknown') this.hostFailed = false;
        break;
      case 'host-failed':
        this.hostFailed = true;
        this.drop();
        break;
      case 'link':
        if (e.sn !== this.cfg.sn) return;
        this.linkState = e.state;
        if (e.state === 'connected') {
          if (!this.connected) this.invAt = this.now();
          this.connected = true;
        } else this.drop();
        break;
      case 'heartbeat':
        if (e.sn !== this.cfg.sn) return;
        this.onHeartbeat(e.module, e.fields);
        return;
      default:
        return;
    }
    this.evaluate();
  }

  private drop(): void {
    if (this.connected) this.graceFrom = this.now();
    this.connected = false;
  }

  private onHeartbeat(module: 'inv' | 'pd' | 'mppt', fields: Record<string, number | string>): void {
    const t = this.now();
    if (typeof fields.cfgAcEnabled === 'number' && (module === 'inv' || module === 'mppt')) this.cfgAcEnabled = fields.cfgAcEnabled;
    if (module !== 'inv') return;
    this.invAt = t;
    const verdict = detectGrid({
      'inv.acInVol': fields.acInVol, 'inv.acInFreq': fields.acInFreq, 'inv.inputWatts': fields.inputWatts,
    });
    if (verdict.power === this.lastPower && t - this.lastGridAt < READING_MS) return;
    this.lastGridAt = t;
    this.lastReason = undefined;
    this.emit(verdict.power === 'unknown'
      ? { power: 'unknown', observedAt: this.iso(t), reason: verdict.reason }
      : { power: verdict.power, observedAt: this.iso(t), detail: verdict.detail });
  }

  /** The reason the power cannot be told right now, if any. */
  private reason(t: number): string | undefined {
    if (this.connected) {
      if (t - this.invAt < INV_SILENT_MS) return undefined;
      return BLE_REASON.invSilent + (this.cfgAcEnabled === 0 ? BLE_REASON.acOffHint : '');
    }
    if (t - this.graceFrom < LINK_GRACE_MS) return undefined;
    if (this.hostFailed) return BLE_REASON['host-failed'];
    const adapter = adapterReason(this.adapter);
    if (adapter) return adapter;
    switch (this.linkState) {
      case 'refused': return BLE_REASON.refused;
      case 'stalled': return BLE_REASON.stalled;
      case 'unsupported': return BLE_REASON.unsupported;
      default: return BLE_REASON.lost;
    }
  }

  private evaluate(): void {
    const t = this.now();
    const reason = this.reason(t);
    if (reason === undefined) {
      this.lastReason = undefined;
      return;
    }
    if (reason === this.lastReason && t - this.lastReasonAt < REASON_REPEAT_MS) return;
    if (reason !== this.lastReason) this.deps.log.info(`ecoflow-ble: unknown — ${reason}`);
    this.lastReason = reason;
    this.lastReasonAt = t;
    this.emit({ power: 'unknown', observedAt: this.iso(t), reason });
  }

  private emit(r: ActualReading): void {
    this.lastPower = r.power;
    this.onReading?.(r);
  }

  private iso(t: number): string { return new Date(t).toISOString(); }
}
