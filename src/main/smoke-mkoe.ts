import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, net } from 'electron';
import { electronHttp } from './providers/electron-http';
import type { HttpFetch, HttpResponse } from './providers/http';
import { MkoeProvider } from './providers/mkoe';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import { kyivDateKey } from '../shared/time';
import type { LineInfo } from '../shared/types';
import { slotRuns } from '../shared/widget-state';

// Live check of the Mykolaiv provider: the bundled city list -> «м. Миколаїв» -> a street -> the first of its houses
// with a ГПВ queue (via houseLines) -> snapshot, and a snapshot of an always-on house when one turns up on the way.
// Plain HTTPS from main, no window. Prints each request's path and status. No day with outages has been seen live yet:
// when `v2/schedule/active` is not `[]`, its body (ids, slot types and times only) is saved to the temp folder.
// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-mkoe-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const CITY = 'м. Миколаїв';
const STREETS = ['вул. Маріупольська', 'вул. Шевченка'];
const MAX_HOUSES = 10;

const started = Date.now();
const requests: { path: string; status: number | string }[] = [];
let activeBody: string | undefined;

const recordingHttp: HttpFetch = async (url, init) => {
  const path = new URL(url).pathname;
  let res: HttpResponse;
  try {
    res = await electronHttp(url, init);
  } catch (e) {
    requests.push({ path, status: (e as Error).name });
    throw e;
  }
  requests.push({ path, status: res.status });
  if (path !== '/api/v2/schedule/active') return res;
  // The same body the provider reads, kept for the first real shape.
  const body = await res.text();
  activeBody = body;
  return { ok: res.ok, status: res.status, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
};

/** `[]`, or where the non-empty body was saved. */
function activeReport(): unknown {
  if (activeBody === undefined) return 'not requested';
  if (activeBody.trim() === '[]') return '[]';
  const file = join(tmpdir(), `mkoe-schedule-active-live-${kyivDateKey(new Date())}-${Date.now()}.json`);
  writeFileSync(file, activeBody, 'utf8');
  return { bytes: activeBody.length, savedTo: file };
}

async function main(): Promise<number> {
  const provider = new MkoeProvider({ fetch: recordingHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const cities = await provider.listCities();
    if (!cities.includes(CITY)) throw new Error(`no ${CITY} among ${cities.length} cities`);
    const streets = await provider.listStreets(CITY);
    let pick: { street: string; houses: number; house: string; lines: LineInfo[] } | undefined;
    let noneHouse: { street: string; house: string } | undefined;
    for (const street of STREETS.filter((s) => streets.includes(s))) {
      const houses = await provider.listHouses(CITY, street);
      for (const h of houses.slice(0, MAX_HOUSES)) {
        const lines = await provider.houseLines(CITY, street, h.house);
        if (lines.some((l) => l.groupId !== 'none')) { pick = { street, houses: houses.length, house: h.house, lines }; break; }
        noneHouse ??= { street, house: h.house };
      }
      if (pick) break;
    }
    if (!pick) throw new Error(`no house with a queue among the first ${MAX_HOUSES} on ${STREETS.join(', ')}`);
    const line = pick.lines.find((l) => l.groupId !== 'none')!;
    const snap = await provider.fetchSnapshot({
      providerId: provider.id, city: CITY, street: pick.street, house: pick.house, lineIndex: line.index, groupId: line.groupId,
    });
    const none = noneHouse
      ? await provider.fetchSnapshot({ providerId: provider.id, city: CITY, ...noneHouse, lineIndex: 1, groupId: 'none' })
      : undefined;
    console.log(JSON.stringify({
      cities: cities.length, city: CITY, streets: streets.length, street: pick.street, houses: pick.houses, house: pick.house,
      houseLines: pick.lines, groupId: snap.groupId, groupLabel: snap.groupLabel, sourceUpdatedAt: snap.sourceUpdatedAt,
      note: snap.note, lines: snap.lines, currentOutage: snap.currentOutage,
      days: snap.days.map((d) => ({ date: d.date, runs: slotRuns(d.slots) })),
      noneHouse: none && {
        ...noneHouse, lines: none.lines, currentOutage: none.currentOutage,
        days: none.days.map((d) => ({ date: d.date, runs: slotRuns(d.slots) })),
      },
      active: activeReport(), requests, elapsedMs: Date.now() - started,
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message} (${Date.now() - started} ms)`);
    console.log(JSON.stringify({ active: activeReport(), requests }, null, 2));
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
