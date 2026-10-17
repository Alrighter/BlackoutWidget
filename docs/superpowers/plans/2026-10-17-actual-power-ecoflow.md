# Фактичний стан світла (EcoFlow) — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Застосунок читає зарядну станцію EcoFlow через офіційний Open API. Він показує фактичний стан «світло є / немає / невідомо» у віджеті, треї та головному вікні і веде локальну історію фактичних вимкнень і ввімкнень. Ключі вводяться в налаштуваннях.

**Architecture:**
- Нова підсистема `src/main/actual/` живе окремо від підсистеми графіка: `ActualStateSource` → `ActualStateService` → `AppState.actual`.
- Джерело EcoFlow:
  - підписує HTTP-запити (`node:crypto`);
  - опитує `quota/all` і тримає MQTT-підписку (mqtt.js);
  - визначає, чи є мережа, чистою функцією за полями показів.
- Сервіс підтверджує зміни, стежить за свіжістю і пише журнал переходів.
- Уся логіка — у чистих модулях з переданими ззовні `fetch`, MQTT-з'єднанням, годинником і шифратором. Electron лише в місцях з'єднання (`index.ts`, `ipc.ts`).

**Tech Stack:** Node 24, Electron 44, TypeScript 7, electron-vite 6, React 19, vitest 5, `mqtt` 5.16.0 (нова залежність).

**Spec:** `docs/superpowers/specs/2026-10-17-actual-power-ecoflow-design.md`. Читати разом з основним дизайном `docs/superpowers/specs/2026-10-17-blackout-widget-design.md`. Посилання «§» нижче ведуть на spec EcoFlow.

## Global Constraints

- Мова інтерфейсу — українська. Тексти копіювати дослівно з плану; де в плані тексту немає — дослівно зі spec.
- Дати й години для людей — у `Europe/Kyiv`. Використовувати `src/shared/time.ts`: `formatHM`, `formatDM`, `kyivDateKey`, `kyivMinutesOfDay`.
- **EcoFlow — лише читання.** Дозволені виклики:
  - HTTP: `GET /iot-open/sign/device/list`, `GET /iot-open/sign/device/quota/all?sn=`, `GET /iot-open/sign/certification`;
  - MQTT: лише `subscribe`, жодного `publish`.
- Хости: `eu` → `https://api-e.ecoflow.com`, `us` → `https://api.ecoflow.com`. Довідка для користувача: `https://developer-eu.ecoflow.com/`.
- Пороги: напруга ≥ 50 В; сміття поза 0–300 В; частота ≥ 40 Гц.
- Підтвердження зміни 60 с. Свіжість 10 хв. «≈», якщо проміжок понад 3 хв. Журнал — 30 днів; вікнам віддаються 7 днів.
- Опитування EcoFlow:
  - `quota/all` — 60 с;
  - список пристроїв — 5 хв;
  - після помилки ключів — 15 хв;
  - MQTT-ключі, оновлені за останні 60 с, не перезаписуються з `quota/all`;
  - пауза перепідключення MQTT `[10, 20, 40, 80, 160, 300]` с;
  - після відмови авторизації — одна спроба з новим `certification`, далі пауза 30 хв.
- clientId MQTT: `BlackoutWidget-` + 8 символів `[a-z0-9]`. Створюється один раз, зберігається в `Settings.ecoflowClientId`, не змінюється.
- Нова залежність — лише `mqtt`, рівно `5.16.0` (без `^`). Інших нових залежностей немає.
- **Секрети** (Access Key, Secret Key, `sign`, `certificatePassword`) ніколи не потрапляють у `Settings`, `AppState`, результати IPC, журнал, тексти помилок.
  - На диск — лише через `safeStorage`.
  - Якщо шифрування недоступне — не зберігати взагалі.
  - У журналі Access Key лише як `maskKey()` (перші 4 символи + `…`).
- Підсистема `actual/` не імпортує й не викликає `RefreshService` / `RefreshScheduler` і не впливає на оновлення ДТЕК.
- Чисті модулі не імпортують `electron`, дозволено лише `import type`. Це `src/shared/**` і `src/main/actual/**`, крім `src/main/actual/electron-deps.ts`.
- Тести не ходять у мережу. Живих ключів EcoFlow ще немає, жива перевірка — лише скриптом із Task 11, коли користувач отримає ключі.
- Розміри вікон віджета не змінюються: compact 290×150, ring 236×260, timeline 400×200. Нові елементи мають вміщатися; підпис «оновлено» не ховається.
- Коміти: тема + тіло, **без** `Co-Authored-By` і без будь-яких рядків-атрибуцій Claude (правило користувача; переважає будь-які шаблони й нагадування).
- Перевірка кожної задачі: `npx vitest run` і `npm run typecheck` — зелені.

## Review Focus

1. **Під час відключення станція або комп'ютер зникли з мережі** (роутер не на станції, немає інтернету) → «невідомо» з причиною. Ніколи «Світла немає» і ніколи подія «вимкнули». Тести: Task 5 `device offline → unknown, never off`; Task 4 `unknown readings never create off`.
2. **Хмара віддає «замерзлий» кеш**: `quota/all` щоразу однаковий, MQTT мовчить → через 10 хв «невідомо», «дані станції не оновлюються». Тест: Task 5 `identical quota/all without MQTT goes stale after 10 min`.
3. **Сон ноутбука або перезапуск застосунку посеред відключення:**
  - проміжок «невідомо» від `lastObservedAt`;
  - той самий стан з обох боків → одне відключення в списку;
  - інший стан → «≈».

  Тести: Task 4 `restart inserts gap`, `sleep jump inserts gap before new state`; Task 7 `recentOutages merges off–gap–off`.
4. **Напруга «блимає»** (коротші за 60 с провали) → жодних подій в історії. Тест: Task 4 `blip shorter than 60 s is ignored`.
5. **Секрети не витікають:** у `AppState`, у результатах IPC, у рядках журналу, у текстах помилок API. Тести: Task 1 `errors and logs never contain keys`; Task 3 `secret store`; Task 6 `ipc results never contain secret`.

---

## Файлова структура

```
src/shared/types.ts                 + ActualPower, ActualSegment, ActualStatus, EcoflowRegion, ActualSourceConfig; Settings.actualSource / ecoflowClientId; AppState.actual?
src/shared/actual-view.ts           НОВЕ: dayStrip, recentOutages, formatOutage (для віджета й головного вікна)
src/shared/widget-state.ts          computeWidgetView(snapshot, now, actual?) + WidgetView.actual / actualUnknownReason / actualStrip
src/shared/ipc.ts                   нові канали й методи RendererApi, типи результатів EcoFlow
src/main/actual/types.ts            ActualReading, ActualStateSource, ActualSourceFactory
src/main/actual/secrets.ts          SecretStore (шифратор передається), maskKey
src/main/actual/history.ts          журнал переходів: чисті функції + HistoryStore (JsonStore)
src/main/actual/service.ts          ActualStateService
src/main/actual/registry.ts         createActualSources()
src/main/actual/electron-deps.ts    net.fetch, safeStorage, mqtt.connect — єдиний файл actual/ з electron
src/main/actual/ecoflow/sign.ts     сплющування, рядок підпису, HMAC
src/main/actual/ecoflow/api.ts      EcoflowApi (HTTP), EcoflowApiError, тексти помилок
src/main/actual/ecoflow/grid.ts     detectGrid
src/main/actual/ecoflow/mqtt-message.ts  normalizeQuotaMessage, parseStatusMessage
src/main/actual/ecoflow/source.ts   EcoflowSource (опитування, MQTT, свіжість)
src/main/actual/ecoflow/index.ts    фабрика + ecoflowTest / ecoflowPreview
src/main/smoke-ecoflow.ts           ручна жива перевірка з ключами з env
src/main/{index.ts, ipc.ts, store.ts, tray.ts}   з'єднання
src/preload/index.ts
src/renderer/src/app/{ActualSettings.tsx, ActualStrip.tsx, SettingsView.tsx, ScheduleView.tsx, app.css}
src/renderer/src/widget/{Widget.tsx, parts.tsx, CompactWidget.tsx, TimelineWidget.tsx, RingWidget.tsx, DayBar.tsx, widget.css}
tests/fixtures/ecoflow/*.json
tests/main/actual/*.test.ts, tests/shared/actual-view.test.ts, tests/renderer/actual-settings.test.tsx
```

---

### Task 1: Підпис і HTTP-клієнт EcoFlow

