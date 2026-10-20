import { app, net, session } from 'electron';
import { electronHttp } from './providers/electron-http';
import type { HttpFetch } from './providers/http';
import { ToeProvider } from './providers/toe';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import { slotRuns } from '../shared/widget-state';

// Live check of the Ternopil provider: the city list -> «Тернопіль» -> the first street with houses -> the first of its
// houses that has a queue (via houseLines) -> snapshot. Plain HTTPS from main, no window. Prints the HTTP status of each
// request and the Origin header Chromium sent, if any: the API answers 403 to a `null` or `file://` Origin.
// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-toe-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const CITY = 'Тернопіль';
const MAX_STREETS = 10;
const MAX_HOUSES = 10;

const requests: { path: string; status: number | string }[] = [];
const origins: { path: string; origin: string | null }[] = [];

const recordingHttp: HttpFetch = async (url, init) => {
  const path = new URL(url).pathname;
  try {
    const res = await electronHttp(url, init);
    requests.push({ path, status: res.status });
    return res;
  } catch (e) {
    requests.push({ path, status: (e as Error).name });
    throw e;
  }
};

const gpvStatus = () => requests.filter(r => r.path.endsWith('/a_gpv_g')).map(r => r.status);

async function main(): Promise<number> {
  const started = Date.now();
  const provider = new ToeProvider({ fetch: recordingHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const cities = await provider.listCities();
    if (!cities.includes(CITY)) throw new Error(`no ${CITY} among ${cities.length} cities`);
    const streets = await provider.listStreets(CITY);
    let street: string | undefined;
    let houses: Awaited<ReturnType<ToeProvider['listHouses']>> = [];
    for (const s of streets.slice(0, MAX_STREETS)) {
      houses = await provider.listHouses(CITY, s);
      if (houses.length > 0) { street = s; break; }
    }
    if (!street) throw new Error(`no houses on the first ${MAX_STREETS} streets`);
    let pick: { house: string; lines: Awaited<ReturnType<ToeProvider['houseLines']>> } | undefined;
    for (const h of houses.slice(0, MAX_HOUSES)) {
      const lines = await provider.houseLines(CITY, street, h.house);
      if (lines.some(l => l.groupId !== 'none')) { pick = { house: h.house, lines }; break; }
    }
    if (!pick) throw new Error(`no house with a queue among the first ${MAX_HOUSES} on ${street}`);
    const line = pick.lines.find(l => l.groupId !== 'none')!;
    const snap = await provider.fetchSnapshot({
      providerId: provider.id, city: CITY, street, house: pick.house, lineIndex: line.index, groupId: line.groupId,
    });
    console.log(JSON.stringify({
      cities: cities.length, city: CITY, streets: streets.length, street, houses: houses.length, house: pick.house,
      houseLines: pick.lines, groupId: snap.groupId, groupLabel: snap.groupLabel, sourceUpdatedAt: snap.sourceUpdatedAt,
      note: snap.note, lines: snap.lines, currentOutage: snap.currentOutage,
      days: snap.days.map(d => ({ date: d.date, runs: slotRuns(d.slots) })),
      a_gpv_g: gpvStatus(), requests, originHeaders: origins, elapsedMs: Date.now() - started,
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message} (${Date.now() - started} ms)`);
    console.log(JSON.stringify({ a_gpv_g: gpvStatus(), requests, originHeaders: origins }, null, 2));
    return 1;
  } finally {
    provider.dispose();
  }
}

app.whenReady().then(async () => {
  // Observe only: the headers go out unchanged.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['https://api-poweron.toe.com.ua/*'] }, (details, cb) => {
    const origin = Object.entries(details.requestHeaders).find(([k]) => k.toLowerCase() === 'origin')?.[1] ?? null;
    origins.push({ path: new URL(details.url).pathname, origin });
    cb({});
  });
  const code = await main();
  // Before app.exit: exit ends the process, so nothing after it runs.
  removeSmokeProfile(profile, PROFILE_PREFIX);
  app.exit(code);
});
