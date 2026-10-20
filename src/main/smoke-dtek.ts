import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, session } from 'electron';
import { BrowserSession } from './providers/browser-session';
import { createProviders, findProvider } from './providers/registry';
import { consoleLogger } from './log';
import type { HouseInfo } from '../shared/types';
import { slotRuns } from '../shared/widget-state';

// Live check of one DTEK site: city -> street -> house -> snapshot. Hidden window only; console output only.
// A throwaway profile, never the app's (or Electron's default) user data.
const profile = mkdtempSync(join(tmpdir(), 'bw-smoke-dtek-'));
app.setPath('userData', profile);

const flag = process.argv.indexOf('--provider');
const providerId = flag >= 0 ? (process.argv[flag + 1] ?? 'dtek-krem') : 'dtek-krem';
const PARTITION = `persist:${providerId}`;
const MAX_TRIES = 5;
const offline = process.argv.includes('--offline');

async function main(): Promise<number> {
  const started = Date.now();
  if (offline) await session.fromPartition(PARTITION).enableNetworkEmulation({ offline: true });
  const providers = createProviders(o => new BrowserSession(o, consoleLogger), consoleLogger);
  try {
    const provider = findProvider(providers, providerId);
    const cities = await provider.listCities();
    // The first city and street are used; a few more only if there is no house with a queue (some places are in no group).
    let city = '', street = '', streets: string[] = [], houses: HouseInfo[] = [];
    let house: HouseInfo | undefined;
    for (let c = 0; !house && c < Math.min(cities.length, MAX_TRIES); c++) {
      city = cities[c];
      streets = await provider.listStreets(city);
      for (let i = 0; !house && i < Math.min(streets.length, MAX_TRIES); i++) {
        street = streets[i];
        houses = await provider.listHouses(city, street);
        house = houses.find(h => h.lines.length > 0);
      }
    }
    if (!house) throw new Error(`no house with lines in the first ${MAX_TRIES} cities x ${MAX_TRIES} streets`);
    const line = house.lines[0];
    const snap = await provider.fetchSnapshot({
      providerId, city, street, house: house.house, lineIndex: line.index, groupId: line.groupId,
    });
    console.log(JSON.stringify({
      provider: providerId, cities: cities.length, city, streets: streets.length, street, houses: houses.length,
      house: house.house, groupId: line.groupId, sourceUpdatedAt: snap.sourceUpdatedAt, lines: snap.lines,
      currentOutage: snap.currentOutage, days: snap.days.map(d => d.date),
      today: slotRuns(snap.days[0]?.slots ?? []), elapsedMs: Date.now() - started,
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message} (${Date.now() - started} ms)`);
    return 1;
  } finally {
    for (const p of providers) p.dispose();
    if (offline) await session.fromPartition(PARTITION).disableNetworkEmulation();
  }
}

app.whenReady().then(async () => {
  const code = await main();
  app.exit(code);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* still held */ }
});
