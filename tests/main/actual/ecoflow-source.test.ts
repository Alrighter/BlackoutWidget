import { EventEmitter } from 'node:events';
import { EcoflowApiError, type EcoflowApiLike, type EcoflowDevice, type FetchLike, type MqttCertificate } from '../../../src/main/actual/ecoflow/api';
import { ecoflowPreview, ecoflowTest } from '../../../src/main/actual/ecoflow/index';
import {
  EcoflowSource, MQTT_AUTH_PAUSE_MS, type MqttClientLike, type MqttConnect,
} from '../../../src/main/actual/ecoflow/source';
import { createActualSources, findActualSource } from '../../../src/main/actual/registry';
import type { ActualReading } from '../../../src/main/actual/types';
import { silentLogger } from '../../../src/main/log';
import { NetworkError } from '../../../src/main/providers/types';

const base = Date.parse('2026-10-17T10:00:00Z');
const SEC = 1000, MIN = 60_000;
const t = (ms: number) => new Date(base + ms).toISOString();
const CERT: MqttCertificate = { account: 'open-1', password: 'pw-secret-42', host: 'mqtt-e.ecoflow.com', port: 8883 };
const CLIENT_ID = 'BlackoutWidget-abc12345';
const KEYS = { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' };
const QUOTA_TOPIC = '/open/open-1/SN1/quota', STATUS_TOPIC = '/open/open-1/SN1/status';
const ONLINE: EcoflowDevice[] = [{ sn: 'SN1', online: true, productName: 'RIVER 2' }];
const OFFLINE: EcoflowDevice[] = [{ sn: 'SN1', online: false, productName: 'RIVER 2' }];
const vol = (mv: number) => ({ 'inv.acInVol': mv });
const STALE = 'дані станції не оновлюються';
const WAITING = 'чекаю на дані від станції';
const NO_LINK = 'немає з’єднання з EcoFlow';
const KEY_8521 = 'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.';

let running: EcoflowSource[] = [];
beforeEach(() => vi.useFakeTimers({ now: base }));
afterEach(() => { running.forEach(s => s.stop()); running = []; vi.useRealTimers(); });

/** Each call takes the next step; the last step repeats. An Error step rejects; a Promise step is returned as is. */
type Step<T> = T | Error | Promise<T>;
const take = <T>(steps: Step<T>[]): Promise<T> => {
  const s = steps.length > 1 ? steps.shift()! : steps[0];
  return s instanceof Error ? Promise.reject(s) : Promise.resolve(s);
};
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

class FakeClient extends EventEmitter implements MqttClientLike {
  subscribe = vi.fn();
  publish = vi.fn();
  end = vi.fn();
}

function fakeMqtt(order: string[] = []) {
  const clients: FakeClient[] = [];
  const connect = vi.fn<MqttConnect>(() => {
    order.push('connect');
    const c = new FakeClient();
    clients.push(c);
    return c;
  });
  return { connect, clients, last: () => clients.at(-1)! };
}

function setup(o: { devices?: Step<EcoflowDevice[]>[]; quota?: Step<Record<string, unknown>>[]; cert?: Step<MqttCertificate>[] } = {}) {
  const order: string[] = [];
  const devices = o.devices ?? [ONLINE], quota = o.quota ?? [vol(229345)], cert = o.cert ?? [CERT];
  const api = {
    listDevices: vi.fn(() => { order.push('list'); return take(devices); }),
    getQuotaAll: vi.fn((_sn: string) => { order.push('quota'); return take(quota); }),
    getCertification: vi.fn(() => { order.push('cert'); return take(cert); }),
  } satisfies EcoflowApiLike;
  const mqtt = fakeMqtt(order);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const readings: ActualReading[] = [];
  const src = new EcoflowSource({ sn: 'SN1', clientId: CLIENT_ID, keys: KEYS }, api, { connect: mqtt.connect, log });
  running.push(src);
  const begin = async () => { src.start(r => readings.push(r)); await flush(); };
  return { api, order, mqtt, log, readings, src, begin, last: () => readings.at(-1) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** mqtt.js passes the PUBLISH packet as the third argument. */
const send = (c: FakeClient, topic: string, body: unknown, packet = { retain: false }) =>
  c.emit('message', topic, Buffer.from(JSON.stringify(body)), packet);
const inv = (acInVol: number) => ({ typeCode: 'invStatus', params: { acInVol } });
const status = (s: 0 | 1) => ({ params: { status: s } });
const authError = () => Object.assign(new Error('Connection refused: Not authorized'), { code: 5 });
const logged = (log: ReturnType<typeof setup>['log']) => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);

test('start: lists, polls, connects with stable clientId and subscribes quota+status', async () => {
  const { api, order, mqtt, log, begin } = setup();
  await begin();
  expect(order).toEqual(['list', 'quota', 'cert', 'connect']);
  expect(api.getQuotaAll).toHaveBeenCalledWith('SN1');
  expect(mqtt.connect).toHaveBeenCalledWith('mqtts://mqtt-e.ecoflow.com:8883', {
    clientId: 'BlackoutWidget-abc12345', username: 'open-1', password: 'pw-secret-42', reconnectPeriod: 0, keepalive: 30, clean: true,
  });
  const c = mqtt.last();
  expect(c.subscribe).not.toHaveBeenCalled();
  c.emit('connect');
  expect(c.subscribe).toHaveBeenCalledWith(['/open/open-1/SN1/quota', '/open/open-1/SN1/status'], { qos: 1 });
  expect(log.info).toHaveBeenCalledWith('ecoflow: mqtt connected');

  await advance(MIN - 1);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(2);
  expect(api.listDevices).toHaveBeenCalledTimes(1);
  await advance(4 * MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(6);
  expect(api.listDevices).toHaveBeenCalledTimes(2);
  expect(api.getCertification).toHaveBeenCalledTimes(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
});

test('MQTT quota message makes data fresh → on with detail', async () => {
  const { mqtt, begin, last, readings } = setup({ quota: [vol(0)] });
  await begin();
  // The cached quota/all says 0 V, but one answer alone is not fresh.
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: WAITING });
  const c = mqtt.last();
  c.emit('connect');
  await advance(10 * SEC);
  send(c, QUOTA_TOPIC, inv(229345));
  expect(last()).toEqual({ power: 'on', observedAt: t(10 * SEC), detail: 'на вході 229 В' });
  // Garbage on the topic is ignored: no reading, no freshness.
  const n = readings.length;
  await advance(SEC);
  c.emit('message', QUOTA_TOPIC, Buffer.from('not json'));
  send(c, QUOTA_TOPIC, { nothing: 1 });
  expect(readings.length).toBe(n);
});

test('identical quota/all without MQTT goes stale after 10 min', async () => {
  const { begin, last, readings } = setup({ quota: [vol(229000), vol(229100), vol(229200), vol(229300)] });
  await begin();
  // Before any sign of fresh data the source is waiting (ruling R15); "stale" is for data that was fresh.
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: WAITING });
  await advance(MIN);
  expect(last()).toEqual({ power: 'on', observedAt: t(MIN), detail: 'на вході 229 В' });
  await advance(2 * MIN);
  expect(last()).toEqual({ power: 'on', observedAt: t(3 * MIN), detail: 'на вході 229 В' });
  await advance(MIN);
  // Same content again: re-emitted with the old freshness time, never "now".
  expect(last()).toEqual({ power: 'on', observedAt: t(3 * MIN), detail: 'на вході 229 В' });
  await advance(9 * MIN); // t = 13 min: exactly 10 min since the last change is still fresh
  expect(last()).toEqual({ power: 'on', observedAt: t(3 * MIN), detail: 'на вході 229 В' });
  await advance(MIN);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(14 * MIN), reason: STALE });
  expect(readings.filter(r => r.power === 'on').every(r => r.observedAt !== t(4 * MIN))).toBe(true);
});

