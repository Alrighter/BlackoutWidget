import { ipcMain } from 'electron';
import {
  ACCOUNT_MISSING_REASON, createActualActions, createActualRestart, KEYS_MISSING_REASON, makeClientId, SCAN_MS,
  type ActualActions, type ActualActionsDeps, type ActualRestartDeps,
} from '../../../src/main/actual/actions';
import { EcoflowApiError, type EcoflowApiLike, type EcoflowDevice, type FetchLike } from '../../../src/main/actual/ecoflow/api';
import { EcoflowAppApi, type AppSession, type EcoflowAppApiLike } from '../../../src/main/actual/ecoflow/app-api';
import type { ScanOutcome } from '../../../src/main/actual/ecoflow/ble/link';
import { authToken } from '../../../src/main/actual/ecoflow/ble/token';
import { AFTER_SAVE_REASON, PREVIEW_WAIT_MS } from '../../../src/main/actual/ecoflow/index';
import type { MqttClientLike } from '../../../src/main/actual/ecoflow/mqtt-session';
import { SecretsUnavailableError } from '../../../src/main/actual/secrets';
import type { ActualReading, ActualSourceFactory, ActualStateSource } from '../../../src/main/actual/types';
import { LIVE_PUSH_MS, registerIpc, throttleLive, type IpcDeps } from '../../../src/main/ipc';
import { NetworkError } from '../../../src/main/providers/types';
import { DEFAULT_SETTINGS } from '../../../src/main/store';
import { BLE_PROBLEM_TEXT, type BleProblem } from '../../../src/shared/ecoflow-ble';
import { IPC, type ActualLive } from '../../../src/shared/ipc';
import type { ActualSourceConfig, Settings } from '../../../src/shared/types';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const AKEY = 'AKEY1234567', SECRET = 'SECRET-xyz';
const KEYS = { region: 'eu', accessKey: AKEY, secretKey: SECRET };
const DEVICE = { sn: 'SN1', label: 'RIVER 2' };
const BAD_INPUT = 'Перевірте введені дані';
const CONNECT_FAILED = 'Не вдалося зв’язатися з EcoFlow';
const SAVE_FAILED = 'Не вдалося безпечно зберегти ключі на цьому комп’ютері';
const ACCOUNT_SAVE_FAILED = 'Не вдалося безпечно зберегти дані входу на цьому комп’ютері';
const KEY_8521 = 'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.';
const CLIENT_ID = /^BlackoutWidget-[a-z0-9]{8}$/;
const RIVER: EcoflowDevice = { sn: 'SN1', online: true, productName: 'RIVER 2' };
const CONFIG: ActualSourceConfig = { id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accessKeyHint: 'AKEY…' };
const EMAIL = 'roman@dully.io', PASSWORD = 'p@ss w0rd!';
const PASSWORD_B64 = Buffer.from(PASSWORD).toString('base64');
const ACCOUNT = { mode: 'account', region: 'eu', email: EMAIL, password: PASSWORD };
const APP_CONFIG: ActualSourceConfig = { id: 'ecoflow-app', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accountHint: 'r…@dully.io' };
const UUID = /^[0-9A-F]{32}$/;
const SESSION: AppSession = { token: 'TOKEN', userId: 'USER1' };
const BLE = { mode: 'ble', region: 'eu', email: EMAIL, password: PASSWORD };
const BLE_SN = 'R601ZEB4AAAA0001';
const BLE_DEV = { sn: BLE_SN, label: 'RIVER 2' };
const BLE_CONFIG: ActualSourceConfig = { id: 'ecoflow-ble', region: 'eu', deviceSn: BLE_SN, deviceName: 'RIVER 2', accountHint: 'r…@dully.io' };
const UNSUPPORTED = 'Модель поки не підтримується';
const SETTINGS_FAILED = 'Не вдалося зберегти налаштування. Спробуйте ще раз.';

const settle = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));

function fakeApi(o: { devices?: EcoflowDevice[] | Error; quota?: Record<string, unknown> | Error } = {}) {
  return {
    listDevices: vi.fn(() => settle(o.devices ?? [RIVER])),
    getQuotaAll: vi.fn((_sn: string) => settle(o.quota ?? { 'inv.acInVol': 229345 })),
    getCertification: vi.fn(() => Promise.reject(new Error('preview must not touch MQTT'))),
  } satisfies EcoflowApiLike;
}

function fakeAppApi(o: { devices?: EcoflowDevice[] | Error; cert?: Error } = {}) {
  return {
    login: vi.fn(() => Promise.resolve(SESSION)),
    getCertification: vi.fn((_s: AppSession) => (o.cert ? Promise.reject(o.cert) : Promise.resolve({ account: 'a', password: 'b', host: 'h', port: 8883 }))),
    listDevices: vi.fn((_s: AppSession) => settle(o.devices ?? [RIVER])),
  } satisfies EcoflowAppApiLike;
}

/** A broker that never answers: handlers are collected and left alone. */
function silentBroker() {
  const client = { on: vi.fn(), subscribe: vi.fn(), publish: vi.fn(), end: vi.fn() } satisfies MqttClientLike;
  return { client, connect: vi.fn(() => client) };
}

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** The Bluetooth link as setup sees it: a scan that answers at once (or fails), and the station it is connected to. */
function fakeBle(o: { scan?: ScanOutcome | Error; connected?: string | null } = {}) {
  return {
    scan: vi.fn((_ms: number) => (o.scan instanceof Error ? Promise.reject(o.scan) : Promise.resolve(o.scan ?? { adverts: [] }))),
    connectedSn: vi.fn(() => o.connected ?? null),
  } satisfies ActualActionsDeps['ble'];
}

const advert = (sn: string) => ({ sn, soc: 80, rssi: -50, encryptType: 7 });

function setup(o: {
  api?: EcoflowApiLike; appApi?: EcoflowAppApiLike; settings?: Partial<Settings>; saveSecrets?: () => void; removeSecrets?: () => void; saveSettings?: () => void;
  ble?: ActualActionsDeps['ble'];
} = {}) {
  const order: string[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings };
  const api = o.api ?? fakeApi();
  const appApi = o.appApi ?? fakeAppApi();
  const broker = silentBroker();
  const ble = o.ble ?? fakeBle();
  const deps = {
    makeApi: vi.fn((_region: string, _keys: { accessKey: string; secretKey: string }) => api),
    makeAppApi: vi.fn((_region: string, _account: { email: string; password: string }) => appApi),
    connect: broker.connect,
    ble,
    secrets: {
      save: vi.fn((_id: string, _s: Record<string, string>) => { order.push('secrets.save'); o.saveSecrets?.(); }),
      remove: vi.fn((_id: string) => { order.push('secrets.remove'); o.removeSecrets?.(); }),
    },
    getSettings: () => settings,
    updateSettings: vi.fn((patch: Partial<Settings>) => {
      order.push('updateSettings');
      o.saveSettings?.();
      settings = { ...settings, ...patch };
    }),
    restartActual: vi.fn(() => { order.push('restartActual'); }),
    log: fakeLog(),
  } satisfies ActualActionsDeps;
  return { deps, actions: createActualActions(deps), order, settings: () => settings, appApi, broker, ble };
}

test('test: lists devices as views', async () => {
  const { actions, deps } = setup();
  expect(await actions.test({ region: 'eu', accessKey: ` ${AKEY} `, secretKey: `${SECRET}\n` }))
    .toEqual({ ok: true, devices: [{ sn: 'SN1', label: 'RIVER 2', online: true }] });
  expect(deps.makeApi).toHaveBeenCalledWith('eu', { accessKey: AKEY, secretKey: SECRET });

  const many = setup({ api: fakeApi({ devices: [RIVER, { sn: 'SN2', online: false, deviceName: 'Garage' }, { sn: 'SN3', online: false }] }) });
  expect(await many.actions.test({ ...KEYS, region: 'us' })).toEqual({
    ok: true,
    devices: [{ sn: 'SN1', label: 'RIVER 2', online: true }, { sn: 'SN2', label: 'Garage', online: false }, { sn: 'SN3', label: 'SN3', online: false }],
  });
  expect(many.deps.makeApi).toHaveBeenCalledWith('us', { accessKey: AKEY, secretKey: SECRET });
});

