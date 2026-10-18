import {
  ACCOUNT_MISSING_REASON, createActualActions, createActualRestart, KEYS_MISSING_REASON, makeClientId,
  type ActualActions, type ActualActionsDeps, type ActualRestartDeps,
} from '../../../src/main/actual/actions';
import { EcoflowApiError, type EcoflowApiLike, type EcoflowDevice, type FetchLike } from '../../../src/main/actual/ecoflow/api';
import { EcoflowAppApi, type AppSession, type EcoflowAppApiLike } from '../../../src/main/actual/ecoflow/app-api';
import { AFTER_SAVE_REASON, PREVIEW_WAIT_MS } from '../../../src/main/actual/ecoflow/index';
import type { MqttClientLike } from '../../../src/main/actual/ecoflow/mqtt-session';
import { SecretsUnavailableError } from '../../../src/main/actual/secrets';
import type { ActualReading, ActualSourceFactory, ActualStateSource } from '../../../src/main/actual/types';
import { NetworkError } from '../../../src/main/providers/types';
import { DEFAULT_SETTINGS } from '../../../src/main/store';
import type { ActualSourceConfig, Settings } from '../../../src/shared/types';

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

function setup(o: {
  api?: EcoflowApiLike; appApi?: EcoflowAppApiLike; settings?: Partial<Settings>; saveSecrets?: () => void; removeSecrets?: () => void; saveSettings?: () => void;
} = {}) {
  const order: string[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings };
  const api = o.api ?? fakeApi();
  const appApi = o.appApi ?? fakeAppApi();
  const broker = silentBroker();
  const deps = {
    makeApi: vi.fn((_region: string, _keys: { accessKey: string; secretKey: string }) => api),
    makeAppApi: vi.fn((_region: string, _account: { email: string; password: string }) => appApi),
    connect: broker.connect,
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
  return { deps, actions: createActualActions(deps), order, settings: () => settings, appApi, broker };
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
  expect(order).toEqual(['secrets.save', 'updateSettings', 'secrets.remove', 'restartActual']);
  expect(deps.secrets.remove).toHaveBeenCalledWith('ecoflow-app');
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
  expect(deps.secrets.remove).toHaveBeenCalledWith('ecoflow');
  expect(deps.secrets.remove).toHaveBeenCalledWith('ecoflow-app');
  expect(order).toEqual(['updateSettings', 'secrets.remove', 'secrets.remove', 'restartActual']);
  expect(settings().actualSource).toBeNull();
  expect(settings().ecoflowClientId).toBe('BlackoutWidget-abc12345');
});

test('disconnect: a secrets file that cannot be rewritten still restarts', async () => {
  const { actions, deps } = setup({ settings: { actualSource: CONFIG }, removeSecrets: () => { throw new Error('EPERM'); } });
  await expect(actions.disconnect()).resolves.toBeUndefined();
  expect(deps.log.error).toHaveBeenCalledTimes(2); // each id is tried on its own
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
    expect(order).toEqual(['secrets.save', 'updateSettings', 'secrets.remove', 'restartActual']);
    expect(deps.secrets.remove).toHaveBeenCalledWith('ecoflow');

    const uuid = settings().ecoflowAppClientUuid;
    expect(await actions.save({ ...ACCOUNT, region: 'us' }, DEV)).toEqual({ ok: true });
    expect(deps.updateSettings.mock.calls[1][0].ecoflowAppClientUuid).toBe(uuid);
  });

  test('save: a failed removal of the keys is logged, not fatal', async () => {
    const { actions, deps } = setup({ removeSecrets: () => { throw new Error('EPERM'); } });
    expect(await actions.save(ACCOUNT, DEV)).toEqual({ ok: true });
    expect(deps.log.error).toHaveBeenCalledTimes(1);
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

  test('disconnect removes the secrets of both sources', async () => {
    const { actions, deps } = setup({ settings: { actualSource: APP_CONFIG } });
    await actions.disconnect();
    expect(deps.secrets.remove.mock.calls.map(c => c[0]).sort()).toEqual(['ecoflow', 'ecoflow-app']);
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
      sources: [{ id: 'ecoflow', displayName: 'EcoFlow', create }, { id: 'ecoflow-app', displayName: 'EcoFlow', create }],
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
