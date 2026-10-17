# Blackout Widget (віха 1: Windows) — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Робочий застосунок для Windows 11: майстер адреси → прихований браузер тягне графік dtek-krem кожні ~15 хв → «скляний» віджет (3 стилі), прикріплений до робочого столу, + головне вікно, трей, автозапуск, інсталятор.

**Architecture:** Electron (main/preload/renderer через electron-vite). Уся логіка даних — чисті модулі без імпорту `electron` (парсер, модель стану, планувальник, сховище), покриті vitest. Electron-залежні частини (прихований браузер, вікна, трей, FFI) тонкі й перевіряються руками за чек-листами. Платформо-специфічне сховане за інтерфейсом `DesktopPinner`, щоб віха 2 (macOS) додала свою реалізацію.

**Tech Stack:** Node 24, Electron 44, TypeScript, electron-vite, React 18+, vitest + jsdom + @testing-library/react, koffi (FFI), electron-builder.

**Spec:** `docs/superpowers/specs/2026-10-17-blackout-widget-design.md` (читати разом із планом; §-посилання нижче — на нього).

**Поза цим планом:** macOS (§7.2, §10) — окремий план «віха 2» після цієї віхи. Код має лишатися кросплатформним: усе win32-специфічне — за `process.platform === 'win32'`.

## Global Constraints

- Платформа віхи: Windows 11 x64 (перевірено на build 26300). Node v24.x, Electron 44.x (прототип працював на 44.9.0).
- Мова інтерфейсу — лише українська; тексти копіювати дослівно з плану.
- Уся арифметика графіка — у часовому поясі `Europe/Kyiv`.
- Джерело: `https://www.dtek-krem.com.ua/ua/shutdowns`, partition `persist:dtek-krem`, AJAX `POST /ua/ajax`.
- Оновлення: кожні 15 хв ± 1 хв; автоматично не частіше ніж раз на 5 хв; ніяких паралельних запитів до джерела.
- Дані застарілі, якщо `now − fetchedAt > 45 хв`.
- Щонайбільше 2 лінії на будинок (Лінія N = N-та черга після `slice(0,2)` + фільтр, §4.4).
- Розміри віджета (DIP): compact 290×150, ring 236×260, timeline 400×200.
- Жодних сторонніх сервісів/телеметрії, крім сайту джерела.
- Коміти: тема + тіло, **без** `Co-Authored-By` і без будь-яких рядків-атрибуцій Claude.
- Чисті модулі (`src/shared/**`, `src/main/providers/dtek-krem/parse.ts`, `src/main/store.ts`, `src/main/scheduler.ts`, `src/main/refresh.ts`, `src/main/tray-menu.ts`, `src/main/widget/position.ts`, `src/main/widget/glass.ts`, `src/main/widget/wallpaper-parse.ts`) не імпортують `electron` (дозволено лише `import type`).

## Review Focus

1. **ДТЕК змінив графік або опублікував завтрашній між оновленнями** → наступне оновлення замінює знімок і віджет перераховується без перезапуску. Тест: Task 5 `new sourceUpdatedAt replaces snapshot`.
2. **Комп'ютер прокинувся наступного дня зі вчорашнім знімком** → віджет не видає вчорашні години за сьогоднішні; якщо у знімку є «завтра», що вже стало сьогодні, — бере його. Тест: Task 3 `next day after sleep`.
3. **Старт без мережі з кешем на диску** → віджет одразу показує кешований знімок з «оновлено о …» і позначкою застарілості. Тест: Task 5 `starts with cached snapshot`.
4. **Сайт повернув сміття / будинку більше немає у відповіді** → фаза `error`, останній знімок лишається, без падіння. Тести: Task 4 `house missing`, Task 2 `parseHomeNumResponse rejects garbage`, Task 5 `provider error keeps previous snapshot`.
5. **Перехід на зимовий час 25.10.2026** (день 25 год) → відлік і години «о 15:00» правильні в цей день. Тест: Task 1 `kyivWallTimeToInstant across DST end`, Task 3 `DST day countdown`.

---

## Файлова структура

```
package.json, electron.vite.config.ts, tsconfig.json, tsconfig.node.json, tsconfig.web.json,
vitest.config.ts, electron-builder.yml, README.md
resources/tray/{on,off,emergency,unknown}.png     іконки трею 32×32
scripts/gen-tray-icons.mjs                         генератор іконок (чистий Node + zlib)
src/shared/types.ts            доменні типи (Slot, DaySchedule, ScheduleSnapshot, Settings, AppState…)
src/shared/time.ts             київський час
src/shared/widget-state.ts     знімок + now → WidgetView (стан, відлік, тексти)
src/shared/ipc.ts              імена каналів + RendererApi
src/main/index.ts              bootstrap
src/main/smoke-dtek.ts         ручна перевірка джерела наживо
src/main/providers/types.ts    ScheduleProvider, PageSession, помилки
src/main/providers/registry.ts
src/main/providers/browser-session.ts   прихований BrowserWindow (electron)
src/main/providers/dtek-krem/{index.ts,parse.ts,page-scripts.ts}
src/main/store.ts              JsonStore + AppStore
src/main/refresh.ts            RefreshService
src/main/scheduler.ts          RefreshScheduler
src/main/ipc.ts                реєстрація IPC-обробників
src/main/tray-menu.ts          чисті будівники меню/підказки трею
src/main/tray.ts               Tray (electron)
src/main/main-window.ts        головне вікно (electron)
src/main/widget/{widget-window.ts,position.ts,desktop-pin.ts,pin-win32.ts,glass.ts,wallpaper-parse.ts,wallpaper-win32.ts}
src/preload/index.ts           contextBridge → window.api
src/renderer/{app.html,widget.html}
src/renderer/src/app/{main.tsx,App.tsx,SetupWizard.tsx,Autocomplete.tsx,ScheduleView.tsx,SettingsView.tsx,app.css}
src/renderer/src/widget/{main.tsx,WidgetRoot.tsx,Widget.tsx,CompactWidget.tsx,RingWidget.tsx,TimelineWidget.tsx,DayBar.tsx,OutageBadge.tsx,usePointerGestures.ts,widget.css}
tests/fixtures/dtek-krem/{getHomeNum-stale-updateFact.json,getHomeNum-fresh.json}
tests/helpers/snapshot.ts      fixtureSnapshot()
tests/**.test.ts(x)
```

---

### Task 1: Каркас проєкту + київський час

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`, `src/main/index.ts` (тимчасовий), `src/preload/index.ts` (порожній), `src/renderer/app.html`, `src/renderer/widget.html`, `src/renderer/src/app/main.tsx` (заглушка), `src/renderer/src/widget/main.tsx` (заглушка), `src/shared/types.ts`, `src/shared/time.ts`
- Test: `tests/shared/time.test.ts`

**Interfaces:**
- Produces (`src/shared/types.ts`):
```ts
export type Slot = 'on' | 'off' | 'maybe-off' | 'unknown';
export interface DaySchedule { date: string /* YYYY-MM-DD Kyiv */; slots: Slot[] /* 48 */ }
export interface LineInfo { index: number; groupId: string; label: string }
export interface HouseInfo { house: string; lines: LineInfo[] }
export interface Address { providerId: string; city: string; street: string; house: string; lineIndex: number; groupId: string }
export interface CurrentOutage { kind: 'emergency' | 'other'; text: string; start?: string; end?: string }
export interface ScheduleSnapshot {
  providerId: string; address: Address; groupId: string; groupLabel: string;
  days: DaySchedule[]; sourceUpdatedAt?: string; fetchedAt: string /* ISO */;
  lines: LineInfo[]; currentOutage?: CurrentOutage;
}
export type WidgetStyle = 'compact' | 'ring' | 'timeline';
export interface WidgetPosition { x: number; y: number; displayId: number }
export interface Settings { address: Address | null; widgetStyle: WidgetStyle; autostart: boolean; widgetPosition: WidgetPosition | null }
export type RefreshPhase = 'idle' | 'refreshing' | 'ok' | 'error' | 'captcha';
export interface AppState { settings: Settings; snapshot: ScheduleSnapshot | null; phase: RefreshPhase; lastError?: string; lineChanged: boolean }
export type WidgetBackground = { kind: 'image'; dataUrl: string } | { kind: 'tint' };
```
- Produces (`src/shared/time.ts`): `KYIV_TZ = 'Europe/Kyiv'`; `kyivDateKey(d: Date): string`; `kyivMinutesOfDay(d: Date): number`; `kyivWallTimeToInstant(dateKey: string, minutes: number): Date` (minutes 0..1440, 1440 = наступна північ); `addDays(dateKey: string, n: number): string`; `formatHM(d: Date): string` (Kyiv, `HH:MM`); `formatDM(dateKey: string): string` (`DD.MM`); `parseDtekDateTime(s: string): Date | undefined` (формати `HH:MM DD.MM.YYYY` і `DD.MM.YYYY HH:MM`, київський настінний час).

- [ ] **Step 1: Ініціалізувати npm-проєкт і поставити залежності**

Run: `npm init -y`, потім `npm i react react-dom koffi` і `npm i -D electron@44 electron-vite vite @vitejs/plugin-react typescript vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom electron-builder @types/node @types/react @types/react-dom`.
У `package.json`: `"main": "out/main/index.js"`, scripts `dev: electron-vite dev`, `build: electron-vite build`, `typecheck: tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json`, `test: vitest run`.
`electron.vite.config.ts`: main input `src/main/index.ts`; preload `src/preload/index.ts`; renderer з плагіном react і двома входами `app: src/renderer/app.html`, `widget: src/renderer/widget.html`. `vitest.config.ts`: `include: ['tests/**/*.test.{ts,tsx}']`, env `node` (renderer-тести вмикають jsdom коментарем `// @vitest-environment jsdom`), `setupFiles` з `@testing-library/jest-dom/vitest`.
Тимчасовий `src/main/index.ts`: на `app.whenReady` відкрити вікно 400×300 з `app.html` (dev: `process.env.ELECTRON_RENDERER_URL + '/app.html'`, prod: `loadFile(join(__dirname, '../renderer/app.html'))`).

- [ ] **Step 2: Написати падаючий тест часу**

