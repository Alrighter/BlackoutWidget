import { EventEmitter } from 'node:events';
import { EcoflowApiError, type EcoflowDevice, type FetchLike, type MqttCertificate } from '../../../src/main/actual/ecoflow/api';
import type { AppSession, EcoflowAppApiLike } from '../../../src/main/actual/ecoflow/app-api';
import {
  APP_AUTH_REFUSED_REASON, APP_NO_DATA_REASON, APP_UNSUPPORTED_REASON, appAuthPauseReason, EcoflowAppSource, LOGIN_RETRY_MS,
  LOGIN_TRANSIENT_RETRY_MS,
} from '../../../src/main/actual/ecoflow/app-source';
import { AFTER_SAVE_REASON, ecoflowAppPreview, ecoflowAppTest, PREVIEW_WAIT_MS } from '../../../src/main/actual/ecoflow/index';
import { FRESH_MS } from '../../../src/main/actual/ecoflow/quota-tracker';
import { NO_LINK_REASON, type MqttClientLike, type MqttConnect } from '../../../src/main/actual/ecoflow/source';
import { createActualSources, findActualSource } from '../../../src/main/actual/registry';
import type { ActualReading } from '../../../src/main/actual/types';
import { silentLogger } from '../../../src/main/log';
import { NetworkError } from '../../../src/main/providers/types';
import type { ActualSourceConfig } from '../../../src/shared/types';

const base = Date.parse('2026-10-18T10:00:00Z');
const SEC = 1000, MIN = 60_000;
const t = (ms: number) => new Date(base + ms).toISOString();

const EMAIL = 'roman.test@example.com', PASSWORD = 'pässwörd-77', B64 = Buffer.from(PASSWORD, 'utf8').toString('base64');
const TOKEN = 'jwt-token-abc', USER_ID = '1234567890123456789';
const SESSION: AppSession = { token: TOKEN, userId: USER_ID };
const CERT: MqttCertificate = { account: 'app-xyz', password: 'cert-pw-99', host: 'mqtt-e.ecoflow.com', port: 8883 };
const SECRETS = [EMAIL, PASSWORD, B64, TOKEN, USER_ID, CERT.password];
const UUID = 'A1B2C3D4E5F60718293A4B5C6D7E8F90';
const SN = 'R601ABC';
const PROPERTY = '/app/device/property/R601ABC';
const REPLY = `/app/${USER_ID}/R601ABC/thing/property/get_reply`;
const GET = `/app/${USER_ID}/R601ABC/thing/property/get`;
const PROTOBUF = Buffer.from('0a141020182070', 'hex');
const ON = { 'inv.acInVol': 227718, 'inv.acInFreq': 50 }, OFF = { 'inv.acInVol': 0, 'inv.acInFreq': 0 };
const ON_DETAIL = 'на вході 228 В', OFF_DETAIL = 'на вході 0 В';
const STALE = 'дані станції не оновлюються', WAITING = 'чекаю на дані від станції', OFFLINE = 'станція не в мережі';
const NO_LINK = 'немає з’єднання з EcoFlow';

let running: EcoflowAppSource[] = [];
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

