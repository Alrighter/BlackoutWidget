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
/** The app polls quota/all every 60 s and counts only a change in content as fresh data. */
const QUOTA_GAP_MS = 60_000;
// The only readings whose values are printed: the ones detectGrid uses for the AC input.
const AC_KEYS = [
  'inv.acInVol', 'plugInInfoAcInVol', 'hs_yj751_pd_backend_addr.inAcC20Vol', 'inv.acInFreq', 'plugInInfoAcInFeq',
  'plugInInfoAcInFlag', 'inv.inputWatts', 'powGetAcIn', 'hs_yj751_pd_appshow_addr.inAcC20Pwr',
];
const VOLTAGE_KEYS = ['inv.acInVol', 'plugInInfoAcInVol'];

type Quota = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const acValues = (q: Quota): string =>
  AC_KEYS.filter(k => k in q).map(k => `${k}=${JSON.stringify(q[k])}`).join(' ') || '(немає ключів входу AC)';

const voltageValues = (q: Quota): string =>
  VOLTAGE_KEYS.map(k => `${k}=${k in q ? JSON.stringify(q[k]) : 'немає'}`).join(' ');

function verdictLine(q: Quota): string {
  const v = detectGrid(q);
  return v.power === 'unknown' ? `unknown (${v.reason}${v.unsupported ? ', unsupported' : ''})` : `${v.power} (${v.detail})`;
}

