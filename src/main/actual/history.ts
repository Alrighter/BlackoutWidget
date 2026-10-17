import type { ActualPower, ActualSegment } from '../../shared/types';
import { JsonStore } from '../store';

export interface Transition { at: string; power: ActualPower; approx?: boolean; lastBefore?: string }
export interface HistoryData { transitions: Transition[]; lastObservedAt?: string }

/** `<userData>/actual-history.json`: transitions in time order plus the time of the last fresh reading. */
export class HistoryStore {
  private readonly file: JsonStore<HistoryData>;

  constructor(filePath: string) {
    this.file = new JsonStore<HistoryData>(filePath, { transitions: [] });
  }

  /** A file of the wrong shape reads as an empty journal; a locked one throws (JsonStore) so it is never overwritten. */
  read(): HistoryData {
    const raw = this.file.read() as Partial<HistoryData> | null;
    const data: HistoryData = { transitions: Array.isArray(raw?.transitions) ? raw.transitions : [] };
    if (typeof raw?.lastObservedAt === 'string') data.lastObservedAt = raw.lastObservedAt;
    return data;
  }

  write(d: HistoryData): void {
    this.file.write(d);
  }
}

/** Everything newer than `nowMs − keepMs`, plus the last transition before it — the state at the cutoff. */
export function pruneTransitions(t: Transition[], nowMs: number, keepMs: number): Transition[] {
  const cutoff = nowMs - keepMs;
  const firstNew = t.findIndex(x => Date.parse(x.at) > cutoff);
  return firstNew === -1 ? t.slice(-1) : t.slice(Math.max(0, firstNew - 1));
}

/** Segments of [sinceMs, nowMs]: one running across `sinceMs` starts there (not approximate); the last one is open. */
export function buildSegments(t: Transition[], nowMs: number, sinceMs: number): ActualSegment[] {
  const runs = t.filter(x => Date.parse(x.at) <= nowMs).filter((x, i, a) => i === 0 || a[i - 1].power !== x.power);
  const segments: ActualSegment[] = [];
  runs.forEach((x, i) => {
    const end = runs[i + 1]?.at;
    if (end !== undefined && Date.parse(end) <= sinceMs) return;
    const clipped = Date.parse(x.at) < sinceMs;
    const seg: ActualSegment = { power: x.power, start: clipped ? new Date(sinceMs).toISOString() : x.at };
    if (x.approx && !clipped) seg.startApprox = true;
    if (end !== undefined) seg.end = end;
    segments.push(seg);
  });
  return segments;
}
