import { BLE_REASON } from '../../../../shared/ecoflow-ble';
import type { Logger } from '../../../log';
import type { ActualReading, ActualStateSource } from '../../types';
import { detectGrid, type GridVerdict } from '../grid';
import { ADAPTER_UNREADY_MS, INV_SILENT_MS, type BleLinkLike, type LinkEvent } from './link';
import type { HostTimers } from './host';
import type { AdapterState, LinkState } from './messages';

/** At most one grid reading per this long, unless the power changes. */
export const READING_MS = 10_000;
/** A not-connected state is reported only once it has held this long (counted from start or from the drop). */
export const LINK_GRACE_MS = 30_000;
/** An unknown reason is reported again this often while it holds. */
export const REASON_REPEAT_MS = 60_000;
/**
 * A longer gap between two looks at the clocks (or one going back) means the system slept or the clock jumped: the
 * grace and the inverter's silence start over then, so the link gets its chance to come back after a wake.
 */
export const TICK_GAP_MS = 5_000;
/**
 * With the inverter silent, the PD heartbeat's 0 W in and some W out (the battery feeding the outputs) held this long
 * reads «off». The inverter is the AC charger, so a grid that comes back wakes it and its verdict takes over.
 */
export const DRAIN_HOLD_MS = 30_000;
/** A PD heartbeat older than this says nothing about now. */
export const PD_FRESH_MS = 15_000;
export const ON_BATTERY_DETAIL = 'станція працює від батареї, вхід 0 Вт';
const isUnready = (s: AdapterState | null): boolean => s === 'unknown' || s === 'resetting';

/** How often the clocks above are looked at. */
const CHECK_MS = 1_000;

const GLOBAL_TIMERS: HostTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function adapterReason(state: AdapterState | null, unready: boolean): string | undefined {
  switch (state) {
    case 'poweredOff': return BLE_REASON['bt-off'];
    case 'unauthorized': return BLE_REASON['bt-denied'];
    case 'unsupported': return BLE_REASON['bt-missing'];
    case 'unknown': case 'resetting': return unready ? BLE_REASON['bt-unavailable'] : undefined;
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
  /** When the adapter entered unknown/resetting; a momentary one (a host respawn) is no problem. */
  private adapterSince = 0;
  /** The last look at the clocks, for TICK_GAP_MS. */
  private checkedAt = 0;
  private mpptAc: number | undefined;
  private invAc: number | undefined;
  private pdAt = 0;
  /**
   * Since when the PD heartbeat has shown the battery feeding the outputs: set by 0 W in with some W out, kept while
   * the input stays 0 W (a load switched off does not bring the grid back), cleared by any input.
   */
  private drainSince: number | undefined;

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
    this.checkedAt = t;
    if (this.link.connectedSn() === this.cfg.sn) {
      this.connected = true;
      this.linkState = 'connected';
      this.invAt = t;
    }
    this.adapter = this.link.adapterState();
    this.adapterSince = t;
    this.hostFailed = this.link.hostFailed();
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
      try {
        this.evaluate();
      } finally {
        this.schedule();
      }
    }, CHECK_MS);
  }

  private onEvent(e: LinkEvent): void {
    if (this.stopped) return;
    switch (e.ev) {
      case 'adapter':
        if (isUnready(e.state) !== isUnready(this.adapter)) this.adapterSince = this.now();
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
          if (!this.connected) {
            this.invAt = this.now();
            this.mpptAc = this.invAc = undefined;
            this.pdAt = 0;
            this.drainSince = undefined;
          }
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
    this.mpptAc = this.invAc = undefined;
    this.pdAt = 0;
    this.drainSince = undefined;
  }

  private onHeartbeat(module: 'inv' | 'pd' | 'mppt', fields: Record<string, number | string>): void {
    if (!this.connected) return;
    const t = this.now();
    if (typeof fields.cfgAcEnabled === 'number') {
      if (module === 'mppt') this.mpptAc = fields.cfgAcEnabled;
      else if (module === 'inv') this.invAc = fields.cfgAcEnabled;
    }
    if (module === 'pd') this.onPd(t, fields);
    if (module !== 'inv') return;
    // A payload cut short before the frequency would skip detectGrid's voltage/frequency check (0 V alone reads «off»):
    // it gives no verdict and does not count as the inverter reporting.
    if (typeof fields.acInVol !== 'number' || typeof fields.acInFreq !== 'number') return;
    this.invAt = t;
    const verdict = detectGrid({
      'inv.acInVol': fields.acInVol, 'inv.acInFreq': fields.acInFreq, 'inv.inputWatts': fields.inputWatts,
    });
    this.report(t, verdict);
  }

  private onPd(t: number, fields: Record<string, number | string>): void {
    this.pdAt = t;
    const { wattsInSum: inW, wattsOutSum: outW } = fields;
    if (typeof inW !== 'number' || inW > 0) this.drainSince = undefined;
    else if (this.drainSince === undefined && typeof outW === 'number' && outW > 0) this.drainSince = t;
  }

  /** A grid verdict, at most one per READING_MS unless the power changes. */
  private report(t: number, verdict: GridVerdict): void {
    if (verdict.power === this.lastPower && t - this.lastGridAt < READING_MS) return;
    this.lastGridAt = t;
    this.lastReason = undefined;
    this.emit(verdict.power === 'unknown'
      ? { power: 'unknown', observedAt: this.iso(t), reason: verdict.reason }
      : { power: verdict.power, observedAt: this.iso(t), detail: verdict.detail });
  }

  /**
   * With the inverter silent: 'off' once the battery has fed the outputs for DRAIN_HOLD_MS, 'wait' while that is being
   * held (so no «unknown» comes in between), null when the PD heartbeat tells nothing.
   */
  private battery(t: number): 'off' | 'wait' | null {
    if (this.drainSince === undefined || t - this.pdAt >= PD_FRESH_MS) return null;
    return t - this.drainSince >= DRAIN_HOLD_MS ? 'off' : 'wait';
  }

  /** The reason the power cannot be told right now, if any. */
  private reason(t: number): string | undefined {
    if (this.connected) {
      if (t - this.invAt < INV_SILENT_MS) return undefined;
      return BLE_REASON.invSilent + ((this.mpptAc ?? this.invAc) === 0 ? BLE_REASON.acOffHint : '');
    }
    if (t - this.graceFrom < LINK_GRACE_MS) return undefined;
    if (this.hostFailed) return BLE_REASON['host-failed'];
    const adapter = adapterReason(this.adapter, t - this.adapterSince >= ADAPTER_UNREADY_MS);
    if (adapter) return adapter;
    switch (this.linkState) {
      case 'refused': return BLE_REASON.refused;
      case 'stalled': return BLE_REASON.stalled;
      case 'unsupported': return BLE_REASON.unsupported;
      default: return BLE_REASON.lost;
    }
  }

  /** Reached from the 1 s loop and from link events, whichever comes first after a wake. */
  private evaluate(): void {
    const t = this.now();
    const gap = t - this.checkedAt;
    this.checkedAt = t;
    if (gap > TICK_GAP_MS || gap < 0) {
      this.graceFrom = this.invAt = t;
      this.drainSince = undefined;
    }
    if (this.connected && t - this.invAt >= INV_SILENT_MS) {
      const battery = this.battery(t);
      if (battery === 'off') return this.report(t, { power: 'off', detail: ON_BATTERY_DETAIL });
      if (battery === 'wait') return;
    }
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
    try {
      this.onReading?.(r);
    } catch {
      this.deps.log.warn('ecoflow-ble: reading handler failed');
    }
  }

  private iso(t: number): string { return new Date(t).toISOString(); }
}