**Files:**
- Create: `src/main/actual/ecoflow/sign.ts`, `src/main/actual/ecoflow/api.ts`, `src/main/actual/secrets.ts` (лише `maskKey`; клас `SecretStore` — у Task 3)
- Modify: `src/shared/types.ts` (лише `export type EcoflowRegion = 'eu' | 'us'`)
- Test: `tests/main/actual/ecoflow-sign.test.ts`, `tests/main/actual/ecoflow-api.test.ts`

**Interfaces:**
- Consumes: `NetworkError` з `src/main/providers/types.ts` (наслідує `ProviderError`; повідомлення — текст для людей); `Logger` з `src/main/log.ts`.
- Produces:
```ts
// sign.ts
export function flattenParams(params: Record<string, unknown>): string;           // 'a.b=1&c[0]=2', ASCII-сорт ключів, без URL-кодування
export function signString(params: Record<string, unknown> | undefined, accessKey: string, nonce: string, timestamp: string): string;
export function hmacHex(message: string, secretKey: string): string;
// api.ts  (EcoflowRegion — import type з src/shared/types.ts)
export const ECOFLOW_HOSTS: Record<EcoflowRegion, string>;
export interface EcoflowKeys { accessKey: string; secretKey: string }
export interface EcoflowDevice { sn: string; online: boolean; productName?: string; deviceName?: string }
export interface MqttCertificate { account: string; password: string; host: string; port: number }
export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
export class EcoflowApiError extends Error { readonly code: string; readonly keyProblem: boolean }
export function describeEcoflowError(code: string, apiMessage: string): string;
export function deviceLabel(d: EcoflowDevice): string;                            // productName ?? deviceName ?? sn
export interface EcoflowApiLike {
  listDevices(): Promise<EcoflowDevice[]>;
  getQuotaAll(sn: string): Promise<Record<string, unknown>>;
  getCertification(): Promise<MqttCertificate>;
}
export class EcoflowApi implements EcoflowApiLike {
  constructor(region: EcoflowRegion, keys: EcoflowKeys,
    deps: { fetch: FetchLike; now?: () => number; random?: () => number; timeoutMs?: number /* 15000 */ });
}
// secrets.ts
export function maskKey(key: string): string;                                       // перші 4 символи + '…'; коротший за 5 — '…'
```
- Запит:
  - заголовки рівно `accessKey`, `nonce` (6 цифр із `random`, з нулями попереду), `timestamp` (`String(now())`), `sign`;
  - **без** `Content-Type`;
  - параметри GET (`sn`) і в URL, і в рядку підпису.
- Відповіді:
  - `code === "0"` → `data`;
  - інший `code` → `EcoflowApiError(code, message)`;
  - HTTP не 2xx → `EcoflowApiError('http-<status>')`;
  - не JSON → `EcoflowApiError('bad-json')`;
  - відмова `fetch` (не тайм-аут) → `NetworkError('Немає з’єднання з EcoFlow')`;
  - тайм-аут → `EcoflowApiError('timeout')`.
- `keyProblem === true` для `8521`, `8524`, `8513` і для повідомлень за `/accessKey is invalid|doesn.?t exist|does not exist/i`.
- `certification`: `url` → `host`; `port` — рядок, перетворити на число.
- `listDevices`: `online` — `=== 1` або `=== true`.

`describeEcoflowError` — тексти дослівно:

| code / умова | текст |
|---|---|
| `1006` | `EcoFlow не віддає дані цієї станції через API розробника (1006). Можливо, станція прив’язана до іншого акаунта або ця модель не підтримується.` |
| `8521` | `EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.` |
| `8524` | `EcoFlow не прийняв час запиту (8524). Перевірте, чи правильно виставлено час на комп’ютері.` |
| `8513` | `Схоже, ключі з іншого регіону (8513). Спробуйте інший регіон.` |
| повідомлення про accessKey (див. вище) | `EcoFlow не знає такого Access Key. Перевірте ключ і регіон.` |
| `timeout` | `EcoFlow не відповідає. Спробуйте пізніше.` |
| `bad-json` | `EcoFlow повернув незрозумілу відповідь.` |
| `http-<N>` | `EcoFlow не відповідає (HTTP <N>).` |
| інше | `Помилка EcoFlow <code>: <apiMessage>` |

`EcoflowApiError.message` = `describeEcoflowError(...)`.

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/main/actual/ecoflow-sign.test.ts
test('documented golden vector', () => {
  const s = signString({ sn: '123456789', params: { cmdSet: 11, id: 24, eps: 0 } }, 'Fp4SvIprYSDPXtYJidEtUAd1o', '345164', '1671171709428');
  expect(s).toBe('params.cmdSet=11&params.eps=0&params.id=24&sn=123456789&accessKey=Fp4SvIprYSDPXtYJidEtUAd1o&nonce=345164&timestamp=1671171709428');
  expect(hmacHex(s, 'WIbFEKre0s6sLnh4ei7SPUeYnptHG6V')).toBe('07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e');
});
test('flattens arrays and objects in arrays, sorted', () => {
  expect(flattenParams({ name: 'demo1', ids: [1, 2, 3], deviceInfo: { id: 1 }, deviceList: [{ id: 1 }, { id: 2 }] }))
    .toBe('deviceInfo.id=1&deviceList[0].id=1&deviceList[1].id=2&ids[0]=1&ids[1]=2&ids[2]=3&name=demo1');
});
test('booleans lowercase; no params → only the key part', () => {
  expect(flattenParams({ b: true, a: false })).toBe('a=false&b=true');
  expect(signString(undefined, 'AK', '000001', '5')).toBe('accessKey=AK&nonce=000001&timestamp=5');
});
```
```ts
// tests/main/actual/ecoflow-api.test.ts — fetch-фейк записує виклики
const keys = { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' };
test('GET quota/all: sn in URL and in signature, headers exact, no Content-Type', async () => {
  const calls: any[] = [];
  const fetch = async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"code":"0","data":{"inv.acInVol":228652}}' }; };
  const api = new EcoflowApi('eu', keys, { fetch, now: () => 1671171709428, random: () => 0.345164 });
  expect(await api.getQuotaAll('R601X')).toEqual({ 'inv.acInVol': 228652 });
  expect(calls[0].url).toBe('https://api-e.ecoflow.com/iot-open/sign/device/quota/all?sn=R601X');
  expect(Object.keys(calls[0].init.headers).sort()).toEqual(['accessKey', 'nonce', 'sign', 'timestamp']);
  expect(calls[0].init.headers.nonce).toBe('345164');
  expect(calls[0].init.headers.sign).toBe(hmacHex('sn=R601X&accessKey=AKEY1234567&nonce=345164&timestamp=1671171709428', 'SECRET-xyz'));
});
test('device list parsing and label fallback', async () => { /* data: [{sn:'A',online:1,productName:'RIVER 2'},{sn:'B',online:0,deviceName:'DELTA 3 Plus-XYZ'},{sn:'C',online:0}] → online true/false/false; deviceLabel → 'RIVER 2' / 'DELTA 3 Plus-XYZ' / 'C' */ });
test('certification maps url/port', async () => { /* data:{certificateAccount:'open-1',certificatePassword:'pw',url:'mqtt-e.ecoflow.com',port:'8883',protocol:'mqtts'} → {account:'open-1',password:'pw',host:'mqtt-e.ecoflow.com',port:8883} */ });
test.each([
  ['1006', 'current device is not allowed to get device info', false, 'EcoFlow не віддає дані цієї станції через API розробника (1006). Можливо, станція прив’язана до іншого акаунта або ця модель не підтримується.'],
  ['8521', 'signature is wrong', true, 'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.'],
  ['8513', 'x', true, 'Схоже, ключі з іншого регіону (8513). Спробуйте інший регіон.'],
  ['9999', 'accessKey is invalid', true, 'EcoFlow не знає такого Access Key. Перевірте ключ і регіон.'],
  ['4242', 'boom', false, 'Помилка EcoFlow 4242: boom'],
])('api error %s', async (code, message, keyProblem, text) => { /* відповідь {code,message} → reject EcoflowApiError {code,keyProblem,message:text} */ });
test('fetch rejection → NetworkError; HTTP 503 → http-503; garbage → bad-json', async () => { /* … */ });
test('errors and logs never contain keys', async () => {
  // для кожного виду помилки: String(err) і JSON.stringify(err) не містять 'AKEY1234567' і 'SECRET-xyz'
});
test('maskKey', () => { expect(maskKey('Fp4SvIprYSDPXtYJidEtUAd1o')).toBe('Fp4S…'); expect(maskKey('abc')).toBe('…'); });
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/actual` → FAIL (модулів немає).
- [ ] **Step 3: Реалізувати `sign.ts`, `api.ts`, `maskKey` у `secrets.ts`.** Тайм-аут — через `AbortController` і `setTimeout`.
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add EcoFlow request signing and read-only HTTP client"`