```ts
// tests/shared/time.test.ts
import { kyivDateKey, kyivMinutesOfDay, kyivWallTimeToInstant, addDays, formatHM, formatDM, parseDtekDateTime } from '../../src/shared/time';
test('kyivDateKey: DTEK day key 1792184400 is 2026-10-17', () => {
  expect(kyivDateKey(new Date(1792184400 * 1000))).toBe('2026-10-17');
});
test('kyivMinutesOfDay', () => expect(kyivMinutesOfDay(new Date('2026-10-17T08:50:00Z'))).toBe(710));
test('kyivWallTimeToInstant summer time', () =>
  expect(kyivWallTimeToInstant('2026-10-17', 900).toISOString()).toBe('2026-10-17T12:00:00.000Z'));
test('kyivWallTimeToInstant across DST end', () =>
  expect(kyivWallTimeToInstant('2026-10-25', 900).toISOString()).toBe('2026-10-25T13:00:00.000Z'));
test('kyivWallTimeToInstant 24:00 is next midnight', () =>
  expect(kyivWallTimeToInstant('2026-10-18', 1440).toISOString()).toBe('2026-10-18T21:00:00.000Z'));
test('addDays crosses month', () => expect(addDays('2026-10-31', 1)).toBe('2026-11-01'));
test('formatHM / formatDM', () => {
  expect(formatHM(new Date('2026-10-17T08:48:00Z'))).toBe('11:48');
  expect(formatDM('2026-10-18')).toBe('18.10');
});
test('parseDtekDateTime both orders, garbage → undefined', () => {
  expect(parseDtekDateTime('11:55 17.10.2026')?.toISOString()).toBe('2026-10-17T08:55:00.000Z');
  expect(parseDtekDateTime('17.10.2026 11:55')?.toISOString()).toBe('2026-10-17T08:55:00.000Z');
  expect(parseDtekDateTime('')).toBeUndefined();
  expect(parseDtekDateTime('завтра')).toBeUndefined();
});
```

- [ ] **Step 3: Запустити — має впасти**

Run: `npx vitest run tests/shared/time.test.ts` → FAIL (модуль не існує).

- [ ] **Step 4: Реалізувати `src/shared/types.ts` і `src/shared/time.ts`**

Через `Intl.DateTimeFormat('en-CA', { timeZone: KYIV_TZ, ... }).formatToParts`. `kyivWallTimeToInstant`: взяти UTC-кандидат `Date.UTC(y,m,d,0,minutes)`, визначити зсув Києва для кандидата, відняти; перевірити зсув ще раз для результату (на межі DST) і скоригувати.

- [ ] **Step 5: Тести + збірка зелені**