test('first quota/all alone is not fresh', async () => {
  const { mqtt, begin, readings } = setup({ quota: [vol(229345)] });
  await begin();
  mqtt.last().emit('connect');
  await advance(2 * MIN);
  expect(readings.length).toBeGreaterThanOrEqual(3);
  expect(readings.every(r => r.power === 'unknown' && r.reason === WAITING)).toBe(true);
});

test('device offline → unknown, never off', async () => {
  // quota/all changes at 1:00, so 0 V is even "fresh" — the offline list still wins.
  const { begin, last, readings } = setup({ devices: [OFFLINE], quota: [vol(0), vol(1)] });
  await begin();
  await advance(MIN);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(MIN), reason: 'станція не в мережі' });
  expect(readings.length).toBeGreaterThanOrEqual(3);
  expect(readings.every(r => r.power === 'unknown' && r.reason === 'станція не в мережі')).toBe(true);
});

test('station missing from the account → unknown', async () => {
  const { begin, last } = setup({ devices: [[{ sn: 'OTHER', online: true }]] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: 'станцію не знайдено в акаунті' });
});

test('status topic beats the lagging device list while MQTT is connected', async () => {
  const { mqtt, begin, last } = setup({ devices: [ONLINE, OFFLINE] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(30 * SEC);
  send(c, STATUS_TOPIC, status(0)); // the list still says online
  expect(last()).toEqual({ power: 'unknown', observedAt: t(30 * SEC), reason: 'станція не в мережі' });
  await advance(30 * SEC);
  send(c, STATUS_TOPIC, status(1));
  send(c, QUOTA_TOPIC, inv(229345));
  expect(last()).toEqual({ power: 'on', observedAt: t(MIN), detail: 'на вході 229 В' });
  // At 5 min the lagging list flips to offline; /status keeps winning while MQTT is up.
  await advance(4 * MIN);
  expect(last()).toEqual({ power: 'on', observedAt: t(MIN), detail: 'на вході 229 В' });
  // MQTT gone: the list's change is now the most recent one.
  c.emit('close');
  expect(last()).toEqual({ power: 'unknown', observedAt: t(5 * MIN), reason: 'станція не в мережі' });
});

test('a /quota message is online evidence: a /status 0 from an earlier session no longer sticks', async () => {
  const { mqtt, begin, last } = setup(); // the list says online throughout
  await begin();
  const c1 = mqtt.last();
  c1.emit('connect');
  await advance(30 * SEC);
  send(c1, STATUS_TOPIC, status(0));
  c1.emit('close'); // the station comes back while MQTT is down: its /status 1 is missed
  await advance(10 * SEC);
  const c2 = mqtt.last();
  expect(c2).not.toBe(c1);
  c2.emit('connect');
  await advance(5 * MIN); // 5:40 — the 5:00 list still says online, unchanged since boot
  expect(last()).toEqual({ power: 'unknown', observedAt: t(5 * MIN), reason: 'станція не в мережі' });
  send(c2, QUOTA_TOPIC, inv(229345));
  expect(last()).toEqual({ power: 'on', observedAt: t(5 * MIN + 40 * SEC), detail: 'на вході 229 В' });
});

test('quota/all never overwrites a key MQTT sent while MQTT data is fresh (R8)', async () => {
  const { mqtt, begin, last } = setup({ quota: [vol(229345)] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(30 * SEC);
  send(c, QUOTA_TOPIC, inv(0));
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: 'на вході 0 В' });
  // MQTT stays fresh through other keys; the lagging cache keeps saying 229 V.
  for (let m = 1; m <= 3; m++) {
    await advance(m === 1 ? 30 * SEC : MIN);
    send(c, QUOTA_TOPIC, { typeCode: 'pdStatus', params: { soc: 80 + m } });
  }
  expect(last()).toEqual({ power: 'off', observedAt: t(3 * MIN), detail: 'на вході 0 В' });
  await advance(MIN); // 4:00 — a quota/all after the last message
  expect(last()).toEqual({ power: 'off', observedAt: t(3 * MIN), detail: 'на вході 0 В' });
});

test('after MQTT is silent for over 10 min, quota/all values apply again (R8)', async () => {
  const quota = [...Array<Record<string, unknown>>(11).fill(vol(229345)), vol(229400)];
  const { mqtt, begin, last } = setup({ quota });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  send(c, QUOTA_TOPIC, inv(0));
  await advance(10 * MIN); // 10:00 — exactly 10 min since the message: still fresh, the MQTT key holds
  expect(last()).toEqual({ power: 'off', observedAt: t(0), detail: 'на вході 0 В' });
  await advance(MIN); // 11:00 — MQTT stale; quota/all changed, so it is fresh and wins every key
  expect(last()).toEqual({ power: 'on', observedAt: t(11 * MIN), detail: 'на вході 229 В' });
});

test('keys MQTT sent in an earlier fresh period are not protected in a new one (R8)', async () => {
  // quota/all fails 1:00–12:00, so nothing clears the old marks while MQTT is stale.
  const net = new NetworkError('x');
  const quota = [vol(229000), ...Array<Error>(12).fill(net), vol(229000)];
  const { mqtt, begin, last } = setup({ quota });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(30 * SEC);
  send(c, QUOTA_TOPIC, inv(0));
  await advance(12 * MIN); // 12:30 — MQTT back after 12 min of silence, with another key
  send(c, QUOTA_TOPIC, { typeCode: 'pdStatus', params: { soc: 80 } });
  expect(last()).toEqual({ power: 'off', observedAt: t(12.5 * MIN), detail: 'на вході 0 В' });
  await advance(30 * SEC); // 13:00 — quota/all works again and may write inv.acInVol
  expect(last()).toEqual({ power: 'on', observedAt: t(12.5 * MIN), detail: 'на вході 229 В' });
});

test('network error → unknown «немає з’єднання з EcoFlow»; polling continues every 60 s', async () => {
  const net = () => new NetworkError('Немає з’єднання з EcoFlow');
  const { api, log, begin, last } = setup({ quota: [net(), net(), vol(229000), vol(229100), net()] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: NO_LINK });
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(2);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(MIN), reason: NO_LINK });
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(3);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(2 * MIN), reason: WAITING });
  await advance(MIN);
  expect(last()).toEqual({ power: 'on', observedAt: t(3 * MIN), detail: 'на вході 229 В' });
  // Fresh only through quota/all (no MQTT): a new failure decides at once.
  await advance(MIN);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(4 * MIN), reason: NO_LINK });
  // One log line per outage, the code only.
  expect(log.warn.mock.calls.filter(([m]) => m === 'ecoflow: quota/all failed')).toEqual([
    ['ecoflow: quota/all failed', 'network'], ['ecoflow: quota/all failed', 'network'],
  ]);
});