---

### Task 2: Визначення мережі та MQTT-повідомлення

**Files:**
- Create: `src/main/actual/ecoflow/grid.ts`, `src/main/actual/ecoflow/mqtt-message.ts`, `tests/fixtures/ecoflow/{river2-grid-on.json, delta2-grid-on-0w.json, deltapro-grid-off.json, delta3-grid-on.json, unsupported.json}`
- Test: `tests/main/actual/ecoflow-grid.test.ts`, `tests/main/actual/ecoflow-mqtt-message.test.ts`

**Interfaces:**
- Produces:
```ts
// grid.ts
export const GRID_MIN_VOLTS = 50, MAX_SANE_VOLTS = 300, GRID_MIN_HZ = 40;
export type GridVerdict =
  | { power: 'on' | 'off'; detail: string }
  | { power: 'unknown'; reason: string; unsupported: boolean };
export function detectGrid(quota: Record<string, unknown>): GridVerdict;
// mqtt-message.ts
export function normalizeQuotaMessage(msg: unknown): Record<string, unknown> | null; // null — не повідомлення з показами
export function parseStatusMessage(msg: unknown): boolean | null;                     // {params:{status:1|0}} → true/false
```
- **`detectGrid`** — §4.6 по групах, перша група з придатним полем вирішує.
  - Напруга: `inv.acInVol` (÷1000), `plugInInfoAcInVol`, `hs_yj751_pd_backend_addr.inAcC20Vol`.
  - Частота: `inv.acInFreq`, `plugInInfoAcInFeq`.
  - Прапорець: `plugInInfoAcInFlag` (1/0 або true/false).
  - Вати: `inv.inputWatts`, `powGetAcIn`, `hs_yj751_pd_appshow_addr.inAcC20Pwr`.
  - Придатне значення — скінченне число (для прапорця ще й boolean). Напруга поза 0–300 В після перерахунку — непридатна.
  - Відсутнє поле ніколи не дорівнює 0.
- **`detail`** дослівно:
  - напруга — `на вході ${Math.round(V)} В`;
  - частота — `на вході ${Math.round(Hz)} Гц`;
  - прапорець — `вхід AC підключено` / `вхід AC не підключено`;
  - вати > 0 — `на вході ${Math.round(W)} Вт`.
- **`reason`** дослівно:
  - вати = 0, і більше нічого немає — `не вдається визначити` (`unsupported: false`);
  - жодного поля — `модель поки не підтримується` (`unsupported: true`).
- **`normalizeQuotaMessage`** — §4.5 «Формати MQTT-повідомлень». Префікси: `typeCode` → таблиця; `cmdFunc` + `cmdId` → `${cmdFunc}_${cmdId}.`; `addr` → `${addr}.`; лише `params` → без префікса. Ключ тіла — `params` або `param`.

- [ ] **Step 1: Фікстури** (пласкі мапи `quota/all`, значення з §4.5 і research):
  - `river2-grid-on.json`: `{"inv.acInVol":229345,"inv.acInFreq":50,"inv.inputWatts":12,"pd.soc":81}`;
  - `delta2-grid-on-0w.json`: `{"inv.acInVol":228652,"inv.acInFreq":50,"inv.inputWatts":0}`;
  - `deltapro-grid-off.json`: `{"inv.acInVol":0,"inv.acInFreq":0,"inv.inputWatts":0}`;
  - `delta3-grid-on.json`: `{"plugInInfoAcInVol":229.6,"plugInInfoAcInFeq":50,"plugInInfoAcInFlag":1,"powGetAcIn":35.2}`;
  - `unsupported.json`: `{"pd.soc":55,"bms_bmsStatus.temp":24}`.
- [ ] **Step 2: Написати падаючі тести**

```ts
// tests/main/actual/ecoflow-grid.test.ts
const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, '../../fixtures/ecoflow', n), 'utf8'));
test('River 2: mV voltage → on', () => expect(detectGrid(fx('river2-grid-on.json'))).toEqual({ power: 'on', detail: 'на вході 229 В' }));
test('Delta 2: voltage present with 0 W is still on', () => expect(detectGrid(fx('delta2-grid-on-0w.json'))).toEqual({ power: 'on', detail: 'на вході 229 В' }));
test('Delta Pro without grid → off', () => expect(detectGrid(fx('deltapro-grid-off.json'))).toEqual({ power: 'off', detail: 'на вході 0 В' }));
test('Delta 3 family: volts, not mV', () => expect(detectGrid(fx('delta3-grid-on.json'))).toEqual({ power: 'on', detail: 'на вході 230 В' }));
test('unknown model', () => expect(detectGrid(fx('unsupported.json'))).toEqual({ power: 'unknown', reason: 'модель поки не підтримується', unsupported: true }));
test('49 999 mV is off, 50 000 mV is on', () => {
  expect(detectGrid({ 'inv.acInVol': 49999 }).power).toBe('off');
  expect(detectGrid({ 'inv.acInVol': 50000 }).power).toBe('on');
});
test('insane voltage falls through to frequency', () => {
  expect(detectGrid({ 'plugInInfoAcInVol': 228652, 'plugInInfoAcInFeq': 50 })).toEqual({ power: 'on', detail: 'на вході 50 Гц' });
});
test('frequency 0 → off; flag true → on; watts only', () => {
  expect(detectGrid({ 'inv.acInFreq': 0 }).power).toBe('off');
  expect(detectGrid({ plugInInfoAcInFlag: true })).toEqual({ power: 'on', detail: 'вхід AC підключено' });
  expect(detectGrid({ powGetAcIn: 120.4 })).toEqual({ power: 'on', detail: 'на вході 120 Вт' });
  expect(detectGrid({ 'inv.inputWatts': 0 })).toEqual({ power: 'unknown', reason: 'не вдається визначити', unsupported: false });
});
test('non-numeric values are ignored, never read as 0', () => {
  expect(detectGrid({ 'inv.acInVol': null, 'inv.acInFreq': '50' }).power).toBe('unknown');
});
```
```ts
// tests/main/actual/ecoflow-mqtt-message.test.ts
test('typeCode envelope', () => expect(normalizeQuotaMessage({ typeCode: 'invStatus', params: { acInVol: 228652, inputWatts: 0 } }))
  .toEqual({ 'inv.acInVol': 228652, 'inv.inputWatts': 0 }));
test('bms/ems prefixes', () => {
  expect(normalizeQuotaMessage({ typeCode: 'bmsStatus', params: { soc: 80 } })).toEqual({ 'bms_bmsStatus.soc': 80 });
  expect(normalizeQuotaMessage({ typeCode: 'emsStatus', params: { chgState: 1 } })).toEqual({ 'bms_emsStatus.chgState': 1 });
});
test('cmdFunc/cmdId, addr and flat envelopes', () => {
  expect(normalizeQuotaMessage({ cmdId: 1, cmdFunc: 20, param: { x: 1 } })).toEqual({ '20_1.x': 1 });
  expect(normalizeQuotaMessage({ addr: 'hs_yj751_pd_appshow_addr', param: { inAcC20Pwr: 5 } })).toEqual({ 'hs_yj751_pd_appshow_addr.inAcC20Pwr': 5 });
  expect(normalizeQuotaMessage({ params: { plugInInfoAcInVol: 230 } })).toEqual({ plugInInfoAcInVol: 230 });
});
test('garbage → null', () => { for (const m of [null, 'x', 42, {}, { typeCode: 'invStatus' }, { params: 5 }]) expect(normalizeQuotaMessage(m)).toBeNull(); });
test('status topic', () => {
  expect(parseStatusMessage({ id: '1', params: { status: 1 } })).toBe(true);
  expect(parseStatusMessage({ params: { status: 0 } })).toBe(false);
  expect(parseStatusMessage({ params: {} })).toBeNull();
});
```

