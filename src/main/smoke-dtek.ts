import { app, session } from 'electron';
import { BrowserSession } from './providers/browser-session';
import { createProviders, findProvider } from './providers/registry';
import { consoleLogger } from './log';
import { slotRuns } from '../shared/widget-state';

const PARTITION = 'persist:dtek-krem';
const offline = process.argv.includes('--offline');

async function main(): Promise<number> {
  const started = Date.now();
  if (offline) await session.fromPartition(PARTITION).enableNetworkEmulation({ offline: true });
  // Console only: the smoke run must never write into a userData log.
  const providers = createProviders(o => new BrowserSession(o, consoleLogger), consoleLogger);
  try {
    const provider = findProvider(providers, 'dtek-krem');
    const snap = await provider.fetchSnapshot({
      providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла',
      house: '40', lineIndex: 1, groupId: 'GPV1.2',
    });
    console.log(JSON.stringify({
      sourceUpdatedAt: snap.sourceUpdatedAt, lines: snap.lines, currentOutage: snap.currentOutage,
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
});
