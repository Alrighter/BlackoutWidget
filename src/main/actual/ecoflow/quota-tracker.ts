import type { Logger } from '../../log';
import type { ActualReading } from '../types';
import { detectGrid } from './grid';

export const FRESH_MS = 10 * 60_000;
export const WAITING_REASON = 'чекаю на дані від станції';
export const STALE_REASON = 'дані станції не оновлюються';
export const OFFLINE_REASON = 'станція не в мережі';

/** Key order must not make an unchanged snapshot look fresh. */
const canonical = (q: Record<string, unknown>) => JSON.stringify(Object.keys(q).sort().map(k => [k, q[k]]));

export const unknownReading = (now: number, reason: string): ActualReading =>
  ({ power: 'unknown', observedAt: new Date(now).toISOString(), reason });

/**
 * One station's merged quota map and the time of the last real sign of fresh data, shared by both EcoFlow sources.
 * - A push (an MQTT quota message) is always fresh.
 * - A cloud snapshot (quota/all, a get_reply quotaMap) is fresh only when its content changed: the cloud serves its
 *   cache even for an offline station.
 * - Ruling R8 decides which of the two holds a key.
 * A source runs its own checks (errors, offline) first, then takes `reading` for the rest.
 */
export class QuotaTracker {
  /** Null prototype: a `__proto__` key from the cloud stays a plain key. */
  private readonly map: Record<string, unknown> = Object.create(null);
  /** Keys pushed during the current fresh push period (ruling R8). */
  private readonly pushedKeys = new Set<string>();
  private lastSnapshot: string | undefined;
  private freshAt: number | undefined;
  private pushFreshAt: number | undefined;
  private unsupportedLogged = false;

  constructor(private readonly opts: {
    log: Logger;
    /** Log prefix, e.g. `ecoflow`. */
    label: string;
    /**
     * Whether the very first snapshot counts as fresh. The keys source waits for a change (MQTT comes alongside); the
     * account source may have nothing but snapshots, and a steady grid must then go stale rather than wait forever.
     */
    firstSnapshotFresh: boolean;
  }) {}

  /** Merges a cloud snapshot; true when it counted as fresh. */
  snapshot(q: Record<string, unknown>, now: number): boolean {
    const content = canonical(q);
    const fresh = this.lastSnapshot === undefined ? this.opts.firstSnapshotFresh : content !== this.lastSnapshot;
    if (fresh) this.freshAt = now;
    this.lastSnapshot = content;
    // Ruling R8: the cache can lag MQTT, and MQTT pushes a key only when it changes, so while pushes are fresh their
    // keys hold; once they are stale, the snapshot wins every key again.
    if (!this.pushFresh(now)) this.pushedKeys.clear();
    for (const [k, v] of Object.entries(q)) if (!this.pushedKeys.has(k)) this.map[k] = v;
    this.logUnsupported();
    return fresh;
  }

  push(q: Record<string, unknown>, now: number): void {
    if (!this.pushFresh(now)) this.pushedKeys.clear(); // a new fresh period: keys from an earlier one no longer hold
    for (const [k, v] of Object.entries(q)) {
      this.map[k] = v;
      this.pushedKeys.add(k);
    }
    this.freshAt = this.pushFreshAt = now;
    this.logUnsupported();
  }

  pushFresh(now: number): boolean {
    return this.pushFreshAt !== undefined && now - this.pushFreshAt <= FRESH_MS;
  }

  /** No key in the map tells the grid state (an empty map included). */
  get unsupported(): boolean {
    const v = detectGrid(this.map);
    return v.power === 'unknown' && v.unsupported;
  }

  /** Waiting before any fresh data, stale once it is older than FRESH_MS, else the grid verdict at the fresh time. */
  reading(now: number): ActualReading {
    if (this.freshAt === undefined) return unknownReading(now, WAITING_REASON);
    if (now - this.freshAt > FRESH_MS) return unknownReading(now, STALE_REASON);
    const v = detectGrid(this.map);
    if (v.power === 'unknown') return unknownReading(now, v.reason);
    return { power: v.power, observedAt: new Date(this.freshAt).toISOString(), detail: v.detail };
  }

  /** Checked on every map update, fresh or not: a frozen cloud is exactly where an unknown model shows up first. */
  private logUnsupported(): void {
    if (this.unsupportedLogged) return;
    const keys = Object.keys(this.map);
    const v = detectGrid(this.map);
    if (keys.length === 0 || v.power !== 'unknown' || !v.unsupported) return;
    this.unsupportedLogged = true;
    this.opts.log.info(`${this.opts.label}: unsupported quota keys`, keys.sort());
  }
}
