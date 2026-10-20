import type { CurrentOutage, HouseInfo, LineInfo } from '../../../shared/types';
import { kyivDateKey, parseDtekDateTime } from '../../../shared/time';

export interface QueueRow { raion: string; settlement: string; street: string; houses: string[]; gpv: string /* '6.1' or 'none' */ }
export interface OutageRow {
  raion: string; settlement: string; street: string; houses: string[]; type: string; reason: string; start: string; end: string;
}

const HOUSE_RE = /^\d+(?:-?\p{L})?(?:\/\d+(?:-?\p{L})?)?$/u;

export function isHouseNumber(s: string): boolean {
  return HOUSE_RE.test(s);
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Cells (decoded text, `<hr>` as '\n') of every row of the first `table table-sm` element, header row first. */
function tableRows(html: string): string[][] {
  const start = html.search(/<table class=['"]table table-sm/);
  if (start < 0) return [];
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? undefined : end);
  const rows: string[][] = [];
  for (const tr of table.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|$)/gi)) {
    const cells: string[] = [];
    for (const td of tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      cells.push(decode(td[1].replace(/<hr\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, '')).trim());
    }
    rows.push(cells);
  }
  return rows;
}

function splitHouses(cell: string): string[] {
  return cell.split(',').map((h) => h.trim()).filter(isHouseNumber);
}

export function parseQueueTable(html: string): QueueRow[] {
  const out: QueueRow[] = [];
  for (const c of tableRows(html).slice(1)) {
    if (c.length < 5) continue;
    out.push({
      raion: c[0], settlement: c[1], street: c[2], houses: splitHouses(c[3]),
      gpv: c[4] === 'Не залучено' ? 'none' : c[4],
    });
  }
  return out;
}

const collator = new Intl.Collator('uk', { numeric: true });

export function housesOf(rows: QueueRow[], street: string): HouseInfo[] {
  const byHouse = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.street !== street) continue;
    for (const h of r.houses) {
      let set = byHouse.get(h);
      if (!set) byHouse.set(h, (set = new Set()));
      set.add(r.gpv);
    }
  }
  return [...byHouse.keys()].sort(collator.compare).map((house) => {
    const queues = [...byHouse.get(house)!].sort((a, b) =>
      a === 'none' ? 1 : b === 'none' ? -1 : collator.compare(a, b));
    const lines: LineInfo[] = queues.map((q, i) => ({
      index: i + 1, groupId: q, label: q === 'none' ? 'Не залучено до ГПВ' : `Черга ${q}`,
    }));
    return { house, lines, outageActive: false };
  });
}

/** '2026-10-20 09:50' -> '20.10.2026 09:50'; anything else is returned as is. */
function toDtekFormat(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}:\d{2})/.exec(s.trim());
  return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}` : s.trim();
}

export function parseOutageTable(html: string): OutageRow[] {
  const out: OutageRow[] = [];
  for (const c of tableRows(html).slice(1)) {
    if (c.length < 7) continue;
    const [start = '', end = ''] = c[6].split('\n').map(toDtekFormat);
    out.push({ raion: c[0], settlement: c[1], street: c[2], houses: splitHouses(c[3]), type: c[4], reason: c[5], start, end });
  }
  return out;
}

function kindOf(type: string): CurrentOutage['kind'] | undefined {
  if (/графік/i.test(type)) return undefined;
  if (type === 'Аварійне вимкнення') return 'emergency';
  if (type === 'Планове вимкнення') return 'planned';
  return 'other';
}

const RANK = { emergency: 0, planned: 1, other: 2 } as const;

export function matchOutage(
  rows: OutageRow[], at: { settlement: string; street: string; house: string }, now: Date,
): CurrentOutage | undefined {
  const today = kyivDateKey(now);
  const active: { o: CurrentOutage; start: Date }[] = [];
  const later: { o: CurrentOutage; start: Date }[] = [];
  for (const r of rows) {
    if (r.settlement !== at.settlement || r.street !== at.street || !r.houses.includes(at.house)) continue;
    const kind = kindOf(r.type);
    if (!kind) continue;
    const start = parseDtekDateTime(r.start);
    if (!start) continue;
    const end = parseDtekDateTime(r.end);
    const o: CurrentOutage = { kind, text: r.reason, start: r.start, end: r.end };
    if (start <= now && (!end || now < end)) active.push({ o, start });
    else if (start > now && kyivDateKey(start) === today) later.push({ o, start });
  }
  active.sort((a, b) => RANK[a.o.kind] - RANK[b.o.kind]);
  later.sort((a, b) => a.start.getTime() - b.start.getTime());
  return (active[0] ?? later[0])?.o;
}