test('a failed device list is over once quota/all works again', async () => {
  // No MQTT here: freshness comes from a changing quota/all, so only the error rule decides.
  const quota = Array.from({ length: 8 }, (_, i) => vol(229000 + i));
  const { begin, last } = setup({ devices: [ONLINE, new NetworkError('x'), ONLINE], quota });
  await begin();
  await advance(5 * MIN); // 5:00 — the list fails, quota/all in the same tick works
  await advance(MIN);
  expect(last()).toEqual({ power: 'on', observedAt: t(6 * MIN), detail: 'на вході 229 В' });
});

test('fresh MQTT quotas outrank a quota/all that keeps answering 1006 (R7)', async () => {
  const { mqtt, log, begin, last } = setup({ quota: [new EcoflowApiError('1006', 'current device is not allowed to get device info')] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: new EcoflowApiError('1006').message });
  const c = mqtt.last();
  c.emit('connect');
  send(c, QUOTA_TOPIC, inv(229345));
  expect(last()).toEqual({ power: 'on', observedAt: t(0), detail: 'на вході 229 В' });
  await advance(30 * SEC);
  send(c, QUOTA_TOPIC, inv(0));
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: 'на вході 0 В' });
  await advance(30 * SEC); // 1:00 — quota/all fails again; the error is only logged
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: 'на вході 0 В' });
  expect(log.warn.mock.calls.filter(([m]) => m === 'ecoflow: quota/all failed')).toEqual([['ecoflow: quota/all failed', '1006']]);

  // MQTT falls silent: once its data is over 10 min old the error still in force decides again.
  await advance(9 * MIN); // 10:00 — 9.5 min since the last message
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: 'на вході 0 В' });
  await advance(MIN);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(11 * MIN), reason: new EcoflowApiError('1006').message });
});

