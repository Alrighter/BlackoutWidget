/**
 * SPIKE (throwaway): a read-only RIVER 2 Bluetooth probe. It signs in to the EcoFlow account only to learn the
 * account's user id, finds the station by its advertisement, runs the encrypted session and prints/logs every
 * heartbeat, so the user can switch AC output and the wall cord and we see what the station reports in each state.
 *
 * Run it in your own terminal (the password prompt needs a real console): npm run ble:probe
 * The log goes to .superpowers/ble-probe/ with no email, password, token, user id or full serial number in it.
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withBindings } from '@stoprocent/noble';
import type { EcoflowRegion } from '../../src/shared/types';
import { EcoflowAppApi } from '../../src/main/actual/ecoflow/app-api';
import { scrubSecrets } from '../../src/main/actual/secrets';
import { parseAdvert, type EcoflowAdvert } from '../../src/main/actual/ecoflow/ble/advert';
import { authToken } from '../../src/main/actual/ecoflow/ble/crypto';
import { decodeHeartbeat, heartbeatOf, type Fields } from '../../src/main/actual/ecoflow/ble/heartbeats';
import { EcoflowBleSession } from '../../src/main/actual/ecoflow/ble/session';

const CASES: Record<string, string> = {
  a: 'A: мережа є, вихід AC увімк, заряджається',
  b: 'B: мережа є, вихід AC вимк, заряджається',
  c: 'C: мережа є, вихід AC вимк, батарея 100%',
  d: 'D: мережа є, вихід AC увімк, батарея 100%',
  e: 'E: шнур витягнуто, вихід AC увімк з навантаженням',
  f: 'F: шнур витягнуто, вихід AC вимк',
  p: 'P: телефон підключається через Bluetooth',
};

const SCAN_MS = 30_000;
const RECONNECT_MS = 5_000;
const INV_SILENCE_MS = 10_000;
const CONNECT_TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- log ----------

const logDir = resolve(__dirname, '../../.superpowers/ble-probe');
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
let secrets: string[] = [];
const t0 = Date.now();

function log(kind: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), ms: Date.now() - t0, kind, ...data });
  appendFileSync(logFile, `${scrubSecrets(line, secrets)}\n`);
}

/** Secrets as they could appear in a payload's hex too. */
function addSecret(s: string): void {
  if (!s) return;
  secrets.push(s, Buffer.from(s, 'utf8').toString('hex'));
}

// ---------- console input ----------

function ask(question: string, hidden = false): Promise<string> {
  return new Promise(resolvePromise => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolvePromise(value);
          return;
        }
        if (ch === '\u0008' || ch === '\u007f') {
          if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        value += ch;
        process.stdout.write(hidden ? '*' : ch);
      }
    };
    stdin.on('data', onData);
  });
}

// ---------- state shown to the user ----------

const state: { inv?: Fields; pd?: Fields; mppt?: Fields; ems?: Fields; invAt?: number; marker?: string; connected: boolean } = { connected: false };

function status(): string {
  const now = Date.now();
  const inv = state.inv;
  const grid = inv && state.invAt && now - state.invAt < INV_SILENCE_MS
    ? `вхід AC: ${(Number(inv.acInVol) / 1000).toFixed(1)} В ${inv.acInFreq} Гц, ${inv.inputWatts} Вт`
    : `вхід AC: інвертор мовчить${state.invAt ? ` ${Math.round((now - state.invAt) / 1000)} с` : ''}`;
  const acOut = state.mppt?.cfgAcEnabled ?? inv?.cfgAcEnabled;
  const parts = [
    new Date().toLocaleTimeString('uk-UA'),
    grid,
    `вихід AC: ${acOut === undefined ? '?' : acOut ? 'увімк' : 'вимк'}`,
    `заряд: ${state.pd?.soc ?? '?'}%`,
    `вхід всього: ${state.pd?.wattsInSum ?? '?'} Вт`,
  ];
  if (state.marker) parts.push(`[${state.marker.slice(0, 1)}]`);
  return parts.join(' | ');
}

// ---------- BLE ----------

