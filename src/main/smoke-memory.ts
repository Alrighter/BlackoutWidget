import { app, net } from 'electron';
import { BrowserSession } from './providers/browser-session';
import { electronHttp } from './providers/electron-http';
import { createProviders, findProvider } from './providers/registry';
import { consoleLogger } from './log';
import { makeSmokeProfile, removeSmokeProfile } from './smoke-profile';

// Memory of one DTEK session, the app's heaviest part: the hidden page is loaded, left to settle, then every Electron
// process's memory is printed. Hidden window only; console output only; a throwaway profile, never the app's data.
// `--no-gpu` measures the same with hardware acceleration off.
const PROFILE_PREFIX = 'bw-smoke-memory-';
const profile = makeSmokeProfile(PROFILE_PREFIX);
app.setPath('userData', profile);

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const providerId = arg('--provider') ?? 'dtek-krem';
const settleMs = Number(arg('--settle') ?? '20') * 1000;
if (process.argv.includes('--no-gpu')) app.disableHardwareAcceleration();

// An uncaught error must end the run with a console line, never with Electron's error dialog on the desktop.
process.on('uncaughtException', err => {
  console.log(`FAILED uncaught: ${err.message}`);
  removeSmokeProfile(profile, PROFILE_PREFIX);
  app.exit(1);
});

const mb = (kb: number | undefined) => Math.round((kb ?? 0) / 102.4) / 10;

async function main(): Promise<number> {
  const providers = createProviders(
    o => new BrowserSession(o, consoleLogger), consoleLogger, { fetch: electronHttp, isOnline: () => net.isOnline() },
  );
  try {
    const cities = await findProvider(providers, providerId).listCities();
    await new Promise(r => setTimeout(r, settleMs));
    const rows = app.getAppMetrics().map(m => ({
      type: m.type + (m.serviceName ? ` ${m.serviceName}` : ''), workingSetMB: mb(m.memory.workingSetSize),
      privateMB: mb(m.memory.privateBytes),
    }));
    const total = (k: 'workingSetMB' | 'privateMB') => Math.round(rows.reduce((s, r) => s + r[k], 0) * 10) / 10;
    console.log(JSON.stringify({
      provider: providerId, gpu: !process.argv.includes('--no-gpu'), cities: cities.length, rows,
      totalWorkingSetMB: total('workingSetMB'), totalPrivateMB: total('privateMB'),
    }, null, 2));
    return 0;
  } catch (e) {
    console.log(`FAILED ${(e as Error).constructor.name}: ${(e as Error).message}`);
    return 1;
  } finally {
    for (const p of providers) p.dispose();
  }
}

app.whenReady().then(async () => {
  const code = await main();
  removeSmokeProfile(profile, PROFILE_PREFIX);
  app.exit(code);
});
