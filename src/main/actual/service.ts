import type { ActualPower, ActualStatus } from '../../shared/types';
import type { Logger } from '../log';
import { buildSegments, pruneTransitions, type HistoryData, type HistoryStore, type Transition } from './history';
import type { ActualReading, ActualStateSource } from './types';

export const CONFIRM_MS = 60_000, STALE_MS = 10 * 60_000, APPROX_GAP_MS = 3 * 60_000,
  KEEP_MS = 30 * 86_400_000, SHOWN_MS = 7 * 86_400_000, OBSERVED_SAVE_MS = 60_000, CHECK_MS = 30_000;
const STALE_REASON = 'дані станції не оновлюються', CHECKING_REASON = 'перевіряю зміну стану';

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Every published state goes through getStatus: a failure there must cost the actual part only, never the DTEK state.
 * Logged once per distinct message, not on every 60 s publish.
 */
export function safeActualStatus(getStatus: () => ActualStatus | null, log: Logger): () => ActualStatus | null {
  let logged: string | undefined;
  return () => {
    try {
      const status = getStatus();
      logged = undefined;
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== logged) log.error('actual: could not compose the status', err);
      logged = message;
      return null;
    }
  };
}

/**
 * Turns readings into a confirmed on/off/unknown state and its transition journal. A change counts once its readings'
 * observation times span CONFIRM_MS (wall-clock time only decides freshness and gaps); a time without fresh data is
 * recorded as `unknown` from the last fresh reading, never as off.
 */
export class ActualStateService {
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private run: { source: ActualStateSource; label: string; timer: ReturnType<typeof setInterval> } | null = null;
  /** Readings from a stopped or replaced source carry an older generation and are ignored. */
  private generation = 0;
  private data: HistoryData = { transitions: [] };
  private confirmed: ActualPower = 'unknown';
  private candidate: { power: 'on' | 'off'; firstAt: number; lastBefore?: number } | undefined;
  private lastObservedAt: number | undefined;
  /** The last fresh reading of the last confirmed on/off state, kept across gaps: the "before" side of a ≈ change. */
  private lastKnownObservedAt: number | undefined;
  private reason: string | undefined;
  private detail: string | undefined;
  private savedAt = -Infinity;
  private observedUnsaved = false;
  private transitioned = false;

  constructor(private readonly deps: { history: HistoryStore; log: Logger; now?: () => number }) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(source: ActualStateSource, sourceLabel: string): void {
    if (this.run) this.shutdown();
    this.data = this.deps.history.read();
    const saved = Date.parse(this.data.lastObservedAt ?? '');
    this.lastObservedAt = this.lastKnownObservedAt = Number.isFinite(saved) ? saved : undefined;
    this.confirmed = 'unknown';
    this.candidate = this.reason = this.detail = undefined;
    this.savedAt = -Infinity;
    this.observedUnsaved = false;
    this.closeJournal();
    const generation = ++this.generation;
    this.run = { source, label: sourceLabel, timer: setInterval(() => this.check(), CHECK_MS) };
    this.emit();
    source.start(r => { if (generation === this.generation) this.handle(r); });
  }

  stop(): void {
    if (!this.run) return;
    this.shutdown();
    this.emit();
  }

