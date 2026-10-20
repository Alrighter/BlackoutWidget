import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, net } from 'electron';
import { electronHttp } from './providers/electron-http';
import { VoeProvider } from './providers/voe';
import { consoleLogger } from './log';
import { slotRuns } from '../shared/widget-state';

// Live check of the Volyn provider: Kovel streets -> Незалежності houses -> snapshot for house 25, line 1.
// Plain HTTPS from main, no window. A throwaway profile, never the app's (or Electron's default) user data.
const profile = mkdtempSync(join(tmpdir(), 'bw-smoke-voe-'));
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

/**
 * Chromium's helper processes (GPU, network) keep files of the profile open until the app is gone, so on Windows the
 * folder often cannot be removed from inside. Then a detached Node (Electron run as Node, no window) retries for 10 s.
 */
function removeProfile(): void {
  try {
    rmSync(profile, { recursive: true, force: true });
    return;
  } catch { /* still held */ }
  const retry = `const { rmSync } = require('node:fs'); let n = 0; const t = setInterval(() => {
    try { rmSync(process.argv[1], { recursive: true, force: true }); clearInterval(t); } catch { if (++n >= 40) clearInterval(t); }
  }, 250);`;
  spawn(process.execPath, ['-e', retry, profile], {
    detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).unref();
}

app.whenReady().then(async () => {
  const code = await main();
  // Before app.exit: exit ends the process, so nothing after it runs.
  removeProfile();
  app.exit(code);
});
