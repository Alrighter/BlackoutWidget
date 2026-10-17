import { describeEcoflowError, deviceLabel, EcoflowApi, EcoflowApiError } from '../../../src/main/actual/ecoflow/api';
import { hmacHex } from '../../../src/main/actual/ecoflow/sign';
import { maskKey } from '../../../src/main/actual/secrets';
import { NetworkError } from '../../../src/main/providers/types';

const keys = { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' };
const reply = (body: string, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const make = (fetch: any) => new EcoflowApi('eu', keys, { fetch, now: () => 1671171709428, random: () => 0.345164 });

test('GET quota/all: sn in URL and in signature, headers exact, no Content-Type', async () => {
  const calls: any[] = [];
  const fetch = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"code":"0","data":{"inv.acInVol":228652}}' }; };
  const api = new EcoflowApi('eu', keys, { fetch, now: () => 1671171709428, random: () => 0.345164 });
  expect(await api.getQuotaAll('R601X')).toEqual({ 'inv.acInVol': 228652 });
  expect(calls[0].url).toBe('https://api-e.ecoflow.com/iot-open/sign/device/quota/all?sn=R601X');
  expect(calls[0].init.method).toBe('GET');
  expect(Object.keys(calls[0].init.headers).sort()).toEqual(['accessKey', 'nonce', 'sign', 'timestamp']);
  expect(calls[0].init.headers.nonce).toBe('345164');
  expect(calls[0].init.headers.timestamp).toBe('1671171709428');
  expect(calls[0].init.headers.sign).toBe(hmacHex('sn=R601X&accessKey=AKEY1234567&nonce=345164&timestamp=1671171709428', 'SECRET-xyz'));
});

test('us region host, nonce zero-padded', async () => {
  const calls: any[] = [];
  const fetch = async (u: string, i: any) => { calls.push({ u, i }); return { ok: true, status: 200, text: async () => '{"code":"0","data":[]}' }; };
  await new EcoflowApi('us', keys, { fetch, now: () => 1, random: () => 0.000042 }).listDevices();
  expect(calls[0].u).toBe('https://api.ecoflow.com/iot-open/sign/device/list');
  expect(calls[0].i.headers.nonce).toBe('000042');
});

test('device list parsing and label fallback', async () => {
  const data = [{ sn: 'A', online: 1, productName: 'RIVER 2' }, { sn: 'B', online: 0, deviceName: 'DELTA 3 Plus-XYZ' }, { sn: 'C', online: 0 }];
  const devs = await make(reply(JSON.stringify({ code: '0', data }))).listDevices();
  expect(devs.map(d => d.online)).toEqual([true, false, false]);
  expect(devs.map(deviceLabel)).toEqual(['RIVER 2', 'DELTA 3 Plus-XYZ', 'C']);
});

test('certification maps url/port', async () => {
  const data = { certificateAccount: 'open-1', certificatePassword: 'pw', url: 'mqtt-e.ecoflow.com', port: '8883', protocol: 'mqtts' };
  expect(await make(reply(JSON.stringify({ code: '0', data }))).getCertification())
    .toEqual({ account: 'open-1', password: 'pw', host: 'mqtt-e.ecoflow.com', port: 8883 });
});

test.each([
  ['1006', 'current device is not allowed to get device info', false, 'EcoFlow не віддає дані цієї станції через API розробника (1006). Можливо, станція прив’язана до іншого акаунта або ця модель не підтримується.'],
  ['8521', 'signature is wrong', true, 'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.'],
  ['8524', 'bad time', true, 'EcoFlow не прийняв час запиту (8524). Перевірте, чи правильно виставлено час на комп’ютері.'],
  ['8513', 'x', true, 'Схоже, ключі з іншого регіону (8513). Спробуйте інший регіон.'],
  ['9999', 'accessKey is invalid', true, 'EcoFlow не знає такого Access Key. Перевірте ключ і регіон.'],
  ['9998', 'device does not exist', true, 'EcoFlow не знає такого Access Key. Перевірте ключ і регіон.'],
  ['4242', 'boom', false, 'Помилка EcoFlow 4242: boom'],
])('api error %s', async (code, message, keyProblem, text) => {
  const err = await make(reply(JSON.stringify({ code, message }))).getQuotaAll('S').catch(e => e);
  expect(err).toBeInstanceOf(EcoflowApiError);
  expect(err).toMatchObject({ code, keyProblem, message: text });
});

test('describeEcoflowError for local codes', () => {
  expect(describeEcoflowError('timeout', '')).toBe('EcoFlow не відповідає. Спробуйте пізніше.');
  expect(describeEcoflowError('bad-json', '')).toBe('EcoFlow повернув незрозумілу відповідь.');
  expect(describeEcoflowError('http-503', '')).toBe('EcoFlow не відповідає (HTTP 503).');
});

test('fetch rejection → NetworkError; HTTP 503 → http-503; garbage → bad-json', async () => {
  const net = await make(async () => { throw new TypeError('fetch failed'); }).listDevices().catch(e => e);
  expect(net).toBeInstanceOf(NetworkError);
  expect(net.message).toBe('Немає з’єднання з EcoFlow');
  expect(await make(reply('oops', 503)).listDevices().catch(e => e)).toMatchObject({ code: 'http-503', keyProblem: false });
  expect(await make(reply('<html>')).listDevices().catch(e => e)).toMatchObject({ code: 'bad-json' });
});

const hangUntilAbort = (_u: string, init: any) => new Promise<never>((_, rej) => {
  init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
});

test('timeout aborts the request → EcoflowApiError timeout', async () => {
  const api = new EcoflowApi('eu', keys, { fetch: hangUntilAbort, timeoutMs: 10 });
  expect(await api.listDevices().catch(e => e)).toMatchObject({ code: 'timeout', message: 'EcoFlow не відповідає. Спробуйте пізніше.' });
});

test('errors never contain keys', async () => {
  const fetches = [
    reply(JSON.stringify({ code: '8521', message: 'signature is wrong' })),
    reply('oops', 503),
    reply('<html>'),
    async () => { throw new TypeError('fetch failed'); },
    hangUntilAbort,
  ];
  for (const f of fetches) {
    const err = await new EcoflowApi('eu', keys, { fetch: f as any, timeoutMs: 10 }).listDevices().catch(e => e);
    for (const s of [String(err), JSON.stringify(err), err.message, String(err.stack)]) {
      expect(s).not.toContain('AKEY1234567');
      expect(s).not.toContain('SECRET-xyz');
    }
  }
});

test('maskKey', () => { expect(maskKey('Fp4SvIprYSDPXtYJidEtUAd1o')).toBe('Fp4S…'); expect(maskKey('abc')).toBe('…'); });