const short = (uuid: string): string => {
  const u = uuid.replace(/-/g, '').toLowerCase();
  if (u.length === 32 && u.endsWith('00001000800000805f9b34fb')) return parseInt(u.slice(0, 8), 16).toString(16);
  return /^[0-9a-f]{4,8}$/.test(u) ? parseInt(u, 16).toString(16) : u;
};
const UUIDS = [
  { write: '2', notify: '3' },
  { write: '6e400002b5a3f393e0a9e50e24dcca9e', notify: '6e400003b5a3f393e0a9e50e24dcca9e' },
];

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('Запустіть це у власному терміналі (PowerShell або Terminal): пароль треба ввести з клавіатури.');
    process.exit(2);
  }
  console.log('Тест Bluetooth для EcoFlow RIVER 2. Нічого не змінює на станції, лише читає.');
  console.log('Закрийте застосунок EcoFlow на телефоні або вимкніть на телефоні Bluetooth.\n');

  const regionIn = (await ask('Регіон акаунта EcoFlow, eu або us [eu]: ')).trim().toLowerCase();
  const region = (regionIn === 'us' ? 'us' : 'eu') as EcoflowRegion;
  const email = (await ask('Email: ')).trim();
  let password = await ask('Пароль (не показується): ', true);
  addSecret(email);
  addSecret(password);
  addSecret(Buffer.from(password, 'utf8').toString('base64'));

  const api = new EcoflowAppApi(region, { email, password }, { fetch: (url, init) => fetch(url, init) });
  let userId: string;
  let sns: string[];
  try {
    const s = await api.login();
    addSecret(s.token);
    addSecret(s.userId);
    userId = s.userId;
    sns = (await api.listDevices(s)).map(d => d.sn);
  } catch (e) {
    const msg = scrubSecrets(String((e as Error)?.message ?? e), secrets);
    console.error(`Не вдалося увійти: ${msg}`);
    log('login-failed', { error: msg });
    process.exit(1);
  }
  password = '';
  console.log(`Вхід успішний. Станцій в акаунті: ${sns.length}.`);
  log('login-ok', { devices: sns.map(sn => sn.slice(0, 4)) });

  const noble = withBindings('default');
  noble.on('stateChange', (s: string) => log('adapter-state', { state: s }));
  await noble.waitForPoweredOnAsync();

  console.log('Шукаю станцію поруч…');
  let advert: EcoflowAdvert | null = null;
  let peripheral: any = null;
  await noble.startScanningAsync([], true);
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('станцію не знайдено за 30 с: вона увімкнена і поруч?')), SCAN_MS);
    noble.on('discover', (p: any) => {
      const a = parseAdvert(p.advertisement?.manufacturerData);
      if (!a || peripheral) return;
      log('advert', { snPrefix: a.sn.slice(0, 4), soc: a.soc, encryptType: a.encryptType, flags: a.flags, rssi: p.rssi, inAccount: sns.includes(a.sn) });
      if (!sns.includes(a.sn)) return;
      advert = a;
      peripheral = p;
      clearTimeout(timer);
      done();
    });
  });
  await noble.stopScanningAsync();
  const found = advert as unknown as EcoflowAdvert;
  addSecret(found.sn);
  addSecret(authToken(userId, found.sn).toString('ascii'));
  console.log(`Знайдено ${found.sn.slice(0, 4)}…, заряд ${found.soc}%, тип шифрування ${found.encryptType}.`);
  if (found.encryptType !== 7) console.log('Увага: тип шифрування не 7, цей тест розрахований на 7.');

  console.log('\nКлавіші: a–f позначити стан (див. список), p: телефон підключається, q: вийти.');
  for (const [k, v] of Object.entries(CASES)) console.log(`  ${k}  ${v}`);
  console.log('');

  let quitting = false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const ch of chunk.toLowerCase()) {
      if (ch === 'q' || ch === '\u0003') { quitting = true; void shutdown(); return; }
      if (CASES[ch]) {
        state.marker = CASES[ch];
        log('marker', { case: ch, label: CASES[ch] });
        process.stdout.write(`\n>>> ${CASES[ch]}\n`);
      }
    }
  });

  async function shutdown(): Promise<void> {
    log('quit');
    process.stdout.write(`\nЛог: ${logFile}\n`);
    try { await peripheral?.disconnectAsync(); } catch { /* already gone */ }
    noble.stop();
    process.exit(0);
  }

  const ticker = setInterval(() => { if (state.connected) process.stdout.write(`\r${status()}    `); }, 1000);
  ticker.unref();

  let failures = 0;
  for (let attempt = 1; !quitting; attempt++) {
    if (state.marker === CASES.p) {
      // The phone's turn: leave the station to it until another state key is pressed.
      process.stdout.write('Пауза: Bluetooth станції вільний для телефона. Натисніть a–f, щоб продовжити.\n');
      while (state.marker === CASES.p && !quitting) await sleep(1000);
      if (quitting) break;
    }
    const started = Date.now();
    try {
      await session(peripheral, userId, found.sn, attempt);
    } catch (e) {
      const msg = scrubSecrets(String((e as Error)?.message ?? e), secrets);
      log('session-error', { attempt, error: msg, afterMs: Date.now() - started });
      process.stdout.write(`\nЗ'єднання: ${msg}\n`);
      if (/refused auth/.test(msg)) {
        // Retrying a refusal only hammers the station; the account or the binding is the problem.
        process.stdout.write('Станція не прийняла цей акаунт. Тест зупинено.\n');
        await shutdown();
      }
    }
    failures = state.connected ? 0 : failures + 1;
    state.connected = false;
    if (quitting) break;
    if (state.marker === CASES.p) continue;
    const wait = Math.min(RECONNECT_MS * 2 ** Math.min(failures, 4), 60_000);
    process.stdout.write(`Перепідключення через ${wait / 1000} с…\n`);
    await sleep(wait);
  }
}