Run: `npx vitest run` → PASS; `npm run typecheck` → без помилок; `npm run build` → створює `out/`; `npm run dev` → відкривається порожнє вікно (закрити).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "Scaffold Electron app and add Kyiv time helpers"
```

---

### Task 2: Парсер dtek-krem (чистий)

**Files:**
- Create: `src/main/providers/types.ts`, `src/main/providers/dtek-krem/parse.ts`, `tests/fixtures/dtek-krem/*.json` (скопіювати з `docs/superpowers/specs/assets/dtek-krem-samples/`)
- Test: `tests/providers/dtek-parse.test.ts`

**Interfaces:**
- Consumes: типи з Task 1, `kyivDateKey`, `parseDtekDateTime`.
- Produces (`src/main/providers/types.ts`):
```ts
export class ProviderError extends Error {}
export class CaptchaRequiredError extends Error {}
export interface PageSession {
  ensureReady(): Promise<void>;          // кидає CaptchaRequiredError по таймауту
  evaluate<T>(js: string): Promise<T>;
  reload(): Promise<void>;
  showForUser(): Promise<void>;          // показує вікно, резолвиться коли сторінка знову готова
  dispose(): void;
}
export interface ScheduleProvider {
  id: string; displayName: string;
  listCities(): Promise<string[]>;
  listStreets(city: string): Promise<string[]>;
  listHouses(city: string, street: string): Promise<HouseInfo[]>;
  fetchSnapshot(address: Address): Promise<ScheduleSnapshot>;
  showVerification(): Promise<void>;
  dispose(): void;
}
```
- Produces (`parse.ts`):
```ts
export interface DtekFact { data: Record<string, Record<string, Record<string, string>>>; update: string; today: number }
export interface DtekHouseEntry { sub_type: string; start_date: string; end_date: string; type: string; sub_type_reason: string[]; voluntarily: unknown; cek: unknown }
export interface DtekHomeNumResponse { result: boolean; data: Record<string, DtekHouseEntry>; updateTimestamp?: string; fact?: DtekFact; preset?: { sch_names: Record<string, string> } }
export function parseHomeNumResponse(json: unknown): DtekHomeNumResponse;          // ProviderError якщо не те
export function hourToSlots(status: string): [Slot, Slot];
export function factToDays(fact: DtekFact, groupId: string): DaySchedule[];       // відсортовано за датою
export function deriveLines(subTypeReason: string[], fact: DtekFact, schNames: Record<string, string>): LineInfo[];
export function parseHouses(resp: DtekHomeNumResponse, fact: DtekFact, schNames: Record<string, string>): HouseInfo[];
export function parseCurrentOutage(entry: DtekHouseEntry): CurrentOutage | undefined;
```

- [ ] **Step 1: Скопіювати фікстури й написати падаючі тести**

```ts
// tests/providers/dtek-parse.test.ts
import stale from '../fixtures/dtek-krem/getHomeNum-stale-updateFact.json';
import { parseHomeNumResponse, hourToSlots, factToDays, deriveLines, parseHouses, parseCurrentOutage } from '../../src/main/providers/dtek-krem/parse';
import { ProviderError } from '../../src/main/providers/types';
const resp = parseHomeNumResponse(stale);
const fact = resp.fact!; const names = resp.preset!.sch_names;

test('hourToSlots maps every DTEK status', () => {
  expect(hourToSlots('yes')).toEqual(['on', 'on']);
  expect(hourToSlots('no')).toEqual(['off', 'off']);
  expect(hourToSlots('first')).toEqual(['off', 'on']);
  expect(hourToSlots('second')).toEqual(['on', 'off']);
  expect(hourToSlots('maybe')).toEqual(['maybe-off', 'maybe-off']);
  expect(hourToSlots('mfirst')).toEqual(['maybe-off', 'on']);
  expect(hourToSlots('msecond')).toEqual(['on', 'maybe-off']);
  expect(hourToSlots('weird')).toEqual(['unknown', 'unknown']);
});
test('factToDays: GPV1.2 on 2026-10-17 matches the site screenshot', () => {
  const days = factToDays(fact, 'GPV1.2');
  expect(days.map(d => d.date)).toEqual(['2026-10-17']);
  expect(days[0].slots).toHaveLength(48);
  const off = days[0].slots.flatMap((s, i) => (s === 'off' ? [i] : []));
  expect(off).toEqual([12, 13, 14, 15, 16, 30, 31, 32, 33, 34, 35, 36, 37]);
});
test('factToDays: GPV4.2 half hours', () => {
  const s = factToDays(fact, 'GPV4.2')[0].slots;
  expect(s.slice(0, 2)).toEqual(['off', 'off']);
  expect(s.slice(36, 38)).toEqual(['on', 'off']);
  expect(s.slice(44, 46)).toEqual(['off', 'on']);
});
test('factToDays: unknown group → []', () => expect(factToDays(fact, 'GPV9.9')).toEqual([]));
test('deriveLines: house 40 → Лінія 1 = GPV1.2, Лінія 2 = GPV4.2', () => {
  expect(deriveLines(['GPV1.2', 'GPV4.2'], fact, names)).toEqual([
    { index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' },
    { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' },
  ]);
});
test('deriveLines keeps only first two (house 13)', () =>
  expect(deriveLines(['GPV4.2', 'GPV2.2', 'GPV4.1', 'GPV1.2'], fact, names).map(l => l.groupId)).toEqual(['GPV4.2', 'GPV2.2']));
test('deriveLines: slice first, then filter, then number', () => {
  expect(deriveLines(['GPV9.9', 'GPV1.2'], fact, names)).toEqual([{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }]);
  expect(deriveLines(['GPV9.9', 'GPV8.8', 'GPV1.2'], fact, names)).toEqual([]);
  expect(deriveLines([], fact, names)).toEqual([]);
});
test('parseHouses keeps response order and odd keys', () => {
  const houses = parseHouses(resp, fact, names);
  expect(houses.find(h => h.house === '40')!.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
  expect(houses.some(h => h.house === ':0098')).toBe(true);
});
test('parseCurrentOutage: empty → undefined; filled → emergency', () => {
  expect(parseCurrentOutage(resp.data['40'])).toBeUndefined();
  expect(parseCurrentOutage({ ...resp.data['40'], type: 'Аварійне відключення', start_date: '10:05 17.10.2026', end_date: '17:00 17.10.2026' }))
    .toEqual({ kind: 'emergency', text: 'Аварійне відключення', start: '10:05 17.10.2026', end: '17:00 17.10.2026' });
  expect(parseCurrentOutage({ ...resp.data['40'], sub_type: 'Екстрене відключення' })?.kind).toBe('emergency');
  expect(parseCurrentOutage({ ...resp.data['40'], type: 'Планові ремонтні роботи' })?.kind).toBe('other');
});
test('parseHomeNumResponse rejects garbage', () => {
  expect(() => parseHomeNumResponse('<html>')).toThrow(ProviderError);
  expect(() => parseHomeNumResponse({ result: false })).toThrow(ProviderError);
  expect(() => parseHomeNumResponse({ result: true })).toThrow(ProviderError);
});
```
(`tsconfig` має `resolveJsonModule: true`.)

- [ ] **Step 2: Запустити — має впасти**

Run: `npx vitest run tests/providers/dtek-parse.test.ts` → FAIL.

- [ ] **Step 3: Реалізувати `types.ts` і `parse.ts`**

`factToDays`: для кожного ключа дня `kyivDateKey(new Date(+ts*1000))`, години `"1".."24"` → `hourToSlots`, відсутня година → `['unknown','unknown']`. `deriveLines` — дослівно правило §4.4 (група має бути в `fact.data[day]` для **кожного** дня і в `schNames`). `parseCurrentOutage`: `text = [type, sub_type].filter(Boolean).join(' · ')`; порожньо → `undefined`; `kind = /аварій|екстрен/i.test(text) ? 'emergency' : 'other'`; `start/end` — сирі рядки, якщо непорожні.

- [ ] **Step 4: Тести зелені**

Run: `npx vitest run tests/providers` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Add DTEK KREM schedule parser with captured fixtures"
```

---

### Task 3: Модель стану віджета і тексти

**Files:**
- Create: `src/shared/widget-state.ts`, `tests/helpers/snapshot.ts`
- Test: `tests/shared/widget-state.test.ts`

**Interfaces:**
- Consumes: Task 1 (`time.ts`, типи), Task 2 (`parseHomeNumResponse`, `factToDays`, `deriveLines` — лише в тестовому хелпері).
- Produces (`src/shared/widget-state.ts`):
```ts
export const STALE_AFTER_MIN = 45;
export type PowerState = 'on' | 'off' | 'maybe-off' | 'unknown' | 'emergency';
export interface WidgetView {
  state: PowerState; title: string; nextText: string;
  countdownShort?: string; countdownCaption?: string;
  todayKey: string; today: DaySchedule | null; tomorrow: DaySchedule | null;
  nowFraction: number;                 // kyivMinutesOfDay(now) / 1440
  lineLabel: string;                   // 'Лінія 1 · черга 1.2'
  updatedText: string;                 // 'оновлено 11:48'
  stale: boolean; outageBadge?: 'Аварійне' | 'Екстрене' | 'Позапланове';
}
export function computeWidgetView(snapshot: ScheduleSnapshot, now: Date): WidgetView;
export function slotRuns(slots: Slot[]): { start: number; end: number; slot: Slot }[]; // end exclusive
export function formatDurationLong(min: number): string;   // 190 → '3 год 10 хв', 45 → '45 хв', 60 → '1 год'
export function formatDurationShort(min: number): string;  // 190 → '3:10', 45 → '0:45'
```
- Produces (`tests/helpers/snapshot.ts`): `fixtureSnapshot(opts?: { groupId?: string; lineIndex?: number; fetchedAt?: string; extraDays?: DaySchedule[]; currentOutage?: CurrentOutage; sourceUpdatedAt?: string }): ScheduleSnapshot` — з stale-фікстури; за замовчуванням GPV1.2, lineIndex 1, `fetchedAt '2026-10-17T08:48:00.000Z'`, адреса `{ providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' }`, `groupLabel: 'Черга 1.2'`.

**Правила (алгоритм, який тести не визначають повністю):**
- `today` = день з `date === kyivDateKey(now)`; `tomorrow` = день з `addDays(todayKey, 1)`. Немає `today` → `state 'unknown'`, `title 'Немає даних'`, `nextText 'Графік на сьогодні ще не отримано'`.
- Поточний слот `i = floor(kyivMinutesOfDay(now)/30)`. Сканувати `today.slots[i+1..47]`, далі `tomorrow.slots` (якщо є); зупинка на першому `unknown` (= кінець відомих даних). Перший слот ≠ поточного — зміна; момент = `kyivWallTimeToInstant(dateKey, j*30)`; `minutesLeft = ceil((at − now)/60000)`.
- Заголовки: on `Світло є`; off `Світла немає`; maybe-off `Можливе відключення`; unknown `Немає даних`; emergency `Світла немає`.
- `nextText` за цільовим слотом (`завтра ` перед `о`, якщо дата моменту ≠ todayKey):
  - → on: `Увімкнуть о HH:MM · через {long}`; caption `до увімкнення о HH:MM`
  - → off: `Вимкнення о HH:MM · через {long}`; caption `до вимкнення о HH:MM`
  - → maybe-off: `Можливе вимкнення о HH:MM · через {long}`; caption `до можливого вимкнення о HH:MM`
  - зміни немає: `Без змін до кінця графіка`, без countdown.
- Аварійне (`snapshot.currentOutage` з `kind 'emergency'` або `'other'`): `state 'emergency'`; `outageBadge` = `/екстрен/i` → `Екстрене`, `/аварій/i` → `Аварійне`, інакше `Позапланове`; якщо `parseDtekDateTime(end)` у майбутньому — `nextText '{badge} · орієнтовно до HH:MM'`, countdown до кінця з caption `до орієнтовного увімкнення`; інакше `nextText '{badge} відключення · час відновлення невідомий'`.
- `stale = now − fetchedAt > 45 хв`. `lineLabel = 'Лінія ' + address.lineIndex + ' · ' + groupLabel.toLowerCase()`.

- [ ] **Step 1: Написати хелпер і падаючі тести**

```ts
// tests/shared/widget-state.test.ts
import { computeWidgetView, slotRuns, formatDurationLong, formatDurationShort } from '../../src/shared/widget-state';
import { fixtureSnapshot } from '../helpers/snapshot';
const at = (iso: string) => new Date(iso);
const allOn = (date: string) => ({ date, slots: Array(48).fill('on') });

test('11:50 Kyiv: light on, outage at 15:00', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-17T08:50:00Z'));
  expect(v.state).toBe('on'); expect(v.title).toBe('Світло є');
  expect(v.nextText).toBe('Вимкнення о 15:00 · через 3 год 10 хв');
  expect(v.countdownShort).toBe('3:10'); expect(v.countdownCaption).toBe('до вимкнення о 15:00');
  expect(v.lineLabel).toBe('Лінія 1 · черга 1.2'); expect(v.updatedText).toBe('оновлено 11:48');
  expect(v.stale).toBe(false); expect(v.tomorrow).toBeNull();
});
test('08:10: off until 08:30 ("first" half hour)', () =>
  expect(computeWidgetView(fixtureSnapshot(), at('2026-10-17T05:10:00Z')).nextText).toBe('Увімкнуть о 08:30 · через 20 хв'));
test('16:00: off until 19:00', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-17T13:00:00Z'));
  expect(v.title).toBe('Світла немає'); expect(v.nextText).toBe('Увімкнуть о 19:00 · через 3 год');
});
test('20:00 without tomorrow: no more changes', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-17T17:00:00Z'));
  expect(v.nextText).toBe('Без змін до кінця графіка'); expect(v.countdownShort).toBeUndefined();
});
test('20:00 with tomorrow: change tomorrow at 06:00', () => {
  const tmr = allOn('2026-10-18'); tmr.slots[12] = 'off';
  const v = computeWidgetView(fixtureSnapshot({ extraDays: [tmr] }), at('2026-10-17T17:00:00Z'));
  expect(v.nextText).toBe('Вимкнення завтра о 06:00 · через 10 год');
});
test('next day after sleep: yesterday-only snapshot → no data', () => {
  const v = computeWidgetView(fixtureSnapshot(), at('2026-10-18T07:00:00Z'));
  expect(v.state).toBe('unknown'); expect(v.nextText).toBe('Графік на сьогодні ще не отримано');
});
test('next day after sleep: former tomorrow becomes today', () => {
  const v = computeWidgetView(fixtureSnapshot({ extraDays: [allOn('2026-10-18')] }), at('2026-10-18T07:00:00Z'));
  expect(v.state).toBe('on'); expect(v.todayKey).toBe('2026-10-18');
});
test('DST day countdown (2026-10-25, UTC+2 after 04:00)', () => {
  const d = allOn('2026-10-25'); d.slots[30] = 'off';             // 15:00
  const v = computeWidgetView(fixtureSnapshot({ extraDays: [d] }), at('2026-10-25T10:00:00Z')); // 12:00 Kyiv
  expect(v.nextText).toBe('Вимкнення о 15:00 · через 3 год');
});
test('maybe-off target', () => {
  const d = allOn('2026-10-17'); d.slots[30] = 'maybe-off';
  const s = { ...fixtureSnapshot(), days: [d] };
  expect(computeWidgetView(s, at('2026-10-17T08:50:00Z')).nextText).toBe('Можливе вимкнення о 15:00 · через 3 год 10 хв');
});
test('emergency overrides schedule', () => {
  const s = fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення', end: '17:00 17.10.2026' } });
  const v = computeWidgetView(s, at('2026-10-17T08:50:00Z'));
  expect(v.state).toBe('emergency'); expect(v.title).toBe('Світла немає'); expect(v.outageBadge).toBe('Аварійне');
  expect(v.nextText).toBe('Аварійне · орієнтовно до 17:00');
  expect(v.countdownCaption).toBe('до орієнтовного увімкнення');
  const noEnd = computeWidgetView(fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Екстрене відключення' } }), at('2026-10-17T08:50:00Z'));
  expect(noEnd.outageBadge).toBe('Екстрене'); expect(noEnd.nextText).toBe('Екстрене відключення · час відновлення невідомий');
});
test('stale after 45 min', () => {
  expect(computeWidgetView(fixtureSnapshot(), at('2026-10-17T09:34:00Z')).stale).toBe(true);   // 46 хв
  expect(computeWidgetView(fixtureSnapshot(), at('2026-10-17T09:32:00Z')).stale).toBe(false);  // 44 хв
});
test('slotRuns GPV1.2', () =>
  expect(slotRuns(fixtureSnapshot().days[0].slots)).toEqual([
    { start: 0, end: 12, slot: 'on' }, { start: 12, end: 17, slot: 'off' }, { start: 17, end: 30, slot: 'on' },
    { start: 30, end: 38, slot: 'off' }, { start: 38, end: 48, slot: 'on' }]));
test('duration formats', () => {
  expect(formatDurationLong(190)).toBe('3 год 10 хв'); expect(formatDurationLong(45)).toBe('45 хв'); expect(formatDurationLong(60)).toBe('1 год');
  expect(formatDurationShort(190)).toBe('3:10'); expect(formatDurationShort(45)).toBe('0:45');
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/shared/widget-state.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `src/shared/widget-state.ts` за правилами вище.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add widget view model with countdown and Ukrainian copy"`

---

### Task 4: Прихований браузер + провайдер dtek-krem + smoke

**Files:**
- Create: `src/main/providers/browser-session.ts`, `src/main/providers/dtek-krem/page-scripts.ts`, `src/main/providers/dtek-krem/index.ts`, `src/main/providers/registry.ts`, `src/main/smoke-dtek.ts`
- Modify: `electron.vite.config.ts` (другий main-вхід `smoke-dtek`)
- Test: `tests/providers/dtek-provider.test.ts`

**Interfaces:**
- Consumes: Task 2 (`PageSession`, `ScheduleProvider`, помилки, усі функції `parse.ts`).
- Produces:
```ts
// browser-session.ts (імпортує electron)
export interface SessionOptions { url: string; partition: string; readyCheck: string; readyTimeoutMs?: number /* 30000 */ }
export class BrowserSession implements PageSession { constructor(opts: SessionOptions) }
// page-scripts.ts
export const DTEK_URL = 'https://www.dtek-krem.com.ua/ua/shutdowns';
export const READY_CHECK = "typeof DisconSchedule !== 'undefined' && !!DisconSchedule.fact";
export const READ_FACT: string;        // → { fact: DtekFact, schNames: Record<string,string> } (JSON-клон)
export const READ_CITIES: string;      // → string[]  (Object.keys(DisconSchedule.streets))
export function readStreetsScript(city: string): string;                                   // → string[]
export function getHomeNumScript(city: string, street: string, updateFact: string): string; // → { status: number; body: string }
// index.ts
export class DtekKremProvider implements ScheduleProvider { constructor(session: PageSession) } // id 'dtek-krem', displayName 'ДТЕК Київські регіональні електромережі'
// registry.ts
export function createProviders(makeSession: (o: SessionOptions) => PageSession): ScheduleProvider[];
export function findProvider(list: ScheduleProvider[], id: string): ScheduleProvider; // ProviderError якщо немає
```

**Поведінка `DtekKremProvider`:**
- Тримає в пам'яті `fact` і `schNames`. Перед будь-якою дією — `session.ensureReady()`; якщо `fact` ще немає — `evaluate(READ_FACT)`.
- `fetchSnapshot(address)`: `evaluate(getHomeNumScript(city, street, fact.update))`; `status !== 200` або невалідний JSON → `session.reload()`, перечитати `READ_FACT`, повторити **один** раз; друга невдача → `ProviderError('Сайт ДТЕК повернув помилку')`. Якщо у відповіді є `fact`/`preset` — замінити кешовані. Будинку немає → `ProviderError('Будинок не знайдено у відповіді ДТЕК')`. Лінії — `deriveLines`; група = `lines[address.lineIndex-1]?.groupId ?? address.groupId`; `days = factToDays(fact, group)`; `currentOutage = parseCurrentOutage(entry)`; `sourceUpdatedAt = fact.update`; `fetchedAt = new Date().toISOString()`.
- `listHouses(city, street)`: той самий `getHomeNum` → `parseHouses`.
- `showVerification()` → `session.showForUser()`.
- `BrowserSession`: `show:false` BrowserWindow 1280×900 з `partition`; `loadURL` ігнорує `ERR_ABORTED` (Imperva перезавантажує сторінку); поллінг `readyCheck` кожні 500 мс до `readyTimeoutMs` → `CaptchaRequiredError('Сайт просить пройти перевірку')`. Не запускати два `ensureReady` паралельно (спільний проміс). `showForUser()`: `win.show()`, поллінг без таймауту, коли готово — `win.hide()`.

- [ ] **Step 1: Написати падаючі тести з фейковою сесією**

```ts
// tests/providers/dtek-provider.test.ts
import stale from '../fixtures/dtek-krem/getHomeNum-stale-updateFact.json';
import fresh from '../fixtures/dtek-krem/getHomeNum-fresh.json';
import { DtekKremProvider } from '../../src/main/providers/dtek-krem';
import { READ_FACT, getHomeNumScript } from '../../src/main/providers/dtek-krem/page-scripts';
import { CaptchaRequiredError, ProviderError } from '../../src/main/providers/types';
const C = 'м. Біла Церква', S = 'бул. Грушевського Михайла';
const addr = { providerId: 'dtek-krem', city: C, street: S, house: '40', lineIndex: 1, groupId: 'GPV1.2' };
const oldFact = { ...stale.fact, update: '17.10.2026 09:40' };
function fakeSession(replies: Record<string, unknown[]>) {
  return {
    ensureReady: vi.fn(async () => {}), showForUser: vi.fn(async () => {}), dispose: vi.fn(), reload: vi.fn(async () => {}),
    evaluate: vi.fn(async (js: string) => { const q = replies[js]; if (!q?.length) throw new Error('unexpected ' + js.slice(0, 60)); return q.shift(); }) };
}
test('first fetch sends cached updateFact and adopts fresh fact', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: oldFact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 09:40')]: [{ status: 200, body: JSON.stringify(stale) }] });
  const snap = await new DtekKremProvider(s as any).fetchSnapshot(addr);
  expect(snap.sourceUpdatedAt).toBe('17.10.2026 11:55');
  expect(snap.groupId).toBe('GPV1.2'); expect(snap.groupLabel).toBe('Черга 1.2');
  expect(snap.days.map(d => d.date)).toEqual(['2026-10-17']);
  expect(snap.lines.map(l => l.groupId)).toEqual(['GPV1.2', 'GPV4.2']);
});
test('second fetch reuses cached fact when response has none', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }, { status: 200, body: JSON.stringify(fresh) }] });
  const p = new DtekKremProvider(s as any);
  await p.fetchSnapshot(addr);
  const snap = await p.fetchSnapshot(addr);
  expect(snap.days[0].slots[12]).toBe('off');
});
test('non-200 → reload and retry once, then ProviderError', async () => {
  const bad = { status: 403, body: '<html>' };
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }, { fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [bad, bad] });
  await expect(new DtekKremProvider(s as any).fetchSnapshot(addr)).rejects.toThrow(ProviderError);
  expect(s.reload).toHaveBeenCalledTimes(1);
});
test('house missing → ProviderError', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }] });
  await expect(new DtekKremProvider(s as any).fetchSnapshot({ ...addr, house: '999' })).rejects.toThrow(/Будинок не знайдено/);
});
test('captcha propagates', async () => {
  const s = fakeSession({}); s.ensureReady.mockRejectedValue(new CaptchaRequiredError('x'));
  await expect(new DtekKremProvider(s as any).fetchSnapshot(addr)).rejects.toBeInstanceOf(CaptchaRequiredError);
});
test('listHouses parses lines', async () => {
  const s = fakeSession({ [READ_FACT]: [{ fact: stale.fact, schNames: stale.preset.sch_names }],
    [getHomeNumScript(C, S, '17.10.2026 11:55')]: [{ status: 200, body: JSON.stringify(stale) }] });
  const houses = await new DtekKremProvider(s as any).listHouses(C, S);
  expect(houses.find(h => h.house === '40')!.lines).toHaveLength(2);
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/providers/dtek-provider.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `page-scripts.ts`, `index.ts`, `registry.ts`** (`getHomeNumScript` — як у прототипі: `URLSearchParams` з `method`, `data[i][name]/[value]`, `fetch('/ua/ajax', { method:'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-CSRF-Token': <meta csrf-token>, 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' })`; значення вставляти через `JSON.stringify`).
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run tests/providers` → PASS.
- [ ] **Step 5: Реалізувати `browser-session.ts` і `smoke-dtek.ts`** — smoke: на `app.whenReady` створити провайдер через `createProviders(o => new BrowserSession(o))`, `fetchSnapshot` для адреси вище, надрукувати `{ sourceUpdatedAt, lines, today: slotRuns(days[0].slots) }`, `app.quit()`.
- [ ] **Step 6: Перевірити наживо.** Run: `npm run build` і `npx electron out/main/smoke-dtek.js` → у виводі `lines` з `GPV1.2`, `GPV4.2` і `sourceUpdatedAt` сьогоднішньої дати; другий запуск помітно швидший (cookies збережені).
- [ ] **Step 7: Commit** — `git add -A && git commit -m "Add hidden-browser session and DTEK KREM provider"`

---

### Task 5: Сховище + RefreshService

**Files:**
- Create: `src/main/store.ts`, `src/main/refresh.ts`
- Test: `tests/main/store.test.ts`, `tests/main/refresh.test.ts`

**Interfaces:**
- Consumes: типи (Task 1), `ScheduleProvider`, `CaptchaRequiredError` (Task 2), `fixtureSnapshot` (Task 3).
- Produces:
```ts
// store.ts
export const DEFAULT_SETTINGS: Settings = { address: null, widgetStyle: 'compact', autostart: true, widgetPosition: null };
export class JsonStore<T> { constructor(filePath: string, defaults: T); read(): T; write(value: T): void } // атомарно: tmp + rename; битий/відсутній файл → defaults
export class AppStore {
  constructor(dir: string);                       // файли settings.json, snapshot.json
  getSettings(): Settings; updateSettings(patch: Partial<Settings>): Settings;
  getSnapshot(): ScheduleSnapshot | null; setSnapshot(s: ScheduleSnapshot): void;
}
// refresh.ts
export class RefreshService {
  constructor(deps: { store: AppStore; getProvider(id: string): ScheduleProvider });
  getState(): AppState;
  refresh(): Promise<boolean>;                 // true = успіх або немає адреси (нема що робити)
  setAddress(a: Address): Promise<void>;       // зберегти, скинути старий знімок, refresh()
  onState(cb: (s: AppState) => void): () => void;
}
```
- `lineChanged = snapshot.lines[address.lineIndex-1]?.groupId !== address.groupId`. Помилка → `phase 'error'`, `lastError = err.message`, знімок не чіпати. `CaptchaRequiredError` → `phase 'captcha'`. Під час запиту — `phase 'refreshing'` (емітити).

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/main/store.test.ts
test('missing file → defaults; round trip; corrupt → defaults; no tmp left', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bw-'));
  const s = new AppStore(dir);
  expect(s.getSettings()).toEqual(DEFAULT_SETTINGS);
  s.updateSettings({ widgetStyle: 'ring' });
  expect(new AppStore(dir).getSettings().widgetStyle).toBe('ring');
  writeFileSync(join(dir, 'settings.json'), '{oops');
  expect(new AppStore(dir).getSettings()).toEqual(DEFAULT_SETTINGS);
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);
});
// tests/main/refresh.test.ts
const addr = fixtureSnapshot().address;
function setup(fetch: () => Promise<ScheduleSnapshot>, opts: { cached?: ScheduleSnapshot } = {}) {
  const store = new AppStore(mkdtempSync(join(tmpdir(), 'bw-')));
  store.updateSettings({ address: addr }); if (opts.cached) store.setSnapshot(opts.cached);
  const provider = { fetchSnapshot: vi.fn(fetch) } as unknown as ScheduleProvider;
  return { store, provider, svc: new RefreshService({ store, getProvider: () => provider }) };
}
test('starts with cached snapshot before any refresh (offline start)', () => {
  const { svc } = setup(async () => { throw new Error('offline'); }, { cached: fixtureSnapshot() });
  expect(svc.getState().snapshot?.sourceUpdatedAt).toBe('17.10.2026 11:55');
});
test('successful refresh saves snapshot, phase ok, emits', async () => {
  const { svc, store } = setup(async () => fixtureSnapshot());
  const seen: string[] = []; svc.onState(s => seen.push(s.phase));
  expect(await svc.refresh()).toBe(true);
  expect(seen).toEqual(['refreshing', 'ok']); expect(store.getSnapshot()).not.toBeNull();
});
test('new sourceUpdatedAt replaces snapshot and emits', async () => {
  let n = 0; const { svc } = setup(async () => fixtureSnapshot({ sourceUpdatedAt: n++ ? '17.10.2026 14:00' : '17.10.2026 11:55' }));
  await svc.refresh(); await svc.refresh();
  expect(svc.getState().snapshot?.sourceUpdatedAt).toBe('17.10.2026 14:00');
});
test('provider error keeps previous snapshot', async () => {
  const { svc } = setup(async () => { throw new ProviderError('Сайт ДТЕК повернув помилку'); }, { cached: fixtureSnapshot() });
  expect(await svc.refresh()).toBe(false);
  expect(svc.getState()).toMatchObject({ phase: 'error', lastError: 'Сайт ДТЕК повернув помилку' });
  expect(svc.getState().snapshot).not.toBeNull();
});
test('captcha → phase captcha', async () => {
  const { svc } = setup(async () => { throw new CaptchaRequiredError('x'); });
  await svc.refresh(); expect(svc.getState().phase).toBe('captcha');
});
test('lineChanged when group under lineIndex differs or line vanished', async () => {
  const swapped = { ...fixtureSnapshot(), lines: [{ index: 1, groupId: 'GPV3.1', label: 'Черга 3.1' }] };
  const a = setup(async () => swapped); await a.svc.refresh(); expect(a.svc.getState().lineChanged).toBe(true);
  const b = setup(async () => ({ ...fixtureSnapshot(), lines: [] })); await b.svc.refresh(); expect(b.svc.getState().lineChanged).toBe(true);
  const c = setup(async () => fixtureSnapshot()); await c.svc.refresh(); expect(c.svc.getState().lineChanged).toBe(false);
});
test('no address → no provider call, returns true, phase idle', async () => {
  const { svc, store, provider } = setup(async () => fixtureSnapshot());
  store.updateSettings({ address: null });
  expect(await svc.refresh()).toBe(true); expect(provider.fetchSnapshot).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main` → FAIL.
- [ ] **Step 3: Реалізувати `store.ts` і `refresh.ts`.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add settings/snapshot store and refresh service"`

---

### Task 6: RefreshScheduler

**Files:**
- Create: `src/main/scheduler.ts`
- Test: `tests/main/scheduler.test.ts`

**Interfaces:**
- Produces:
```ts
export const INTERVAL_MS = 15 * 60_000, JITTER_MS = 60_000, MIN_GAP_MS = 5 * 60_000;
export const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
export type TriggerReason = 'resume' | 'online' | 'manual';
export class RefreshScheduler {
  constructor(run: () => Promise<boolean>, deps?: { random?: () => number }); // таймери — глобальні setTimeout/Date.now (vi.useFakeTimers)
  start(): void; trigger(reason: TriggerReason): void; stop(): void;
}
```
- Після успіху: `INTERVAL_MS + (random()*2 − 1) * JITTER_MS`. Після n-ї невдачі поспіль: `BACKOFF_MS[min(n−1, 4)]`. `resume`/`online`: якщо від початку останнього запуску ≥ `MIN_GAP_MS` — одразу, інакше на `lastStart + MIN_GAP_MS` (якщо раніше за поточний таймер). `manual` — одразу, ігнорує MIN_GAP. Поки `run` виконується — тригери ігноруються.

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/main/scheduler.test.ts
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
const min = 60_000;
test('runs at start, then every 15 min (random 0.5 → no jitter)', async () => {
  const run = vi.fn(async () => true); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
});
test('jitter bounds: random 0 → 14 min, random 1 → 16 min', async () => {
  for (const [r, m] of [[0, 14], [1, 16]] as const) {
    const run = vi.fn(async () => true); const s = new RefreshScheduler(run, { random: () => r }); s.start();
    await vi.advanceTimersByTimeAsync(m * min - 1); expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2); s.stop();
  }
});
test('backoff 1,2,4,8,15,15 min on failures', async () => {
  const run = vi.fn(async () => false); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(0);
  for (const [i, m] of [1, 2, 4, 8, 15, 15].entries()) { await vi.advanceTimersByTimeAsync(m * min); expect(run).toHaveBeenCalledTimes(i + 2); }
});
test('resume within 5 min of last run waits until the 5-min mark; later runs immediately', async () => {
  const run = vi.fn(async () => true); const s = new RefreshScheduler(run, { random: () => 0.5 }); s.start();
  await vi.advanceTimersByTimeAsync(2 * min); s.trigger('resume');
  await vi.advanceTimersByTimeAsync(3 * min - 1); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(run).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(6 * min); s.trigger('online');
  await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(3);
});
test('manual runs immediately even 1 min after a run', async () => {
  const run = vi.fn(async () => true); const s = new RefreshScheduler(run); s.start();
  await vi.advanceTimersByTimeAsync(min); s.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(2);
});
test('no parallel runs', async () => {
  let release!: () => void; const run = vi.fn(() => new Promise<boolean>(r => (release = () => r(true))));
  const s = new RefreshScheduler(run); s.start(); await vi.advanceTimersByTimeAsync(0);
  s.trigger('manual'); s.trigger('manual'); await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1); release();
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/scheduler.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `scheduler.ts`.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add refresh scheduler with jitter, backoff and trigger gap"`

---

### Task 7: Оболонка застосунку — IPC, preload, bootstrap, трей, автозапуск

**Files:**
- Create: `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/main/tray-menu.ts`, `src/main/tray.ts`, `src/main/main-window.ts`, `scripts/gen-tray-icons.mjs`, `resources/tray/*.png`
- Modify: `src/main/index.ts` (повна заміна тимчасового), `src/preload/index.ts`
- Test: `tests/main/tray-menu.test.ts`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces (`src/shared/ipc.ts`):
```ts
export const IPC = {
  getState: 'state:get', state: 'state:changed', background: 'widget:background',
  listProviders: 'providers:list', listCities: 'addr:cities', listStreets: 'addr:streets', listHouses: 'addr:houses',
  previewLines: 'addr:preview-lines', saveAddress: 'settings:address', setWidgetStyle: 'settings:style',
  setAutostart: 'settings:autostart', refreshNow: 'refresh:now', solveCaptcha: 'captcha:solve',
  openMainWindow: 'window:open-main', widgetContextMenu: 'widget:context-menu', widgetDrag: 'widget:drag',
} as const;
export type MainView = 'schedule' | 'settings' | 'setup';
export interface RendererApi {
  getState(): Promise<AppState>; onState(cb: (s: AppState) => void): () => void;
  onBackground(cb: (b: WidgetBackground) => void): () => void;
  listProviders(): Promise<{ id: string; displayName: string }[]>;
  listCities(providerId: string): Promise<string[]>;
  listStreets(providerId: string, city: string): Promise<string[]>;
  listHouses(providerId: string, city: string, street: string): Promise<HouseInfo[]>;
  previewLines(providerId: string, city: string, street: string, house: string): Promise<{ line: LineInfo; today: DaySchedule | null }[]>;
  saveAddress(a: Address): Promise<void>; setWidgetStyle(s: WidgetStyle): Promise<void>; setAutostart(on: boolean): Promise<void>;
  refreshNow(): Promise<void>; solveCaptcha(): Promise<void>;
  openMainWindow(view?: MainView): void; widgetContextMenu(): void;
  widgetDrag(phase: 'start' | 'move' | 'end', screenX: number, screenY: number): void;
}
declare global { interface Window { api: RendererApi } }
```
- Produces (`src/main/tray-menu.ts`):
```ts
export interface TrayActions { showSchedule(): void; refreshNow(): void; setStyle(s: WidgetStyle): void; moveWidget(): void; openSettings(): void; toggleAutostart(): void; solveCaptcha(): void; quit(): void }
export function buildTrayMenu(state: AppState, a: TrayActions): MenuItemConstructorOptions[]; // import type з electron
export function trayTooltip(view: WidgetView | null): string;      // null → 'Графік відключень — налаштуйте адресу'; інакше `${title} · ${nextText}`
export function trayIconName(view: WidgetView | null): 'on' | 'off' | 'emergency' | 'unknown';
```
- `main-window.ts`: `export class MainWindow { constructor(preload: string); open(view?: MainView): void }` — 900×640, `title: 'Графік відключень'`, на win32 `backgroundMaterial: 'mica'`; закриття ховає вікно (застосунок живе в треї); `open(view)` шле в renderer `view` через query-параметр або IPC.
- `previewLines`: `listHouses` → лінії будинку → для кожної `fetchSnapshot({...addr, lineIndex, groupId})` → `{ line, today: days.find(d => d.date === kyivDateKey(new Date())) ?? null }`.

**Bootstrap (`index.ts`):** `requestSingleInstanceLock` (другий запуск → `mainWindow.open()`); `app.setAppUserModelId('ua.blackoutwidget.app')`; не виходити на `window-all-closed`; `AppStore(app.getPath('userData'))`; `createProviders(o => new BrowserSession(o))`; `RefreshService`; `RefreshScheduler(() => service.refresh())` → `start()`; `powerMonitor.on('resume') → trigger('resume')`; `net.isOnline()` поллінг кожні 30 с, перехід false→true → `trigger('online')`; `app.setLoginItemSettings({ openAtLogin: settings.autostart })` при старті й при зміні; `solveCaptcha` → `await provider.showVerification()` → `scheduler.trigger('manual')`; `refreshNow` → `scheduler.trigger('manual')`; кожну хвилину й на кожен `state` — оновити іконку/підказку трею через `computeWidgetView`; без адреси — `mainWindow.open('setup')`. Віджет підключається в Task 10.

- [ ] **Step 1: Написати падаючі тести меню трею**

```ts
// tests/main/tray-menu.test.ts
const noop = () => {}; const actions = { showSchedule: noop, refreshNow: noop, setStyle: noop, moveWidget: noop, openSettings: noop, toggleAutostart: noop, solveCaptcha: noop, quit: noop };
const state = (p: Partial<AppState> = {}): AppState => ({ settings: { ...DEFAULT_SETTINGS, widgetStyle: 'ring' }, snapshot: null, phase: 'ok', lineChanged: false, ...p });
test('menu order and checked items', () => {
  const m = buildTrayMenu(state(), actions);
  expect(m.filter(i => i.type !== 'separator').map(i => i.label)).toEqual(
    ['Показати графік', 'Оновити зараз', 'Стиль віджета', 'Перемістити віджет', 'Налаштування', 'Автозапуск', 'Вийти']);
  const style = m.find(i => i.label === 'Стиль віджета')!.submenu as MenuItemConstructorOptions[];
  expect(style.map(i => [i.label, i.checked])).toEqual([['Компакт', false], ['Циферблат', true], ['Таймлайн', false]]);
  expect(m.find(i => i.label === 'Автозапуск')!.checked).toBe(true);
});
test('captcha phase puts verification first', () =>
  expect(buildTrayMenu(state({ phase: 'captcha' }), actions)[0].label).toBe('Пройти перевірку'));
test('tooltip and icon', () => {
  expect(trayTooltip(null)).toBe('Графік відключень — налаштуйте адресу');
  const v = computeWidgetView(fixtureSnapshot(), new Date('2026-10-17T08:50:00Z'));
  expect(trayTooltip(v)).toBe('Світло є · Вимкнення о 15:00 · через 3 год 10 хв');
  expect(trayIconName(v)).toBe('on'); expect(trayIconName(null)).toBe('unknown');
  expect(trayIconName({ ...v, state: 'maybe-off' })).toBe('off'); expect(trayIconName({ ...v, state: 'emergency' })).toBe('emergency');
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/tray-menu.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `ipc.ts` (shared), `tray-menu.ts`.** Тести → PASS.
- [ ] **Step 4: Іконки трею.** `scripts/gen-tray-icons.mjs` малює 32×32 заповнені кола з антиаліасингом і пише PNG (zlib, без залежностей): on `#3ddc84`, off `#ff9f2a`, emergency `#ff4d4f`, unknown `#9aa0a6`. Run: `node scripts/gen-tray-icons.mjs` → 4 файли в `resources/tray/`.
- [ ] **Step 5: Реалізувати preload, `main/ipc.ts` (`registerIpc(deps)`), `tray.ts`, `main-window.ts`, `index.ts`.** Renderer головного вікна поки показує заглушку з `view`.
- [ ] **Step 6: Ручна перевірка.** Run: `npm run typecheck && npm run dev` → з'являється іконка в треї (сіра), меню з пунктами як у тесті; без адреси відкривається головне вікно; «Вийти» закриває застосунок; другий запуск `npm run dev` під час роботи не створює другої іконки.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "Add app shell: IPC contract, preload, tray and autostart"`

---

### Task 8: Головне вікно — майстер, графік, налаштування

**Files:**
- Create: `src/renderer/src/app/{App.tsx,SetupWizard.tsx,Autocomplete.tsx,ScheduleView.tsx,SettingsView.tsx,app.css}`; Modify: `src/renderer/src/app/main.tsx`
- Test: `tests/renderer/setup-wizard.test.tsx`, `tests/renderer/schedule-view.test.tsx`

**Interfaces:**
- Consumes: `RendererApi`, `MainView` (Task 7), `computeWidgetView`, `formatHM`, `formatDM` (Tasks 1, 3); `DayBar` **не** використовувати звідси — у вікні своя сітка.
- Produces: `SetupWizard({ api, onDone }: { api: RendererApi; onDone(): void })`, `ScheduleView({ state, now, api }: { state: AppState; now: Date; api: RendererApi })`, `SettingsView({ state, api, onChangeAddress }: { state: AppState; api: RendererApi; onChangeAddress(): void })`, `App` (обирає view: немає адреси або `view==='setup'` → майстер; інакше вкладки «Графік» / «Налаштування»).

**Майстер (кроки й тексти):** «Компанія» (список `listProviders`, вибраний перший) → «Населений пункт» (`Autocomplete` по `listCities`: регістронезалежний пошук підрядка, до 50 варіантів; порожній запит показує перші 50) → «Вулиця» (`listStreets`) → «Будинок» (`listHouses`; 0 ліній → текст `Для цього будинку ДТЕК не публікує графік відключень` і кнопка «Далі» неактивна) → «Лінія» (лише якщо ліній 2: дві картки `Лінія N · Черга X.Y` з 24-годинною смужкою сьогодні з `previewLines`, підказка `Звірте з сайтом ДТЕК, якщо не впевнені`) → «Стиль віджета» (Компакт / Циферблат / Таймлайн) → «Готово» → `saveAddress` + `setWidgetStyle` → `onDone()`. Кнопки «Назад» / «Далі».
**Графік:** вкладки `Сьогодні DD.MM` / `Завтра DD.MM`; 24 колонки `00-01`…`23-24` з половинками (класи `on/off/maybe/unknown`); рядок `Оновлено о HH:MM · графік ДТЕК від {sourceUpdatedAt}`; банери: аварійне (`outageBadge` + текст), `Схема підключення змінилась — перевірте лінію` (кнопка → майстер), капча (`Сайт ДТЕК просить пройти перевірку` + кнопка `Пройти перевірку` → `api.solveCaptcha()`), помилка (`Не вдалося оновити: {lastError}`). Немає завтра → `Графік на завтра ще не опубліковано`.
**Налаштування:** адреса одним рядком + «Змінити адресу»; стиль (радіо); `Запускати разом із системою` (перемикач → `setAutostart`); «Оновити зараз».

- [ ] **Step 1: Написати падаючі тести**

```tsx
// tests/renderer/setup-wizard.test.tsx
// @vitest-environment jsdom
function mockApi(houses: HouseInfo[]) {
  return { listProviders: vi.fn(async () => [{ id: 'dtek-krem', displayName: 'ДТЕК Київські регіональні електромережі' }]),
    listCities: vi.fn(async () => ['м. Біла Церква', 'с-ще Козин']), listStreets: vi.fn(async () => ['бул. Грушевського Михайла']),
    listHouses: vi.fn(async () => houses),
    previewLines: vi.fn(async () => houses[0].lines.map(line => ({ line, today: fixtureSnapshot().days[0] }))),
    saveAddress: vi.fn(async () => {}), setWidgetStyle: vi.fn(async () => {}) } as unknown as RendererApi;
}
const two = [{ house: '40', lines: [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }, { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' }] }];
async function pickAddress(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  await user.type(await screen.findByRole('combobox', { name: 'Населений пункт' }), 'Біла');
  expect(screen.queryByText('с-ще Козин')).toBeNull();
  await user.click(screen.getByText('м. Біла Церква')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('бул. Грушевського Михайла')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('40'));
}
test('two lines: shows both previews and saves chosen line', async () => {
  const api = mockApi(two); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={onDone} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · Черга 1.2')).toBeInTheDocument(); expect(screen.getByText('Лінія 2 · Черга 4.2')).toBeInTheDocument();
  await user.click(screen.getByText('Лінія 1 · Черга 1.2')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(screen.getByText('Таймлайн')); await user.click(screen.getByRole('button', { name: 'Готово' }));
  expect(api.saveAddress).toHaveBeenCalledWith({ providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' });
  expect(api.setWidgetStyle).toHaveBeenCalledWith('timeline'); expect(onDone).toHaveBeenCalled();
});
test('one line: skips line step', async () => {
  const api = mockApi([{ house: '40', lines: [two[0].lines[0]] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Компакт')).toBeInTheDocument(); expect(api.previewLines).not.toHaveBeenCalled();
});
test('no lines: explains and blocks', async () => {
  const api = mockApi([{ house: '40', lines: [] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
// tests/renderer/schedule-view.test.tsx
// @vitest-environment jsdom
test('shows source time and unpublished tomorrow', async () => {
  const state: AppState = { settings: { ...DEFAULT_SETTINGS, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false };
  render(<ScheduleView state={state} now={new Date('2026-10-17T08:50:00Z')} api={{} as RendererApi} />);
  expect(screen.getByText('Оновлено о 11:48 · графік ДТЕК від 17.10.2026 11:55')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Завтра 18.10' }));
  expect(screen.getByText('Графік на завтра ще не опубліковано')).toBeInTheDocument();
});
test('captcha banner calls solveCaptcha', async () => {
  const api = { solveCaptcha: vi.fn(async () => {}) } as unknown as RendererApi;
  render(<ScheduleView state={{ settings: DEFAULT_SETTINGS, snapshot: fixtureSnapshot(), phase: 'captcha', lineChanged: false }} now={new Date('2026-10-17T08:50:00Z')} api={api} />);
  await userEvent.click(screen.getByRole('button', { name: 'Пройти перевірку' })); expect(api.solveCaptcha).toHaveBeenCalled();
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/renderer` → FAIL.
- [ ] **Step 3: Реалізувати компоненти** (`Autocomplete` — `input role="combobox"` з `aria-label`, список варіантів-кнопок). Стиль — у дусі макетів (скло, Segoe UI Variable), фон прозорий над Mica.
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run` → PASS.
- [ ] **Step 5: Ручна перевірка.** Run: `npm run dev` → пройти майстер для м. Біла Церква / бул. Грушевського Михайла / 40 / Лінія 1 → вкладка «Графік» показує 06:00–08:30 і 15:00–19:00 як на сайті (або актуальні значення сайту на сьогодні).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "Add setup wizard, schedule and settings views"`

---

### Task 9: UI віджета — три стилі

**Files:**
- Create: `src/renderer/src/widget/{Widget.tsx,CompactWidget.tsx,RingWidget.tsx,TimelineWidget.tsx,DayBar.tsx,OutageBadge.tsx,WidgetRoot.tsx,widget.css}`; Modify: `src/renderer/src/widget/main.tsx`
- Test: `tests/renderer/widget.test.tsx`

**Interfaces:**
- Consumes: `computeWidgetView`, `slotRuns`, `WidgetView` (Task 3), `RendererApi` (Task 7), `WidgetBackground` (Task 1).
- Produces: `Widget({ state, now, background }: { state: AppState; now: Date; background: WidgetBackground })` — чисто презентаційний; `DayBar({ day, nowFraction }: { day: DaySchedule | null; nowFraction?: number })`; `WidgetRoot` — підписка `api.getState/onState/onBackground`, годинник на межі хвилини (`setTimeout` до наступної хвилини, далі щохвилини), рендерить `Widget`.

**Вигляд:** точно за `docs/superpowers/specs/assets/2026-10-17-widget-styles.html` (кольори, радіуси 22px, шрифт, світла рамка). Фон: `background.kind==='image'` → шар з `background-image`, `filter: blur(18px) saturate(160%)`, `inset: -30px`; поверх тонування (темна тема `rgba(20,22,40,.28)`, світла `rgba(255,255,255,.16)` через `prefers-color-scheme`); `tint` → лише тонування `rgba(30,30,60,.45)` / світла `rgba(245,245,250,.55)`. Півгодинки — `DayBar` з 48 половинок (`on/off/maybe/unknown`, `maybe` — штрихований бурштин); `day === null` → штриховка + підпис `ще не опубліковано`. Ring — SVG за `slotRuns` (дуги `off` і `maybe-off`), біла точка в `nowFraction`. Без адреси (`settings.address === null`) → `Налаштуйте адресу` (картка поточного стилю). Стан `emergency` → `OutageBadge` з текстом `outageBadge` і червоний індикатор. `stale` → у підписі ` · дані застаріли` попереджувальним кольором. `lineChanged` → рядок `Схема підключення змінилась — перевірте лінію`.

- [ ] **Step 1: Написати падаючі тести**

```tsx
// tests/renderer/widget.test.tsx
// @vitest-environment jsdom
const now = new Date('2026-10-17T08:50:00Z');
const st = (p: Partial<AppState> = {}, style: WidgetStyle = 'compact'): AppState =>
  ({ settings: { ...DEFAULT_SETTINGS, widgetStyle: style, address: fixtureSnapshot().address }, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...p });
test.each(['compact', 'ring', 'timeline'] as const)('%s shows status and countdown', style => {
  render(<Widget state={st({}, style)} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Світло є')).toBeInTheDocument();
  expect(screen.getByText(style === 'compact' ? 'Вимкнення о 15:00 · через 3 год 10 хв' : '3:10')).toBeInTheDocument();
});
test('compact caption', () => {
  render(<Widget state={st()} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Лінія 1 · черга 1.2 · оновлено 11:48')).toBeInTheDocument();
});
test('timeline: tomorrow not published', () => {
  render(<Widget state={st({}, 'timeline')} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('ще не опубліковано')).toBeInTheDocument(); expect(screen.getByText('Завтра 18.10')).toBeInTheDocument();
});
test('DayBar renders 48 halves with off at 12..16', () => {
  const { container } = render(<DayBar day={fixtureSnapshot().days[0]} />);
  const halves = container.querySelectorAll('[data-slot]'); expect(halves).toHaveLength(48);
  expect(halves[12].getAttribute('data-slot')).toBe('off'); expect(halves[17].getAttribute('data-slot')).toBe('on');
});
test('emergency badge', () => {
  const s = st({ snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварійне відключення' } }) });
  render(<Widget state={s} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Аварійне')).toBeInTheDocument(); expect(screen.getByText('Світла немає')).toBeInTheDocument();
});
test('stale, line changed, no address', () => {
  const { rerender } = render(<Widget state={st()} now={new Date('2026-10-17T09:40:00Z')} background={{ kind: 'tint' }} />);
  expect(screen.getByText(/дані застаріли/)).toBeInTheDocument();
  rerender(<Widget state={st({ lineChanged: true })} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Схема підключення змінилась — перевірте лінію')).toBeInTheDocument();
  rerender(<Widget state={{ ...st(), settings: DEFAULT_SETTINGS, snapshot: null }} now={now} background={{ kind: 'tint' }} />);
  expect(screen.getByText('Налаштуйте адресу')).toBeInTheDocument();
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/renderer/widget.test.tsx` → FAIL.
- [ ] **Step 3: Реалізувати компоненти.**
- [ ] **Step 4: Тести зелені.** Run: `npx vitest run` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "Add widget UI in compact, ring and timeline styles"`

---

### Task 10: Вікно віджета, жести, прикріплення до столу (Windows), режим переміщення

**Files:**
- Create: `src/main/widget/{widget-window.ts,position.ts,desktop-pin.ts,pin-win32.ts}`, `src/renderer/src/widget/usePointerGestures.ts`
- Modify: `src/main/index.ts`, `src/main/ipc.ts`, `src/main/tray.ts` (пункт «Перемістити віджет»), `src/renderer/src/widget/WidgetRoot.tsx`
- Test: `tests/main/position.test.ts`, `tests/renderer/pointer.test.tsx`

**Interfaces:**
- Consumes: `AppStore` (Task 5), `RendererApi.widgetDrag/openMainWindow/widgetContextMenu` (Task 7), `WIDGET_SIZES` нижче.
- Produces:
```ts
// position.ts (чистий)
export const WIDGET_SIZES: Record<WidgetStyle, { width: number; height: number }> = { compact: { width: 290, height: 150 }, ring: { width: 236, height: 260 }, timeline: { width: 400, height: 200 } };
export interface DisplayLike { id: number; workArea: { x: number; y: number; width: number; height: number } }
export function placeWidget(pos: WidgetPosition | null, size: { width: number; height: number }, displays: DisplayLike[], primaryId: number): WidgetPosition;
// desktop-pin.ts
export interface DesktopPinner { pin(win: BrowserWindow): void; unpin(win: BrowserWindow): void; setBounds(win: BrowserWindow, rect: Rectangle /* DIP */): void; readonly pinned: boolean; dispose(): void }
export function createDesktopPinner(): DesktopPinner;   // win32 → Win32DesktopPinner, інакше NoopPinner (setBounds = win.setBounds)
// widget-window.ts
export class WidgetWindow {
  constructor(deps: { store: AppStore; pinner: DesktopPinner; preload: string; onClick(): void; onContextMenu(): void });
  show(): void; setStyle(style: WidgetStyle): void; send(channel: string, payload: unknown): void;
  drag(phase: 'start' | 'move' | 'end', screenX: number, screenY: number): void;
  beginMoveMode(): void; endMoveMode(): void; getBoundsDip(): Rectangle; onMoved(cb: () => void): void;
}
// usePointerGestures.ts
export function usePointerGestures(api: Pick<RendererApi, 'widgetDrag' | 'openMainWindow' | 'widgetContextMenu'>): { onPointerDown; onPointerMove; onPointerUp; onContextMenu };
```
- `placeWidget`: `null` або невідомий `displayId` → правий верхній кут робочої області основного дисплея з відступом 24; інакше обмежити так, щоб вікно повністю було в `workArea` свого дисплея.
- Жести: ЛКМ без зсуву > 4 px → `openMainWindow('schedule')`; зсув > 4 px → `widgetDrag('start', …)`, далі `move`, на відпусканні `end` (без кліку); `pointer capture`; ПКМ (`contextmenu`) → `widgetContextMenu()`. Main: нова позиція = позиція на `start` + (screen − screenНаStart) у DIP → `pinner.setBounds`; на `end` → `placeWidget` і зберегти `widgetPosition` → `onMoved`.
- Вікно: `frame:false, transparent:true, resizable:false, skipTaskbar:true, focusable:true, hasShadow:false`, розмір з `WIDGET_SIZES`, контент `widget.html`. Після `ready-to-show` → `pinner.pin(win)`.
- `Win32DesktopPinner` (koffi, `user32.dll`): `pin` — `FindWindowW('Progman')`, `SendMessageTimeoutW(progman, 0x052C, 0xD, 0x1, 0, 1000)`, `SetParent(hwnd, progman)` (hwnd = `win.getNativeWindowHandle().readBigUInt64LE(0)`, оголосити як `uintptr`), потім `setBounds`. `setBounds` для прикріпленого: `screen.dipToScreenRect(null, rect)` → відняти лівий верхній кут `GetWindowRect(progman)` → `SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOZORDER|SWP_NOACTIVATE)`. Кожні 5 с: якщо `!IsWindow(progman)` або `GetParent(hwnd) !== поточний Progman` → перепрікріпити (перезапуск explorer). `unpin` — `SetParent(hwnd, 0)` + `win.setBounds`.
- Режим переміщення (трей «Перемістити віджет» / «Завершити переміщення»): `unpin`, `setAlwaysOnTop(true)`, у віджеті рамка-підсвітка і кнопка `Готово` (→ `endMoveMode`: зберегти позицію, `setAlwaysOnTop(false)`, `pin`). Доступний завжди — це запасний шлях §7.3.
- Контекстне меню віджета: `Стиль ▸ (Компакт/Циферблат/Таймлайн)`, `Оновити зараз`, `Налаштування`, `Вийти`.

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/main/position.test.ts
const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1000 } };
const size = WIDGET_SIZES.compact;
test('default: top-right of primary with 24px margin', () =>
  expect(placeWidget(null, size, [primary, second], 1)).toEqual({ x: 1920 - 290 - 24, y: 24, displayId: 1 }));
test('unknown display → default', () =>
  expect(placeWidget({ x: 5000, y: 10, displayId: 9 }, size, [primary], 1)).toEqual({ x: 1606, y: 24, displayId: 1 }));
test('clamped into its display work area', () =>
  expect(placeWidget({ x: 3100, y: 950, displayId: 2 }, size, [primary, second], 1)).toEqual({ x: 1920 + 1280 - 290, y: 1000 - 150, displayId: 2 }));
// tests/renderer/pointer.test.tsx
// @vitest-environment jsdom
function Harness({ api }: { api: any }) { const h = usePointerGestures(api); return <div data-testid="w" {...h} />; }
const mk = () => ({ widgetDrag: vi.fn(), openMainWindow: vi.fn(), widgetContextMenu: vi.fn() });
test('click opens main window', () => {
  const api = mk(); render(<Harness api={api} />); const w = screen.getByTestId('w');
  fireEvent.pointerDown(w, { button: 0, screenX: 100, screenY: 100, pointerId: 1 }); fireEvent.pointerUp(w, { button: 0, screenX: 101, screenY: 100, pointerId: 1 });
  expect(api.openMainWindow).toHaveBeenCalledWith('schedule'); expect(api.widgetDrag).not.toHaveBeenCalled();
});
test('drag beyond 4px sends start/move/end and no click', () => {
  const api = mk(); render(<Harness api={api} />); const w = screen.getByTestId('w');
  fireEvent.pointerDown(w, { button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  fireEvent.pointerMove(w, { screenX: 110, screenY: 100, pointerId: 1 }); fireEvent.pointerUp(w, { button: 0, screenX: 110, screenY: 100, pointerId: 1 });
  expect(api.widgetDrag.mock.calls.map((c: any[]) => c[0])).toEqual(['start', 'move', 'end']); expect(api.openMainWindow).not.toHaveBeenCalled();
});
test('right click opens context menu', () => {
  const api = mk(); render(<Harness api={api} />); fireEvent.contextMenu(screen.getByTestId('w'));
  expect(api.widgetContextMenu).toHaveBeenCalled();
});
```
(У jsdom `setPointerCapture` може бути відсутній — викликати лише якщо існує.)

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/position.test.ts tests/renderer/pointer.test.tsx` → FAIL.
- [ ] **Step 3: Реалізувати `position.ts`, `usePointerGestures.ts`.** Тести → PASS.
- [ ] **Step 4: Реалізувати `desktop-pin.ts`, `pin-win32.ts`, `widget-window.ts`, підключити в `index.ts`/`ipc.ts`/`tray.ts`.** Стиль з налаштувань → розмір вікна змінюється при `setWidgetStyle`.
- [ ] **Step 5: Ручна перевірка на Windows 11 (записати результати в опис коміту)**

Run: `npm run dev`, потім:
1. Віджет у правому верхньому куті; інші вікна його перекривають.
2. Win+D → віджет лишається видимим.
3. ЛКМ → відкривається головне вікно; перетягування → віджет їде за курсором; ПКМ → контекстне меню. **Якщо щось із трьох не працює на прикріпленому вікні** — не боротися довше за таймбокс 2 год: залишити режим переміщення з трею як основний шлях і записати обмеження в README (розділ «Відомі обмеження»), §7.3.
4. Перезапуск: `taskkill /f /im explorer.exe` і `start explorer.exe` → віджет з'являється знову ≤ 10 с.
5. Перезапуск застосунку → позиція та стиль збережені.
6. «Перемістити віджет» з трею → перетягнути → «Готово» → віджет знову прикріплений (перевірити Win+D).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "Pin widget window to the Windows desktop with drag, click and move mode"` (тіло — результати чек-листа).

---

### Task 11: Імітація скла зі шпалер (Windows)

**Files:**
- Create: `src/main/widget/glass.ts`, `src/main/widget/wallpaper-parse.ts`, `src/main/widget/wallpaper-win32.ts`
- Modify: `src/main/index.ts` (підключити оновлення фону), `src/main/widget/widget-window.ts` (подія `onMoved` вже є)
- Test: `tests/main/glass.test.ts`, `tests/main/wallpaper-parse.test.ts`

**Interfaces:**
- Consumes: `WidgetWindow.getBoundsDip/onMoved/send`, `IPC.background`, `WidgetBackground` (Tasks 1, 7, 10).
- Produces:
```ts
// wallpaper-parse.ts (чистий)
export type WallpaperStyle = 'fill' | 'fit' | 'stretch' | 'tile' | 'center' | 'span';
export function parseRegQuery(output: string): Record<string, string>;
export function toWallpaperStyle(wallpaperStyle: string | undefined, tile: string | undefined): WallpaperStyle; // 10 fill, 6 fit, 2 stretch, 22 span, 0+tile=1 tile, 0 center; інше → fill
// glass.ts (чистий)
export interface Rect { x: number; y: number; width: number; height: number }
export function computeCrop(img: { width: number; height: number }, style: WallpaperStyle, monitor: Rect, virtual: Rect, widget: Rect): Rect | null; // усе у фізичних px; null → тонування
// wallpaper-win32.ts (Node, без electron)
export function readWallpaper(): Promise<{ path: string; style: WallpaperStyle } | null>; // execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop'])
```
- `computeCrop`: fill — `s = max(mw/iw, mh/ih)`, зсув `(m − i·s)/2`; fit — `s = min(…)`, якщо віджет повністю поза зображенням → `null`, інакше обрізати до перетину; stretch — окремі масштаби по осях; center — `s = 1`, зсув `(m − i)/2`; span — як fill, але відносно `virtual`; tile — `s = 1`, верхній лівий кут по модулю розміру зображення (без зшивання країв). Результат — у координатах зображення, обрізаний до його меж.
- `readWallpaper`: `WallPaper` порожній або файл відсутній → спробувати `%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper`; нічого → `null`. Одні шпалери на всі монітори (окремі шпалери на моніторах не підтримуємо — *моє рішення*, у такому разі буде неточний виріз).
- У `index.ts` (лише win32): `updateGlass()` — `readWallpaper()` → `nativeImage.createFromPath(path)` → монітор віджета (`screen.getDisplayMatching`) і віртуальний екран (об'єднання всіх дисплеїв) у фізичних px через `screen.dipToScreenRect` → `computeCrop` → `image.crop(rounded).resize({ width: round(widget.width/2) })` → `send(IPC.background, { kind: 'image', dataUrl })`; будь-яка помилка або `null` → `{ kind: 'tint' }`. Викликати: після показу віджета, після `onMoved`, на `screen` `display-metrics-changed`/`display-added`/`display-removed`, і кожні 60 с, якщо змінився `path`, `style` або `mtime` файлу.

- [ ] **Step 1: Написати падаючі тести**

```ts
// tests/main/wallpaper-parse.test.ts
const out = `\r\nHKEY_CURRENT_USER\\Control Panel\\Desktop\r\n    WallPaper    REG_SZ    C:\\Users\\me\\Pictures\\wall.jpg\r\n    WallpaperStyle    REG_SZ    10\r\n    TileWallpaper    REG_SZ    0\r\n`;
test('parseRegQuery', () => expect(parseRegQuery(out)).toMatchObject({ WallPaper: 'C:\\Users\\me\\Pictures\\wall.jpg', WallpaperStyle: '10', TileWallpaper: '0' }));
test('toWallpaperStyle', () => {
  expect(toWallpaperStyle('10', '0')).toBe('fill'); expect(toWallpaperStyle('6', '0')).toBe('fit'); expect(toWallpaperStyle('2', '0')).toBe('stretch');
  expect(toWallpaperStyle('22', '0')).toBe('span'); expect(toWallpaperStyle('0', '1')).toBe('tile'); expect(toWallpaperStyle('0', '0')).toBe('center');
  expect(toWallpaperStyle(undefined, undefined)).toBe('fill');
});
// tests/main/glass.test.ts
const mon = { x: 0, y: 0, width: 2560, height: 1440 };
const expectRect = (a: Rect | null, e: Rect) => { expect(a).not.toBeNull(); for (const k of ['x', 'y', 'width', 'height'] as const) expect(a![k]).toBeCloseTo(e[k], 6); };
test('fill, same aspect', () =>
  expectRect(computeCrop({ width: 1920, height: 1080 }, 'fill', mon, mon, { x: 100, y: 100, width: 290, height: 150 }), { x: 75, y: 75, width: 217.5, height: 112.5 }));
test('fill, square image on 16:9 crops vertically', () => {
  const m = { x: 0, y: 0, width: 1920, height: 1080 };
  expectRect(computeCrop({ width: 1000, height: 1000 }, 'fill', m, m, { x: 0, y: 0, width: 192, height: 108 }), { x: 0, y: 218.75, width: 100, height: 56.25 });
});
test('stretch', () =>
  expectRect(computeCrop({ width: 1280, height: 720 }, 'stretch', mon, mon, { x: 0, y: 0, width: 256, height: 144 }), { x: 0, y: 0, width: 128, height: 72 }));
test('center', () => {
  const m = { x: 0, y: 0, width: 1920, height: 1080 };
  expectRect(computeCrop({ width: 1000, height: 500 }, 'center', m, m, { x: 460, y: 290, width: 100, height: 50 }), { x: 0, y: 0, width: 100, height: 50 });
});
test('fit: widget in letterbox → null', () => {
  const m = { x: 0, y: 0, width: 1920, height: 1080 };
  expect(computeCrop({ width: 1000, height: 1000 }, 'fit', m, m, { x: 0, y: 0, width: 200, height: 100 })).toBeNull();
});
test('second monitor offsets are relative to that monitor', () => {
  const m2 = { x: 2560, y: 0, width: 2560, height: 1440 };
  expectRect(computeCrop({ width: 1920, height: 1080 }, 'fill', m2, { x: 0, y: 0, width: 5120, height: 1440 }, { x: 2660, y: 100, width: 290, height: 150 }),
    { x: 75, y: 75, width: 217.5, height: 112.5 });
});
test('span uses the virtual screen', () => {
  const virt = { x: 0, y: 0, width: 5120, height: 1440 };
  expectRect(computeCrop({ width: 5120, height: 1440 }, 'span', { x: 2560, y: 0, width: 2560, height: 1440 }, virt, { x: 2660, y: 100, width: 290, height: 150 }),
    { x: 2660, y: 100, width: 290, height: 150 });
});
```

- [ ] **Step 2: Запустити — має впасти.** Run: `npx vitest run tests/main/glass.test.ts tests/main/wallpaper-parse.test.ts` → FAIL.
- [ ] **Step 3: Реалізувати `wallpaper-parse.ts`, `glass.ts`.** Тести → PASS.
- [ ] **Step 4: Реалізувати `wallpaper-win32.ts` і `updateGlass()` у `index.ts`.**
- [ ] **Step 5: Ручна перевірка.** Run: `npm run dev` → фон віджета — розмита ділянка саме тих шпалер, що під ним (порівняти, сховавши віджет через «Перемістити»); перетягнути в інше місце → фон оновився; змінити шпалери в Параметрах Windows → фон оновився ≤ 60 с; однотонні шпалери / Spotlight → акуратне тонування без артефактів; темна й світла тема Windows.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "Simulate glass behind the pinned widget from the desktop wallpaper"`

---

### Task 12: Інсталятор Windows + README

**Files:**
- Create: `electron-builder.yml`, `README.md`
- Modify: `package.json` (script `dist:win`)

**Interfaces:**
- Consumes: збірка `out/` (Tasks 1–11).
- Produces: `dist/*Setup*.exe`.

- [ ] **Step 1: Налаштувати electron-builder**

`electron-builder.yml`: `appId: ua.blackoutwidget.app`, `productName: Blackout Widget` *(моє рішення — у спеці назви не було; UI-заголовки українською)*, `directories.output: dist`, `files: [out/**, resources/**, package.json]`, `asarUnpack: ['**/node_modules/koffi/**']` (нативні бінарники koffi не працюють з asar), `extraResources: [{ from: resources/tray, to: tray }]` (іконки трею брати з `process.resourcesPath/tray` у prod, з `resources/tray` у dev), `win.target: [{ target: nsis, arch: [x64] }]`, `nsis: { oneClick: true, perMachine: false }`. Script: `"dist:win": "electron-vite build && electron-builder --win --x64"`.

- [ ] **Step 2: Зібрати.** Run: `npm run dist:win` → у `dist/` є `Blackout Widget Setup <version>.exe`.

- [ ] **Step 3: README.md** — розділи: що це; розробка (`npm i`, `npm run dev`, `npm test`, `npm run build`, smoke `npx electron out/main/smoke-dtek.js`); збірка `npm run dist:win`; перше встановлення на Windows: SmartScreen → «Докладніше» → «Виконати все одно»; як додати нове джерело (реалізувати `ScheduleProvider` у `src/main/providers/<id>/`, зареєструвати в `registry.ts`, додати фікстури й тести за зразком dtek-krem); «Відомі обмеження» (з Task 10, якщо є; окремі шпалери на різних моніторах не підтримуються); macOS — «буде у віхі 2».

- [ ] **Step 4: Перевірка інсталятора.** Встановити `.exe` → застосунок стартує → майстер → віджет; `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run` містить запис застосунку (автозапуск); вимкнути автозапуск у налаштуваннях → запис зникає; перезавантаження Windows → віджет на місці з даними; пройти чек-лист Task 10 (п. 2–5) на встановленій версії.

- [ ] **Step 5: Повний прогін.** Run: `npm test && npm run typecheck` → PASS без помилок.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "Add Windows installer config and README"`