test('test: api error text passes through', async () => {
  expect(await setup({ api: fakeApi({ devices: new EcoflowApiError('8521') }) }).actions.test(KEYS))
    .toEqual({ ok: false, error: KEY_8521 });
  expect(await setup({ api: fakeApi({ devices: new NetworkError('Немає з’єднання з EcoFlow') }) }).actions.test(KEYS))
    .toEqual({ ok: false, error: 'Немає з’єднання з EcoFlow' });
});

test('unknown error → «Не вдалося зв’язатися з EcoFlow», logged', async () => {
  const { actions, deps } = setup({ api: fakeApi({ devices: new TypeError('x is undefined') }) });
  expect(await actions.test(KEYS)).toEqual({ ok: false, error: CONNECT_FAILED });
  expect(deps.log.error).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(deps.log.error.mock.calls)).toContain('x is undefined');

  const preview = setup({ api: fakeApi({ quota: new RangeError('boom') }) });
  expect(await preview.actions.preview(KEYS, 'SN1')).toEqual({ ok: false, error: CONNECT_FAILED });
  expect(preview.deps.log.error).toHaveBeenCalledTimes(1);
});

test('invalid input → «Перевірте введені дані»', async () => {
  const { actions, deps } = setup();
  const badKeys: unknown[] = [
    { ...KEYS, region: 'xx' }, { ...KEYS, accessKey: '' }, { ...KEYS, secretKey: '   ' }, { ...KEYS, accessKey: 'A'.repeat(201) },
    { ...KEYS, secretKey: 42 }, { region: 'eu', accessKey: AKEY }, null, undefined, 'eu', [],
  ];
  for (const i of badKeys) {
    expect(await actions.test(i)).toEqual({ ok: false, error: BAD_INPUT });
    expect(await actions.preview(i, 'SN1')).toEqual({ ok: false, error: BAD_INPUT });
    expect(await actions.save(i, DEVICE)).toEqual({ ok: false, error: BAD_INPUT });
  }
  // Letters and digits only: `#`, `+` and `/` would change the meaning of an MQTT topic.
  for (const sn of ['x'.repeat(500), 'x'.repeat(65), '', 42, null, 'SN#1', 'SN+', 'R601/SN1', 'SN 1', 'SN-1', 'SN1\n', 'СН1']) {
    expect(await actions.preview(KEYS, sn)).toEqual({ ok: false, error: BAD_INPUT });
    expect(await actions.save(KEYS, { sn, label: 'RIVER 2' })).toEqual({ ok: false, error: BAD_INPUT });
  }
  for (const device of [null, 'SN1', { sn: 'SN1' }, { sn: 'SN1', label: 'L'.repeat(121) }, { sn: 'SN1', label: 7 }]) {
    expect(await actions.save(KEYS, device)).toEqual({ ok: false, error: BAD_INPUT });
  }
  expect(deps.makeApi).not.toHaveBeenCalled();
  expect(deps.secrets.save).not.toHaveBeenCalled();
  expect(deps.updateSettings).not.toHaveBeenCalled();
  expect(deps.restartActual).not.toHaveBeenCalled();
  expect(deps.log.error).not.toHaveBeenCalled();
});

test('input at the length limits is accepted', async () => {
  const { actions, deps } = setup();
  const keys = { region: 'eu', accessKey: 'A'.repeat(200), secretKey: 'S'.repeat(200) };
  expect(await actions.test(keys)).toMatchObject({ ok: true });
  expect(await actions.preview(keys, 'N'.repeat(64))).toMatchObject({ ok: true });
  expect(await actions.save(keys, { sn: 'N'.repeat(64), label: 'L'.repeat(120) })).toEqual({ ok: true });
  expect(deps.updateSettings).toHaveBeenCalledTimes(1);
});

test('preview: reads the station over HTTP and maps the verdict', async () => {
  const on = setup();
  expect(await on.actions.preview(KEYS, 'SN1')).toEqual({ ok: true, online: true, power: 'on', detail: 'на вході 229 В' });
  const api = on.deps.makeApi.mock.results[0].value as ReturnType<typeof fakeApi>;
  expect(api.getQuotaAll).toHaveBeenCalledWith('SN1');
  expect(api.getCertification).not.toHaveBeenCalled();

  expect(await setup({ api: fakeApi({ devices: [{ ...RIVER, online: false }], quota: { 'inv.acInVol': 0 } }) }).actions.preview(KEYS, 'SN1'))
    .toEqual({ ok: true, online: false, power: 'off', detail: 'на вході 0 В' });
  expect(await setup({ api: fakeApi({ quota: { foo: 1 } }) }).actions.preview(KEYS, 'SN1'))
    .toEqual({ ok: true, online: true, power: 'unknown', reason: 'модель поки не підтримується', unsupported: true });
  expect(await setup({ api: fakeApi({ quota: { 'inv.inputWatts': 0 } }) }).actions.preview(KEYS, 'SN1'))
    .toEqual({ ok: true, online: true, power: 'unknown', reason: 'не вдається визначити', unsupported: false });
  expect(await setup({ api: fakeApi({ quota: new EcoflowApiError('1006') }) }).actions.preview(KEYS, 'SN1'))
    .toEqual({ ok: false, error: new EcoflowApiError('1006').message });
});

test('save: encrypts keys, stores hint and stable clientId, restarts', async () => {
  const { actions, deps, order, settings } = setup();
  expect(await actions.save({ region: 'eu', accessKey: ` ${AKEY} `, secretKey: ` ${SECRET} ` }, DEVICE)).toEqual({ ok: true });
  expect(deps.secrets.save).toHaveBeenCalledWith('ecoflow', { accessKey: AKEY, secretKey: SECRET });
  expect(deps.updateSettings).toHaveBeenCalledTimes(1);
  const patch = deps.updateSettings.mock.calls[0][0];
  expect(patch.actualSource).toEqual({ id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accessKeyHint: 'AKEY…' });
  expect(patch.ecoflowClientId).toMatch(CLIENT_ID);
  expect(order).toEqual(['secrets.save', 'updateSettings', 'secrets.remove', 'secrets.remove', 'restartActual']);
  expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow-app', 'ecoflow-ble']);
  expect(deps.makeApi).not.toHaveBeenCalled();

  const clientId = settings().ecoflowClientId;
  expect(await actions.save({ ...KEYS, region: 'us' }, { sn: 'SN2', label: 'DELTA 2' })).toEqual({ ok: true });
  expect(deps.updateSettings.mock.calls[1][0]).toEqual({
    actualSource: { id: 'ecoflow', region: 'us', deviceSn: 'SN2', deviceName: 'DELTA 2', accessKeyHint: 'AKEY…' },
    ecoflowClientId: clientId,
  });
  expect(deps.restartActual).toHaveBeenCalledTimes(2);
});

test('save: secrets unavailable → error, settings untouched', async () => {
  const { actions, deps } = setup({ saveSecrets: () => { throw new SecretsUnavailableError(); } });
  expect(await actions.save(KEYS, DEVICE)).toEqual({ ok: false, error: SAVE_FAILED });
  expect(deps.updateSettings).not.toHaveBeenCalled();
  expect(deps.restartActual).not.toHaveBeenCalled();
});