test('network error on HTTP with fresh MQTT quotas → the MQTT verdict (R7)', async () => {
  const net = () => new NetworkError('Немає з’єднання з EcoFlow');
  const { mqtt, begin, last } = setup({ devices: [ONLINE, net()], quota: [vol(229000), net()] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(MIN);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(MIN), reason: NO_LINK });
  await advance(30 * SEC);
  send(c, QUOTA_TOPIC, inv(229345));
  expect(last()).toEqual({ power: 'on', observedAt: t(1.5 * MIN), detail: 'на вході 229 В' });
  // At 5:00 the list fails too; "online" stays the last list flag.
  await advance(4.5 * MIN);
  expect(last()).toEqual({ power: 'on', observedAt: t(1.5 * MIN), detail: 'на вході 229 В' });
});

test('a poll still in flight when its timer fires skips that tick', async () => {
  const slow = deferred<Record<string, unknown>>();
  const { api, begin } = setup({ quota: [vol(229000), slow.promise, vol(229100)] });
  await begin();
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(2);
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(2);
  slow.resolve(vol(229000));
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(3);
});

test('non-key API error → its message as reason; polling stays at 60 s', async () => {
  const { api, begin, last } = setup({ quota: [new EcoflowApiError('1006', 'current device is not allowed to get device info')] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: new EcoflowApiError('1006').message });
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(2);
  // A working device list does not hide the quota/all error.
  await advance(4 * MIN);
  expect(api.listDevices).toHaveBeenCalledTimes(2);
  expect(last()).toMatchObject({ power: 'unknown', reason: new EcoflowApiError('1006').message });
});

