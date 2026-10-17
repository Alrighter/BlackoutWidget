import {
  createActualActions, createActualRestart, KEYS_MISSING_REASON, makeClientId, type ActualActionsDeps, type ActualRestartDeps,
} from '../../../src/main/actual/actions';
import { EcoflowApiError, type EcoflowApiLike, type EcoflowDevice } from '../../../src/main/actual/ecoflow/api';
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
const KEY_8521 = 'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.';
const CLIENT_ID = /^BlackoutWidget-[a-z0-9]{8}$/;
const RIVER: EcoflowDevice = { sn: 'SN1', online: true, productName: 'RIVER 2' };
const CONFIG: ActualSourceConfig = { id: 'ecoflow', region: 'eu', deviceSn: 'SN1', deviceName: 'RIVER 2', accessKeyHint: 'AKEY…' };

const settle = <T>(v: T | Error): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));

function fakeApi(o: { devices?: EcoflowDevice[] | Error; quota?: Record<string, unknown> | Error } = {}) {
  return {
    listDevices: vi.fn(() => settle(o.devices ?? [RIVER])),
    getQuotaAll: vi.fn((_sn: string) => settle(o.quota ?? { 'inv.acInVol': 229345 })),
    getCertification: vi.fn(() => Promise.reject(new Error('preview must not touch MQTT'))),
  } satisfies EcoflowApiLike;
}

const fakeLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function setup(o: {
  api?: EcoflowApiLike; settings?: Partial<Settings>; saveSecrets?: () => void; removeSecrets?: () => void; saveSettings?: () => void;
} = {}) {
  const order: string[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS, ...o.settings };
  const api = o.api ?? fakeApi();
  const deps = {
    makeApi: vi.fn((_region: string, _keys: { accessKey: string; secretKey: string }) => api),
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
  return { deps, actions: createActualActions(deps), order, settings: () => settings };
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
  for (const sn of ['x'.repeat(500), 'x'.repeat(65), '', 42, null]) {
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
  expect(order).toEqual(['secrets.save', 'updateSettings', 'restartActual']);
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
  expect(order).toEqual(['updateSettings', 'secrets.remove', 'restartActual']);
  expect(settings().actualSource).toBeNull();
  expect(settings().ecoflowClientId).toBe('BlackoutWidget-abc12345');
});

test('disconnect: a secrets file that cannot be rewritten still restarts', async () => {
  const { actions, deps } = setup({ settings: { actualSource: CONFIG }, removeSecrets: () => { throw new Error('EPERM'); } });
  await expect(actions.disconnect()).resolves.toBeUndefined();
  expect(deps.log.error).toHaveBeenCalledTimes(1);
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
      sources: [{ id: 'ecoflow', displayName: 'EcoFlow', create }],
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