test('save: an unreadable secrets file → the same error, logged, settings untouched', async () => {
  const locked = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const { actions, deps } = setup({ saveSecrets: () => { throw locked; } });
  expect(await actions.save(KEYS, DEVICE)).toEqual({ ok: false, error: SAVE_FAILED });
  expect(deps.log.error).toHaveBeenCalledTimes(1);
  expect(deps.updateSettings).not.toHaveBeenCalled();
  expect(deps.restartActual).not.toHaveBeenCalled();
});

test('save: settings cannot be written → error, keys kept, no restart (ruling R10)', async () => {
  const { actions, deps, order, settings } = setup({ saveSettings: () => { throw new Error(`EBUSY: settings.json ${SECRET}`); } });
  expect(await actions.save(KEYS, DEVICE)).toEqual({ ok: false, error: 'Не вдалося зберегти налаштування. Спробуйте ще раз.' });
  expect(order).toEqual(['secrets.save', 'updateSettings']);
  expect(deps.secrets.remove).not.toHaveBeenCalled();
  expect(settings().actualSource).toBeNull();
  expect(deps.log.error).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(deps.log.error.mock.calls)).toContain('EBUSY');
  expect(JSON.stringify(deps.log.error.mock.calls)).not.toContain(SECRET);
});

test('disconnect: settings cannot be written → rejects, keys kept, no restart (ruling R10)', async () => {
  const { actions, deps, order, settings } = setup({
    settings: { actualSource: CONFIG }, saveSettings: () => { throw new Error('EBUSY: settings.json'); },
  });
  await expect(actions.disconnect()).rejects.toThrow('EBUSY: settings.json');
  expect(order).toEqual(['updateSettings']);
  expect(deps.secrets.remove).not.toHaveBeenCalled();
  expect(deps.restartActual).not.toHaveBeenCalled();
  expect(settings().actualSource).toEqual(CONFIG);
  expect(deps.log.error).toHaveBeenCalledTimes(1);
});

test('disconnect: clears settings and secrets, keeps clientId', async () => {
  const { actions, deps, order, settings } = setup({ settings: { actualSource: CONFIG, ecoflowClientId: 'BlackoutWidget-abc12345' } });
  await actions.disconnect();
  expect(deps.updateSettings).toHaveBeenCalledWith({ actualSource: null });
  expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow', 'ecoflow-app', 'ecoflow-ble']);
  expect(order).toEqual(['updateSettings', 'secrets.remove', 'secrets.remove', 'secrets.remove', 'restartActual']);
  expect(settings().actualSource).toBeNull();
  expect(settings().ecoflowClientId).toBe('BlackoutWidget-abc12345');
});

test('disconnect: a secrets file that cannot be rewritten still restarts', async () => {
  const { actions, deps } = setup({ settings: { actualSource: CONFIG }, removeSecrets: () => { throw new Error('EPERM'); } });
  await expect(actions.disconnect()).resolves.toBeUndefined();
  expect(deps.log.error).toHaveBeenCalledTimes(3); // each id is tried on its own
  expect(deps.restartActual).toHaveBeenCalledTimes(1);
});

test('ipc results never contain secret', async () => {
  const echo = `accessKey=${AKEY} secretKey=${SECRET}`;
  const results: unknown[] = [];
  const run = async (s: ReturnType<typeof setup>) => {
    results.push(await s.actions.test(KEYS), await s.actions.preview(KEYS, 'SN1'), await s.actions.save(KEYS, DEVICE));
    expect(JSON.stringify(s.deps.updateSettings.mock.calls)).not.toMatch(/AKEY1234567|SECRET-xyz/);
    for (const level of Object.values(s.deps.log)) expect(JSON.stringify(level.mock.calls)).not.toMatch(/AKEY1234567|SECRET-xyz/);
  };
  await run(setup());
  await run(setup({ api: fakeApi({ devices: new EcoflowApiError('9999', echo), quota: new EcoflowApiError('9999', echo) }) }));
  await run(setup({ api: fakeApi({ devices: new Error(echo), quota: new Error(echo) }), saveSecrets: () => { throw new Error(echo); } }));
  await run(setup({ saveSecrets: () => { throw new SecretsUnavailableError(); } }));
  results.push(await setup().actions.test({ ...KEYS, region: 'xx' }));

  expect(results).toContainEqual({ ok: false, error: 'Помилка EcoFlow 9999: accessKey=AKEY… secretKey=…' });
  for (const error of [CONNECT_FAILED, SAVE_FAILED, BAD_INPUT]) expect(results).toContainEqual({ ok: false, error });
  expect(results).toContainEqual({ ok: true, online: true, power: 'on', detail: 'на вході 229 В' });
  for (const r of results) {
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(AKEY);
  }
});

test('makeClientId: BlackoutWidget- + 8 characters [a-z0-9]', () => {
  expect(makeClientId(() => 0)).toBe('BlackoutWidget-aaaaaaaa');
  expect(makeClientId(() => 0.99999)).toBe('BlackoutWidget-99999999');
  expect(makeClientId(() => 1)).toBe('BlackoutWidget-99999999');
  expect(makeClientId()).toMatch(CLIENT_ID);
});