/** One connection: resolves or rejects when the link is gone. */
async function session(peripheral: any, userId: string, sn: string, attempt: number): Promise<void> {
  const t = Date.now();
  log('connecting', { attempt });
  // A connect can hang while another central (the phone) holds the station.
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      peripheral.connectAsync(),
      new Promise((_, reject) => { timer = setTimeout(() => { try { peripheral.cancelConnect(); } catch { /* not pending */ } reject(new Error('станція не відповідає на підключення')); }, CONNECT_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  log('connected', { attempt, ms: Date.now() - t, mtu: peripheral.mtu });
  const gone = new Promise<never>((_, reject) => {
    peripheral.once('disconnect', (reason: unknown) => { log('disconnect', { reason: String(reason ?? '') }); reject(new Error('станція розірвала з’єднання')); });
  });

  const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
  const byUuid = new Map<string, any>(characteristics.map((c: any) => [short(c.uuid), c]));
  log('gatt', { characteristics: characteristics.map((c: any) => `${short(c.uuid)}:${(c.properties ?? []).join('+')}`) });
  const pair = UUIDS.find(u => byUuid.has(u.write) && byUuid.has(u.notify));
  if (!pair) throw new Error('немає потрібних характеристик GATT');
  const writeChar = byUuid.get(pair.write);
  const notifyChar = byUuid.get(pair.notify);

  const s = new EcoflowBleSession({
    userId, sn,
    write: data => writeChar.writeAsync(data, false),
    onStage: stage => log('stage', { stage, ms: Date.now() - t }),
    onBadFrame: e => log('bad-frame', { error: e.message }),
    onPacket: p => {
      const module = heartbeatOf(p);
      const entry: Record<string, unknown> = {
        src: p.src, dst: p.dst, cmdSet: p.cmdSet, cmdId: p.cmdId, seq0: p.seq[0], len: p.payload.length,
      };
      if (module) {
        const fields = decodeHeartbeat(module, p.payload);
        entry.module = module;
        entry.fields = fields;
        state[module as 'inv' | 'pd' | 'mppt' | 'ems'] = fields;
        if (module === 'inv') state.invAt = Date.now();
      }
      // Telemetry and the station's short status replies; the scrub list covers the token as a backstop.
      entry.hex = p.payload.toString('hex');
      log('packet', entry);
    },
  });
  notifyChar.on('data', (data: Buffer) => s.handle(data));
  await notifyChar.subscribeAsync();
  log('subscribed', { ms: Date.now() - t, mtu: peripheral.mtu });

  try {
    await Promise.race([s.start(), gone]);
  } catch (e) {
    try { await peripheral.disconnectAsync(); } catch { /* already gone */ }
    throw e;
  }
  state.connected = true;
  process.stdout.write(`Підключено за ${((Date.now() - t) / 1000).toFixed(1)} с. Дані йдуть:\n`);
  await gone;
}

main().catch(e => {
  const msg = scrubSecrets(String((e as Error)?.message ?? e), secrets);
  log('fatal', { error: msg });
  console.error(`\nПомилка: ${msg}\nЛог: ${logFile}`);
  process.exit(1);
});