test('key error slows HTTP polling to 15 min', async () => {
  const bad = () => new EcoflowApiError('8521');
  const { api, mqtt, log, begin, last } = setup({
    devices: [bad(), bad(), ONLINE], quota: [bad(), bad(), vol(229000)], cert: [bad(), bad(), CERT],
  });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: KEY_8521 });
  const counts = () => [api.listDevices.mock.calls.length, api.getQuotaAll.mock.calls.length, api.getCertification.mock.calls.length];
  expect(counts()).toEqual([1, 1, 1]);
  await advance(15 * MIN - 1);
  expect(counts()).toEqual([1, 1, 1]);
  await advance(1);
  expect(counts()).toEqual([2, 2, 2]);
  expect(mqtt.connect).not.toHaveBeenCalled();
  // Keys work again: certification and MQTT come up, polling is back to every 60 s.
  await advance(15 * MIN);
  expect(counts()).toEqual([3, 3, 3]);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(4);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(31 * MIN), reason: WAITING });
  expect(log.warn).toHaveBeenCalledWith('ecoflow: device list failed', '8521');
  expect(log.warn).toHaveBeenCalledWith('ecoflow: quota/all failed', '8521');
  expect(log.warn).toHaveBeenCalledWith('ecoflow: certification failed', '8521');
});

test('MQTT reconnect backoff 10,20,40 s; auth failure refreshes certification once, then pauses 30 min', async () => {
  const { api, mqtt, log, begin } = setup();
  await begin();
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  for (const [i, ms] of [10 * SEC, 20 * SEC, 40 * SEC].entries()) {
    mqtt.last().emit('close');
    await advance(ms - 1);
    expect(mqtt.connect).toHaveBeenCalledTimes(i + 1);
    await advance(1);
    expect(mqtt.connect).toHaveBeenCalledTimes(i + 2);
  }
  // Ordinary reconnects reuse the certificate.
  expect(api.getCertification).toHaveBeenCalledTimes(1);
  expect(log.warn).not.toHaveBeenCalledWith('ecoflow: mqtt closed');

  // A CONNACK alone does not reset the ladder (ruling R12): the session has not proved itself.
  const c4 = mqtt.last();
  c4.emit('connect');
  c4.emit('close');
  expect(c4.end).toHaveBeenCalledWith(true);
  expect(log.warn).toHaveBeenCalledWith('ecoflow: mqtt closed');
  await advance(80 * SEC - 1);
  expect(mqtt.connect).toHaveBeenCalledTimes(4);
  await advance(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(5);

  // Not authorized: one new certificate and an immediate try (mqtt.js emits error, then close).
  const c5 = mqtt.last();
  c5.emit('error', authError());
  c5.emit('close');
  await flush();
  expect(c5.end).toHaveBeenCalledWith(true);
  expect(api.getCertification).toHaveBeenCalledTimes(2);
  expect(mqtt.connect).toHaveBeenCalledTimes(6);
  // Refused again: pause 30 min, then try with a new certificate.
  mqtt.last().emit('error', authError());
  mqtt.last().emit('close');
  await advance(MQTT_AUTH_PAUSE_MS - 1);
  expect(mqtt.connect).toHaveBeenCalledTimes(6);
  expect(api.getCertification).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(api.getCertification).toHaveBeenCalledTimes(3);
  expect(mqtt.connect).toHaveBeenCalledTimes(7);
  // Late events of an old client change nothing.
  c5.emit('close');
  await advance(10 * MIN);
  expect(mqtt.connect).toHaveBeenCalledTimes(7);

  expect(logged(log)).not.toContain('pw-secret-42');
});

/** Drops the current client before it connects `times` times, so the backoff ladder is past its first step. */
async function climb(mqtt: ReturnType<typeof setup>['mqtt'], times: number) {
  for (const s of [10, 20, 40].slice(0, times)) {
    mqtt.last().emit('close');
    await advance(s * SEC);
  }
}
/** Drops the current client and returns the delay before the next connect, in seconds. */
async function nextDelay(mqtt: ReturnType<typeof setup>['mqtt'], drop: (c: FakeClient) => void = c => c.emit('close')) {
  const n = mqtt.connect.mock.calls.length;
  drop(mqtt.last());
  for (let s = 1; s <= 300; s++) {
    await advance(SEC);
    if (mqtt.connect.mock.calls.length > n) return s;
  }
  return Infinity;
}

test('a session that connects and drops without proving itself climbs the backoff to its cap (R12)', async () => {
  const { mqtt, begin } = setup();
  await begin();
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    const c = mqtt.last();
    c.emit('connect');
    // None of these prove the session: /status, garbage on /quota, a retained /quota or /status replay.
    send(c, STATUS_TOPIC, status(1));
    c.emit('message', QUOTA_TOPIC, Buffer.from('not json'), { retain: false });
    send(c, QUOTA_TOPIC, inv(229345), { retain: true });
    send(c, STATUS_TOPIC, status(1), { retain: true });
    delays.push(await nextDelay(mqtt));
  }
  expect(delays).toEqual([10, 20, 40, 80, 160, 300, 300]);
});

