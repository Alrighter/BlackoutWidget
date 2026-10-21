import { app, net } from 'electron';
import { electronHttp } from './providers/electron-http';
import type { HttpFetch } from './providers/http';
import { ZtoeProvider } from './providers/ztoe';
import { ztoeSettlements } from './providers/ztoe/settlements';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import type { HouseInfo, ScheduleSnapshot } from '../shared/types';
import { slotRuns } from '../shared/widget-state';

// Live check of the Zhytomyr provider: the bundled city list -> «місто Житомир» -> its streets -> the first street with
// houses -> a house on a queue -> snapshot; then с. Березівка (Хорошівський РЕМ) -> вул. Вишнева the same way. Plain
// HTTPS from main, no window. Prints each request (method, path and query or form ids) with its status, and whether the
// page's update stamp was read: the pages are windows-1251, so a stamp proves Electron's TextDecoder decodes them.
// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-ztoe-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const ZHYTOMYR = 'місто Житомир';
/** с. Березівка of the Хорошівський РЕМ: its label carries the РЕМ (four namesakes). */
const BEREZIVKA = ztoeSettlements().find((s) => s.id === 16205)!.label;
const VYSHNEVA = 'вул. Вишнева';
/** Житомир has 966 streets: the first few (in label order) are tried until one has houses. */
const MAX_STREETS = 8;

const started = Date.now();
const requests: { request: string; status: number | string; atMs: number }[] = [];

const recordingHttp: HttpFetch = async (url, init) => {
  const u = new URL(url);
  // Form bodies and queries carry ids and a settlement name only.
  const request = `${init.method} ${u.pathname}${u.search}${init.body ? ` ${init.body}` : ''}`;
  const atMs = Date.now() - started;
  try {
    const res = await electronHttp(url, init);
    requests.push({ request, status: res.status, atMs });
    return res;
  } catch (e) {
    requests.push({ request, status: (e as Error).name, atMs });
    throw e;
  }
};

/** The least time between two request starts, to show the 1 s spacing held live. */
const minGapMs = (): number | undefined =>
  requests.length < 2 ? undefined : Math.min(...requests.slice(1).map((r, i) => r.atMs - requests[i].atMs));

/** The first house on a queue (its snapshot reads the schedule page), else the first house. */
const pickHouse = (houses: HouseInfo[]): HouseInfo | undefined =>
  houses.find((h) => h.lines.some((l) => l.groupId !== 'none')) ?? houses[0];

async function snapshotOf(provider: ZtoeProvider, city: string, street: string, houses: HouseInfo[]) {
  const house = pickHouse(houses);
  if (!house) throw new Error(`no house on ${street}`);
  const line = house.lines.find((l) => l.groupId !== 'none') ?? house.lines[0];
  const snap: ScheduleSnapshot = await provider.fetchSnapshot({
    providerId: provider.id, city, street, house: house.house, lineIndex: line.index, groupId: line.groupId,
  });
  return {
    city, street, houses: houses.length, house: house.house, houseLines: house.lines,
    groupId: snap.groupId, groupLabel: snap.groupLabel, stampFound: snap.sourceUpdatedAt !== undefined,
    sourceUpdatedAt: snap.sourceUpdatedAt, note: snap.note?.slice(0, 160), lines: snap.lines, currentOutage: snap.currentOutage,
    days: snap.days.map((d) => ({ date: d.date, runs: slotRuns(d.slots) })),
  };
}

async function main(): Promise<number> {
  const provider = new ZtoeProvider({ fetch: recordingHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const cities = await provider.listCities();
    for (const c of [ZHYTOMYR, BEREZIVKA]) if (!cities.includes(c)) throw new Error(`no ${c} among ${cities.length} cities`);

    const streets = await provider.listStreets(ZHYTOMYR);
    let zhytomyr: { street: string; houses: HouseInfo[] } | undefined;
    for (const street of streets.slice(0, MAX_STREETS)) {
      const houses = await provider.listHouses(ZHYTOMYR, street);
      if (houses.length > 0) { zhytomyr = { street, houses }; break; }
    }
    if (!zhytomyr) throw new Error(`no houses on the first ${MAX_STREETS} streets of ${ZHYTOMYR}`);
    const first = await snapshotOf(provider, ZHYTOMYR, zhytomyr.street, zhytomyr.houses);

    const berezivkaStreets = await provider.listStreets(BEREZIVKA);
    if (!berezivkaStreets.includes(VYSHNEVA)) throw new Error(`no ${VYSHNEVA} among ${berezivkaStreets.join(', ')}`);
    const second = await snapshotOf(provider, BEREZIVKA, VYSHNEVA, await provider.listHouses(BEREZIVKA, VYSHNEVA));

    console.log(JSON.stringify({
      cities: cities.length, zhytomyrStreets: streets.length, berezivkaStreets,
      snapshots: [first, second], requests, minGapMs: minGapMs(), elapsedMs: Date.now() - started,
    }, null, 2));
    return first.stampFound || second.stampFound ? 0 : 1;
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