type SubscribeCb = (err: Error | null, granted?: { topic: string; qos: number }[]) => void;
class FakeClient extends EventEmitter implements MqttClientLike {
  subscribe = vi.fn<MqttClientLike['subscribe']>();
  publish = vi.fn<MqttClientLike['publish']>();
  /** mqtt.js emits close once the connection is down, also after end(). */
  end = vi.fn<MqttClientLike['end']>(() => { this.emit('close'); });
  /** The callback of the subscribe call for `topic`. */
  subscribed(topic: string): SubscribeCb {
    const call = this.subscribe.mock.calls.find(([topics]) => topics[0] === topic);
    if (!call) throw new Error(`not subscribed: ${topic}`);
    return call[2] as SubscribeCb;
  }
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

function setup(o: { login?: Step<AppSession>[]; cert?: Step<MqttCertificate>[] } = {}) {
  const order: string[] = [];
  const login = o.login ?? [SESSION], cert = o.cert ?? [CERT];
  const api = {
    login: vi.fn(() => { order.push('login'); return take(login); }),
    getCertification: vi.fn((_s: AppSession) => { order.push('cert'); return take(cert); }),
    listDevices: vi.fn((_s: AppSession) => { order.push('list'); return Promise.resolve<EcoflowDevice[]>([]); }),
  } satisfies EcoflowAppApiLike;
  const mqtt = fakeMqtt(order);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const readings: ActualReading[] = [];
  const src = new EcoflowAppSource(
    { sn: SN, clientUuid: UUID, account: { email: EMAIL, password: PASSWORD } }, api, { connect: mqtt.connect, log },
  );
  running.push(src);
  const begin = async () => { src.start(r => readings.push(r)); await flush(); };
  return { api, order, mqtt, log, readings, src, begin, last: () => readings.at(-1) };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const send = (c: FakeClient, topic: string, body: unknown, packet = { retain: false }) =>
  c.emit('message', topic, Buffer.from(JSON.stringify(body)), packet);
const push = (c: FakeClient, params: Record<string, unknown>, packet = { retain: false }) =>
  send(c, PROPERTY, { id: 1330299626203776316, version: '1.0', timestamp: 1669603259, moduleType: '3', params }, packet);
const getReply = (quotaMap: Record<string, unknown>, online = 1) =>
  ({ code: '0', id: 179531081, moduleType: 0, operateType: 'latestQuotas', version: '1.1', data: { sn: SN, online, quotaMap } });
const reply = (c: FakeClient, quotaMap: Record<string, unknown>, online = 1, packet = { retain: false }) =>
  send(c, REPLY, getReply(quotaMap, online), packet);
const gets = (c: FakeClient) => c.publish.mock.calls.filter(([topic]) => topic === GET).length;
const authError = (code = 5) => Object.assign(new Error('Connection refused: Not authorized'), { code });
/** Every logger call as text; an Error argument counts with its name, message and stack (JSON alone makes it `{}`). */
const logged = (log: ReturnType<typeof setup>['log']) => JSON.stringify(
  [log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls],
  (_k, v: unknown) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack}` : v),
);

/** Drops the current client and returns the delay before the next connect, in seconds. */
async function nextDelay(mqtt: ReturnType<typeof fakeMqtt>) {
  const n = mqtt.connect.mock.calls.length;
  mqtt.last().emit('close');
  for (let s = 1; s <= 300; s++) {
    await advance(SEC);
    if (mqtt.connect.mock.calls.length > n) return s;
  }
  return Infinity;
}

test('start: logs in, certifies, then connects as ANDROID_<uuid>_<userId>', async () => {
  const { api, order, mqtt, begin, last } = setup();
  await begin();
  expect(order).toEqual(['login', 'cert', 'connect']);
  expect(api.getCertification).toHaveBeenCalledWith(SESSION);
  expect(api.listDevices).not.toHaveBeenCalled();
  expect(mqtt.connect).toHaveBeenCalledWith('mqtts://mqtt-e.ecoflow.com:8883', {
    clientId: `ANDROID_${UUID}_1234567890123456789`, username: 'app-xyz', password: 'cert-pw-99',
    reconnectPeriod: 0, keepalive: 30, clean: true,
  });
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: WAITING });
});

test('on connect: two separate subscribes, then one latestQuotas request; nothing ever goes to /set', async () => {
  const { mqtt, log, begin } = setup();
  await begin();
  const c = mqtt.last();
  expect(c.subscribe).not.toHaveBeenCalled();
  expect(c.publish).not.toHaveBeenCalled();
  await advance(5 * SEC);
  c.emit('connect');
  expect(c.subscribe.mock.calls.map(([topics, opts]) => [topics, opts])).toEqual([
    [[PROPERTY], { qos: 1 }],
    [[REPLY], { qos: 1 }],
  ]);
  expect(c.publish).toHaveBeenCalledTimes(1);
  const [topic, payload, opts] = c.publish.mock.calls[0];
  expect([topic, opts]).toEqual([GET, { qos: 1 }]);
  expect(JSON.parse(payload)).toEqual({
    from: 'Android', id: String(base + 5 * SEC), moduleType: 0, operateType: 'latestQuotas', params: {}, version: '1.1',
  });
  // Sent without waiting for the SUBACKs: a refused topic must not hold the request back (ioBroker #456).
  expect(c.subscribe.mock.invocationCallOrder[1]).toBeLessThan(c.publish.mock.invocationCallOrder[0]);
  expect(log.info).toHaveBeenCalledWith('ecoflow-app: mqtt connected');

  await advance(30 * MIN);
  expect(mqtt.clients.flatMap(x => x.publish.mock.calls.map(([tp]) => tp)).every(tp => tp === GET)).toBe(true);
});

test('get timer: the next request comes after 300 s', async () => {
  const { mqtt, begin } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  c.subscribed(PROPERTY)(null, [{ topic: PROPERTY, qos: 1 }]);
  c.subscribed(REPLY)(null, [{ topic: REPLY, qos: 1 }]);
  await advance(300 * SEC - 1);
  expect(gets(c)).toBe(1);
  await advance(1);
  expect(gets(c)).toBe(2);
  push(c, ON); // keeps the watchdog quiet
  await advance(300 * SEC);
  expect(gets(c)).toBe(3);
});

test.each([
  ['an error', (cb: SubscribeCb) => cb(Object.assign(new Error('Subscribe error: Unspecified error'), { code: 128 }))],
  ['granted QoS 128', (cb: SubscribeCb) => cb(null, [{ topic: PROPERTY, qos: 128 }])],
])('a refused property topic (%s): requests every 120 s and the timer keeps running', async (_name, refuse) => {
  const { mqtt, log, begin } = setup();
  await begin();
  const c1 = mqtt.last();
  c1.emit('connect');
  refuse(c1.subscribed(PROPERTY));
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: property topic refused');
  await advance(120 * SEC - 1);
  expect(gets(c1)).toBe(1);
  await advance(1);
  expect(gets(c1)).toBe(2);
  reply(c1, ON);
  await advance(120 * SEC);
  expect(gets(c1)).toBe(3);

  // A new connection asks again: granted this time, back to 300 s.
  c1.emit('close');
  await advance(10 * SEC);
  const c2 = mqtt.last();
  expect(c2).not.toBe(c1);
  c2.emit('connect');
  c2.subscribed(PROPERTY)(null, [{ topic: PROPERTY, qos: 1 }]);
  await advance(300 * SEC - 1);
  expect(gets(c2)).toBe(1);
  await advance(1);
  expect(gets(c2)).toBe(2);
});

test('a refused snapshot topic is logged; the requests go on', async () => {
  const { mqtt, log, begin } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  c.subscribed(REPLY)(null, [{ topic: REPLY, qos: 128 }]);
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: snapshot topic refused');
  push(c, ON);
  await advance(300 * SEC);
  expect(gets(c)).toBe(2);
});

test('property pushes: on, then off; a 19-digit id parses fine', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(10 * SEC);
  c.emit('message', PROPERTY, Buffer.from(
    '{"id":1330299626203776316,"version":"1.0","timestamp":1669603259,"moduleType":"3","params":{"inv.acInVol":227718,"inv.acInFreq":50}}',
  ), { retain: false });
  expect(last()).toEqual({ power: 'on', observedAt: t(10 * SEC), detail: ON_DETAIL });
  await advance(20 * SEC);
  push(c, OFF);
  expect(last()).toEqual({ power: 'off', observedAt: t(30 * SEC), detail: OFF_DETAIL });
  // A push of other keys is fresh too.
  await advance(20 * SEC);
  push(c, { 'bms_bmsStatus.f32ShowSoc': 89.7 });
  expect(last()).toEqual({ power: 'off', observedAt: t(50 * SEC), detail: OFF_DETAIL });
});

test('retained messages are ignored on both topics (R18)', async () => {
  const { mqtt, log, begin, readings } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  const n = readings.length;
  push(c, ON, { retain: true });
  reply(c, ON, 1, { retain: true });
  reply(c, {}, 0, { retain: true });
  c.emit('message', PROPERTY, PROTOBUF, { retain: true });
  c.emit('message', REPLY, PROTOBUF, { retain: true });
  expect(readings.length).toBe(n);
  expect(logged(log)).not.toContain('protobuf');
});

test('get_reply: on; an identical reply is no news; only identical replies go stale, even across a watchdog reconnect', async () => {
  const { api, mqtt, begin, last } = setup();
  await begin();
  const c1 = mqtt.last();
  c1.emit('connect');
  await advance(SEC);
  reply(c1, ON);
  expect(last()).toEqual({ power: 'on', observedAt: t(SEC), detail: ON_DETAIL });
  await advance(299 * SEC); // 5:00 — the next request, the same answer (key order aside)
  expect(gets(c1)).toBe(2);
  reply(c1, { 'inv.acInFreq': 50, 'inv.acInVol': 227718 });
  expect(last()).toEqual({ power: 'on', observedAt: t(SEC), detail: ON_DETAIL });
  await advance(300 * SEC); // 10:00 — exactly FRESH_MS - 1 s since the snapshot
  reply(c1, ON);
  expect(last()).toEqual({ power: 'on', observedAt: t(SEC), detail: ON_DETAIL });
  // 10:01 — nothing fresh for twice the request interval: the watchdog reconnects once, no new login.
  await advance(SEC);
  expect(c1.end).toHaveBeenCalledWith(true);
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
  const c2 = mqtt.last();
  c2.emit('connect');
  await advance(SEC); // 10:02 — the cloud's cache again: still no news, now older than FRESH_MS
  reply(c2, ON);
  expect(Date.now() - (base + SEC)).toBeGreaterThan(FRESH_MS);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(602 * SEC), reason: STALE });
  // Once per stall: the same silence never reconnects again.
  await advance(20 * MIN);
  reply(c2, ON);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(30 * MIN + 2 * SEC), reason: STALE });
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
  expect(api.login).toHaveBeenCalledTimes(1);
});

test('get_reply: a changed snapshot is fresh again', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  reply(c, ON);
  await advance(300 * SEC);
  reply(c, { ...ON, 'inv.acInVol': 228100 });
  expect(last()).toEqual({ power: 'on', observedAt: t(300 * SEC), detail: ON_DETAIL });
});

test('get_reply online 0 → unknown «станція не в мережі»; a push brings it back', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  reply(c, ON);
  expect(last()).toMatchObject({ power: 'on' });
  await advance(10 * SEC);
  send(c, REPLY, { code: '0', operateType: 'latestQuotas', data: { online: 0 } });
  expect(last()).toEqual({ power: 'unknown', observedAt: t(10 * SEC), reason: OFFLINE });
  await advance(10 * SEC);
  push(c, OFF);
  expect(last()).toEqual({ power: 'off', observedAt: t(20 * SEC), detail: OFF_DETAIL });
});

test('a snapshot never overwrites a key the property topic pushed while pushes are fresh (R8)', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  push(c, OFF);
  await advance(10 * SEC);
  reply(c, ON); // the first snapshot, so fresh, but lagging behind the push
  expect(last()).toEqual({ power: 'off', observedAt: t(10 * SEC), detail: OFF_DETAIL });
});

test.each([PROPERTY, REPLY])('a protobuf payload on %s → unsupported, logged once', async topic => {
  const { mqtt, log, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  await advance(SEC);
  c.emit('message', topic, PROTOBUF, { retain: false });
  expect(last()).toEqual({ power: 'unknown', observedAt: t(SEC), reason: APP_UNSUPPORTED_REASON });
  expect(APP_UNSUPPORTED_REASON).toBe('Ця модель EcoFlow поки не підтримується входом через акаунт');
  for (let i = 0; i < 3; i++) {
    await advance(SEC);
    c.emit('message', PROPERTY, PROTOBUF, { retain: false });
    c.emit('message', REPLY, PROTOBUF, { retain: false });
  }
  // A JSON answer without any grid key does not hide it either.
  reply(c, { 'pd.soc': 80 });
  expect(last()).toEqual({ power: 'unknown', observedAt: t(4 * SEC), reason: APP_UNSUPPORTED_REASON });
  const lines = [...log.info.mock.calls, ...log.warn.mock.calls].filter(([m]) => String(m).includes('protobuf'));
  expect(lines).toEqual([['ecoflow-app: protobuf payload, this model is not supported']]);
  expect(logged(log)).not.toContain('0a14');
});

test('a stray binary frame does not hide real grid data', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  push(c, ON);
  c.emit('message', PROPERTY, Buffer.from('not json'), { retain: false });
  expect(last()).toEqual({ power: 'on', observedAt: t(0), detail: ON_DETAIL });
});

test('unsupported JSON keys: the existing reason, key names logged once', async () => {
  const { mqtt, log, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  push(c, { 'zeta.x': 1 });
  reply(c, { 'alpha.y': 2 });
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: 'модель поки не підтримується' });
  expect(log.info.mock.calls.filter(([m]) => m === 'ecoflow-app: unsupported quota keys'))
    .toEqual([['ecoflow-app: unsupported quota keys', ['zeta.x']]]);
});

test('watchdog: 600 s connected without fresh data → one reconnect with the same certificate, no login', async () => {
  const { api, mqtt, log, begin } = setup();
  await begin();
  const c1 = mqtt.last();
  c1.emit('connect');
  push(c1, ON);
  await advance(600 * SEC - 1);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(c1.end).toHaveBeenCalledWith(true);
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
  expect(mqtt.connect.mock.calls[1]).toEqual(mqtt.connect.mock.calls[0]);
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: no fresh data, reconnecting');
  // The old client's close schedules nothing; the silence goes on, and the watchdog stays quiet.
  const c2 = mqtt.last();
  c2.emit('connect');
  await advance(20 * MIN);
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
  // Fresh data ends the stall; the next one earns another reconnect.
  push(c2, ON);
  await advance(600 * SEC);
  expect(mqtt.connect).toHaveBeenCalledTimes(3);
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([1, 1]);
});

test('nothing at all from the station by the watchdog → a reason, never a silent wait', async () => {
  const { mqtt, log, begin, last } = setup();
  await begin();
  const c1 = mqtt.last();
  c1.emit('connect');
  c1.subscribed(PROPERTY)(null, [{ topic: PROPERTY, qos: 128 }]); // and the JSON request goes unanswered
  await advance(240 * SEC - 1);
  expect(last()).toMatchObject({ reason: WAITING });
  await advance(1);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(240 * SEC), reason: APP_NO_DATA_REASON });
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: nothing from the station, reconnecting');
  const c2 = mqtt.last();
  c2.emit('connect');
  await advance(10 * MIN);
  expect(last()).toMatchObject({ reason: APP_NO_DATA_REASON });
  // The first answer ends it.
  reply(c2, ON);
  expect(last()).toEqual({ power: 'on', observedAt: t(840 * SEC), detail: ON_DETAIL });
});

test('a reply with neither a quotaMap nor offline is no word from the station: the watchdog gives the no-data reason', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  c.subscribed(PROPERTY)(null, [{ topic: PROPERTY, qos: 128 }]);
  await advance(SEC);
  send(c, REPLY, { code: '0', operateType: 'latestQuotas', data: { sn: SN, online: 1 } });
  expect(last()).toMatchObject({ reason: WAITING });
  await advance(239 * SEC);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(240 * SEC), reason: APP_NO_DATA_REASON });
});

test('watchdog with a refused property topic: twice the 120 s interval', async () => {
  const { mqtt, begin } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect');
  c.subscribed(PROPERTY)(null, [{ topic: PROPERTY, qos: 128 }]);
  await advance(240 * SEC - 1);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(2);
});

test('close or error: reconnect backoff 10, 20, 40 s with the same certificate', async () => {
  const { api, mqtt, log, begin } = setup();
  await begin();
  expect(await nextDelay(mqtt)).toBe(10);
  expect(await nextDelay(mqtt)).toBe(20);
  const n = mqtt.connect.mock.calls.length;
  mqtt.last().emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: undefined }));
  await advance(40 * SEC - 1);
  expect(mqtt.connect).toHaveBeenCalledTimes(n);
  await advance(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(n + 1);
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([1, 1]);
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: mqtt error', 'Error');
});

test('a session that connects and drops without proving itself climbs to the cap (R12)', async () => {
  const { mqtt, begin } = setup();
  await begin();
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    const c = mqtt.last();
    c.emit('connect');
    // A snapshot answers the request, it does not prove the session.
    reply(c, { ...ON, 'inv.acInVol': 227000 + i });
    delays.push(await nextDelay(mqtt));
  }
  expect(delays).toEqual([10, 20, 40, 80, 160, 300, 300]);
});

test('60 s connected or a live push proves the session: the next drop waits 10 s again (R12)', async () => {
  const { mqtt, begin } = setup();
  await begin();
  expect(await nextDelay(mqtt)).toBe(10);
  expect(await nextDelay(mqtt)).toBe(20);
  mqtt.last().emit('connect');
  await advance(60 * SEC - 1);
  expect(await nextDelay(mqtt)).toBe(40);
  mqtt.last().emit('connect');
  await advance(60 * SEC);
  expect(await nextDelay(mqtt)).toBe(10);
  expect(await nextDelay(mqtt)).toBe(20);
  const c = mqtt.last();
  c.emit('connect');
  push(c, ON);
  expect(await nextDelay(mqtt)).toBe(10);
});

test.each([5, 4, 134, 135])('CONNACK %i: one full login and certification, then a 30 min pause', async code => {
  const { order, mqtt, log, begin } = setup();
  await begin();
  mqtt.last().emit('error', authError(code));
  mqtt.last().emit('close');
  await flush();
  expect(order).toEqual(['login', 'cert', 'connect', 'login', 'cert', 'connect']);
  mqtt.last().emit('error', authError(code));
  await advance(LOGIN_RETRY_MS[0] - 1);
  expect(order).toHaveLength(6);
  await advance(1);
  expect(order.slice(6)).toEqual(['login', 'cert', 'connect']);
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: mqtt not authorized, signing in again');
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: mqtt not authorized again, pausing 30 min');
});

test('the 30 min auth pause shows its reason; it clears when the pause ends', async () => {
  const { mqtt, begin, last } = setup();
  await begin();
  mqtt.last().emit('error', authError());
  await flush(); // the one immediate re-login: no pause, no reason
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: WAITING });
  await advance(SEC);
  mqtt.last().emit('error', authError());
  expect(last()).toEqual({ power: 'unknown', observedAt: t(SEC), reason: appAuthPauseReason(30) });
  expect(appAuthPauseReason(30)).toBe('EcoFlow не пустив до даних станції — наступна спроба приблизно за 30 хв');
  await advance(LOGIN_RETRY_MS[0] - 1);
  expect(last()).toMatchObject({ reason: appAuthPauseReason(30) });
  await advance(1); // the pause is over: a fresh login and certificate
  expect(last()).toEqual({ power: 'unknown', observedAt: t(SEC + LOGIN_RETRY_MS[0]), reason: WAITING });
  const c = mqtt.last();
  c.emit('connect');
  push(c, ON);
  expect(last()).toMatchObject({ power: 'on' });
});

test('a refusal that lasts: the pauses climb 30, 60, 120 min and stay; each ends in one login; a proven session starts over', async () => {
  const { api, mqtt, log, begin, last } = setup();
  await begin();
  mqtt.last().emit('error', authError());
  await flush(); // the one immediate re-login
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([2, 2]);
  for (const [i, wait] of [30, 60, 120, 120].entries()) {
    mqtt.last().emit('error', authError());
    expect(last()).toMatchObject({ power: 'unknown', reason: appAuthPauseReason(wait) });
    expect(log.warn).toHaveBeenLastCalledWith(`ecoflow-app: mqtt not authorized again, pausing ${wait} min`);
    await advance(wait * MIN - 1);
    expect(api.login).toHaveBeenCalledTimes(2 + i);
    await advance(1);
    expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([3 + i, 3 + i]);
  }
  expect(appAuthPauseReason(120)).toBe('EcoFlow не пустив до даних станції — наступна спроба приблизно за 120 хв');
  // 60 s connected proves the session (R12): the next refusal earns the immediate re-login again, then 30 min.
  const c = mqtt.last();
  c.emit('connect');
  await advance(60 * SEC);
  c.emit('error', authError());
  await flush();
  expect(api.login).toHaveBeenCalledTimes(7);
  mqtt.last().emit('error', authError());
  expect(last()).toMatchObject({ reason: appAuthPauseReason(30) });
  await advance(30 * MIN);
  expect(api.login).toHaveBeenCalledTimes(8);
});

test('three failed connects in a row before any CONNACK → «немає з’єднання з EcoFlow»; the backoff goes on; a CONNACK clears it', async () => {
  const { mqtt, log, begin, last } = setup();
  await begin();
  mqtt.last().emit('error', new Error('connect ETIMEDOUT')); // port 8883 blocked, say
  expect(last()).toMatchObject({ reason: WAITING });
  mqtt.connect.mockImplementationOnce(() => { throw new Error('boom'); });
  await advance(10 * SEC); // the second try throws at once
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: mqtt connect failed', 'Error');
  expect(last()).toMatchObject({ reason: WAITING });
  await advance(20 * SEC);
  mqtt.last().emit('close');
  expect(last()).toEqual({ power: 'unknown', observedAt: t(30 * SEC), reason: NO_LINK });
  expect(NO_LINK_REASON).toBe(NO_LINK);
  await advance(40 * SEC);
  expect(mqtt.connect).toHaveBeenCalledTimes(4);
  mqtt.last().emit('connect');
  expect(last()).toEqual({ power: 'unknown', observedAt: t(70 * SEC), reason: WAITING });
});

test('a refused CONNACK is an answer: it does not count as a failed connect', async () => {
  const { mqtt, begin, readings } = setup();
  await begin();
  mqtt.last().emit('close');
  await advance(10 * SEC);
  mqtt.last().emit('close');
  await advance(20 * SEC);
  mqtt.last().emit('error', authError()); // the broker answered; the re-login follows
  await flush();
  mqtt.last().emit('close');
  expect(readings.some(r => r.reason === NO_LINK)).toBe(false);
});

test('the re-login after a refusal is earned back by a proven session', async () => {
  const { api, mqtt, begin } = setup();
  await begin();
  mqtt.last().emit('error', authError());
  await flush();
  const c = mqtt.last();
  c.emit('connect');
  push(c, ON);
  mqtt.last().emit('error', authError());
  await flush();
  expect(api.login).toHaveBeenCalledTimes(3);
  expect(mqtt.connect).toHaveBeenCalledTimes(3);
});

test('login rejected (2026): its message as the reason; retries after 30, 60, then 120 min, staying at 120', async () => {
  const e2026 = () => new EcoflowApiError('2026', 'Account doesn’t exist or incorrect password');
  const { api, mqtt, log, begin, last } = setup({ login: [e2026(), e2026(), e2026(), e2026(), e2026(), SESSION] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: e2026().message });
  expect(api.getCertification).not.toHaveBeenCalled();
  expect(mqtt.connect).not.toHaveBeenCalled();
  let at = 0;
  for (const [i, wait] of [30, 60, 120, 120, 120].entries()) {
    await advance(wait * MIN - 1);
    expect(api.login).toHaveBeenCalledTimes(i + 1);
    await advance(1);
    at += wait * MIN;
    expect(api.login).toHaveBeenCalledTimes(i + 2);
  }
  expect(LOGIN_RETRY_MS).toEqual([30 * MIN, 60 * MIN, 120 * MIN]);
  // The sixth try works: the reason clears and MQTT comes up.
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  expect(last()).toEqual({ power: 'unknown', observedAt: t(at), reason: WAITING });
  // One log line per kind of failure, the code only.
  expect(log.warn.mock.calls.filter(([m]) => m === 'ecoflow-app: login failed')).toEqual([['ecoflow-app: login failed', '2026']]);
});

test('login network error: «немає з’єднання з EcoFlow»; retries after 1, 2, 5, 10, then 30 min, staying at 30', async () => {
  const net = () => new NetworkError('Немає з’єднання з EcoFlow');
  const { api, mqtt, begin, last } = setup({ login: [net(), net(), net(), net(), net(), net(), SESSION] });
  await begin();
  expect(last()).toEqual({ power: 'unknown', observedAt: t(0), reason: NO_LINK });
  for (const [i, wait] of [1, 2, 5, 10, 30, 30].entries()) {
    await advance(wait * MIN - 1);
    expect(api.login).toHaveBeenCalledTimes(i + 1);
    await advance(1);
    expect(api.login).toHaveBeenCalledTimes(i + 2);
  }
  expect(LOGIN_TRANSIENT_RETRY_MS).toEqual([1, 2, 5, 10, 30].map(m => m * MIN));
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
});

test.each([
  ['timeout', 10 * SEC], ['bad-json', 10 * SEC], ['http-500', 10 * SEC],
])('certification %s: retried on the MQTT backoff with the same login', async (code, wait) => {
  const { api, mqtt, begin, last } = setup({ cert: [new EcoflowApiError(code), new NetworkError('x'), CERT] });
  await begin();
  expect(last()).toMatchObject({ power: 'unknown', reason: new EcoflowApiError(code).message });
  await advance(wait - 1);
  expect(api.getCertification).toHaveBeenCalledTimes(1);
  await advance(1);
  await advance(20 * SEC); // a network failure next: still no new login
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([1, 3]);
  expect(api.getCertification.mock.calls.every(([s]) => s === SESSION)).toBe(true);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  // The session is not kept once certified: a refused CONNACK logs in afresh.
  mqtt.last().emit('error', authError());
  await flush();
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([2, 4]);
});

test.each([
  ['1005', 30 * MIN], ['http-403', 30 * MIN], ['9999', 30 * MIN],
])('certification %s: a rejection waits %i ms, then logs in afresh', async (code, wait) => {
  const { api, begin, last } = setup({ cert: [new EcoflowApiError(code), CERT] });
  await begin();
  expect(last()).toMatchObject({ power: 'unknown', reason: new EcoflowApiError(code).message });
  await advance(wait - 1);
  expect(api.getCertification).toHaveBeenCalledTimes(1);
  await advance(1);
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([2, 2]);
});

test.each(['timeout', 'bad-json', 'http-500'])('login %s: the transient schedule, first retry after 1 min', async code => {
  const { api, begin } = setup({ login: [new EcoflowApiError(code), SESSION] });
  await begin();
  await advance(MIN - 1);
  expect(api.login).toHaveBeenCalledTimes(1);
  await advance(1);
  expect([api.login.mock.calls.length, api.getCertification.mock.calls.length]).toEqual([2, 1]);
});

test('transient and rejected logins count separately', async () => {
  const net = () => new NetworkError('x'), e2026 = () => new EcoflowApiError('2026');
  const { api, begin } = setup({ login: [net(), e2026(), net(), SESSION] });
  await begin();
  await advance(MIN); // the 1st transient waited 1 min; the 1st rejection now waits 30 min
  await advance(30 * MIN); // the 2nd transient waits 2 min
  expect(api.login).toHaveBeenCalledTimes(3);
  await advance(2 * MIN - 1);
  expect(api.login).toHaveBeenCalledTimes(3);
  await advance(1);
  expect(api.login).toHaveBeenCalledTimes(4);
});

test('no secret reaches a reading or a log line, even when the server echoes them', async () => {
  // A server can echo only what it was sent or issued: the account at login, the session at certification.
  const loginEcho = `email=${EMAIL} password=${PASSWORD} b64=${B64}`;
  const certEcho = `email=${EMAIL} b64=${B64} token=${TOKEN} user=${USER_ID}`;
  const { mqtt, log, begin, readings } = setup({
    login: [new EcoflowApiError(`E-${EMAIL}`, loginEcho), SESSION],
    cert: [new EcoflowApiError(`E-${TOKEN}-${USER_ID}`, certEcho), CERT],
  });
  await begin();
  expect(readings.at(-1)?.reason).toBe('Помилка EcoFlow E-…: email=… password=… b64=…');
  await advance(30 * MIN); // login works, certification echoes the token and the userId
  expect(readings.at(-1)?.reason).toBe('Помилка EcoFlow E-…-…: email=… b64=… token=… user=…');
  await advance(60 * MIN); // now all of it works
  const c1 = mqtt.last();
  c1.emit('connect');
  c1.subscribed(PROPERTY)(new Error('Subscribe error'));
  push(c1, ON);
  c1.emit('message', REPLY, PROTOBUF, { retain: false });
  c1.emit('error', authError());
  await flush();
  const c2 = mqtt.last();
  c2.emit('connect');
  await advance(20 * MIN); // the watchdog
  c2.emit('close');
  await advance(MIN);
  for (const text of [JSON.stringify(readings), logged(log)]) {
    for (const s of SECRETS) expect(text).not.toContain(s);
  }
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: login failed', 'E-…');
  expect(log.warn).toHaveBeenCalledWith('ecoflow-app: certification failed', 'E-…-…');
});

test('stop() clears every timer and ends the client; no readings afterwards', async () => {
  const { api, mqtt, src, begin, readings } = setup();
  await begin();
  const c = mqtt.last();
  c.emit('connect'); // the request, watchdog and session-proof timers are running
  push(c, ON);
  const n = readings.length;
  src.stop();
  expect(c.end).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
  push(c, OFF);
  reply(c, OFF);
  c.emit('message', PROPERTY, PROTOBUF, { retain: false });
  c.emit('close');
  await advance(3 * 60 * MIN);
  expect(readings.length).toBe(n);
  expect(gets(c)).toBe(1);
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  expect(api.login).toHaveBeenCalledTimes(1);
});

test('stop() during sign-in or a retry wait never connects', async () => {
  const login = deferred<AppSession>();
  const a = setup({ login: [login.promise] });
  await a.begin();
  a.src.stop();
  login.resolve(SESSION);
  await flush();
  expect(a.api.getCertification).not.toHaveBeenCalled();
  expect(a.mqtt.connect).not.toHaveBeenCalled();
  expect(a.readings).toEqual([]);

  const cert = deferred<MqttCertificate>();
  const b = setup({ cert: [cert.promise] });
  await b.begin();
  b.src.stop();
  cert.resolve(CERT);
  await flush();
  expect(b.mqtt.connect).not.toHaveBeenCalled();

  const c = setup({ login: [new EcoflowApiError('2026'), SESSION] });
  await c.begin();
  c.src.stop();
  expect(vi.getTimerCount()).toBe(0);
  await advance(3 * 60 * MIN);
  expect(c.api.login).toHaveBeenCalledTimes(1);

  const d = setup();
  await d.begin();
  d.mqtt.last().emit('close'); // reconnect pending in 10 s
  d.src.stop();
  expect(vi.getTimerCount()).toBe(0);
});

test('stop() from the reading handler during sign-in never connects', async () => {
  const { mqtt, src } = setup();
  src.start(() => src.stop()); // the first reading comes from the finished sign-in itself
  await flush();
  expect(mqtt.connect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('a throwing consumer is logged; the source goes on', async () => {
  const { mqtt, log, src } = setup();
  src.start(() => { throw new Error('boom'); });
  await flush();
  expect(mqtt.connect).toHaveBeenCalledTimes(1);
  const c = mqtt.last();
  c.emit('connect');
  push(c, ON);
  await advance(300 * SEC);
  expect(gets(c)).toBe(2);
  expect(log.error).toHaveBeenCalledWith('ecoflow-app: reading handler failed', expect.any(Error));
});

// --- factory, test and preview ---

const APP_CONFIG = { id: 'ecoflow-app', region: 'eu', deviceSn: SN, deviceName: 'RIVER 2', accountHint: 'r…@example.com' } as unknown as ActualSourceConfig;

test('registry: the ecoflow-app factory signs in with the account and connects as ANDROID_<uuid>_<userId>', async () => {
  const fetch = vi.fn<FetchLike>(async url => {
    const data = url.includes('/auth/login') ? { token: TOKEN, user: { userId: USER_ID } }
      : { certificateAccount: 'app-xyz', certificatePassword: 'cert-pw-99', url: 'mqtt-e.ecoflow.com', port: '8883' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', data }) };
  });
  const mqtt = fakeMqtt();
  const factory = findActualSource(createActualSources({ fetch, connect: mqtt.connect }), 'ecoflow-app');
  expect([factory.id, factory.displayName]).toEqual(['ecoflow-app', 'EcoFlow']);
  const src = factory.create(APP_CONFIG, { email: EMAIL, password: PASSWORD }, { clientId: UUID, log: silentLogger });
  running.push(src as EcoflowAppSource);
  src.start(() => {});
  await flush();
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://api-e.ecoflow.com/auth/login',
    `https://api-e.ecoflow.com/iot-auth/app/certification?userId=${USER_ID}`,
  ]);
  expect(JSON.parse(fetch.mock.calls[0][1].body!)).toMatchObject({ email: EMAIL, password: B64 });
  expect(mqtt.connect).toHaveBeenCalledWith('mqtts://mqtt-e.ecoflow.com:8883', expect.objectContaining({
    clientId: `ANDROID_${UUID}_${USER_ID}`, username: 'app-xyz', password: 'cert-pw-99',
  }));
});