test('a live /quota message proves the session: the next drop waits 10 s again (R12)', async () => {
  const { mqtt, begin } = setup();
  await begin();
  await climb(mqtt, 2);
  const c = mqtt.last();
  c.emit('connect');
  send(c, QUOTA_TOPIC, inv(229345));
  expect(await nextDelay(mqtt)).toBe(10);
  expect(await nextDelay(mqtt)).toBe(20);
});

test('60 s of being connected proves the session; 1 ms less does not (R12)', async () => {
  const { mqtt, begin } = setup();
  await begin();
  await climb(mqtt, 2);
  mqtt.last().emit('connect');
  await advance(60 * SEC - 1);
  expect(await nextDelay(mqtt)).toBe(40);
  mqtt.last().emit('connect');
  await advance(60 * SEC);
  expect(await nextDelay(mqtt)).toBe(10);
});

test('the fresh-certificate retry is earned back by a proven session, not by a CONNACK (R12)', async () => {
  const { api, mqtt, begin } = setup();
  await begin();
  const calls = () => [api.getCertification.mock.calls.length, mqtt.connect.mock.calls.length];
  mqtt.last().emit('error', authError()); // refused: one new certificate, tried at once
  await flush();
  expect(calls()).toEqual([2, 2]);
  mqtt.last().emit('connect'); // accepted, then dropped before proving itself
  expect(await nextDelay(mqtt)).toBe(10);
  mqtt.last().emit('error', authError()); // refused again: no second new certificate, the 30 min pause
  await flush();
  expect(calls()).toEqual([2, 3]);
  await advance(MQTT_AUTH_PAUSE_MS);
  expect(calls()).toEqual([3, 4]);
  const c4 = mqtt.last();
  c4.emit('connect');
  send(c4, QUOTA_TOPIC, inv(229345));
  expect(await nextDelay(mqtt)).toBe(10);
  mqtt.last().emit('error', authError()); // after a proven session a refusal earns a new certificate again
  await flush();
  expect(calls()).toEqual([4, 6]);
});

test.each([4, 134, 135])('CONNACK %i is an auth refusal too: one new certificate, then a 30 min pause', async code => {
  const { api, mqtt, begin } = setup();
  await begin();
  const refused = () => Object.assign(new Error('Connection refused'), { code });
  mqtt.last().emit('error', refused());
  mqtt.last().emit('close');
  await flush();
  expect(api.getCertification).toHaveBeenCalledTimes(2);
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
  mqtt.last().emit('error', refused());
  await advance(MQTT_AUTH_PAUSE_MS - 1);
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
  await advance(1);
  expect(api.getCertification).toHaveBeenCalledTimes(3);
  expect(mqtt.connect).toHaveBeenCalledTimes(3);
});