- [ ] **Step 3: Запустити — має впасти.** Run: `npx vitest run tests/main/actual` → FAIL.
- [ ] **Step 4: Реалізувати `grid.ts`, `mqtt-message.ts`.** Невідомий `typeCode` → префікс = `typeCode` з відкинутим `Status` + `.` (напр. `fooStatus` → `foo.`).
- [ ] **Step 5: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "Detect grid presence from EcoFlow quotas across model families"`

---

### Task 3: Типи, налаштування, сховище ключів

**Files:**
- Modify: `src/shared/types.ts`, `src/main/store.ts` (`DEFAULT_SETTINGS`), `src/main/actual/secrets.ts`
- Create: `src/main/actual/types.ts`
- Test: `tests/main/actual/secrets.test.ts`, `tests/main/store.test.ts` (доповнити)

**Interfaces:**
- Produces:
```ts
// src/shared/types.ts
export type ActualPower = 'on' | 'off' | 'unknown';
export interface ActualSegment { power: ActualPower; start: string; end?: string; startApprox?: boolean }
export interface ActualStatus {
  sourceLabel: string; power: ActualPower; since?: string; sinceApprox?: boolean;
  observedAt?: string; reason?: string; detail?: string;
  history: ActualSegment[];   // відрізки за останні 7 днів, за часом, останній — відкритий (без end)
}
// EcoflowRegion — уже є з Task 1
export interface ActualSourceConfig { id: 'ecoflow'; region: EcoflowRegion; deviceSn: string; deviceName: string; accessKeyHint: string }
// Settings += actualSource: ActualSourceConfig | null; ecoflowClientId?: string
// AppState += actual?: ActualStatus | null        (необов'язкове: RefreshService його не знає, main додає сам)
// src/main/actual/types.ts
export interface ActualReading { power: ActualPower; observedAt: string; reason?: string; detail?: string }
export interface ActualStateSource { start(onReading: (r: ActualReading) => void): void; stop(): void }
export interface ActualSourceFactory {
  id: string; displayName: string;
  create(config: ActualSourceConfig, secrets: Record<string, string>, ctx: { clientId: string; log: Logger }): ActualStateSource;
}
// src/main/actual/secrets.ts
export interface Encryptor { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }
export class SecretsUnavailableError extends Error {}   // message: 'Не вдалося безпечно зберегти ключі на цьому комп’ютері'
export class SecretStore {
  constructor(filePath: string, enc: Encryptor);
  save(sourceId: string, secrets: Record<string, string>): void;   // кидає SecretsUnavailableError, нічого не пише
  load(sourceId: string): Record<string, string> | null;            // немає / не розшифровується / шифрування недоступне → null
  remove(sourceId: string): void;
}
```
- `DEFAULT_SETTINGS.actualSource = null`.
- `AppStore.getSettings()` уже зливає збережене з `DEFAULT_SETTINGS`, тож старий `settings.json` дає `actualSource: null`. Перевірити тестом.
- Файл секретів (`<userData>/secrets.json`): `{ [sourceId]: base64(encryptString(JSON.stringify(secrets))) }`. Запис атомарний (tmp + rename, як `JsonStore.write`). Можна перевикористати `JsonStore<Record<string,string>>`.
- `accessKeyHint` = `maskKey(accessKey)`.

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/main/actual/secrets.test.ts — фейковий шифратор: encrypt = Buffer.from('enc:' + reverse(s)); тимчасова тека (mkdtempSync)
test('round trip; file never contains plaintext', () => {
  const st = new SecretStore(file, fakeEnc); st.save('ecoflow', { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' });
  expect(st.load('ecoflow')).toEqual({ accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' });
  const raw = readFileSync(file, 'utf8'); expect(raw).not.toContain('AKEY1234567'); expect(raw).not.toContain('SECRET-xyz');
});
test('encryption unavailable → throws, writes nothing', () => {
  const st = new SecretStore(file, { ...fakeEnc, isEncryptionAvailable: () => false });
  expect(() => st.save('ecoflow', { a: 'b' })).toThrow(SecretsUnavailableError);
  expect(existsSync(file)).toBe(false);
});
test('undecryptable or missing → null; remove deletes only that source', () => { /* decryptString кидає → null; save x2 sources, remove one */ });
```
```ts
// tests/main/store.test.ts (доповнити)
test('old settings.json without actualSource reads as null', () => { /* записати {"widgetStyle":"ring"} → getSettings().actualSource === null */ });
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main` → FAIL.
- [ ] **Step 3: Реалізувати типи, `DEFAULT_SETTINGS`, `SecretStore`, `actual/types.ts`.** Перевірити, що `npm run typecheck` не ламає наявні тести, де `AppState` збирається без `actual`.
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add actual-state types, settings fields and encrypted key store"`

---

### Task 4: ActualStateService і журнал

**Files:**
- Create: `src/main/actual/history.ts`, `src/main/actual/service.ts`
- Test: `tests/main/actual/service.test.ts`

**Interfaces:**
- Consumes: `ActualReading`, `ActualStateSource` (Task 3); `JsonStore` з `src/main/store.ts`; `Logger`.
- Produces:
```ts
// history.ts
export interface Transition { at: string; power: ActualPower; approx?: boolean; lastBefore?: string }
export interface HistoryData { transitions: Transition[]; lastObservedAt?: string }
export class HistoryStore { constructor(filePath: string); read(): HistoryData; write(d: HistoryData): void }   // поверх JsonStore; файл <userData>/actual-history.json
export function pruneTransitions(t: Transition[], nowMs: number, keepMs: number): Transition[];   // лишає все новіше за межу + останній перехід перед нею
export function buildSegments(t: Transition[], nowMs: number, sinceMs: number): ActualSegment[];   // обрізає до sinceMs; суміжні однакові power зливаються
// service.ts
export const CONFIRM_MS = 60_000, STALE_MS = 10 * 60_000, APPROX_GAP_MS = 3 * 60_000,
  KEEP_MS = 30 * 86_400_000, SHOWN_MS = 7 * 86_400_000, OBSERVED_SAVE_MS = 60_000, CHECK_MS = 30_000;
export class ActualStateService {
  constructor(deps: { history: HistoryStore; log: Logger; now?: () => number });   // таймер — глобальний setInterval (vi.useFakeTimers)
  start(source: ActualStateSource, sourceLabel: string): void;   // зупиняє попереднє джерело
  stop(): void;                                                   // getStatus() → null
  getStatus(): ActualStatus | null;
  onChange(cb: () => void): () => void;                           // помилка в слухачі не ламає інших (як у RefreshService)
}
```
- **Стан сервісу:** `confirmed: ActualPower` (на старті `unknown`); `candidate?: { power, firstAt, lastBefore }`; `lastObservedAt`; остання причина й `detail`.
- **Показ `r`:**
  1. Свіжий, якщо `power ≠ unknown` і `now − observedAt ≤ STALE_MS`. Інакше показ вважається `unknown`; причина — `r.reason`, а для застарілого — `дані станції не оновлюються`.
  2. **Проміжок перед новим показом.** Якщо `confirmed ∈ {on, off}` і `now − lastObservedAt > STALE_MS` (сон, зависання) — спершу перехід `{ at: lastObservedAt, power: 'unknown' }`, `confirmed = unknown`.
  3. **`unknown`:** `candidate` скидається. Якщо `confirmed ∈ {on, off}` — перехід `{ at: lastObservedAt, power: 'unknown' }`.
  4. **Свіжий `on`/`off`:** `lastObservedAt = observedAt`.
     - Якщо `power === confirmed` — `candidate` скидається.
     - Інакше `candidate` для цього `power` — наявний або новий `{ firstAt: observedAt, lastBefore: lastKnownObservedAt }`, де `lastKnownObservedAt` — останній свіжий показ попереднього відомого стану, навіть до проміжку.
     - Коли `now − candidate.firstAt ≥ CONFIRM_MS` — перехід `{ at: firstAt, power, approx: firstAt − lastBefore > APPROX_GAP_MS, lastBefore }`, `confirmed = power`.
- **Таймер `CHECK_MS`:** якщо `confirmed ∈ {on, off}` і дані застаріли — перехід у `unknown` за п. 2 з причиною `дані станції не оновлюються`.
- **Збереження:** кожен перехід пишеться одразу (з `pruneTransitions(KEEP_MS)`). `lastObservedAt` — не частіше разу на `OBSERVED_SAVE_MS`.
- **`start()` після перезапуску:** якщо останній збережений перехід не `unknown` — дописати `{ at: lastObservedAt ?? last.at, power: 'unknown' }`. `lastKnownObservedAt` = збережений `lastObservedAt` (для «≈»).
- **`stop()`:** те саме дописування `unknown`, потім `source.stop()`.
- **`getStatus()`:**
  - `power = confirmed`;
  - `since` / `sinceApprox` — початок поточного відрізка `confirmed`, коли `confirmed ∈ {on, off}`. Якщо перед ним проміжок `unknown`, а перед проміжком — той самий `power`, то `since` = початок того раннього відрізка, а `sinceApprox` — з нього;
  - `observedAt = lastObservedAt`;
  - `reason` (лише для `unknown`);
  - `detail` з останнього свіжого показу;
  - `history = buildSegments(…, now − SHOWN_MS)`.
