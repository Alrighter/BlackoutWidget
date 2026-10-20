import { app, net } from 'electron';
import { electronHttp } from './providers/electron-http';
import { VoeProvider } from './providers/voe';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';
import { slotRuns } from '../shared/widget-state';

// Live check of the Volyn provider: Kovel streets -> Незалежності houses -> snapshot for house 25, line 1.
// Plain HTTPS from main, no window. A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-voe-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const CITY = 'м. Ковель';
const STREET = 'Незалежності';
const HOUSE = '25';

async function main(): Promise<number> {
  const started = Date.now();
  const provider = new VoeProvider({ fetch: electronHttp, isOnline: () => net.isOnline(), log: consoleLogger });
  try {
    const streets = await provider.listStreets(CITY);
    const houses = await provider.listHouses(CITY, STREET);
    const house = houses.find(h => h.house === HOUSE);
    if (!house) throw new Error(`no house ${HOUSE} on ${STREET} among ${houses.length} houses`);
    const line = house.lines[0];
    const snap = await provider.fetchSnapshot({
      providerId: provider.id, city: CITY, street: STREET, house: HOUSE, lineIndex: line.index, groupId: line.groupId,
    });
    console.log(JSON.stringify({
      city: CITY, streets: streets.length, street: STREET, houses: houses.length, house: HOUSE, houseLines: house.lines,
      groupId: snap.groupId, groupLabel: snap.groupLabel, sourceUpdatedAt: snap.sourceUpdatedAt, note: snap.note,
      lines: snap.lines, currentOutage: snap.currentOutage,
      days: snap.days.map(d => ({ date: d.date, runs: slotRuns(d.slots) })), elapsedMs: Date.now() - started,
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message} (${Date.now() - started} ms)`);
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
