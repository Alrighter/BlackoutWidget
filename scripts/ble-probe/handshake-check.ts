/**
 * SPIKE (throwaway): connects to the nearby RIVER 2, runs the key exchange and the auth-status request, and
 * disconnects without authenticating. Needs no account: it proves the ECDH, the session key and the framing against
 * the real station. Prints the SN prefix only.
 */
import { withBindings } from '@stoprocent/noble';
import { parseAdvert } from '../../src/main/actual/ecoflow/ble/advert';
import { EcoflowBleSession } from '../../src/main/actual/ecoflow/ble/session';

const short = (uuid: string): string => {
  const u = uuid.replace(/-/g, '').toLowerCase();
  if (u.length === 32 && u.endsWith('00001000800000805f9b34fb')) return parseInt(u.slice(0, 8), 16).toString(16);
  return /^[0-9a-f]{4,8}$/.test(u) ? parseInt(u, 16).toString(16) : u;
};

async function main(): Promise<void> {
  const noble = withBindings('default');
  await noble.waitForPoweredOnAsync();
  await noble.startScanningAsync([], true);
  const { peripheral, sn } = await new Promise<{ peripheral: any; sn: string }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('no EcoFlow advert in 30 s')), 30_000);
    noble.on('discover', (p: any) => {
      const a = parseAdvert(p.advertisement?.manufacturerData);
      if (!a) return;
      clearTimeout(timer);
      done({ peripheral: p, sn: a.sn });
    });
  });
  await noble.stopScanningAsync();
  console.log(`found ${sn.slice(0, 4)}…`);
  const t = Date.now();
  const ms = () => `${Date.now() - t} ms`;
  peripheral.once('disconnect', (r: unknown) => console.log(`disconnect (${String(r ?? '')}) at ${ms()}`));
  await peripheral.connectAsync();
  console.log(`connected at ${ms()}, mtu ${peripheral.mtu}`);
  const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
  console.log('characteristics:', characteristics.map((c: any) => `${short(c.uuid)}:${(c.properties ?? []).join('+')}`).join(' '));
  const byUuid = new Map<string, any>(characteristics.map((c: any) => [short(c.uuid), c]));
  const writeChar = byUuid.get('2');
  const notifyChar = byUuid.get('3');
  if (!writeChar || !notifyChar) throw new Error('no 0002/0003 characteristics');
  let packets = 0;
  const s = new EcoflowBleSession({
    userId: '', sn, stopAfterAuthStatus: true,
    write: data => writeChar.writeAsync(data, false),
    onStage: stage => console.log(`stage ${stage} at ${ms()}`),
    onBadFrame: e => console.log(`bad frame: ${e.message}`),
    onPacket: p => {
      packets++;
      console.log(`packet src=${p.src.toString(16)} dst=${p.dst.toString(16)} ${p.cmdSet.toString(16)}/${p.cmdId.toString(16)} len=${p.payload.length}`
        + (p.cmdSet === 0x35 ? ` payload=${p.payload.toString('hex')}` : ''));
    },
  });
  notifyChar.on('data', (d: Buffer) => s.handle(d));
  await notifyChar.subscribeAsync();
  console.log(`subscribed at ${ms()}, mtu ${peripheral.mtu}`);
  try {
    await s.start();
    console.log(`KEY EXCHANGE OK at ${ms()}`);
    // Watch for 3 s whether data flows before auth (it should not).
    await new Promise(r => setTimeout(r, 3000));
  } finally {
    console.log(`packets: ${packets}`);
    try { await peripheral.disconnectAsync(); } catch { /* gone */ }
    noble.stop();
  }
}

main().then(() => process.exit(0), e => { console.error(`FAILED: ${e?.stage ?? ''} ${e?.message ?? e}`); process.exit(1); });