describe('account mode', () => {
  const DEV = { sn: 'SN1', label: 'RIVER 2' };

  test('test: logs in and lists the devices', async () => {
    const { actions, deps, appApi } = setup();
    expect(await actions.test({ ...ACCOUNT, email: ` ${EMAIL} `, password: PASSWORD }))
      .toEqual({ ok: true, devices: [{ sn: 'SN1', label: 'RIVER 2', online: true }] });
    expect(deps.makeAppApi).toHaveBeenCalledWith('eu', { email: EMAIL, password: PASSWORD });
    expect(appApi.listDevices).toHaveBeenCalledWith(SESSION);
    expect(deps.makeApi).not.toHaveBeenCalled();
  });

  test('save: stores the account under ecoflow-app, hints, makes the uuid once, then drops the keys', async () => {
    const { actions, deps, order, settings } = setup({ settings: { ecoflowClientId: 'BlackoutWidget-abc12345' } });
    expect(await actions.save(ACCOUNT, DEV)).toEqual({ ok: true });
    expect(deps.secrets.save).toHaveBeenCalledWith('ecoflow-app', { email: EMAIL, password: PASSWORD });
    const patch = deps.updateSettings.mock.calls[0][0];
    expect(patch.actualSource).toEqual({ id: 'ecoflow-app', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accountHint: 'r…@dully.io' });
    expect(patch.ecoflowAppClientUuid).toMatch(UUID);
    expect(JSON.stringify(patch)).not.toContain(EMAIL);
    expect(JSON.stringify(patch)).not.toContain(PASSWORD);
    expect(order).toEqual(['secrets.save', 'updateSettings', 'secrets.remove', 'secrets.remove', 'restartActual']);
    expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow', 'ecoflow-ble']);

    const uuid = settings().ecoflowAppClientUuid;
    expect(await actions.save({ ...ACCOUNT, region: 'us' }, DEV)).toEqual({ ok: true });
    expect(deps.updateSettings.mock.calls[1][0].ecoflowAppClientUuid).toBe(uuid);
  });

  test('save: a failed removal of the keys is logged, not fatal', async () => {
    const { actions, deps } = setup({ removeSecrets: () => { throw new Error('EPERM'); } });
    expect(await actions.save(ACCOUNT, DEV)).toEqual({ ok: true });
    expect(deps.log.error).toHaveBeenCalledTimes(2); // the keys and the Bluetooth token, each on its own
    expect(deps.restartActual).toHaveBeenCalledTimes(1);
  });

  test('save: failing secrets or settings leave the other mode untouched', async () => {
    const a = setup({ saveSecrets: () => { throw new SecretsUnavailableError(); } });
    expect(await a.actions.save(ACCOUNT, DEV)).toEqual({ ok: false, error: ACCOUNT_SAVE_FAILED });
    const b = setup({ saveSettings: () => { throw new Error(`EBUSY ${PASSWORD}`); } });
    expect(await b.actions.save(ACCOUNT, DEV)).toEqual({ ok: false, error: 'Не вдалося зберегти налаштування. Спробуйте ще раз.' });
    for (const s of [a, b]) {
      expect(s.deps.secrets.remove).not.toHaveBeenCalled();
      expect(s.deps.restartActual).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(b.deps.log.error.mock.calls)).not.toContain(PASSWORD);
  });

  test('invalid input → «Перевірте введені дані»', async () => {
    const { actions, deps } = setup();
    const bad: unknown[] = [
      { ...ACCOUNT, email: 'roman.dully.io' }, { ...ACCOUNT, email: '   ' }, { ...ACCOUNT, email: '@x' }, { ...ACCOUNT, email: 'x@' }, { ...ACCOUNT, password: '' }, { ...ACCOUNT, password: 7 },
      { ...ACCOUNT, email: `${'a'.repeat(200)}@x.io` }, { ...ACCOUNT, password: 'p'.repeat(201) }, { ...ACCOUNT, region: 'xx' },
      { ...ACCOUNT, mode: 'oauth' }, { ...ACCOUNT, mode: 1 }, { mode: 'account', region: 'eu', email: EMAIL },
    ];
    for (const i of bad) {
      expect(await actions.test(i)).toEqual({ ok: false, error: BAD_INPUT });
      expect(await actions.preview(i, 'SN1')).toEqual({ ok: false, error: BAD_INPUT });
      expect(await actions.save(i, DEV)).toEqual({ ok: false, error: BAD_INPUT });
    }
    for (const sn of ['SN#1', 'R601/+', '#', 'SN 1']) {
      expect(await actions.preview(ACCOUNT, sn)).toEqual({ ok: false, error: BAD_INPUT });
      expect(await actions.save(ACCOUNT, { sn, label: 'RIVER 2' })).toEqual({ ok: false, error: BAD_INPUT });
    }
    expect(deps.makeAppApi).not.toHaveBeenCalled();
    expect(deps.secrets.save).not.toHaveBeenCalled();
    expect(deps.updateSettings).not.toHaveBeenCalled();
  });

  test('the password is not trimmed; 200 characters are accepted', async () => {
    const { actions, deps } = setup();
    const password = ` ${'p'.repeat(198)} `;
    expect(await actions.save({ ...ACCOUNT, password }, DEV)).toEqual({ ok: true });
    expect(deps.secrets.save).toHaveBeenCalledWith('ecoflow-app', { email: EMAIL, password });
  });

  test('an explicit mode keys works like no mode', async () => {
    const { actions, deps } = setup();
    expect(await actions.test({ mode: 'keys', ...KEYS })).toMatchObject({ ok: true });
    expect(deps.makeApi).toHaveBeenCalledWith('eu', { accessKey: AKEY, secretKey: SECRET });
  });

  test('errors come back scrubbed of the email, the password and its base64', async () => {
    const echo = `bad ${EMAIL} ${PASSWORD} ${PASSWORD_B64}`;
    const api = fakeAppApi({ devices: new EcoflowApiError('9999', echo) });
    const s = setup({ appApi: api });
    const res = await s.actions.test(ACCOUNT);
    expect(res).toMatchObject({ ok: false });
    for (const secret of [EMAIL, PASSWORD, PASSWORD_B64]) expect(JSON.stringify(res)).not.toContain(secret);

    const unknown = setup({ appApi: fakeAppApi({ devices: new Error(echo) }) });
    expect(await unknown.actions.test(ACCOUNT)).toEqual({ ok: false, error: CONNECT_FAILED });
    for (const secret of [EMAIL, PASSWORD, PASSWORD_B64]) expect(JSON.stringify(unknown.deps.log.error.mock.calls)).not.toContain(secret);

    const net = setup({ appApi: fakeAppApi({ cert: new NetworkError(echo) }) });
    expect(JSON.stringify(await net.actions.preview(ACCOUNT, 'SN1'))).not.toContain(PASSWORD);

    const saveFail = setup({ saveSecrets: () => { throw new Error(echo); } });
    expect(await saveFail.actions.save(ACCOUNT, DEV)).toEqual({ ok: false, error: ACCOUNT_SAVE_FAILED });
    for (const secret of [EMAIL, PASSWORD, PASSWORD_B64]) expect(JSON.stringify(saveFail.deps.log.error.mock.calls)).not.toContain(secret);
  });

  test('preview: with no reply the verdict is unknown and the station counts as online', async () => {
    vi.useFakeTimers();
    try {
      const { actions, deps, broker } = setup();
      const pending = actions.preview(ACCOUNT, 'SN1');
      await vi.advanceTimersByTimeAsync(PREVIEW_WAIT_MS);
      expect(await pending).toEqual({ ok: true, online: true, power: 'unknown', reason: AFTER_SAVE_REASON, unsupported: false });
      expect(deps.makeAppApi).toHaveBeenCalledWith('eu', { email: EMAIL, password: PASSWORD });
      expect(broker.connect).toHaveBeenCalledTimes(1);
      expect(deps.makeApi).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('preview: an api error is scrubbed and returned', async () => {
    const { actions } = setup({ appApi: fakeAppApi({ cert: new EcoflowApiError('9999', `x ${PASSWORD}`) }) });
    const res = await actions.preview(ACCOUNT, 'SN1');
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).not.toContain(PASSWORD);
  });

  test('a server echo of the token or the userId never reaches the IPC result', async () => {
    const TOKEN = 'jwt-token-abc', USER_ID = '1234567890123456789';
    const fetch = vi.fn<FetchLike>(async url => {
      const body = url.includes('/auth/login')
        ? { code: '0', data: { token: TOKEN, user: { userId: USER_ID } } }
        : { code: `E-${USER_ID}`, message: `token=${TOKEN} user=${USER_ID}` };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    });
    const { actions } = setup({ appApi: new EcoflowAppApi('eu', { email: EMAIL, password: PASSWORD }, { fetch }) });
    const echoed = { ok: false, error: 'Помилка EcoFlow E-…: token=… user=…' };
    expect(await actions.test(ACCOUNT)).toEqual(echoed); // the device list echoes
    expect(await actions.preview(ACCOUNT, 'SN1')).toEqual(echoed); // the certification echoes
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/auth/login', '/iot-service/user/device', '/auth/login', '/iot-auth/app/certification',
    ]);
  });

  test('disconnect removes the secrets of all three sources', async () => {
    const { actions, deps } = setup({ settings: { actualSource: APP_CONFIG } });
    await actions.disconnect();
    expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow', 'ecoflow-app', 'ecoflow-ble']);
  });
});