  getStatus(): ActualStatus | null {
    if (!this.run) return null;
    const now = this.now();
    const status: ActualStatus = {
      sourceLabel: this.run.label, power: this.confirmed, history: buildSegments(this.data.transitions, now, now - SHOWN_MS),
    };
    if (this.confirmed !== 'unknown') {
      // off → gap → off is one off period: `since` goes back to where it began.
      const segs = buildSegments(this.data.transitions, now, 0);
      let i = segs.length - 1;
      if (segs[i]?.power === this.confirmed) {
        while (i >= 2 && segs[i - 1].power === 'unknown' && segs[i - 2].power === this.confirmed) i -= 2;
        status.since = segs[i].start;
        status.sinceApprox = !!segs[i].startApprox;
      }
    }
    const reason = this.shownReason();
    if (reason !== undefined) status.reason = reason;
    if (this.lastObservedAt !== undefined) status.observedAt = iso(this.lastObservedAt);
    if (this.detail !== undefined) status.detail = this.detail;
    return status;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private handle(r: ActualReading): void {
    this.update(() => {
      const now = this.now();
      this.closeGap(now);
      const observedAt = Date.parse(r.observedAt);
      if (r.power === 'unknown' || !(now - observedAt <= STALE_MS)) {
        this.candidate = undefined;
        if (this.confirmed !== 'unknown') this.toUnknown();
        this.reason = r.power === 'unknown' ? r.reason : STALE_REASON;
        return;
      }
      this.lastObservedAt = observedAt;
      this.reason = undefined;
      this.detail = r.detail;
      if (r.power === this.confirmed) {
        this.candidate = undefined;
        this.lastKnownObservedAt = observedAt;
      } else {
        if (this.candidate?.power !== r.power) this.candidate = { power: r.power, firstAt: observedAt, lastBefore: this.lastKnownObservedAt };
        const { firstAt, lastBefore } = this.candidate;
        // Observed evidence must span CONFIRM_MS (ruling R6): a re-emitted old observation is not 60 s of holding.
        if (observedAt - firstAt >= CONFIRM_MS) {
          this.confirmed = r.power;
          this.candidate = undefined;
          this.lastKnownObservedAt = observedAt;
          const tr: Transition = { at: iso(firstAt), power: r.power, approx: lastBefore !== undefined && firstAt - lastBefore > APPROX_GAP_MS };
          if (lastBefore !== undefined) tr.lastBefore = iso(lastBefore);
          this.record(tr);
        }
      }
      if (now - this.savedAt >= OBSERVED_SAVE_MS) this.save();
      else this.observedUnsaved = true;
    });
  }

  private check(): void {
    this.update(() => {
      const known = this.confirmed !== 'unknown';
      this.closeGap(this.now());
      if (known && this.confirmed === 'unknown') this.reason = STALE_REASON;
    });
  }

  /** No fresh data for over STALE_MS (sleep, hang): the time since the last fresh reading becomes a gap. */
  private closeGap(now: number): void {
    if (this.lastObservedAt === undefined || now - this.lastObservedAt <= STALE_MS) return;
    // A pending change must not span the gap: it has not been seen holding through it.
    this.candidate = undefined;
    if (this.confirmed !== 'unknown') this.toUnknown();
  }

  private toUnknown(): void {
    this.confirmed = 'unknown';
    this.record({ at: iso(this.lastObservedAt ?? this.now()), power: 'unknown' });
  }

  /** A journal must not end in on/off while nothing is watching: close it with a gap from the last fresh reading. */
  private closeJournal(): void {
    const last = this.data.transitions.at(-1);
    if (!last || last.power === 'unknown') return;
    this.record({ at: this.lastObservedAt !== undefined ? iso(this.lastObservedAt) : last.at, power: 'unknown' });
  }

  private shutdown(): void {
    const { source, timer } = this.run!;
    clearInterval(timer);
    this.generation++;
    this.closeJournal();
    if (this.observedUnsaved) this.save();
    this.run = null;
    source.stop();
  }

  private record(tr: Transition): void {
    this.data.transitions = pruneTransitions([...this.data.transitions, tr], this.now(), KEEP_MS);
    this.transitioned = true;
    this.deps.log.info(`actual: ${tr.power} since ${tr.at}${tr.approx ? ' (approx)' : ''}`);
    this.save();
  }

  private save(): void {
    if (this.lastObservedAt !== undefined) this.data.lastObservedAt = iso(this.lastObservedAt);
    this.savedAt = this.now();
    this.observedUnsaved = false;
    try {
      this.deps.history.write(this.data);
    } catch (err) {
      this.deps.log.error('actual: could not save history', err);
    }
  }

  /** Why the state is unknown, as shown: a pending change counts when nothing else explains it (ruling R15). */
  private shownReason(): string | undefined {
    if (this.confirmed !== 'unknown') return undefined;
    return this.reason ?? (this.candidate ? CHECKING_REASON : undefined);
  }

  /**
   * Runs a state change; listeners hear of transitions and of shown-reason changes only. `detail` changes with every
   * rounding of the voltage and nothing displays it at once: the 60 s publish carries it.
   */
  private update(change: () => void): void {
    const { reason } = this, shown = this.shownReason();
    this.transitioned = false;
    change();
    if (this.reason !== reason && this.reason !== undefined) this.deps.log.info(`actual: unknown — ${this.reason}`);
    if (this.transitioned || this.reason !== reason || this.shownReason() !== shown) this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) {
      try { cb(); } catch (err) { this.deps.log.error('ActualStateService listener failed', err); }
    }
  }
}