- `onChange` спрацьовує на кожен перехід і на кожну зміну `reason` / `detail`, а не на кожен показ без змін.
- Журнал: кожен перехід — `log.info('actual: <power> since <at>' + (approx ? ' (approx)' : ''))`; зміна причини `unknown` — `log.info('actual: unknown — <reason>')`.
- `HistoryStore` за замовчуванням — `{ transitions: [] }`.

- [ ] **Step 1: Написати падаючі тести** (фальшиве джерело: `start(cb)` зберігає `cb`; `t(min)` = ISO від бази `2026-10-17T10:00:00Z`; `vi.useFakeTimers({ now: base })`)

```ts
test('starts unknown; confirms on after 60 s of readings, at the first reading time', ...);
  // показ on@0, on@0:30 → power unknown; on@1:00 → power on, since t(0)
test('blip shorter than 60 s is ignored', ...);
  // підтверджено on; off@5:00, on@5:40, on@6:40 → жодного off у журналі, since лишається
test('on → off transition timestamp is the first off reading; approx false when readings are continuous', ...);
test('unknown readings never create off', ...);
  // підтверджено on; unknown('станція не в мережі') ×20 протягом 30 хв → журнал: on, unknown@lastObservedAt; жодного off; reason 'станція не в мережі'
test('stale data → unknown after 10 min via timer, gap starts at lastObservedAt', ...);
test('sleep jump inserts gap before new state; different state gets approx', ...);
  // підтверджено on@0 (останній показ @2:00); годинник +2 год; off@122:00, off@123:00 → переходи: unknown@2:00, off@122:00 approx=true lastBefore=@2:00
test('same state after a gap: since keeps the earlier start', ...);
  // off підтверджено @0, gap, off знову → status.since === t(0)
test('restart inserts gap from lastObservedAt', ...);
  // HistoryStore із [{at:t(0),power:'off'}], lastObservedAt t(30) → start() → дописано unknown@t(30); power unknown
test('prunes transitions older than 30 days but keeps the last one before the cutoff', ...);
test('history in status covers 7 days, last segment open', ...);
test('stop() records gap and getStatus() is null', ...);
test('listener throwing does not break others', ...);
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/actual/service.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `history.ts`, `service.ts`.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add actual-state service with confirmation, freshness and history"`

---

### Task 5: Джерело EcoFlow (опитування + MQTT) і реєстр

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install --save-exact mqtt@5.16.0`)
- Create: `src/main/actual/ecoflow/source.ts`, `src/main/actual/ecoflow/index.ts`, `src/main/actual/registry.ts`
- Test: `tests/main/actual/ecoflow-source.test.ts`

**Interfaces:**
- Consumes: `EcoflowApiLike`, `EcoflowApiError`, `deviceLabel` (Task 1); `detectGrid`, `normalizeQuotaMessage`, `parseStatusMessage` (Task 2); `ActualStateSource`, `ActualSourceFactory`, `ActualReading` (Task 3); `NetworkError`.
- Produces:
```ts
// source.ts
export const QUOTA_POLL_MS = 60_000, DEVICES_POLL_MS = 5 * 60_000, KEY_ERROR_POLL_MS = 15 * 60_000,
  FRESH_MS = 10 * 60_000, MQTT_WINS_MS = 60_000, MQTT_AUTH_PAUSE_MS = 30 * 60_000;
export const MQTT_BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 160_000, 300_000];
export interface MqttClientLike {
  on(event: 'connect', cb: () => void): void;
  on(event: 'message', cb: (topic: string, payload: Buffer) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error & { code?: number }) => void): void;
  subscribe(topics: string[], opts: { qos: 1 }): void;
  end(force?: boolean): void;
}
export type MqttConnect = (url: string, opts: {
  clientId: string; username: string; password: string; reconnectPeriod: 0; keepalive: 30; clean: true;
}) => MqttClientLike;
export class EcoflowSource implements ActualStateSource {
  constructor(cfg: { sn: string; clientId: string }, api: EcoflowApiLike, deps: { connect: MqttConnect; log: Logger; now?: () => number });
}
// index.ts
export interface EcoflowPreview { online: boolean; verdict: GridVerdict }
export function createEcoflowFactory(deps: { fetch: FetchLike; connect: MqttConnect }): ActualSourceFactory;  // id 'ecoflow', displayName 'EcoFlow'
export function ecoflowTest(api: EcoflowApiLike): Promise<EcoflowDevice[]>;
export function ecoflowPreview(api: EcoflowApiLike, sn: string): Promise<EcoflowPreview>;   // лише HTTP: список + quota/all; MQTT не чіпає
// registry.ts
export function createActualSources(deps: { fetch: FetchLike; connect: MqttConnect }): ActualSourceFactory[];
export function findActualSource(list: ActualSourceFactory[], id: string): ActualSourceFactory;
```
- **Поведінка — §5.5.**
  - **Старт:** `listDevices` → `getQuotaAll` → `getCertification` → `connect('mqtts://<host>:<port>', …)`. На `connect` — підписка на `/open/<account>/<sn>/quota` і `/open/<account>/<sn>/status` з `qos: 1`.
  - **Таймери:** `quota/all` кожні `QUOTA_POLL_MS`; список кожні `DEVICES_POLL_MS`.
  - **Злиття:** `quota/all` зливається в мапу, крім ключів, які MQTT оновив менше ніж `MQTT_WINS_MS` тому.
  - **Свіжість:** MQTT-повідомлення на `/quota` → `freshAt = now`. `quota/all`, вміст якого відрізняється від попереднього (порівняння після сортування ключів), → `freshAt = now`. Перша відповідь `quota/all` свіжою не вважається.
  - **Онлайн:** найсвіжіша зміна з двох джерел; поки MQTT підключений і вже прийшов `/status`, перевагу має `/status`.
- **Висновок** після кожного оновлення мапи, онлайну або помилки — один `ActualReading`:
  - станції немає у списку → `unknown`, `станцію не знайдено в акаунті`;
  - станція не в мережі → `unknown`, `станція не в мережі`;
  - `freshAt` відсутній або `now − freshAt > FRESH_MS` → `unknown`, `дані станції не оновлюються`;
  - інакше — `detectGrid(map)`: `on`/`off` з `detail`, або `unknown` з `reason`;
  - `NetworkError` → `unknown`, `немає з’єднання з EcoFlow`;
  - `EcoflowApiError` → `unknown`, `reason = err.message`; при `keyProblem` HTTP-опитування сповільнюється до `KEY_ERROR_POLL_MS`.
- **`observedAt`:** для `on`/`off` — `freshAt`; для `unknown` — `now`.
- **MQTT:**
  - `close` / `error` → перепідключення через `MQTT_BACKOFF_MS[min(n, 5)]`; після успішного `connect` лічильник скидається;
  - помилка з `code === 5` (не авторизовано) → один раз новий `getCertification` і негайна спроба; повторна → пауза `MQTT_AUTH_PAUSE_MS`.
- **`stop()`:** знімає всі таймери, `end(true)`, далі показів немає.
- **Журнал:** MQTT підключено / відключено; коди помилок API; один раз на джерело — `log.info('ecoflow: unsupported quota keys', Object.keys(map).sort())`, коли `verdict.unsupported`. Без значень, без ключів доступу й паролів.

- [ ] **Step 1: Встановити залежність.** Run: `npm install --save-exact mqtt@5.16.0` → у `package.json` `"mqtt": "5.16.0"` у `dependencies`.
- [ ] **Step 2: Написати падаючі тести** (фейкові `api`: лічильники викликів і черги відповідей; фейковий `connect` повертає емітер і записує `subscribe` та `end`; `vi.useFakeTimers()`)

```ts
test('start: lists, polls, connects with stable clientId and subscribes quota+status', ...);
  // connect URL 'mqtts://mqtt-e.ecoflow.com:8883', opts.clientId === 'BlackoutWidget-abc12345', username/password з certification; subscribe(['/open/open-1/SN1/quota','/open/open-1/SN1/status'],{qos:1})
test('MQTT quota message makes data fresh → on with detail', ...);
  // emit message на /quota з {typeCode:'invStatus',params:{acInVol:229345}} → останній показ {power:'on',detail:'на вході 229 В'}
test('identical quota/all without MQTT goes stale after 10 min', ...);
  // MQTT не підключається; quota/all тричі різний (fresh), далі однаковий → через 10 хв після останньої зміни показ unknown 'дані станції не оновлюються'