test('registry: the created source scrubs a server echo of the account', async () => {
  const fetch = vi.fn<FetchLike>(async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ code: '9999', message: `email=${EMAIL} password=${B64}` }),
  }));
  const src = findActualSource(createActualSources({ fetch, connect: fakeMqtt().connect }), 'ecoflow-app')
    .create(APP_CONFIG, { email: EMAIL, password: PASSWORD }, { clientId: UUID, log: silentLogger });
  running.push(src as EcoflowAppSource);
  const readings: ActualReading[] = [];
  src.start(r => readings.push(r));
  await flush();
  expect(readings.at(-1)).toEqual({ power: 'unknown', observedAt: t(0), reason: 'Помилка EcoFlow 9999: email=… password=…' });
});

test('ecoflowAppTest: login, then the device list of that session', async () => {
  const { api, order } = setup();
  expect(await ecoflowAppTest(api)).toEqual({ session: SESSION, devices: [] });
  expect(order).toEqual(['login', 'list']);
  expect(api.listDevices).toHaveBeenCalledWith(SESSION);
});

/** 0, 1/16, 2/16, …: the throw-away clientId reads 0123456789ABCDEF0123456789ABCDEF. */
const counting = () => { let i = 0; return () => (i++ % 16) / 16; };

function preview(sn = SN) {
  const { api, mqtt } = setup();
  const result = ecoflowAppPreview(api, mqtt.connect, sn, counting());
  return { api, mqtt, result };
}