test('a retained /quota message changes nothing: no merge, no freshness, no reading (R18)', async () => {
  const { mqtt, begin, last, readings } = setup({ quota: [vol(0)] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(10 * SEC);
  const n = readings.length;
  send(c, QUOTA_TOPIC, inv(229345), { retain: true });
  expect(readings.length).toBe(n);
  // 1:00 — an unchanged quota/all: still no sign of fresh data.
  await advance(50 * SEC);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(MIN), reason: WAITING });
  // A live message of another key makes the data fresh: the voltage is still the 0 V from quota/all.
  await advance(10 * SEC);
  send(c, QUOTA_TOPIC, { typeCode: 'pdStatus', params: { soc: 80 } });
  expect(last()).toEqual({ power: 'off', observedAt: t(70 * SEC), detail: 'на вході 0 В' });
  expect(readings.some(r => r.power === 'on')).toBe(false);
});

test('a retained /status 0 does not make the station offline; the device list and live /status still decide (R18)', async () => {
  // No live /quota here: it would count as online evidence by itself.
  const { mqtt, begin, last, readings } = setup({ quota: [vol(229000), vol(229100)] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(10 * SEC);
  const n = readings.length;
  send(c, STATUS_TOPIC, status(0), { retain: true });
  expect(readings.length).toBe(n);
  await advance(50 * SEC); // 1:00 — quota/all changed, so fresh; the list says online
  expect(last()).toEqual({ power: 'on', observedAt: t(MIN), detail: 'на вході 229 В' });
  send(c, STATUS_TOPIC, status(0));
  expect(last()).toEqual({ power: 'unknown', observedAt: t(MIN), reason: 'станція не в мережі' });
});

test('a retained replay after a reconnect cannot bring back an old value stamped with an old time (R18)', async () => {
  const { mqtt, begin, last, readings } = setup({ quota: [vol(0)] });
  await begin();
  const c1 = mqtt.last();
  c1.emit('connect');
  send(c1, QUOTA_TOPIC, inv(0));
  expect(last()).toEqual({ power: 'off', observedAt: t(0), detail: 'на вході 0 В' });
  c1.emit('close');
  await advance(10 * SEC);
  const c2 = mqtt.last();
  c2.emit('connect');
  send(c2, QUOTA_TOPIC, inv(229345), { retain: true }); // the broker's last message, replayed on subscribe
  await advance(10 * SEC);
  send(c2, QUOTA_TOPIC, { typeCode: 'pdStatus', params: { soc: 80 } });
  expect(last()).toEqual({ power: 'off', observedAt: t(20 * SEC), detail: 'на вході 0 В' });
  expect(readings.some(r => r.power === 'on')).toBe(false);
});

test('a server echo of the keys never reaches a reading or a log line', async () => {
  const echo = `accessKey=${KEYS.accessKey} secretKey=${KEYS.secretKey}`;
  const odd = () => new EcoflowApiError(`E-${KEYS.accessKey}`, echo); // even a server "code" is server text
  const { log, begin, last, readings } = setup({ devices: [odd()], quota: [new EcoflowApiError('9999', echo)], cert: [odd()] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: 'Помилка EcoFlow 9999: accessKey=AKEY… secretKey=…' });
  expect(log.warn).toHaveBeenCalledWith('ecoflow: device list failed', 'E-AKEY…');
  expect(log.warn).toHaveBeenCalledWith('ecoflow: certification failed', 'E-AKEY…');
  for (const text of [JSON.stringify(readings), logged(log)]) {
    expect(text).not.toContain(KEYS.accessKey);
    expect(text).not.toContain(KEYS.secretKey);
  }
});

test('stop() clears timers and ends the client; no readings afterwards', async () => {
  const { api, mqtt, src, begin, readings } = setup({ quota: [vol(229000), vol(229100)] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  send(c, QUOTA_TOPIC, inv(229345));
  const n = readings.length;
  src.stop();
  expect(c.end).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
  send(c, QUOTA_TOPIC, inv(0));
  c.emit('close');
  await advance(30 * MIN);
  expect(readings.length).toBe(n);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
});

test('stop() during a request drops the late result; pending certificate or retry never connects', async () => {
  // A late success that would end the key-error slowdown must not re-arm a timer either.
  const quota = deferred<Record<string, unknown>>();
  const a = setup({ quota: [new EcoflowApiError('8521'), quota.promise] });
  await a.begin();
  await advance(15 * MIN);
  expect(a.api.getQuotaAll).toHaveBeenCalledTimes(2);
  const n = a.readings.length;
  a.src.stop();
  quota.resolve(vol(229345));
  await flush();
  expect(a.readings.length).toBe(n);
  expect(vi.getTimerCount()).toBe(0);

  const cert = deferred<MqttCertificate>();
  const b = setup({ cert: [cert.promise] });
  await b.begin();
  b.src.stop();
  cert.resolve(CERT);
  await flush();
  expect(b.mqtt.connect).not.toHaveBeenCalled();

  const c = setup();
  await c.begin();
  c.mqtt.last().emit('close'); // reconnect pending in 10 s
  c.src.stop();
  await advance(MIN);
  expect(c.mqtt.connect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  const d = setup();
  await d.begin();
  d.mqtt.last().emit('connect'); // the 60 s session-proof timer is running
  d.src.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test('a throwing consumer is logged; start-up and polling go on', async () => {
  const { api, mqtt, log, src } = setup();
  src.start(() => { throw new Error('boom'); });
  await flush();
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  await advance(MIN);
  expect(api.getQuotaAll).toHaveBeenCalledTimes(2);
  expect(log.error).toHaveBeenCalledWith('ecoflow: reading handler failed', expect.any(Error));
});

test('unsupported keys are logged once, names only', async () => {
  const { mqtt, log, begin, last } = setup({ quota: [{ zeta: 5, alpha: 1 }] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  send(c, QUOTA_TOPIC, { params: { beta: 7 } });
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: 'модель поки не підтримується' });
  await advance(3 * MIN);
  const calls = log.info.mock.calls.filter(([m]) => m === 'ecoflow: unsupported quota keys');
  expect(calls).toEqual([['ecoflow: unsupported quota keys', ['alpha', 'zeta']]]);
});

test('ecoflowPreview uses HTTP only', async () => {
  const { api, mqtt } = setup();
  expect(await ecoflowPreview(api, 'SN1')).toEqual({ online: true, verdict: { power: 'on', detail: 'на вході 229 В' } });
  expect(await ecoflowPreview(api, 'NOPE')).toMatchObject({ online: false });
  expect(api.getCertification).not.toHaveBeenCalled();
  expect(mqtt.connect).not.toHaveBeenCalled();
  expect(await ecoflowTest(api)).toEqual(ONLINE);
});

test('registry: the EcoFlow factory wires region, keys and the stable clientId', async () => {
  const fetch = vi.fn<FetchLike>(async url => {
    const data = url.includes('/device/list') ? [{ sn: 'SN1', online: 1 }]
      : url.includes('/quota/all') ? vol(229345)
      : { certificateAccount: 'open-1', certificatePassword: 'pw', url: 'mqtt-e.ecoflow.com', port: '8883' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data }) };
  });
  const mqtt = fakeMqtt();
  const list = createActualSources({ fetch, connect: mqtt.connect });
  const factory = findActualSource(list, 'ecoflow');
  expect([factory.id, factory.displayName]).toEqual(['ecoflow', 'EcoFlow']);
  expect(() => findActualSource(list, 'nope')).toThrow('nope');

  const src = factory.create(
    { id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accessKeyHint: 'AKEY…' },
    { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' },
    { clientId: CLIENT_ID, log: silentLogger },
  );
  running.push(src as EcoflowSource);
  src.start(() => {});
  await flush();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://api-e.ecoflow.com/iot-open/sign/device/list',
    'https://api-e.ecoflow.com/iot-open/sign/device/quota/all?sn=SN1',
    'https://api-e.ecoflow.com/iot-open/sign/certification',
  ]);
  expect(fetch.mock.calls[0][1].headers.accessKey).toBe('AKEY1234567');
  expect(mqtt.connect).toHaveBeenCalledWith('mqtts://mqtt-e.ecoflow.com:8883', expect.objectContaining({ clientId: CLIENT_ID, username: 'open-1' }));
});

test('registry: the created source knows its keys and scrubs a server echo of them', async () => {
  const fetch = vi.fn<FetchLike>(async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ code: '9999', message: 'accessKey=AKEY1234567 secretKey=SECRET-xyz' }),
  }));
  const src = findActualSource(createActualSources({ fetch, connect: fakeMqtt().connect }), 'ecoflow').create(
    { id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accessKeyHint: 'AKEY…' },
    { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' },
    { clientId: CLIENT_ID, log: silentLogger },
  );
  running.push(src as EcoflowSource);
  const readings: ActualReading[] = [];
  src.start(r => readings.push(r));
  await flush();
  expect(readings.at(-1)).toEqual({ power: 'unknown', observedAt: t(0), reason: 'Помилка EcoFlow 9999: accessKey=AKEY… secretKey=…' });
});