test('first quota/all alone is not fresh', ...);
test('device offline → unknown, never off', ...);
  // список online:false, quota/all з inv.acInVol:0 → показ unknown 'станція не в мережі' (не off)
test('status topic beats the lagging device list while MQTT is connected', ...);
test('quota/all does not overwrite keys MQTT updated within 60 s', ...);
test('network error → unknown «немає з’єднання з EcoFlow»; polling continues every 60 s', ...);
test('key error slows HTTP polling to 15 min', ...);
test('MQTT reconnect backoff 10,20,40 s; auth failure refreshes certification once, then pauses 30 min', ...);
test('stop() clears timers and ends the client; no readings afterwards', ...);
test('unsupported keys are logged once, names only', ...);
test('ecoflowPreview uses HTTP only', ...);   // connect не викликався; {online:true, verdict:{power:'on',…}}
```

- [ ] **Step 3: Запустити — має впасти.** Run: `npx vitest run tests/main/actual/ecoflow-source.test.ts` → FAIL.
- [ ] **Step 4: Реалізувати `source.ts`, `index.ts`, `registry.ts`.** Фабрика: `create(config, secrets, ctx)` → `new EcoflowSource({ sn: config.deviceSn, clientId: ctx.clientId }, new EcoflowApi(config.region, { accessKey: secrets.accessKey, secretKey: secrets.secretKey }, { fetch }), { connect, log: ctx.log })`.
- [ ] **Step 5: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "Add EcoFlow actual-state source with polling and MQTT subscription"`

---

### Task 6: З'єднання в main — IPC, preload, старт/зупинка, трей

**Files:**
- Create: `src/main/actual/electron-deps.ts`, `src/main/actual/actions.ts`
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts`
- Test: `tests/main/actual/ipc-actual.test.ts` (тести чистої функції-обробника; `ipcMain` не потрібен)

**Interfaces:**
- Consumes: усе з Tasks 1–5.
- Produces:
```ts
// src/shared/ipc.ts — IPC += { ecoflowTest: 'actual:ecoflow-test', ecoflowPreview: 'actual:ecoflow-preview',
//   ecoflowSave: 'actual:ecoflow-save', actualDisconnect: 'actual:disconnect', openEcoflowHelp: 'actual:ecoflow-help' }
export interface EcoflowKeysInput { region: EcoflowRegion; accessKey: string; secretKey: string }
export interface EcoflowDeviceView { sn: string; label: string; online: boolean }
export type EcoflowTestResult = { ok: true; devices: EcoflowDeviceView[] } | { ok: false; error: string };
export type EcoflowPreviewResult =
  | { ok: true; online: boolean; power: ActualPower; detail?: string; reason?: string; unsupported?: boolean }
  | { ok: false; error: string };
export type ActionResult = { ok: true } | { ok: false; error: string };
// RendererApi += ecoflowTest(i: EcoflowKeysInput): Promise<EcoflowTestResult>;
//   ecoflowPreview(i: EcoflowKeysInput, sn: string): Promise<EcoflowPreviewResult>;
//   ecoflowSave(i: EcoflowKeysInput, device: { sn: string; label: string }): Promise<ActionResult>;
//   actualDisconnect(): Promise<void>; openEcoflowHelp(): void;
// src/main/actual/actions.ts (чисте; Create)
export interface ActualActionsDeps {
  makeApi(region: EcoflowRegion, keys: EcoflowKeys): EcoflowApiLike;
  secrets: Pick<SecretStore, 'save' | 'remove'>;
  getSettings(): Settings; updateSettings(patch: Partial<Settings>): void;
  restartActual(): void;          // перечитує налаштування й ключі, перезапускає ActualStateService
  random?: () => number;
}
export function createActualActions(deps: ActualActionsDeps): {
  test(i: unknown): Promise<EcoflowTestResult>; preview(i: unknown, sn: unknown): Promise<EcoflowPreviewResult>;
  save(i: unknown, device: unknown): Promise<ActionResult>; disconnect(): Promise<void>;
};
```
- **Перевірка вводу:**
  - `region ∈ {eu, us}`;
  - ключі — рядки, після `trim` непорожні, ≤ 200 символів;
  - `sn` — непорожній рядок ≤ 64; `label` ≤ 120.
  - Помилка вводу → `{ ok: false, error: 'Перевірте введені дані' }`.
  - Помилки API → `{ ok: false, error: err.message }` (тексти з Task 1). Невідома помилка → `'Не вдалося зв’язатися з EcoFlow'` і запис у журнал.
- **`save`:**
  1. `secrets.save('ecoflow', { accessKey, secretKey })`. `SecretsUnavailableError` → `{ ok: false, error: err.message }`, далі нічого.
  2. `ecoflowClientId` — наявний або новий `BlackoutWidget-` + 8 символів `[a-z0-9]`.
  3. `updateSettings({ actualSource: { id: 'ecoflow', region, deviceSn: sn, deviceName: label, accessKeyHint: maskKey(accessKey) }, ecoflowClientId })`.
  4. `restartActual()`.
- **`disconnect`:** `updateSettings({ actualSource: null })` → `secrets.remove('ecoflow')` → `restartActual()`. `ecoflowClientId` лишається.
- **`electron-deps.ts`:** `electronFetch: FetchLike` (через `net.fetch`), `electronEncryptor: Encryptor` (`safeStorage`), `mqttConnect: MqttConnect` (через `mqtt.connect`).
- **`index.ts`:**
  - створює `SecretStore(<userData>/secrets.json)`, `HistoryStore(<userData>/actual-history.json)`, `ActualStateService` і реєстр;
  - `restartActual()`:
    - `actualSource == null` → `service.stop()`;
    - ключі не читаються → `service.start(` джерело, що одразу дає `unknown` з причиною `Ключі EcoFlow не знайдено — введіть їх знову в налаштуваннях` `)`;
    - інакше — `factory.create(...)`;
    - мітка джерела — `EcoFlow · ${deviceName}`;
  - викликається при старті й після `save` / `disconnect`;
  - стан для вікон: `composeState() = { ...service.getState(), actual: actualService.getStatus() }`. Він іде і в `IPC.getState`, і в `broadcastState`, і в `tray.update`. `actualService.onChange` → `publish()`;
  - `openEcoflowHelp` → `shell.openExternal('https://developer-eu.ecoflow.com/')`, фіксована адреса.
- `tray.ts` у цій задачі не змінюється: він отримує складений стан, а третій аргумент `computeWidgetView` додає Task 7.

- [ ] **Step 1: Написати падаючі тести** (`tests/main/actual/ipc-actual.test.ts`, фейкові залежності)

```ts
test('test: lists devices as views', ...);            // → {ok:true,devices:[{sn:'SN1',label:'RIVER 2',online:true}]}
test('test: api error text passes through', ...);     // EcoflowApiError 8521 → {ok:false,error:'EcoFlow не прийняв підпис запиту (8521). Перевірте Secret Key і час на комп’ютері.'}
test('invalid input → «Перевірте введені дані»', ...); // region 'xx', порожній ключ, sn 500 символів
test('save: encrypts keys, stores hint and stable clientId, restarts', ...);
  // updateSettings отримав actualSource.accessKeyHint 'AKEY…', ecoflowClientId /^BlackoutWidget-[a-z0-9]{8}$/; другий save не змінює clientId
test('save: secrets unavailable → error, settings untouched', ...);
test('disconnect: clears settings and secrets, keeps clientId', ...);
test('ipc results never contain secret', ...);
  // JSON.stringify(кожного результату test/preview/save, включно з помилковими) не містить 'SECRET-xyz' і 'AKEY1234567'
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/actual/ipc-actual.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `actions.ts`, `electron-deps.ts`, канали в `ipc.ts` / `preload`, з'єднання в `index.ts`.** `registerIpc` отримує нові залежності: `actualActions`, `openEcoflowHelp`, `getState`. `IPC.getState` віддає `getState()`, а не `service.getState()`.
- [ ] **Step 4: Тести зелені й збірка.** Run: `npx vitest run && npm run typecheck && npm run build` → PASS. `mqtt` лишається зовнішнім модулем main і є в `out/main/index.js` як `require("mqtt")`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Wire the actual-state subsystem into main, IPC and tray"`

---

### Task 7: Модель віджета з фактичним станом + спільні помічники

**Files:**
- Create: `src/shared/actual-view.ts`
- Modify: `src/shared/widget-state.ts`, `src/main/tray.ts` (третій аргумент)
- Test: `tests/shared/actual-view.test.ts`, `tests/shared/widget-state.test.ts` (доповнити)