test('preview: one latestQuotas with a throw-away clientId; the reply gives online and the verdict', async () => {
  const { mqtt, result } = preview();
  await flush();
  expect(mqtt.connect).toHaveBeenCalledWith('mqtts://mqtt-e.ecoflow.com:8883', {
    clientId: `ANDROID_0123456789ABCDEF0123456789ABCDEF_${USER_ID}`, username: 'app-xyz', password: 'cert-pw-99',
    reconnectPeriod: 0, keepalive: 30, clean: true,
  });
  const c = mqtt.last();
  c.emit('connect');
  expect(c.subscribe.mock.calls.map(([topics]) => topics)).toEqual([[REPLY]]);
  expect(c.publish).toHaveBeenCalledTimes(1);
  expect(c.publish.mock.calls[0][0]).toBe(GET);
  expect(JSON.parse(c.publish.mock.calls[0][1])).toMatchObject({ operateType: 'latestQuotas', version: '1.1', from: 'Android' });
  await advance(3 * SEC);
  reply(c, ON, 1, { retain: true }); // a replay is no answer
  reply(c, ON);
  await expect(result).resolves.toEqual({ online: true, verdict: { power: 'on', detail: ON_DETAIL } });
  expect(c.end).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('preview: no reply in 10 s → «стан світла з’явиться після збереження»; the client is ended', async () => {
  const { mqtt, result } = preview();
  let settled = false;
  void result.then(() => { settled = true; });
  await flush();
  mqtt.last().emit('connect');
  await advance(PREVIEW_WAIT_MS - 1);
  expect(settled).toBe(false);
  await advance(1);
  await expect(result).resolves.toEqual({ online: true, verdict: { power: 'unknown', reason: AFTER_SAVE_REASON, unsupported: false } });
  expect(AFTER_SAVE_REASON).toBe('стан світла з’явиться після збереження');
  expect(PREVIEW_WAIT_MS).toBe(10_000);
  expect(mqtt.last().end).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('preview: an offline station, a protobuf model, a dropped connection', async () => {
  const a = preview();
  await flush();
  a.mqtt.last().emit('connect');
  send(a.mqtt.last(), REPLY, { code: '0', operateType: 'latestQuotas', data: { online: 0 } });
  await expect(a.result).resolves.toEqual({ online: false, verdict: { power: 'unknown', reason: OFFLINE, unsupported: false } });

  const b = preview();
  await flush();
  b.mqtt.last().emit('connect');
  b.mqtt.last().emit('message', REPLY, PROTOBUF, { retain: false });
  await expect(b.result).resolves.toEqual({ online: true, verdict: { power: 'unknown', reason: APP_UNSUPPORTED_REASON, unsupported: true } });

  const c = preview();
  await flush();
  c.mqtt.last().emit('error', Object.assign(new Error('read ECONNRESET'), { code: undefined }));
  await expect(c.result).resolves.toEqual({ online: true, verdict: { power: 'unknown', reason: AFTER_SAVE_REASON, unsupported: false } });
  for (const x of [a, b, c]) expect(x.mqtt.last().end).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([4, 5, 134, 135])('preview: a refused CONNACK (%i) → «EcoFlow не пустив до даних станції»', async code => {
  const { mqtt, result } = preview();
  await flush();
  mqtt.last().emit('error', authError(code));
  mqtt.last().emit('close');
  await expect(result).resolves.toEqual({ online: true, verdict: { power: 'unknown', reason: APP_AUTH_REFUSED_REASON, unsupported: false } });
  expect(APP_AUTH_REFUSED_REASON).toBe('EcoFlow не пустив до даних станції');
  expect(mqtt.last().end).toHaveBeenCalledWith(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('preview: a given session is certified as is, without a login', async () => {
  const { api, mqtt } = setup();
  const result = ecoflowAppPreview(api, mqtt.connect, SN, counting(), SESSION);
  await flush();
  expect(api.login).not.toHaveBeenCalled();
  expect(api.getCertification).toHaveBeenCalledWith(SESSION);
  mqtt.last().emit('connect');
  reply(mqtt.last(), OFF);
  await expect(result).resolves.toEqual({ online: true, verdict: { power: 'off', detail: OFF_DETAIL } });
});

test('preview: a failed login rejects before any connection', async () => {
  const { api, mqtt } = setup({ login: [new EcoflowApiError('2026')] });
  await expect(ecoflowAppPreview(api, mqtt.connect, SN, counting())).rejects.toMatchObject({ code: '2026' });
  expect(mqtt.connect).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
