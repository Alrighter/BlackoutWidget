import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { spawnBleHost } from './actual/electron-deps';
import type { HostEvent } from './actual/ecoflow/ble/messages';

// Live check of the Bluetooth host, through the real utilityProcess, with no account: a scan, then the handshake with
// the first EcoFlow station up to its auth status (the host never authenticates on a probe). Console only, read only;
// the SN is printed as its 4-character prefix.
const SCAN_MS = 8_000;
/** The host bounds the probe's search and handshake itself; this only ends a host that never answers. */
const DEADLINE_MS = 75_000;

// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-smoke-ble-';
const removeDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* files still held */ }
};
// Profiles of earlier runs that Chromium still held open at exit; old enough not to be a run in progress.
for (const name of readdirSync(tmpdir())) {
  const dir = join(tmpdir(), name);
  if (name.startsWith(PROFILE_PREFIX) && Date.now() - statSync(dir).mtimeMs > 10 * 60_000) removeDir(dir);
}
const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
app.setPath('userData', profile);

const short = (sn: string): string => `${sn.slice(0, 4)}…`;

function main(): Promise<number> {
  return new Promise(resolve => {
    const host = spawnBleHost();
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      host.kill();
      resolve(code);
    };
    const timer = setTimeout(() => {
      console.log(`FAILED no answer from the host in ${DEADLINE_MS / 1000} s`);
      finish(1);
    }, DEADLINE_MS);
    host.onExit(code => {
      if (!done) console.log(`FAILED the host exited (code ${code})`);
      finish(1);
    });
    host.onEvent((e: HostEvent) => {
      switch (e.ev) {
        case 'adapter':
          console.log(`adapter ${e.state}`);
          break;
        case 'log':
          console.log(`host ${e.level}: ${e.text}`);
          break;
        case 'scan-result':
          console.log(`scan-result: ${e.adverts.length} station(s) in ${SCAN_MS / 1000} s`);
          for (const a of e.adverts) console.log(`  ${short(a.sn)} soc ${a.soc}% rssi ${a.rssi} encryptType ${a.encryptType}`);
          host.post({ cmd: 'probe', id: 2 });
          break;
        case 'probe-result':
          console.log(`probe-result ${e.ok ? 'ok' : 'FAILED'}: ${e.detail}`);
          finish(e.ok ? 0 : 1);
          break;
      }
    });
    host.post({ cmd: 'scan', id: 1, ms: SCAN_MS });
  });
}

app.whenReady().then(async () => {
  const code = await main();
  // app.exit() skips the quit events, so the profile goes here; what Chromium still holds goes on a later run.
  removeDir(profile);
  app.exit(code);
});
