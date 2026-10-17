import { app } from 'electron';
import { EcoflowApi, deviceLabel } from './actual/ecoflow/api';
import type { EcoflowKeys } from './actual/ecoflow/api';
import { detectGrid } from './actual/ecoflow/grid';
import { normalizeQuotaMessage, parseStatusMessage } from './actual/ecoflow/mqtt-message';
import { maskKey, scrubKeys } from './actual/secrets';
import { electronFetch, mqttConnect } from './actual/electron-deps';
import type { EcoflowRegion } from '../shared/types';

// Live check against a real account. Console only (never userData), read only (subscribe, never publish).
// The one-off clientId counts toward EcoFlow's ~10 clientIds per day per account.
const CLIENT_ID = 'BlackoutWidget-smoke';
const MQTT_WINDOW_MS = 60_000;
// The only readings whose values are printed: the ones detectGrid uses for the AC input.
const AC_KEYS = [
  'inv.acInVol', 'plugInInfoAcInVol', 'hs_yj751_pd_backend_addr.inAcC20Vol', 'inv.acInFreq', 'plugInInfoAcInFeq',
  'plugInInfoAcInFlag', 'inv.inputWatts', 'powGetAcIn', 'hs_yj751_pd_appshow_addr.inAcC20Pwr',
];

const acValues = (q: Record<string, unknown>): string =>
  AC_KEYS.filter(k => k in q).map(k => `${k}=${JSON.stringify(q[k])}`).join(' ') || '(немає ключів входу AC)';

function verdictLine(q: Record<string, unknown>): string {
  const v = detectGrid(q);
  return v.power === 'unknown' ? `unknown (${v.reason}${v.unsupported ? ', unsupported' : ''})` : `${v.power} (${v.detail})`;
}

async function main(): Promise<number> {
  const accessKey = process.env.ECOFLOW_ACCESS_KEY ?? '', secretKey = process.env.ECOFLOW_SECRET_KEY ?? '';
  const region: EcoflowRegion = process.env.ECOFLOW_REGION === 'us' ? 'us' : 'eu';
  if (!accessKey || !secretKey) {
    console.log('Задайте ECOFLOW_ACCESS_KEY і ECOFLOW_SECRET_KEY');
    return 1;
  }
  const keys: EcoflowKeys = { accessKey, secretKey };
  const say = (s: string): void => console.log(scrubKeys(s, keys));
  try {
    const api = new EcoflowApi(region, keys, { fetch: electronFetch });
    say(`Access Key ${maskKey(accessKey)}, регіон ${region}`);
    const devices = await api.listDevices();
    say(`Станцій: ${devices.length}`);
    const merged = new Map<string, Record<string, unknown>>();
    for (const d of devices) {
      say(`- ${deviceLabel(d)} SN ${d.sn} онлайн: ${d.online ? 'так' : 'ні'}`);
      try {
        const q = await api.getQuotaAll(d.sn);
        merged.set(d.sn, { ...q });
        say(`  вердикт: ${verdictLine(q)}`);
        say(`  ${acValues(q)}`);
        say(`  ключі показів (${Object.keys(q).length}): ${Object.keys(q).sort().join(', ')}`);
      } catch (e) {
        say(`  quota/all: ${(e as Error).message}`);
      }
    }
    if (devices.length === 0) return 0;

    const cert = await api.getCertification();
    say(`MQTT ${cert.host}:${cert.port}, clientId ${CLIENT_ID}, слухаємо ${MQTT_WINDOW_MS / 1000} с`);
    const counts = { quota: 0, status: 0 };
    const online = new Map<string, boolean>();
    await new Promise<void>((resolve, reject) => {
      const client = mqttConnect(`mqtts://${cert.host}:${cert.port}`, {
        clientId: CLIENT_ID, username: cert.account, password: cert.password, reconnectPeriod: 0, keepalive: 30, clean: true,
      });
      const topics = new Map<string, { sn: string; kind: 'quota' | 'status' }>();
      for (const d of devices) {
        topics.set(`/open/${cert.account}/${d.sn}/quota`, { sn: d.sn, kind: 'quota' });
        topics.set(`/open/${cert.account}/${d.sn}/status`, { sn: d.sn, kind: 'status' });
      }
      const timer = setTimeout(() => { client.end(true); resolve(); }, MQTT_WINDOW_MS);
      const fail = (err: Error): void => { clearTimeout(timer); client.end(true); reject(err); };
      client.on('connect', () => client.subscribe([...topics.keys()], { qos: 1 }));
      client.on('error', fail);
      client.on('close', () => fail(new Error('MQTT-з’єднання закрито')));
      client.on('message', (topic, payload) => {
        const t = topics.get(topic);
        if (!t) return;
        counts[t.kind]++;
        let msg: unknown;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        if (t.kind === 'quota') {
          const q = normalizeQuotaMessage(msg);
          if (q) merged.set(t.sn, { ...(merged.get(t.sn) ?? {}), ...q });
        } else {
          const s = parseStatusMessage(msg);
          if (s !== null) online.set(t.sn, s);
        }
      });
    });
    say(`MQTT: повідомлень /quota ${counts.quota}, /status ${counts.status}`);
    for (const d of devices) {
      const q = merged.get(d.sn) ?? {};
      const st = online.get(d.sn);
      say(`- ${deviceLabel(d)}: вердикт після злиття ${verdictLine(q)}${st === undefined ? '' : `, status ${st ? 'online' : 'offline'}`}`);
      say(`  ${acValues(q)}`);
    }
    return 0;
  } catch (e) {
    say(`FAILED ${(e as Error).message}`);
    return 1;
  }
}

app.whenReady().then(async () => {
  const code = await main();
  app.exit(code);
});
