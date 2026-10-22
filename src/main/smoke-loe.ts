import { app, net } from 'electron';
import { electronHttp } from './providers/electron-http';
import type { HttpFetch } from './providers/http';
import { LoeProvider } from './providers/loe';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import { slotRuns } from '../shared/widget-state';

// Live check of the Lviv provider: the city list -> «Львів» -> one of a few short streets -> the first house with a
// queue -> snapshot. Plain HTTPS from main, no window. Prints each request's path, status and start time: LOE's
// Cloudflare once answered a burst with 429, and the provider spaces its requests 1.5 s apart.
// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-loe-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const CITY = 'Львів';
/** Short streets, tried in this order until one has a house on a queue: a long street's accounts run to megabytes. */
const STREETS = ['Похила', 'Мила', 'Зигзаг'];

const started = Date.now();
const requests: { path: string; status: number | string; atMs: number }[] = [];

const recordingHttp: HttpFetch = async (url, init) => {
  const path = new URL(url).pathname;
  const atMs = Date.now() - started;
  try {
    const res = await electronHttp(url, init);
    requests.push({ path, status: res.status, atMs });
    return res;
  } catch (e) {
    requests.push({ path, status: (e as Error).name, atMs });
    throw e;
  }
};

/** The least time between two request starts, to show the spacing held live. */
const minGapMs = (): number | undefined =>
  requests.length < 2 ? undefined : Math.min(...requests.slice(1).map((r, i) => r.atMs - requests[i].atMs));

async function main(): Promise<number> {
  const provider = new LoeProvider({ fetch: recordingHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const cities = await provider.listCities();
    if (!cities.includes(CITY)) throw new Error(`no ${CITY} among ${cities.length} cities`);
    const streets = await provider.listStreets(CITY);
    let pick: { street: string; houses: number; house: string; lines: { index: number; groupId: string }[] } | undefined;
    for (const street of STREETS.filter((s) => streets.includes(s))) {
      const houses = await provider.listHouses(CITY, street);
      const house = houses.find((h) => h.lines.some((l) => l.groupId !== 'none'));
      if (house) { pick = { street, houses: houses.length, house: house.house, lines: house.lines }; break; }
    }
    if (!pick) throw new Error(`no house with a queue on ${STREETS.join(', ')}`);
    const line = pick.lines.find((l) => l.groupId !== 'none')!;
    const snap = await provider.fetchSnapshot({
      providerId: provider.id, city: CITY, street: pick.street, house: pick.house, lineIndex: line.index, groupId: line.groupId,
    });
    console.log(JSON.stringify({
      cities: cities.length, city: CITY, streets: streets.length, street: pick.street, houses: pick.houses, house: pick.house,
      groupId: snap.groupId, groupLabel: snap.groupLabel, sourceUpdatedAt: snap.sourceUpdatedAt, note: snap.note,
      lines: snap.lines, currentOutage: snap.currentOutage, days: snap.days.map((d) => ({ date: d.date, runs: slotRuns(d.slots) })),
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