/** Names of the keys whose values differ between two answers, added and removed keys included. */
function changedKeys(a: Quota, b: Quota): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
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
    if (devices.length === 0) {
      say('ПОМИЛКА: в акаунті немає жодної станції, перевіряти нічого');
      return 1;
    }

    // HTTP alone first: an open MQTT session could itself keep the cloud cache moving.
    const first = new Map<string, { q: Quota; at: number }>();
    const merged = new Map<string, Quota>();
    for (const d of devices) {
      say(`- ${deviceLabel(d)} SN ${d.sn} онлайн: ${d.online ? 'так' : 'ні'}`);
      try {
        const q = await api.getQuotaAll(d.sn);
        first.set(d.sn, { q, at: Date.now() });
        merged.set(d.sn, { ...q });
        say(`  вердикт: ${verdictLine(q)}`);
        say(`  ${acValues(q)}`);
        say(`  сирі значення напруги: ${voltageValues(q)} (≈230000 при мережі — мілівольти, ≈230 — вольти)`);
        say(`  ключі показів (${Object.keys(q).length}): ${Object.keys(q).sort().join(', ')}`);
      } catch (e) {
        say(`  quota/all: ${(e as Error).message}`);
      }
    }
    if (first.size > 0) say(`Другий запит quota/all — щонайменше через ${QUOTA_GAP_MS / 1000} с після першого`);
    for (const d of devices) {
      const f = first.get(d.sn);
      if (!f) continue;
      await sleep(f.at + QUOTA_GAP_MS - Date.now());
      try {
        const q = await api.getQuotaAll(d.sn);
        merged.set(d.sn, { ...q });
        const changed = changedKeys(f.q, q);
        say(`- ${deviceLabel(d)}: між запитами ${Math.round((Date.now() - f.at) / 1000)} с`);
        say(changed.length > 0
          ? `  змінилися ключі (${changed.length}): ${changed.join(', ')}`
          : '  НІЧОГО не змінилося: за самим quota/all свіжість даних не визначити, потрібен MQTT');
      } catch (e) {
        say(`  quota/all (другий запит): ${(e as Error).message}`);
      }
    }

    const cert = await api.getCertification();
    say(`MQTT ${cert.host}:${cert.port}, clientId ${CLIENT_ID}, слухаємо ${MQTT_WINDOW_MS / 1000} с`);
    const counts = { quota: 0, status: 0 };
    const online = new Map<string, boolean>();
    const mqttKeys = new Map<string, Set<string>>();
    const firstQuotaSeen = new Set<string>();
    let subscribedAt: number | undefined, listenedMs = 0;
    await new Promise<void>((resolve, reject) => {
      const client = mqttConnect(`mqtts://${cert.host}:${cert.port}`, {
        clientId: CLIENT_ID, username: cert.account, password: cert.password, reconnectPeriod: 0, keepalive: 30, clean: true,
      });
      const topics = new Map<string, { sn: string; kind: 'quota' | 'status' }>();
      for (const d of devices) {
        topics.set(`/open/${cert.account}/${d.sn}/quota`, { sn: d.sn, kind: 'quota' });
        topics.set(`/open/${cert.account}/${d.sn}/status`, { sn: d.sn, kind: 'status' });
      }
      let done = false;
      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (subscribedAt !== undefined) listenedMs = Date.now() - subscribedAt;
        client.end(true);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(), MQTT_WINDOW_MS);
      // Labelled by station and kind: the topic itself holds the certificate account.
      const label = (topic: string): string => { const t = topics.get(topic); return t ? `${t.sn} ${t.kind}` : '?'; };
      const order = [...topics.keys()];
      client.on('connect', () => client.subscribe(order, { qos: 1 }, (err, granted = []) => {
        if (err) {
          // mqtt.js rejects a SUBACK with any refused topic (code bit 0x80); its codes, in topic order, ride on the error.
          const codes = (err as Error & { packet?: { granted?: unknown[] } }).packet?.granted;
          finish(codes
            ? new Error(`брокер не прийняв підписку, коди SUBACK: ${codes.map((c, i) => `${label(order[i])}=${JSON.stringify(c)}`).join(', ')}`)
            : err);
          return;
        }
        say(`SUBACK, QoS: ${granted.map(g => `${label(g.topic)}=${g.qos}`).join(', ')}`);
        subscribedAt = Date.now();
      }));
      client.on('error', finish);
      client.on('close', () => finish(new Error('MQTT-з’єднання закрито')));
      client.on('message', (topic, payload, packet) => {
        const t = topics.get(topic);
        if (!t) return;
        counts[t.kind]++;
        if (t.kind === 'quota' && !firstQuotaSeen.has(t.sn)) {
          firstQuotaSeen.add(t.sn);
          say(`  перше /quota від ${t.sn}: retain ${packet?.retain ? 'так (такі повідомлення застосунок ігнорує)' : 'ні'}`);
        }
        let msg: unknown;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        if (t.kind === 'quota') {
          const q = normalizeQuotaMessage(msg);
          if (!q) return;
          merged.set(t.sn, { ...(merged.get(t.sn) ?? {}), ...q });
          const names = mqttKeys.get(t.sn) ?? new Set<string>();
          for (const k of Object.keys(q)) names.add(k);
          mqttKeys.set(t.sn, names);
        } else {
          const s = parseStatusMessage(msg);
          if (s !== null) online.set(t.sn, s);
        }
      });
    });
    const perMinute = listenedMs > 0 ? (counts.quota / (listenedMs / 60_000)).toFixed(1) : '—';
    say(`MQTT: повідомлень /quota ${counts.quota}, /status ${counts.status}; /quota за хвилину: ${perMinute}`);
    for (const d of devices) {
      const q = merged.get(d.sn) ?? {};
      const st = online.get(d.sn);
      const sent = mqttKeys.get(d.sn) ?? new Set<string>();
      const httpAc = AC_KEYS.filter(k => k in (first.get(d.sn)?.q ?? {}));
      say(`- ${deviceLabel(d)}: вердикт після злиття ${verdictLine(q)}${st === undefined ? '' : `, status ${st ? 'online' : 'offline'}`}`);
      say(`  ${acValues(q)}`);
      say(httpAc.length > 0
        ? `  ключі входу AC з quota/all у MQTT: ${httpAc.map(k => `${k} ${sent.has(k) ? 'так' : 'ні'}`).join(', ')}`
        : `  ключі входу AC у MQTT: ${AC_KEYS.filter(k => sent.has(k)).join(', ') || 'немає'}`);
    }
    if (first.size === 0) {
      say('ПОМИЛКА: жодна станція не віддала дані quota/all');
      return 1;
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