**Interfaces:**
- Produces:
```ts
// actual-view.ts
export const ACTUAL_STALE_MS = 10 * 60_000;
export interface StripPart { startMin: number; endMin: number; power: ActualPower }   // хвилини київської доби, 0..1440, не далі за now
export function dayStrip(history: ActualSegment[], dayKey: string, now: Date): StripPart[];
export interface ActualOutage { start: string; end?: string; startApprox: boolean; endApprox: boolean; ongoing: boolean }
export function recentOutages(history: ActualSegment[], now: Date): ActualOutage[];   // найновіші спершу
export function formatOutage(o: ActualOutage, now: Date): string;
export function sinceText(since: string, approx: boolean, now: Date): string;      // 'з 14:32' / 'з ≈14:32' / інша доба: 'з 16.10 23:10'
// widget-state.ts
export interface WidgetActual { power: 'on' | 'off'; sinceText?: string; mismatch: boolean }
// WidgetView += actual?: WidgetActual; actualUnknownReason?: string; actualStrip?: StripPart[]
export function computeWidgetView(snapshot: ScheduleSnapshot, now: Date, actual?: ActualStatus | null): WidgetView;
```
- **`recentOutages`:**
  - відрізок `off` — це відключення;
  - `off`, за ним проміжок (`unknown`), за ним знову `off` → одне відключення;
  - `off` → `unknown` → `on`: `end` = початок `on`, `endApprox = true`;
  - `off` → `unknown` до кінця історії: `end` відсутній, `ongoing = false`;
  - останній відрізок `off`: `ongoing = true`.
- **`formatOutage`** дослівно (час з `formatHM`, дата з `formatDM` від київської дати початку, тривалість — `formatDurationLong`):
  - `17.10 · 14:32–16:05 · 1 год 33 хв`;
  - неточні часи — з `≈` перед годиною: `17.10 · ≈14:32–16:05 · 1 год 33 хв`;
  - триває: `17.10 · з 14:32 · триває 2 год 5 хв`;
  - кінець невідомий: `17.10 · з 14:32 · кінець невідомий`.
- **`computeWidgetView` з `actual`** — §6.2:
  - Свіжий — `power ≠ unknown` і `now − observedAt ≤ ACTUAL_STALE_MS`.
  - **Не свіжий** (або `actual` відсутній): вигляд як без `actual`, а коли `actual` є — ще `actualUnknownReason = actual.reason ?? 'немає свіжих даних'` і `actualStrip`. Без `actual` обидва поля відсутні.
  - **Свіжий:** спершу рахується вигляд за графіком (наявна логіка, разом з аварійним).
  - **Збіг:**
    - `off` при `off` / `maybe-off` / `emergency`;
    - `on` при `on` / `maybe-off`;
    - вигляд за графіком `unknown` теж вважається збігом.
  - **При збігу:**
    - `state` = `emergency`, якщо графік `emergency`, а фактично `off`; інакше фактичний `on`/`off`;
    - `title = TITLES[state]`;
    - тексти й відлік — з вигляду за графіком.
  - **Розбіжність:**
    - `state` / `title` — фактичні;
    - `nextText = 'Не за графіком · ' + sinceText`, або `'Не за графіком'`, якщо `since` немає;
    - `countdownShort` і `countdownCaption` відсутні;
    - `outageBadge` лишається.
  - `actual = { power, sinceText?, mismatch }`; `actualStrip = dayStrip(actual.history, todayKey, now)`.

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/shared/actual-view.test.ts (київський час: 2026-10-17 — UTC+3)
const seg = (power, start, end?, startApprox?) => ({ power, start, end, startApprox });
test('dayStrip clips to the Kyiv day and to now', ...);
  // [on 16.10 20:00Z → 17.10 08:30Z, off 08:30Z → open], now 17.10 10:00Z → [{0,690,'on'},{690,780,'off'}]
test('recentOutages merges off–gap–off and marks approx ends', ...);
test('formatOutage variants', () => {
  // '17.10 · 14:32–16:05 · 1 год 33 хв', '17.10 · ≈14:32–16:05 · 1 год 33 хв', '17.10 · з 14:32 · триває 2 год 5 хв', '17.10 · з 14:32 · кінець невідомий'
});
test('sinceText same day / other day / approx', ...);
```
```ts
// tests/shared/widget-state.test.ts (доповнити; fixtureSnapshot, «зараз» у слоті on і в слоті off)
test('fresh actual off while schedule says on → mismatch, no countdown', ...);
  // state 'off', title 'Світла немає', nextText 'Не за графіком · з 12:10', countdownShort undefined, actual.mismatch true
test('fresh actual matching schedule keeps schedule texts and countdown', ...);
test('actual off during DTEK emergency → emergency texts stay', ...);
test('actual on during DTEK emergency → mismatch, badge kept', ...);
test('stale actual (observedAt 11 min ago) falls back to schedule with unknown reason', ...);
test('actual unknown → schedule view + actualUnknownReason', ...);
test('no actual → identical to previous behaviour', ...);   // toEqual з викликом без третього аргументу
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/shared` → FAIL.
- [ ] **Step 3: Реалізувати `actual-view.ts` і розширити `computeWidgetView`.** Трей передає `state.actual`.
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Let a fresh actual reading drive the widget state"`

---

### Task 8: UI віджета — значок джерела, «з HH:MM», смужка фактичних відключень

**Files:**
- Modify: `src/renderer/src/widget/{Widget.tsx, parts.tsx, CompactWidget.tsx, TimelineWidget.tsx, RingWidget.tsx, DayBar.tsx, widget.css}`
- Test: `tests/renderer/widget.test.tsx` (доповнити)

**Interfaces:**
- Consumes: `WidgetView.actual`, `actualUnknownReason`, `actualStrip` (Task 7). `Widget` передає `state.actual` у `computeWidgetView`.
- Produces (компоненти):
  - `SourceMark({ view })` у `parts.tsx`:
    - при `view.actual` — значок з `data-actual="live"` і `title="Фактичний стан · EcoFlow"`;
    - при `view.actualUnknownReason` — приглушений значок з `data-actual="unknown"` і `title={`EcoFlow: ${reason}`}`;
    - інакше нічого.
    - Ставиться в `Status` після назви стану.
  - `ActualLine({ parts })` у `DayBar.tsx`: тонка лінія (3–4 px) під смужкою дня. `off` — колір «немає», `unknown` — штриховка, `on` — прозоро. Кожна частина — елемент з `data-actual-part={power}`, позиція `left/width` у % від 1440.
  - Компакт і Таймлайн (лише рядок «Сьогодні») показують `ActualLine`, коли `view.actualStrip` непорожній.
  - Циферблат — тонка внутрішня дуга (радіус `R − 12`, ширина ~3) для частин `off`, з `data-actual-arc`.
  - «з HH:MM» (`view.actual.sinceText`) при збігу показується там, де вміщається: Компакт — у рядку `w-next` перед текстом через ` · `; Таймлайн — під статусом замість лейбла лінії, якщо той не вміщається (рішення будівельника); Циферблат — не обов'язково.
- Розміри вікон не змінюються. Тексти обрізаються з трикрапкою. «оновлено» видно завжди.

- [ ] **Step 1: Написати падаючі тести**

```ts
test.each(['compact', 'ring', 'timeline'] as const)('%s: live source mark and actual title', style => { /* actual off fresh → Status title 'Світла немає', [data-actual="live"] */ });
test.each(['compact', 'timeline'] as const)('%s: actual line parts rendered for today', style => { /* history з off 12:10–13:00 → [data-actual-part="off"] існує, style.left ≈ 50.69% */ });
test('ring: inner arc for actual off', ...);
test('unknown source shows muted mark with reason tooltip', ...);   // title 'EcoFlow: станція не в мережі'
test('no actual configured → no mark, no line (unchanged markup)', ...);
test.each(['compact', 'ring', 'timeline'] as const)('%s: mismatch text fits — caption with «оновлено» still present', ...);
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/renderer/widget.test.tsx` → FAIL.
- [ ] **Step 3: Реалізувати компоненти й стилі.**
- [ ] **Step 4: Тести зелені й візуальна перевірка.**
  - Run: `npx vitest run && npm run typecheck` → PASS.
  - Потім `npm run build` і тимчасовий скрипт у `.superpowers/tmp/` (тека git-ignored; не комітити):
    - прихований `BrowserWindow` (`show: false`) розміру стилю;
    - preload-заглушка `window.api`, що віддає фальшивий `AppState` з `actual` (збіг, розбіжність, невідомо);
    - завантажити `out/renderer/widget.html`, зняти `webContents.capturePage()` → PNG;
    - переглянути, що нічого не вилазить, і видалити PNG.
  - Не знімати екран користувача, не запускати застосунок з його `userData`, не лишати файлів поза `.superpowers/tmp/`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Show the actual state and today's actual outages in all widget styles"`