describe('Bluetooth mode', () => {
  const ALL_PROBLEMS: BleProblem[] = ['bt-off', 'bt-denied', 'bt-missing', 'bt-unavailable', 'host-failed', 'scan-failed'];

  test('test refuses mode ble (the scan has a call of its own): no sign-in, no scan', async () => {
    const ble = fakeBle({ scan: { adverts: [advert(BLE_SN)] } });
    const { actions, deps } = setup({ ble });
    expect(await actions.test(BLE)).toEqual({ ok: false, error: BAD_INPUT });
    expect(deps.makeAppApi).not.toHaveBeenCalled();
    expect(deps.makeApi).not.toHaveBeenCalled();
    expect(ble.scan).not.toHaveBeenCalled();
  });

  test('the account test does not scan, and its stations carry the cloud state only', async () => {
    const ble = fakeBle({ scan: { adverts: [advert('SN1')] }, connected: 'SN1' });
    const { actions } = setup({ ble });
    expect(await actions.test(ACCOUNT)).toEqual({ ok: true, devices: [{ sn: 'SN1', label: 'RIVER 2', online: true }] });
    expect(ble.scan).not.toHaveBeenCalled();
  });

  test('scan: the scanned SNs plus the station the running source holds, each once, with no sign-in', async () => {
    const ble = fakeBle({
      scan: { adverts: [advert('R601ZEB4AAAA0001'), advert('R331ZEB4AAAA0003'), advert('R601ZEB4AAAA0001')] }, connected: 'R611ZEB4AAAA0002',
    });
    const { actions, deps } = setup({ ble });
    expect(await actions.scan()).toEqual({ nearby: ['R601ZEB4AAAA0001', 'R331ZEB4AAAA0003', 'R611ZEB4AAAA0002'] });
    expect(SCAN_MS).toBe(8_000);
    expect(ble.scan.mock.calls).toEqual([[8_000]]);
    expect(deps.makeAppApi).not.toHaveBeenCalled();
    expect(deps.makeApi).not.toHaveBeenCalled();
    // A held station that advertised as well is listed once; nothing nearby and nothing held is an empty list.
    expect(await setup({ ble: fakeBle({ scan: { adverts: [advert(BLE_SN)] }, connected: BLE_SN }) }).actions.scan()).toEqual({ nearby: [BLE_SN] });
    expect(await setup().actions.scan()).toEqual({ nearby: [] });
  });

  test('scan: a problem becomes the bluetooth text; the held station still counts as nearby', async () => {
    expect(BLE_PROBLEM_TEXT['bt-off']).toBe('Bluetooth на цьому комп’ютері вимкнено');
    for (const problem of ALL_PROBLEMS) {
      const { actions } = setup({ ble: fakeBle({ scan: { adverts: [], problem } }) });
      expect(await actions.scan()).toEqual({ nearby: [], bluetooth: BLE_PROBLEM_TEXT[problem] });
    }
    const held = setup({ ble: fakeBle({ scan: { adverts: [], problem: 'bt-off' }, connected: BLE_SN }) });
    expect(await held.actions.scan()).toEqual({ nearby: [BLE_SN], bluetooth: 'Bluetooth на цьому комп’ютері вимкнено' });
  });

  test('scan never rejects: a rejected or throwing scan is scan-failed, the held station kept, no SN logged', async () => {
    const FAILED = { bluetooth: 'Не вдалося пошукати станцію через Bluetooth' };
    const rejected = setup({ ble: fakeBle({ scan: new Error(`the link fell over near ${BLE_SN}`), connected: BLE_SN }) });
    expect(await rejected.actions.scan()).toEqual({ nearby: [BLE_SN], ...FAILED });
    expect(await setup({ ble: fakeBle({ scan: new Error('the link fell over') }) }).actions.scan()).toEqual({ nearby: [], ...FAILED });
    const thrown = setup({ ble: { scan: vi.fn(() => { throw new TypeError(`no host for ${BLE_SN}`); }), connectedSn: vi.fn(() => null) } });
    expect(await thrown.actions.scan()).toEqual({ nearby: [], ...FAILED });
    const lost = setup({ ble: { scan: vi.fn(async () => ({ adverts: [advert(BLE_SN)] })), connectedSn: vi.fn(() => { throw new Error(`gone ${BLE_SN}`); }) } });
    expect(await lost.actions.scan()).toEqual({ nearby: [], ...FAILED });
    for (const s of [rejected, thrown, lost]) {
      expect(JSON.stringify(Object.values(s.deps.log).map(level => level.mock.calls))).not.toContain(BLE_SN.slice(4));
    }
  });

  test('ble: invalid input starts no sign-in and no scan; preview is not for ble', async () => {
    const ble = fakeBle();
    const { actions, deps } = setup({ ble });
    const bad: unknown[] = [
      { ...BLE, email: 'roman.dully.io' }, { ...BLE, password: '' }, { ...BLE, password: 7 }, { ...BLE, region: 'xx' },
      { mode: 'ble', region: 'eu', email: EMAIL }, { ...BLE, password: 'p'.repeat(201) },
    ];
    for (const i of bad) {
      expect(await actions.test(i)).toEqual({ ok: false, error: BAD_INPUT });
      expect(await actions.save(i, BLE_DEV)).toEqual({ ok: false, error: BAD_INPUT });
    }
    for (const sn of ['R601#1', 'R601/+', '']) expect(await actions.save(BLE, { sn, label: 'RIVER 2' })).toEqual({ ok: false, error: BAD_INPUT });
    expect(await actions.preview(BLE, BLE_SN)).toEqual({ ok: false, error: BAD_INPUT });
    expect(ble.scan).not.toHaveBeenCalled();
    expect(deps.makeAppApi).not.toHaveBeenCalled();
    expect(deps.secrets.save).not.toHaveBeenCalled();
    expect(deps.updateSettings).not.toHaveBeenCalled();
  });

  test('ble save: stores only the token, settings carry the masked email, the other secrets go', async () => {
    const { actions, deps, order, appApi, settings } = setup({ settings: { ecoflowClientId: 'BlackoutWidget-abc12345' } });
    // The form checks with the account and saves the same sign-in with mode ble.
    expect(await actions.test(ACCOUNT)).toMatchObject({ ok: true });
    expect(await actions.save(BLE, BLE_DEV)).toEqual({ ok: true });
    expect(appApi.login).toHaveBeenCalledTimes(1); // the check's session
    expect(deps.secrets.save.mock.calls).toEqual([['ecoflow-ble', { token: authToken('USER1', BLE_SN) }]]);
    expect(deps.secrets.save.mock.calls[0][1].token).toMatch(UUID);
    expect(deps.updateSettings.mock.calls).toEqual([[{ actualSource: BLE_CONFIG }]]);
    expect(order).toEqual(['secrets.save', 'updateSettings', 'secrets.remove', 'secrets.remove', 'restartActual']);
    expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow', 'ecoflow-app']);
    expect(settings().ecoflowClientId).toBe('BlackoutWidget-abc12345');
    expect(settings().ecoflowAppClientUuid).toBeUndefined();
  });

  test('ble save with no check before it signs in itself', async () => {
    const { actions, deps, appApi } = setup();
    expect(await actions.save(BLE, BLE_DEV)).toEqual({ ok: true });
    expect(deps.makeAppApi).toHaveBeenCalledWith('eu', { email: EMAIL, password: PASSWORD });
    expect(appApi.login).toHaveBeenCalledTimes(1);
    expect(deps.secrets.save).toHaveBeenCalledWith('ecoflow-ble', { token: authToken('USER1', BLE_SN) });
  });

  test('ble save refuses an unsupported model', async () => {
    const { actions, deps, appApi } = setup();
    for (const sn of ['R331ZEB4AAAA0003', 'P351ZEB4AAAA0009', 'r601ZEB4AAAA0001']) {
      expect(await actions.save(BLE, { sn, label: 'DELTA 2' })).toEqual({ ok: false, error: UNSUPPORTED });
    }
    expect(deps.makeAppApi).not.toHaveBeenCalled();
    expect(appApi.login).not.toHaveBeenCalled();
    expect(deps.secrets.save).not.toHaveBeenCalled();
    expect(deps.updateSettings).not.toHaveBeenCalled();
    expect(deps.secrets.remove).not.toHaveBeenCalled();
    expect(deps.restartActual).not.toHaveBeenCalled();
    expect(deps.log.error).not.toHaveBeenCalled();
  });

  test('ble save signs in again when the cached session expired', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-19T10:00:00Z') });
    try {
      const fresh: AppSession = { token: 'TOKEN2', userId: 'USER2' };
      let logins = 0;
      const appApi = { ...fakeAppApi(), login: vi.fn(() => Promise.resolve(++logins === 1 ? SESSION : fresh)) };
      const { actions, deps } = setup({ appApi });
      await actions.test(ACCOUNT);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(await actions.save(BLE, BLE_DEV)).toEqual({ ok: true });
      expect(appApi.login).toHaveBeenCalledTimes(2);
      expect(deps.secrets.save).toHaveBeenCalledWith('ecoflow-ble', { token: authToken('USER2', BLE_SN) });
      // The fresh session is kept for the next save.
      expect(await actions.save(BLE, BLE_DEV)).toEqual({ ok: true });
      expect(appApi.login).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('ble save: a failed sign-in, secrets or settings store nothing further', async () => {
    const login = setup({ appApi: { ...fakeAppApi(), login: vi.fn(() => Promise.reject(new NetworkError('Немає з’єднання з EcoFlow'))) } });
    expect(await login.actions.save(BLE, BLE_DEV)).toEqual({ ok: false, error: 'Немає з’єднання з EcoFlow' });
    expect(login.deps.secrets.save).not.toHaveBeenCalled();
    expect(login.deps.updateSettings).not.toHaveBeenCalled();

    const secrets = setup({ saveSecrets: () => { throw new SecretsUnavailableError(); } });
    expect(await secrets.actions.save(BLE, BLE_DEV)).toEqual({ ok: false, error: ACCOUNT_SAVE_FAILED });
    expect(secrets.deps.updateSettings).not.toHaveBeenCalled();

    const stored = setup({ saveSettings: () => { throw new Error('EBUSY: settings.json'); } });
    expect(await stored.actions.save(BLE, BLE_DEV)).toEqual({ ok: false, error: SETTINGS_FAILED });
    for (const s of [login, secrets, stored]) {
      expect(s.deps.secrets.remove).not.toHaveBeenCalled();
      expect(s.deps.restartActual).not.toHaveBeenCalled();
    }
  });

  test('saving keys or the account after Bluetooth removes the Bluetooth token', async () => {
    for (const [input, keep] of [[KEYS, 'ecoflow'], [ACCOUNT, 'ecoflow-app']] as const) {
      const { actions, deps } = setup({ settings: { actualSource: BLE_CONFIG } });
      expect(await actions.save(input, DEVICE)).toEqual({ ok: true });
      expect(deps.secrets.remove).toHaveBeenCalledWith('ecoflow-ble');
      expect(deps.secrets.remove).not.toHaveBeenCalledWith(keep);
    }
  });

  test('no result, log or error contains the password, userId or token', async () => {
    const JWT = 'jwt-token-abc', USER_ID = '1234567890123456789';
    const TOKEN = authToken(USER_ID, BLE_SN);
    const secrets = [EMAIL, PASSWORD, PASSWORD_B64, JWT, USER_ID, TOKEN];
    // The sign-in can only echo what it was given (EcoflowAppApi hides its own session, see the next test);
    // everything after it may echo all of them.
    const signInEcho = `bad ${EMAIL} ${PASSWORD} ${PASSWORD_B64}`;
    const echo = `bad ${secrets.join(' ')}`;
    const session: AppSession = { token: JWT, userId: USER_ID };
    const appApi = (o: { devices?: EcoflowDevice[] | Error } = {}) => ({
      ...fakeAppApi({ devices: o.devices ?? [{ sn: BLE_SN, online: true, productName: 'RIVER 2' }] }),
      login: vi.fn(() => Promise.resolve(session)),
    });
    const results: unknown[] = [];
    const runs: ReturnType<typeof setup>[] = [];
    const run = async (s: ReturnType<typeof setup>) => {
      runs.push(s);
      results.push(await s.actions.test(ACCOUNT), await s.actions.scan(), await s.actions.preview(BLE, BLE_SN), await s.actions.save(BLE, BLE_DEV));
    };
    await run(setup({ appApi: appApi(), ble: fakeBle({ scan: { adverts: [advert(BLE_SN)] }, connected: BLE_SN }) }));
    await run(setup({ appApi: appApi(), ble: fakeBle({ scan: new Error(echo) }) }));
    await run(setup({ appApi: appApi({ devices: new EcoflowApiError('9999', signInEcho) }) }));
    await run(setup({ appApi: appApi({ devices: new Error(signInEcho) }) }));
    await run(setup({ appApi: appApi(), saveSecrets: () => { throw new Error(echo); } }));
    await run(setup({ appApi: appApi(), saveSettings: () => { throw new Error(echo); } }));
    await run(setup({ appApi: { ...appApi(), login: vi.fn(() => Promise.reject(new EcoflowApiError('9999', signInEcho))) } }));
    await run(setup({ appApi: { ...appApi(), login: vi.fn(() => Promise.reject(new Error(signInEcho))) } }));

    expect(results).toContainEqual({ ok: true });
    for (const error of [CONNECT_FAILED, ACCOUNT_SAVE_FAILED, SETTINGS_FAILED, BAD_INPUT]) expect(results).toContainEqual({ ok: false, error });
    expect(results).toContainEqual({ ok: true, devices: [{ sn: BLE_SN, label: 'RIVER 2', online: true }] });
    expect(results).toContainEqual({ nearby: [BLE_SN] });
    expect(results).toContainEqual({ nearby: [], bluetooth: 'Не вдалося пошукати станцію через Bluetooth' });
    for (const s of runs) {
      const seen = [
        ...s.deps.updateSettings.mock.calls.map(c => JSON.stringify(c)),
        ...Object.values(s.deps.log).map(level => JSON.stringify(level.mock.calls)),
      ];
      for (const text of seen) for (const secret of secrets) expect(text).not.toContain(secret);
      for (const [id, saved] of s.deps.secrets.save.mock.calls) expect([id, saved]).toEqual(['ecoflow-ble', { token: TOKEN }]);
    }
    for (const r of results) for (const secret of secrets) expect(JSON.stringify(r)).not.toContain(secret);
  });

  test('disconnect from Bluetooth removes all three secrets', async () => {
    const { actions, deps, order } = setup({ settings: { actualSource: BLE_CONFIG } });
    await actions.disconnect();
    expect(deps.updateSettings).toHaveBeenCalledWith({ actualSource: null });
    expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow', 'ecoflow-app', 'ecoflow-ble']);
    expect(order.at(-1)).toBe('restartActual');
  });
});

/** Registers the handlers with a mocked ipcMain and returns the one for `channel`. */
function handlerOf(channel: string, deps: Partial<IpcDeps>): (...args: unknown[]) => unknown {
  const handle = vi.mocked(ipcMain.handle);
  handle.mockClear();
  registerIpc(deps as IpcDeps);
  const found = handle.mock.calls.find(([ch]) => ch === channel);
  if (!found) throw new Error(`no handler for ${channel}`);
  return (...args) => (found[1] as (e: unknown, ...a: unknown[]) => unknown)({}, ...args);
}

test('ipc-actual: ecoflowScan is wired and passes nothing from the renderer on', async () => {
  expect(IPC.ecoflowScan).toBe('actual:ecoflow-scan');
  const scan = vi.fn(async () => ({ nearby: [BLE_SN] }));
  const handler = handlerOf(IPC.ecoflowScan, { actualActions: { scan } as unknown as ActualActions });
  expect(await handler({ mode: 'ble', region: 'eu' }, 'R601#')).toEqual({ nearby: [BLE_SN] });
  expect(scan).toHaveBeenCalledWith();
});

describe('the live line over IPC', () => {
  const LIVE: ActualLive = { link: 'connected', acInVolts: 227, soc: 87 };

  test('ipc-actual: getActualLive is wired, and answers only while the saved source is ecoflow-ble', () => {
    expect(IPC.getActualLive).toBe('actual:get-live');
    expect(IPC.actualLive).toBe('actual:live');
    let settings: Settings = { ...DEFAULT_SETTINGS, actualSource: BLE_CONFIG };
    const getLive = vi.fn(() => LIVE);
    const getActualLive = handlerOf(IPC.getActualLive, { getSettings: () => settings, bleLive: { getLive } });
    expect(getActualLive()).toEqual(LIVE);
    // Read on each call: switching the source takes effect at once.
    for (const actualSource of [CONFIG, APP_CONFIG, null]) {
      settings = { ...settings, actualSource };
      expect(getActualLive()).toBeNull();
    }
    expect(getLive).toHaveBeenCalledTimes(1);
  });

  describe('throttleLive', () => {
    beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-19T10:00:00Z') }));
    afterEach(() => vi.useRealTimers());

    const searching: ActualLive = { link: 'searching' }, connecting: ActualLive = { link: 'connecting' };

    test('sends at once when idle, then at most once per second, always ending on the last value', () => {
      expect(LIVE_PUSH_MS).toBe(1_000);
      const target = { send: vi.fn() };
      const live = throttleLive(target);
      live.push(searching);
      expect(target.send.mock.calls).toEqual([[IPC.actualLive, searching]]);
      live.push(connecting);
      live.push(LIVE);
      vi.advanceTimersByTime(999);
      expect(target.send).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(target.send.mock.calls).toEqual([[IPC.actualLive, searching], [IPC.actualLive, LIVE]]);
      // A trailing null (the source stopped) is a value like any other.
      live.push(null);
      vi.advanceTimersByTime(999);
      expect(target.send).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(target.send.mock.calls[2]).toEqual([IPC.actualLive, null]);
      // Quiet for a while: the next value goes out at once again.
      vi.advanceTimersByTime(5_000);
      live.push(searching);
      expect(target.send).toHaveBeenCalledTimes(4);
      vi.advanceTimersByTime(10_000);
      expect(target.send).toHaveBeenCalledTimes(4);
    });

    test('a clock set back an hour does not hold the next value for that hour', () => {
      const target = { send: vi.fn() };
      const live = throttleLive(target);
      live.push(searching);
      // The last send now looks an hour in the future.
      vi.setSystemTime(Date.now() - 3_600_000);
      live.push(connecting);
      vi.advanceTimersByTime(LIVE_PUSH_MS);
      expect(target.send.mock.calls).toEqual([[IPC.actualLive, searching], [IPC.actualLive, connecting]]);
      // And the pace after it is the usual one.
      live.push(LIVE);
      vi.advanceTimersByTime(LIVE_PUSH_MS);
      expect(target.send).toHaveBeenCalledTimes(3);
    });

    test('dispose drops a pending send and ignores later values', () => {
      const target = { send: vi.fn() };
      const live = throttleLive(target);
      live.push(searching);
      live.push(LIVE);
      live.dispose();
      live.push(connecting);
      vi.advanceTimersByTime(10_000);
      expect(target.send.mock.calls).toEqual([[IPC.actualLive, searching]]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('account mode: the session of the check', () => {
  const MIN = 60_000;
  const NO_REPLY = { ok: true, online: true, power: 'unknown', reason: AFTER_SAVE_REASON, unsupported: false };
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-18T10:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  /** The silent broker never answers: the preview ends after PREVIEW_WAIT_MS. */
  async function previewNow(actions: ActualActions, i: unknown, sn = 'SN1') {
    const pending = actions.preview(i, sn);
    await vi.advanceTimersByTimeAsync(PREVIEW_WAIT_MS);
    return pending;
  }

  test('test, then the previews of two stations: one login in all', async () => {
    const { actions, appApi, broker } = setup();
    expect(await actions.test(ACCOUNT)).toMatchObject({ ok: true });
    expect(await previewNow(actions, ACCOUNT, 'SN1')).toEqual(NO_REPLY);
    expect(await previewNow(actions, ACCOUNT, 'SN2')).toEqual(NO_REPLY);
    expect(appApi.login).toHaveBeenCalledTimes(1);
    expect(vi.mocked(appApi.getCertification).mock.calls).toEqual([[SESSION], [SESSION]]);
    expect(broker.connect).toHaveBeenCalledTimes(2);
  });

  test('the session is kept for 10 minutes', async () => {
    const a = setup();
    await a.actions.test(ACCOUNT);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    await previewNow(a.actions, ACCOUNT);
    expect(a.appApi.login).toHaveBeenCalledTimes(1);

    const b = setup();
    await b.actions.test(ACCOUNT);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    await previewNow(b.actions, ACCOUNT);
    expect(b.appApi.login).toHaveBeenCalledTimes(2);
  });

  test('another region, email or password logs in again', async () => {
    for (const other of [{ ...ACCOUNT, region: 'us' }, { ...ACCOUNT, email: 'other@dully.io' }, { ...ACCOUNT, password: `${PASSWORD} ` }]) {
      const { actions, appApi } = setup();
      await actions.test(ACCOUNT);
      await previewNow(actions, other);
      expect(appApi.login).toHaveBeenCalledTimes(2);
    }
  });

  test('a refused certification of the kept session: one fresh login, the preview goes on, the new session is kept', async () => {
    const fresh: AppSession = { token: 'TOKEN2', userId: 'USER1' };
    let logins = 0;
    const appApi = {
      login: vi.fn(() => Promise.resolve(++logins === 1 ? SESSION : fresh)),
      getCertification: vi.fn((s: AppSession) => (s === SESSION
        ? Promise.reject(new EcoflowApiError('http-401'))
        : Promise.resolve({ account: 'a', password: 'b', host: 'h', port: 8883 }))),
      listDevices: vi.fn((_s: AppSession) => Promise.resolve([RIVER])),
    } satisfies EcoflowAppApiLike;
    const { actions, broker } = setup({ appApi });
    await actions.test(ACCOUNT);
    expect(await previewNow(actions, ACCOUNT, 'SN1')).toEqual(NO_REPLY);
    expect(await previewNow(actions, ACCOUNT, 'SN2')).toEqual(NO_REPLY);
    expect(appApi.login).toHaveBeenCalledTimes(2);
    expect(appApi.getCertification.mock.calls).toEqual([[SESSION], [fresh], [fresh]]);
    expect(broker.connect).toHaveBeenCalledTimes(2);
  });

  test('a certification that failed on the way costs no login: its error comes back', async () => {
    const { actions, appApi, broker } = setup({ appApi: fakeAppApi({ cert: new NetworkError('Немає з’єднання з EcoFlow') }) });
    await actions.test(ACCOUNT);
    expect(await previewNow(actions, ACCOUNT)).toEqual({ ok: false, error: 'Немає з’єднання з EcoFlow' });
    expect(appApi.login).toHaveBeenCalledTimes(1);
    expect(broker.connect).not.toHaveBeenCalled();
  });
});

describe('restartActual', () => {
  const NOW = Date.parse('2026-10-17T10:00:00Z');

  function restartSetup(o: { settings?: Partial<Settings>; secrets?: Record<string, string> | null; start?: () => void } = {}) {
    let settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings };
    const source: ActualStateSource = { start: vi.fn(), stop: vi.fn() };
    const create = vi.fn<ActualSourceFactory['create']>(() => source);
    const deps = {
      getSettings: () => settings,
      updateSettings: vi.fn((patch: Partial<Settings>) => { settings = { ...settings, ...patch }; }),
      secrets: { load: vi.fn((_id: string) => (o.secrets === undefined ? { accessKey: AKEY, secretKey: SECRET } : o.secrets)) },
      service: { start: vi.fn((_s: ActualStateSource, _label: string) => { o.start?.(); }), stop: vi.fn() },
      sources: [{ id: 'ecoflow', displayName: 'EcoFlow', create }, { id: 'ecoflow-app', displayName: 'EcoFlow', create }, { id: 'ecoflow-ble', displayName: 'EcoFlow', create }],
      log: fakeLog(),
      now: () => NOW,
    } satisfies ActualRestartDeps;
    return { deps, restart: createActualRestart(deps), create, source, settings: () => settings };
  }

  test('no source configured → stops the service', () => {
    const { deps, restart, create } = restartSetup();
    expect(restart()).toBe(true);
    expect(deps.service.stop).toHaveBeenCalledTimes(1);
    expect(deps.service.start).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test('starts the configured source with its keys, clientId and label', () => {
    const { deps, restart, create, source } = restartSetup({ settings: { actualSource: CONFIG, ecoflowClientId: 'BlackoutWidget-abc12345' } });
    expect(restart()).toBe(true);
    expect(deps.secrets.load).toHaveBeenCalledWith('ecoflow');
    expect(create).toHaveBeenCalledWith(CONFIG, { accessKey: AKEY, secretKey: SECRET }, { clientId: 'BlackoutWidget-abc12345', log: deps.log });
    expect(deps.service.start).toHaveBeenCalledWith(source, 'EcoFlow · RIVER 2');
    expect(deps.updateSettings).not.toHaveBeenCalled();
  });

  test('a missing clientId is generated once and saved (ruling R5)', () => {
    const { deps, restart, create, settings } = restartSetup({ settings: { actualSource: CONFIG } });
    restart();
    expect(deps.updateSettings).toHaveBeenCalledTimes(1);
    const clientId = settings().ecoflowClientId;
    expect(clientId).toMatch(CLIENT_ID);
    expect(create.mock.calls[0][2].clientId).toBe(clientId);
    restart();
    expect(deps.updateSettings).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[1][2].clientId).toBe(clientId);
  });

  test('unreadable keys → a source that reports unknown with the reason', () => {
    for (const secrets of [null, { accessKey: AKEY }]) {
      const { deps, restart, create } = restartSetup({ settings: { actualSource: CONFIG, ecoflowClientId: 'BlackoutWidget-abc12345' }, secrets });
      expect(restart()).toBe(true);
      expect(create).not.toHaveBeenCalled();
      const [src, label] = deps.service.start.mock.calls[0];
      expect(label).toBe('EcoFlow · RIVER 2');
      const readings: ActualReading[] = [];
      src.start(r => readings.push(r));
      expect(readings).toEqual([{ power: 'unknown', observedAt: '2026-10-17T10:00:00.000Z', reason: KEYS_MISSING_REASON }]);
      expect(KEYS_MISSING_REASON).toBe('Ключі EcoFlow не знайдено — введіть їх знову в налаштуваннях');
      expect(() => src.stop()).not.toThrow();
    }
  });

  test('account source: clientId is the persisted uuid, secrets load under ecoflow-app', () => {
    const uuid = 'A'.repeat(32);
    const secrets = { email: EMAIL, password: PASSWORD };
    const { deps, restart, create, source } = restartSetup({ settings: { actualSource: APP_CONFIG, ecoflowAppClientUuid: uuid }, secrets });
    expect(restart()).toBe(true);
    expect(deps.secrets.load).toHaveBeenCalledWith('ecoflow-app');
    expect(create).toHaveBeenCalledWith(APP_CONFIG, secrets, { clientId: uuid, log: deps.log });
    expect(deps.service.start).toHaveBeenCalledWith(source, 'EcoFlow · RIVER 2');
    expect(deps.updateSettings).not.toHaveBeenCalled();
  });

  test('account source: a missing uuid is generated once and saved', () => {
    const { deps, restart, create, settings } = restartSetup({ settings: { actualSource: APP_CONFIG }, secrets: { email: EMAIL, password: PASSWORD } });
    restart();
    restart();
    expect(deps.updateSettings).toHaveBeenCalledTimes(1);
    expect(settings().ecoflowAppClientUuid).toMatch(UUID);
    expect(settings().ecoflowClientId).toBeUndefined();
    expect(create.mock.calls[1][2].clientId).toBe(settings().ecoflowAppClientUuid);
  });

  test('account source: missing or partial secrets → unknown with the account reason', () => {
    for (const secrets of [null, { email: EMAIL }, { accessKey: AKEY, secretKey: SECRET }] as (Record<string, string> | null)[]) {
      const { deps, restart, create } = restartSetup({ settings: { actualSource: APP_CONFIG, ecoflowAppClientUuid: 'A'.repeat(32) }, secrets });
      expect(restart()).toBe(true);
      expect(create).not.toHaveBeenCalled();
      const readings: ActualReading[] = [];
      deps.service.start.mock.calls[0][0].start(r => readings.push(r));
      expect(readings).toEqual([{ power: 'unknown', observedAt: '2026-10-17T10:00:00.000Z', reason: ACCOUNT_MISSING_REASON }]);
    }
    expect(ACCOUNT_MISSING_REASON).toBe('Дані входу EcoFlow не знайдено — увійдіть знову в налаштуваннях');
  });

  test('an ecoflow-ble source with a valid token starts the Bluetooth factory, with no clientId made', () => {
    const token = 'ABCDEF0123456789ABCDEF0123456789';
    const config: ActualSourceConfig = { id: 'ecoflow-ble', region: 'eu', deviceSn: 'R601ZEB4XXXX0000', deviceName: 'RIVER 2', accountHint: 'R601…0000' };
    const { deps, restart, create, source } = restartSetup({ settings: { actualSource: config }, secrets: { token } });
    expect(restart()).toBe(true);
    expect(deps.secrets.load).toHaveBeenCalledWith('ecoflow-ble');
    expect(create).toHaveBeenCalledWith(config, { token }, { clientId: '', log: deps.log });
    expect(deps.service.start).toHaveBeenCalledWith(source, 'EcoFlow · RIVER 2');
    expect(deps.updateSettings).not.toHaveBeenCalled();
  });

  test('an ecoflow-ble source with a missing or malformed token gives ACCOUNT_MISSING_REASON', () => {
    const config: ActualSourceConfig = { id: 'ecoflow-ble', region: 'eu', deviceSn: 'R601ZEB4XXXX0000', deviceName: 'RIVER 2', accountHint: 'R601…0000' };
    for (const secrets of [null, {}, { token: 'abc' }, { token: 'abcdef0123456789abcdef0123456789' }] as (Record<string, string> | null)[]) {
      const { deps, restart, create, settings } = restartSetup({ settings: { actualSource: config }, secrets });
      expect(restart()).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(deps.updateSettings).not.toHaveBeenCalled();
      expect(settings().ecoflowClientId).toBeUndefined();
      const readings: ActualReading[] = [];
      deps.service.start.mock.calls[0][0].start(r => readings.push(r));
      expect(readings).toEqual([{ power: 'unknown', observedAt: '2026-10-17T10:00:00.000Z', reason: ACCOUNT_MISSING_REASON }]);
    }
  });

  test('a failing start (locked journal) is logged, never thrown', () => {
    const { deps, restart } = restartSetup({
      settings: { actualSource: CONFIG, ecoflowClientId: 'BlackoutWidget-abc12345' },
      start: () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); },
    });
    expect(restart()).toBe(false);
    expect(deps.log.error).toHaveBeenCalledTimes(1);
  });

  test('an unknown source id is logged, never thrown', () => {
    const { deps, restart } = restartSetup({ settings: { actualSource: { ...CONFIG, id: 'other' as 'ecoflow' }, ecoflowClientId: 'BlackoutWidget-abc12345' } });
    expect(restart()).toBe(false);
    expect(deps.service.start).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledTimes(1);
  });
});
