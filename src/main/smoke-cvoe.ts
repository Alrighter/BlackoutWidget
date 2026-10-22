import { app, net } from 'electron';
import { CvoeProvider } from './providers/cvoe';
import { parseCvoePage } from './providers/cvoe/parse';
import { electronHttp } from './providers/electron-http';
import type { HttpFetch } from './providers/http';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import type { HouseInfo } from '../shared/types';
import { slotRuns } from '../shared/widget-state';

// Live check of the Chernivtsi provider: the bundled list -> «м. Чернівці» -> a street -> a house -> snapshot; then
// «м. Герца» (district 3, the smallest district page) the same way. Plain HTTPS from main, no window. Prints each request
// (method, path, the outage form's fields) with its status, body bytes and duration, and for the schedule page the kind
// and date the reader sees. A Cloudflare block (403 or «Attention Required») is reported, never worked around.
// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-cvoe-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const CHERNIVTSI = 'м. Чернівці';
const HERTSA = 'м. Герца';
/**
 * Planned works were published for 21–23.10.2026 on «вул. КАДЕНЮКА ЛЕОНІДА», 22А among the houses, so the current outage
 * can show live. The search page writes the street «ЛЕОНІДА КАДЕНЮКА»: the outage rows are joined by its words.
 */
const PREFERRED = { street: 'ЛЕОНІДА КАДЕНЮКА', house: '22А' };

interface Request {
  request: string; form?: Record<string, string>; status: number | string; bytes?: number; ms: number; atMs: number; page?: unknown;
}

const started = Date.now();
const requests: Request[] = [];
let blocked = false;

/** The schedule page as the reader sees it; the body itself is never printed. */
function pageKind(html: string): unknown {
  try {
    const p = parseCvoePage(html);
    return p.kind === 'table' ? { kind: p.kind, date: p.date, updatedHM: p.updatedHM, nextLink: p.nextLink } : { kind: p.kind };
  } catch (e) {
    return { kind: 'unreadable', reason: (e as Error).message };
  }
}

/** Each response read once into memory, then served from it: so the bytes and the whole duration can be recorded. */
const recordingHttp: HttpFetch = async (url, init) => {
  const u = new URL(url);
  const t0 = Date.now();
  // The outage form carries the settlement's and street's longest words and the house number only.
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
    if (res.status === 403 || text.includes('Attention Required')) blocked = true;
    if (init.method === 'GET' && u.pathname === '/shutdowns/') req.page = pageKind(text);
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

/** A settlement -> a street (the preferred one when listed, else the first) -> a house -> its snapshot on its first line. */
async function walk(provider: CvoeProvider, city: string, prefer?: { street: string; house: string }) {
  const streets = await provider.listStreets(city);
  const street = prefer && streets.includes(prefer.street) ? prefer.street : streets[0];
  if (!street) throw new Error(`no streets in ${city}`);
  const houses = await provider.listHouses(city, street);
  const house: HouseInfo | undefined = houses.find((h) => h.house === prefer?.house) ?? houses[0];
  if (!house) throw new Error(`no house on ${street}`);
  const line = house.lines[0];
  const snap = await provider.fetchSnapshot({
    providerId: provider.id, city, street, house: house.house, lineIndex: line.index, groupId: line.groupId,
  });
  return {
    city, streets: streets.length, street, houses: houses.length, house: house.house, houseLines: house.lines,
    groupLabel: snap.groupLabel, sourceUpdatedAt: snap.sourceUpdatedAt, note: snap.note, lines: snap.lines,
    currentOutage: snap.currentOutage, days: snap.days.map((d) => ({ date: d.date, runs: slotRuns(d.slots) })),
  };
}

async function main(): Promise<number> {
  const provider = new CvoeProvider({ fetch: recordingHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const cities = await provider.listCities();
    for (const c of [CHERNIVTSI, HERTSA]) if (!cities.includes(c)) throw new Error(`no ${c} among ${cities.length} cities`);
    const first = await walk(provider, CHERNIVTSI, PREFERRED);
    const second = await walk(provider, HERTSA);
    console.log(JSON.stringify({
      cities: cities.length, snapshots: [first, second], requests, minGapMs: minGapMs(), elapsedMs: Date.now() - started,
    }, null, 2));
    if (blocked) console.log('CLOUDFLARE BLOCK: a 403 or an «Attention Required» page came back');
    return blocked ? 1 : 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message} (${Date.now() - started} ms)`);
    if (blocked) console.log('CLOUDFLARE BLOCK: a 403 or an «Attention Required» page came back');
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