---

### Task 9: Налаштування — секція «Фактичний стан світла»

**Files:**
- Create: `src/renderer/src/app/ActualSettings.tsx`
- Modify: `src/renderer/src/app/SettingsView.tsx`, `src/renderer/src/app/app.css`
- Test: `tests/renderer/actual-settings.test.tsx`

**Interfaces:**
- Consumes: `RendererApi.ecoflowTest / ecoflowPreview / ecoflowSave / actualDisconnect / openEcoflowHelp` (Task 6); `state.settings.actualSource`, `state.actual`.
- Produces: `ActualSettings({ state, api })`. Вставляється в `SettingsView` секцією після «Стиль віджета».
- **Реєстр панелей:** `const PANELS: Record<string, { name: string; Panel: Component }> = { ecoflow: { name: 'EcoFlow', Panel: EcoflowPanel } }`. Джерело обирається в `<select aria-label="Джерело">`; поки один пункт.
- **Тексти** дослівно:
  - Заголовок секції: `Фактичний стан світла`.
  - **Не налаштовано:**
    - пояснення `Зарядна станція EcoFlow може показувати, чи є світло насправді.`;
    - кнопка `Підключити EcoFlow`.
  - **Форма:**
    - поле `Регіон` (`<select>`): `Європа` (`eu`, за замовчуванням), `Інший регіон (api.ecoflow.com)` (`us`);
    - поля `Access Key` і `Secret Key` (`type="password"`);
    - підказка `Ключі видає EcoFlow після схвалення заявки розробника на developer-eu.ecoflow.com (зазвичай кілька днів).`;
    - кнопка-посилання `Як отримати ключі` → `api.openEcoflowHelp()`;
    - кнопки `Перевірити` (під час запиту — `Перевіряю…`, вимкнена) і `Скасувати`.
  - **Після перевірки:**
    - заголовок `Станції в акаунті`;
    - кожна станція — радіо з текстом `${label} · …${sn.slice(-4)}` і позначкою `в мережі` / `не в мережі`;
    - порожній список — `У цьому акаунті немає станцій`;
    - одна станція — вибрана одразу.
  - **Прев'ю:**
    - під час запиту — `Читаю показники…`;
    - результати:
      - `on` → `${cap(detail)} — світло є`;
      - `off` → `${cap(detail)} — світла немає`;
      - `!online` → `Станція не в мережі`;
      - `unsupported` → `Модель поки не підтримується`;
      - інший `unknown` → `cap(reason)`;
      - помилка → текст помилки;
    - `cap` — перша літера велика.
  - **Кнопка `Зберегти`:** доступна, коли «Перевірити» успішне і станцію вибрано. Помилку збереження показати під кнопкою.
  - **Налаштовано:**
    - рядок `EcoFlow · ${deviceName} · ключ ${accessKeyHint}`;
    - стан:
      - `Зараз: світло є (дані о HH:MM)`;
      - `Зараз: світла немає (дані о HH:MM)`;
      - `Зараз: невідомо — ${reason}`;
    - кнопки `Змінити` (порожня форма, обидва ключі заново) і `Вимкнути`.
- Секрет живе лише в стані форми й очищується після збереження або скасування.

- [ ] **Step 1: Написати падаючі тести** (замоканий `api`, `@testing-library/user-event`)

```ts
test('not configured → connect button opens the form', ...);
test('check lists stations; single station preselected; preview text', ...);   // 'На вході 229 В — світло є'
test('check error is shown and save stays disabled', ...);                     // 8521 текст
test('save sends keys once and clears the form', ...);                         // ecoflowSave викликано з {region:'eu',accessKey,secretKey},{sn,label}
test('preview offline still allows save', ...);
test('configured view shows hint and current state; disconnect calls api', ...);
test('help link calls openEcoflowHelp', ...);
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/renderer/actual-settings.test.tsx` → FAIL.
- [ ] **Step 3: Реалізувати `ActualSettings.tsx`, стилі.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add EcoFlow connection settings"`

---

### Task 10: Головне вікно — рядок «Фактично» і список відключень

**Files:**
- Create: `src/renderer/src/app/ActualStrip.tsx`
- Modify: `src/renderer/src/app/ScheduleView.tsx`, `src/renderer/src/app/app.css`
- Test: `tests/renderer/schedule-view.test.tsx` (доповнити)

**Interfaces:**
- Consumes: `dayStrip`, `recentOutages`, `formatOutage` (Task 7); `computeWidgetView(snapshot, now, state.actual)`.
- Produces:
  - Коли `state.actual` є:
    - на вкладці «Сьогодні» під `DayStrip` — рядок з підписом `Фактично` і `ActualStrip` у тій самій ширині й шкалі 24 год. Частини мають `data-actual-part`; `unknown` заштрихований;
    - під панеллю графіка — `<section>` із заголовком `Фактичні відключення` і списком `formatOutage` за 7 днів, найновіші зверху. Порожній список — `За останні 7 днів відключень не зафіксовано`.
  - Великий статус і рядок під ним уже йдуть з `computeWidgetView` з `actual`.

- [ ] **Step 1: Написати падаючі тести**

```ts
test('actual row on the today tab only', ...);
test('outage list newest first with exact lines', ...);   // '17.10 · 12:10–13:00 · 50 хв'
test('empty list text', ...);
test('no actual → no row, no list', ...);
test('status follows the actual state', ...);             // h2 'Світла немає' при mismatch
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/renderer/schedule-view.test.tsx` → FAIL.
- [ ] **Step 3: Реалізувати.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Show actual outages next to the schedule in the main window"`

---

### Task 11: Живий smoke-скрипт, README, перевірка збірки

**Files:**
- Create: `src/main/smoke-ecoflow.ts`
- Modify: `electron.vite.config.ts` (вхід `smoke-ecoflow`), `README.md`

**Interfaces:**
- Consumes: `EcoflowApi`, `detectGrid`, `normalizeQuotaMessage`, `parseStatusMessage`, `deviceLabel`, `maskKey`, `electronFetch`, `mqttConnect`.
- **`smoke-ecoflow`:**
  - Запуск: `npx electron out/main/smoke-ecoflow.js`; ключі — зі змінних середовища `ECOFLOW_ACCESS_KEY`, `ECOFLOW_SECRET_KEY`, `ECOFLOW_REGION` (`eu` за замовчуванням).
  - Друкує:
    - `maskKey` ключа;
    - список станцій (мітка, SN, онлайн);
    - для кожної станції — вердикт `detectGrid` за `quota/all` і назви всіх ключів показів;
    - потім 60 с MQTT: кількість повідомлень на `/quota` і `/status` і вердикт після злиття.
  - Не пише в userData, не друкує Secret Key і пароль MQTT.
  - Виходить з кодом 0 при успіху, 1 при помилці (текст помилки — з `describeEcoflowError`).
- **README** (українською), розділ «Фактичний стан (EcoFlow)»:
  - як подати заявку на developer-eu.ecoflow.com і де взяти Access Key / Secret Key;
  - де ввести ключі (Налаштування → Фактичний стан світла);
  - що означає «невідомо»;
  - обмеження: River 2 через Open API не підтверджено, `1006`; роутер без живлення від станції; ліміт ~10 clientId на добу;
  - як запустити smoke-скрипт.

- [ ] **Step 1: Реалізувати скрипт і README.**
- [ ] **Step 2: Збірка.**
  - Run: `npm run build` → у `out/main/` є `index.js` і `smoke-ecoflow.js`.
  - Без ключів `npx electron out/main/smoke-ecoflow.js` виходить з кодом 1 і повідомленням `Задайте ECOFLOW_ACCESS_KEY і ECOFLOW_SECRET_KEY`.
- [ ] **Step 3: Інсталятор.**
  - Run: `npm run dist:win` → збірка успішна.
  - `node_modules/mqtt` потрапив у `app.asar`: перевірити `npx asar list dist/win-unpacked/resources/app.asar | grep -c node_modules/mqtt/` > 0. Якщо `asar` недоступний — `npx @electron/asar list …`.
- [ ] **Step 4: Повний прогін.** Run: `npx vitest run && npm run typecheck` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add EcoFlow live smoke script and README section"`
