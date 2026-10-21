import { app, net } from 'electron';
import { CekProvider } from './providers/cek';
import { extractLocations, parseCekDay } from './providers/cek/parse';
import { electronHttp } from './providers/electron-http';
import type { HttpFetch } from './providers/http';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import type { HouseInfo } from '../shared/types';
import { slotRuns } from '../shared/widget-state';

// Live check of the CEK provider: the map page -> «м. Дніпро» -> a street -> a house with one queue -> snapshot. Plain
// HTTPS from main, no window. Prints each request (method, path, the form's fields) with its status, body bytes and
// duration; for the map page the city, street and house counts the reader sees, and for each form answer what the
// reader makes of it. Bodies are never printed. A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-cek-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const DNIPRO = 'м. Дніпро';

interface Request {
  request: string; form?: Record<string, string>; status: number | string; bytes?: number; ms: number; atMs: number; read?: unknown;
}

const started = Date.now();
const requests: Request[] = [];

/** The map page as the reader sees it: its counts only. */
function mapCounts(html: string): unknown {
  try {
    const map = extractLocations(html);
    const streets = Object.values(map);
    return {
      cities: streets.length,
      streets: streets.reduce((n, s) => n + Object.keys(s).length, 0),
      houses: streets.reduce((n, s) => n + Object.values(s).reduce((m, h) => m + Object.keys(h).length, 0), 0),
    };
  } catch (e) {
    return { kind: 'unreadable', reason: (e as Error).message };
  }
}

/** A form answer as the reader sees it: quiet, or the queues with tables. */
function dayKind(html: string): unknown {
  try {
    const day = parseCekDay(html);
    return day ? { kind: 'tables', queues: Object.keys(day) } : { kind: 'quiet' };
  } catch (e) {
    return { kind: 'unreadable', reason: (e as Error).message };
  }
}

/** Each response read once into memory, then served from it: so the bytes and the whole duration can be recorded. */
const recordingHttp: HttpFetch = async (url, init) => {
  const u = new URL(url);
  const t0 = Date.now();
  const req: Request = { request: `${init.method} ${u.pathname}${u.search}`, status: 'pending', ms: 0, atMs: t0 - started };
  if (init.body) req.form = Object.fromEntries(new URLSearchParams(init.body));
  requests.push(req);
  try {
    const res = await electronHttp(url, init);
    const buf = await res.arrayBuffer();
    req.status = res.status;
    req.bytes = buf.byteLength;
    req.ms = Date.now() - t0;
    const text = new TextDecoder('utf-8').decode(buf);
    if (res.ok) req.read = init.method === 'GET' ? mapCounts(text) : dayKind(text);
    return { ok: res.ok, status: res.status, text: async () => text, arrayBuffer: async () => buf };
  } catch (e) {
    req.status = (e as Error).name;
    req.ms = Date.now() - t0;
    throw e;
  }
};

/** The least time between two request starts, to show the 1 s spacing held live. */
const minGapMs = (): number | undefined =>
  requests.length < 2 ? undefined : Math.min(...requests.slice(1).map((r, i) => r.atMs - requests[i].atMs));

async function main(): Promise<number> {
  const provider = new CekProvider({ fetch: recordingHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const cities = await provider.listCities();
    if (!cities.includes(DNIPRO)) throw new Error(`no ${DNIPRO} among ${cities.length} cities`);
    const streets = await provider.listStreets(DNIPRO);
    const street = streets[0];
    if (!street) throw new Error(`no streets in ${DNIPRO}`);
    const houses = await provider.listHouses(DNIPRO, street);
    const house: HouseInfo | undefined = houses.find((h) => h.lines.length === 1);
    if (!house) throw new Error(`no house with one queue on ${street}`);
    const line = house.lines[0];
    const snap = await provider.fetchSnapshot({
      providerId: provider.id, city: DNIPRO, street, house: house.house, lineIndex: line.index, groupId: line.groupId,
    });
    console.log(JSON.stringify({
      cities: cities.length,
      snapshot: {
        city: DNIPRO, streets: streets.length, street, houses: houses.length, house: house.house, houseLines: house.lines,
        groupLabel: snap.groupLabel, sourceUpdatedAt: snap.sourceUpdatedAt, note: snap.note, lines: snap.lines,
        currentOutage: snap.currentOutage, days: snap.days.map((d) => ({ date: d.date, runs: slotRuns(d.slots) })),
      },
      requests, minGapMs: minGapMs(), elapsedMs: Date.now() - started,
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message} (${Date.now() - started} ms)`);
    console.log(JSON.stringify({ requests, minGapMs: minGapMs() }, null, 2));
    return 1;
  } finally {
    provider.dispose();
  }
}

app.whenReady().then(async () => {
  const code = await main();
  // Before app.exit: exit ends the process, so nothing after it runs.
  removeSmokeProfile(profile, PROFILE_PREFIX);
  app.exit(code);
});
