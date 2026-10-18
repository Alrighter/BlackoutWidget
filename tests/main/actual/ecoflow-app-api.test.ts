import { EcoflowApiError } from '../../../src/main/actual/ecoflow/api';
import { EcoflowAppApi } from '../../../src/main/actual/ecoflow/app-api';
import { NetworkError } from '../../../src/main/providers/types';

const account = { email: 'a@b.c', password: 'pässword' };
const session = { token: 'T', userId: '1234567890123456789' };
const reply = (body: string, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const recording = (body: string, status = 200) => {
  const calls: any[] = [];
  const fetch = async (url: string, init: any) => { calls.push({ url, init }); return { ok: status === 200, status, text: async () => body }; };
  return { calls, fetch };
};
const make = (fetch: any, region: 'eu' | 'us' = 'eu', timeoutMs?: number) => new EcoflowAppApi(region, account, { fetch, timeoutMs });
const LOGIN_OK = '{"code":"0","message":"Success","data":{"token":"T","user":{"userId":"1234567890123456789"}}}';

test('login: POST to the eu host with the exact body and app headers', async () => {
  const { calls, fetch } = recording(LOGIN_OK);
  await make(fetch).login();
  expect(calls[0].url).toBe('https://api-e.ecoflow.com/auth/login');
  expect(calls[0].init.method).toBe('POST');
  const b64 = Buffer.from('pässword', 'utf8').toString('base64');
  expect(calls[0].init.body).toBe(`{"email":"a@b.c","password":"${b64}","scene":"IOT_APP","userType":"ECOFLOW"}`);
  expect(calls[0].init.headers).toMatchObject({
    'content-type': 'application/json', lang: 'en_US', platform: 'android', version: '4.1.2.02', 'user-agent': 'okhttp/3.14.9',
  });
});

test('login: us host', async () => {
  const { calls, fetch } = recording(LOGIN_OK);
  await make(fetch, 'us').login();
  expect(calls[0].url).toBe('https://api.ecoflow.com/auth/login');
});

test('login: token and userId (kept as a string)', async () => {
  expect(await make(reply(LOGIN_OK)).login()).toEqual({ token: 'T', userId: '1234567890123456789' });
});

test('login: a numeric userId becomes a string', async () => {
  const body = '{"code":"0","data":{"token":"T","user":{"userId":42}}}';
  expect(await make(reply(body)).login()).toEqual({ token: 'T', userId: '42' });
});

test('login: missing token or userId is bad-json', async () => {
  const err = await make(reply('{"code":"0","data":{"user":{}}}')).login().catch(e => e);
  expect(err).toMatchObject({ code: 'bad-json' });
});

test('login 2026: not a key problem, spec text', async () => {
  const err = await make(reply('{"code":"2026","message":"Account doesn\'t exist or incorrect password"}')).login().catch(e => e);
  expect(err).toBeInstanceOf(EcoflowApiError);
  expect(err).toMatchObject({
    code: '2026',
    keyProblem: false,
    message: 'EcoFlow не прийняв вхід. Перевірте email, пароль і регіон. Якщо все правильно — можливо, EcoFlow тимчасово недоступний.',
  });
});

test('login 1005: bug text, not a key problem', async () => {
  const err = await make(reply('{"code":"1005","message":"Incorrect format of password"}')).login().catch(e => e);
  expect(err).toMatchObject({ code: '1005', keyProblem: false, message: 'EcoFlow не прийняв формат пароля (1005). Це помилка застосунку — повідомте розробника.' });
});

test('login errors: http, bad-json, network, timeout', async () => {
  expect(await make(reply('', 500)).login().catch(e => e)).toMatchObject({ code: 'http-500' });
  expect(await make(reply('<html>')).login().catch(e => e)).toMatchObject({ code: 'bad-json' });
  const down = async () => { throw new Error('ENOTFOUND'); };
  expect(await make(down).login().catch(e => e)).toBeInstanceOf(NetworkError);
  const hang = (_u: string, init: any) => new Promise<never>((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  expect(await make(hang, 'eu', 10).login().catch(e => e)).toMatchObject({ code: 'timeout' });
});

test('certification: GET with query userId and Bearer, maps fields', async () => {
  const body = '{"code":"0","data":{"url":"mqtt-e.ecoflow.com","port":"8883","protocol":"mqtts","certificateAccount":"app-x","certificatePassword":"p"}}';
  const { calls, fetch } = recording(body);
  expect(await make(fetch).getCertification(session)).toEqual({ host: 'mqtt-e.ecoflow.com', port: 8883, account: 'app-x', password: 'p' });
  expect(calls[0].url).toBe('https://api-e.ecoflow.com/iot-auth/app/certification?userId=1234567890123456789');
  expect(calls[0].init.method).toBe('GET');
  expect(calls[0].init.headers.authorization).toBe('Bearer T');
  expect(calls[0].init.body).toBeUndefined();
});

test('certification: incomplete data is bad-json', async () => {
  const err = await make(reply('{"code":"0","data":{"url":"h"}}')).getCertification(session).catch(e => e);
  expect(err).toMatchObject({ code: 'bad-json' });
});

test('device list: bound keyed by SN plus share as a list', async () => {
  const body = JSON.stringify({ code: '0', data: {
    bound: { R601ABC: { deviceName: 'River', online: 1 } },
    share: [{ sn: 'R602', deviceName: 'Shared', online: 0 }],
  } });
  const { calls, fetch } = recording(body);
  expect(await make(fetch).listDevices(session)).toEqual([
    { sn: 'R601ABC', online: true, deviceName: 'River' },
    { sn: 'R602', online: false, deviceName: 'Shared' },
  ]);
  expect(calls[0].url).toBe('https://api-e.ecoflow.com/iot-service/user/device?userId=1234567890123456789');
  expect(calls[0].init.headers.authorization).toBe('Bearer T');
});

test('device list: grouped list form is flattened', async () => {
  const body = JSON.stringify({ code: '0', data: { bound: { g1: [{ sn: 'A', online: 1, productName: 'RIVER 2' }] } } });
  expect(await make(reply(body)).listDevices(session)).toEqual([{ sn: 'A', online: true, productName: 'RIVER 2' }]);
});

test('device list: empty or missing data gives []', async () => {
  expect(await make(reply('{"code":"0","data":{}}')).listDevices(session)).toEqual([]);
  expect(await make(reply('{"code":"0"}')).listDevices(session)).toEqual([]);
});
