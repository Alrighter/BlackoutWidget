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
const QUOTA_TOPIC = '/open/open-1/SN1/quota', STATUS_TOPIC = '/open/open-1/SN1/status';
const ONLINE: EcoflowDevice[] = [{ sn: 'SN1', online: true, productName: 'RIVER 2' }];
const OFFLINE: EcoflowDevice[] = [{ sn: 'SN1', online: false, productName: 'RIVER 2' }];
const vol = (mv: number) => ({ 'inv.acInVol': mv });
const STALE = 'дані станції не оновлюються';
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
  const src = new EcoflowSource({ sn: 'SN1', clientId: CLIENT_ID }, api, { connect: mqtt.connect, log });
  running.push(src);
  const begin = async () => { src.start(r => readings.push(r)); await flush(); };
  return { api, order, mqtt, log, readings, src, begin, last: () => readings.at(-1) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const send = (c: FakeClient, topic: string, body: unknown) => c.emit('message', topic, Buffer.from(JSON.stringify(body)));
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
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: STALE });
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
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: STALE });
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
  expect(readings.every(r => r.power === 'unknown' && r.reason === STALE)).toBe(true);
});

test('device offline → unknown, never off', async () => {
  const { mqtt, begin, last, readings } = setup({ devices: [OFFLINE], quota: [vol(0), vol(1)] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  send(c, QUOTA_TOPIC, inv(0)); // fresh 0 V from a station that is offline
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

test('quota/all does not overwrite keys MQTT updated within 60 s', async () => {
  const { mqtt, begin, last } = setup({ quota: [vol(229000)] });
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(30 * SEC);
  send(c, QUOTA_TOPIC, inv(0));
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: 'на вході 0 В' });
  await advance(30 * SEC); // quota/all at 1:00 still says 229 V; MQTT wrote the key 30 s ago
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: 'на вході 0 В' });
  await advance(MIN); // 2:00 — 90 s since MQTT: quota/all may write the key again
  expect(last()).toEqual({ power: 'on', observedAt: t(30 * SEC), detail: 'на вході 229 В' });
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
  expect(last()).toEqual({ power: 'unknown', observedAt: t(2 * MIN), reason: STALE });
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
  expect(last()).toEqual({ power: 'unknown', observedAt: t(31 * MIN), reason: STALE });
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

  // A successful connect resets the ladder.
  const c4 = mqtt.last();
  c4.emit('connect');
  c4.emit('close');
  expect(c4.end).toHaveBeenCalledWith(true);
  expect(log.warn).toHaveBeenCalledWith('ecoflow: mqtt closed');
  await advance(10 * SEC);
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
