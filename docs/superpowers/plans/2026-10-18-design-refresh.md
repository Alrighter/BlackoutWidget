# Оновлення дизайну за макетами Claude Design — план реалізації

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Привести віджет (3 стилі, світла й темна теми, усі стани), головне вікно (Графік, Налаштування, панель EcoFlow), майстер першого запуску, трей і режим переміщення у відповідність до макетів користувача.

**Architecture:**
- Візуальне джерело правди — вихідники макетів у `docs/superpowers/specs/assets/design-2026-10-18/`. Це шаблони Claude Design: розмітка з інлайн-стилями і `{{змінними}}`, а в кінці `<script type="text/x-dc">` з точними токенами тем (`THEMES`) і сценаріями. Рендери макетів (PNG-плитки) лежать у `.superpowers/design-refresh/renders/` (git-ignored).
- Токени переносяться в один CSS-файл зі змінними `--bw-*` для обох тем і в TS-модуль для SVG.
- Поведінка застосунку не змінюється, змінюються розмітка і стилі. Винятки перелічено в «Рішеннях».
- Кожна UI-задача перевіряє себе знімками з офскрин-стенда (Task 1) і порівнює їх із рендерами макета.

**Tech Stack:** Electron 44, React 19, TypeScript 7, electron-vite 6, vitest 5 + jsdom. Нових залежностей немає.

**Spec:** макети `docs/superpowers/specs/assets/design-2026-10-18/INDEX.txt` (перелік) + розділ «Рішення» нижче. Поведінка — як в `docs/superpowers/specs/2026-10-17-blackout-widget-design.md` і `docs/superpowers/specs/2026-10-17-actual-power-ecoflow-design.md`.

## Рішення (мої, користувач їх не обирав)
- D1. **Скло віджета.** Прикріплене до столу вікно не може мати справжнього розмиття.
  - Лишається поточний шар розмитих шпалер (`WidgetBackground`).
  - Поверх нього — скло з макета: `glass`, `edge`, `shadow`, а також тонування кольором стану (радіальний градієнт від лівого верхнього кута, альфа `tintA`: 0,14 світла / 0,18 темна).
  - Якщо шпалер немає (`kind: 'tint'`), скло лягає на однотонну підкладку теми.
- D2. **Тема.** Тема — за системною через `prefers-color-scheme` в обох вікнах; Electron сам передає системну тему. Темна й світла обидві обов'язкові.
- D3. **Майстер** лишається всередині головного вікна (900×640). Розмітка — як у діалозі з макета: ліва колонка з 7 кроками, праворуч контент, внизу кнопки. Окремого вікна 640×460 немає.
- D4. **Крок «Регіон / компанія»** показує лише підтримані джерела (зараз одне — «Київська область · ДТЕК Київські регіональні електромережі»), у стилі карток з макета. Неіснуючих регіонів і «району» в автодоповненні немає, бо таких даних немає.
- D5. **Трей.**
  - Нові іконки з окремим гліфом для кожного стану: блискавка / перекреслена блискавка / «!» / «?», 16 px; на темній і світлій панелі.
  - Меню на Windows — як зараз, порядок уже збігається з макетом.
  - На macOS першим пунктом іде неактивний заголовок зі станом і рядком під ним, як у макеті.
- D6. **Режим «Перемістити віджет».** Вікно віджета має фіксований розмір, тож пігулка «Перетягніть віджет у потрібне місце» + «Готово» і пунктирна рамка з гліфом переміщення малюються всередині картки віджета, поверх вмісту. Зовні, як у макеті, не вийде.
- D7. **Мініатюри стилів** у налаштуваннях і майстрі — статичні спрощені ілюстрації в CSS/SVG у бандлі `app`, не живі віджети: бандли `app` і `widget` не імпортують одне одного.
- D8. **Назва джерела.** Назва постачальника для підписів («ДТЕК Київські регіональні електромережі») переїжджає в `src/shared/providers.ts` (`providerDisplayName(id)`). Main-провайдер бере її звідти, щоб не дублювати.
- D9. **Головне вікно.**
  - Заголовок вікна — «Blackout Widget». Рамка системна (Mica на Windows).
  - Вкладки «Графік / Налаштування» — сегментований перемикач. Праворуч у рядку вкладок — кругла кнопка «Оновити зараз» (іконка ⟳).
- D10. **Порожній стан EcoFlow** у вкладці «Графік»: картка «Тут будуть реальні відключення» з кнопкою «Підключити EcoFlow» і рядок «Фактично» з посиланням «Підключити». Обидва відкривають «Налаштування» з одразу розгорнутою формою EcoFlow.
- D11. **«Відкрити графік на сайті ДТЕК»** (крок «Лінія») — новий IPC без аргументів, main відкриває фіксовану адресу `https://www.dtek-krem.com.ua/ua/shutdowns`.

## Global Constraints
- Точні значення (кольори, розміри, радіуси, тіні, відступи, кегль, вага, тексти) — з вихідників макета. Якщо рендер і вихідник розходяться, правий вихідник.
- Розміри вікон віджета не змінюються: compact 290×150, ring 236×260, timeline 400×200. Усе вміщається, тексти обрізаються трикрапкою, «оновлено …» видно завжди.
- Тексти інтерфейсу українською. Беруться з макета, якщо це справжній текст застосунку. Тексти, яких у макеті немає, лишаються як зараз.
- Поведінка не змінюється, крім рішень D1–D11. Наявні тести на поведінку не послаблюються: змінюються лише селектори й розмітка, а твердження про логіку лишаються.
- Шрифти системні: `'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`; для великих цифр — `font-variant-numeric: tabular-nums`.
- Нових залежностей немає. Чисті модулі (`src/shared/**`, `src/main/actual/**` крім `electron-deps.ts`) не імпортують `electron`.
- Бандли `app` і `widget` не імпортують код одне одного. Спільне — у `src/shared/` (TS) і `src/renderer/src/ui/` (CSS-токени).
- Візуальна перевірка — лише через стенд `scripts/ui-capture/` (офскрин, фальшиві стани, тимчасова тека). Ніколи не знімати екран користувача, не чіпати його дані, не запускати встановлений застосунок.
- Коміти: тема + тіло, **без** `Co-Authored-By` і без рядків-атрибуцій Claude.
- Кожна задача: `npx vitest run` і `npm run typecheck` зелені, `npm run build` проходить.

## Review Focus
1. **Світла тема на світлих шпалерах і темна на темних** — контраст тексту не гірший за макет (основний ≥ 7:1, третинний ≥ 4,5:1 на склі). Перевіряється знімками стенда в обох темах.
2. **Найтісніші стани віджета** (попередження + аварійне + EcoFlow-розбіжність + «дані застаріли») не вилазять за вікно. Знімки + вимір `getBoundingClientRect` у стенді.
3. **Стан без даних** (немає знімка, немає адреси, завтра не опубліковано) виглядає як у макеті і не падає.
4. **Вкладка «Графік» без EcoFlow і з EcoFlow** — порожній стан і повний стан; перехід «Підключити EcoFlow» відкриває форму.
5. **Майстер з однією і з двома лініями** — крок «Лінія» пропускається або показується; кроки в лівій колонці відмічаються правильно.

---

### Task 1: Токени, тема і стенд знімків

**Files:**
- Create: `src/renderer/src/ui/tokens.css`, `src/shared/design-tokens.ts`, `src/shared/providers.ts`, `scripts/ui-capture/capture.cjs`, `scripts/ui-capture/preload.cjs`, `scripts/ui-capture/README.md`
- Modify: `src/main/providers/dtek-krem/index.ts` (displayName з `providers.ts`), `src/renderer/src/widget/widget.css` і `src/renderer/src/app/app.css` (імпорт токенів, без зміни вигляду поки що), `package.json` (скрипт `"ui:capture": "electron scripts/ui-capture/capture.cjs"`)
- Test: `tests/shared/design-tokens.test.ts`

**Interfaces:**
- `tokens.css`:
  - змінні `--bw-*` з `tokens.html` і `THEMES` у `widget-compact.html`: on, off-a, off-b, off-dot, maybe, unknown, emergency, badge, ink, ink-2, ink-3, glass, glass-edge, shadow, hair, warn-ink, warn-bg, now, now-ring, tip-bg/ink/edge, tint-a;
  - радіуси й відступи з `tokens.html`;
  - темна тема під `@media (prefers-color-scheme: dark)`, світла — за замовчуванням;
  - класи штриховок: maybe / unknown — 135°, 2/2 px.
- `design-tokens.ts`: `export const THEMES: Record<'light'|'dark', ThemeTokens>` (ті самі значення для SVG/JS), `export function themeTokens(dark: boolean): ThemeTokens`.
- `providers.ts`: `export const PROVIDER_NAMES: Record<string,string> = { 'dtek-krem': 'ДТЕК Київські регіональні електромережі' }`, `export function providerDisplayName(id: string): string` (невідомий id → сам id).
- **Стенд `scripts/ui-capture/`:**
  - `npm run build`, потім `npm run ui:capture -- --target widget|app --style compact|ring|timeline --scenario <name> --theme light|dark --view schedule|settings|setup --out <dir>`;
  - відкриває прихований `BrowserWindow` потрібного розміру з `out/renderer/widget.html` або `app.html`;
  - `nativeTheme.themeSource` задає тему, `--user-data-dir` веде в тимчасову теку;
  - preload-заглушка віддає `window.api` з фальшивим `AppState` і фоном. Фон для віджета — градієнт або «строкаті» шпалери, намальовані на canvas → dataURL, як у макеті;
  - `capturePage` → PNG;
  - друкує JSON з `getBoundingClientRect` для елементів з `data-capture`.
  - Сценарії — ті самі назви, що в макеті: `on, off, maybe, emergency, nodata, stale, warning, nochange, ecoMatch, ecoMismatch, ecoOffline`. Фікстури — з `tests/helpers/snapshot.ts`, де можна; інакше — збирати `ScheduleSnapshot`/`ActualStatus` прямо в preload.

- [ ] Step 1: тест `design-tokens.test.ts` — ключові значення з макета:
  - `THEMES.dark.on === '#5dffa8'`, `THEMES.light.on === '#1fbf72'`;
  - `offA`/`offB`, `badge === '#d12b25'`, `glass`, `tintA` 0.14 / 0.18;
  - `providerDisplayName('dtek-krem')` і невідомий id.
- [ ] Step 2: реалізувати токени, `providers.ts`, стенд; провайдер бере displayName із shared.
- [ ] Step 3: `npm run build` + знімок поточного компакта в обох темах через стенд — стенд працює (у звіті шляхи до PNG).
- [ ] Step 4: `npx vitest run && npm run typecheck` → PASS.
- [ ] Step 5: Commit — `Add design tokens, shared provider names and a UI capture rig`

### Task 2: Віджет «Компакт» і спільні частини віджета

**Files:** `src/renderer/src/widget/{Widget.tsx, CompactWidget.tsx, parts.tsx, DayBar.tsx, OutageBadge.tsx, widget.css}`, тести `tests/renderer/widget.test.tsx`.

**Еталон:** `widget-compact.html` (розмітка + `THEMES` + `SCEN`), `widget-compact-states.html`, плитки `widget-compact-states-*.png`.

**Що зробити:**
- Картка, скло і тонування (D1), крапка з `dotGlow`, статус 20/26 px 650, бейдж, блискавка EcoFlow з підказкою, «з HH:MM».
- Рядок наступної зміни 13 px; рядок попередження з трикутником.
- Смужка: 48 клітинок, проміжок 1 px, заокруглення; минулі клітинки — альфа 0,4; maybe/unknown — штриховки; відрізок «немає» — градієнт off-a→off-b по довжині відрізка.
- Лінія «Фактично» 3 px; маркер «зараз» з кільцем; мітки 00/06/12/18/24.
- Підпис «Лінія 1 · черга 1.2 · оновлено 11:45»; пігулка «дані застаріли».
- Логіка й тексти беруться з `computeWidgetView` як зараз, змінюється лише вигляд.
- Спільні частини (статус, бейдж, блискавка, клітинки, лінія, мітки, підпис) — у `parts.tsx`/`DayBar.tsx`, щоб Task 3–4 їх використали.

- [ ] Тести рендеру оновлено під нову розмітку, логічні твердження збережено; додано тест «минулі клітинки приглушені» і «відрізок немає має градієнт».
- [ ] Знімки стенда: усі 11 сценаріїв × 2 теми; порівняти з плитками макета; виміри — нічого не вилазить.
- [ ] `npx vitest run && npm run typecheck && npm run build` → PASS. Commit — `Restyle the compact widget to match the design`

### Task 3: Віджет «Циферблат»

**Files:** `src/renderer/src/widget/RingWidget.tsx`, `widget.css`, тести.
**Еталон:** `widget-ring.html`, `widget-ring-states.html`, плитки `widget-ring-states-*.png`.
- Сегментоване кільце (00 угорі, за годинниковою стрілкою): кількість і товщина сегментів, проміжки — з макета; минуле приглушене; штриховки для maybe/unknown; біла точка «зараз» з кільцем.
- Внутрішня тонка дуга «Фактично».
- Центр: бейдж над статусом для аварійного; крапка + статус; великий відлік (≈ для аварійного); підпис.
- Мітки 00/06/12/18; підпис унизу.
- [ ] Тести + знімки 11 сценаріїв × 2 теми; виміри.
- [ ] Commit — `Restyle the ring widget to match the design`

### Task 4: Віджет «Таймлайн»

**Files:** `src/renderer/src/widget/TimelineWidget.tsx`, `widget.css`, тести.
**Еталон:** `widget-timeline.html`, `widget-timeline-states.html`, плитки.
- Шапка: статус + рядок; праворуч великий відлік з підписом.
- Рядки «Сьогодні 17.10» / «Завтра 18.10»; завтра не опубліковано — штриховка з написом «ще не опубліковано».
- Лінія «Фактично» під «Сьогодні»; мітки.
- Підпис «Лінія 1 · черга 1.2 · ДТЕК Київські регіональні електро… · оновлено 17:15»: назва з `providerDisplayName`, обрізається першою.
- [ ] Тести + знімки 11 сценаріїв × 2 теми; виміри.
- [ ] Commit — `Restyle the timeline widget to match the design`

### Task 5: Головне вікно — оболонка і вкладка «Графік»

**Files:** `src/main/main-window.ts` (заголовок «Blackout Widget»), `src/renderer/src/app/{App.tsx, ScheduleView.tsx, DayStrip.tsx, ActualStrip.tsx, app.css}`, `src/renderer/app.html` (title), тести `tests/renderer/{app,schedule-view}.test.tsx`.
**Еталон:** `main-schedule.html`, плитки `main-schedule-*.png`.
- Вкладки — сегментований перемикач; кнопка ⟳ праворуч (`api.refreshNow()`).
- Банери (попередження / небезпека / перевірка ДТЕК) з іконкою, заголовком, підрядком, кнопкою.
- Картка стану:
  - крапка + великий статус + бейдж + чип «Фактично · EcoFlow»;
  - підрядок;
  - праворуч великий відлік з підписом, якщо він є.
- Вкладки днів (сегмент) + легенда; «Аварійне» в легенді — лише коли є аварійні клітинки.
- Сітка 24 год:
  - мітки годин і пігулка поточного часу;
  - рядок «Графік» — клітинки з половинками;
  - рядок «Фактично» в тій самій шкалі; без EcoFlow — текст «Підключіть EcoFlow, щоб бачити, чи є світло насправді» з посиланням «Підключити» (D10).
- Під сіткою: «Відключення: …» ліворуч, «Оновлено о … · графік ДТЕК від …» праворуч.
- «Фактичні відключення · 7 днів» + «за даними EcoFlow»: список у дві колонки карток (дата, інтервал, тривалість), поточне — червоне з крапкою і «триває …».
- Без EcoFlow — порожній стан (D10). Навігація «Підключити» → `settings` з відкритою формою EcoFlow: проп або стан у `App`, без нового IPC.
- [ ] Тести: наявні оновлено; нові — порожній стан і перехід до форми; легенда «Аварійне» лише за потреби.
- [ ] Знімки: світла / темна, з EcoFlow / без, аварійне, вкладка «Завтра», банер перевірки ДТЕК.
- [ ] Commit — `Restyle the main window and schedule tab to match the design`

### Task 6: Вкладка «Налаштування» і панель EcoFlow

**Files:** `src/renderer/src/app/{SettingsView.tsx, ActualSettings.tsx, widget-styles.ts, app.css}`, нові мініатюри (D7), тести `tests/renderer/{actual-settings,app}.test.tsx`.
**Еталон:** `main-settings.html`, `ecoflow-panel.html`, плитки.
- Сітка карток у дві колонки.
- **Ліворуч:**
  - «Адреса» — іконка-мітка; адреса; «<назва джерела> · Лінія N · черга X»; кнопка «Змінити адресу»;
  - «Стиль віджета» — три картки з мініатюрами, назвою, розміром і галочкою вибраного.
- **Праворуч:**
  - «Запускати разом із системою» + «Віджет з'явиться після входу» + перемикач;
  - «Графік ДТЕК · Оновлено о HH:MM» + «⟳ Оновити зараз»;
  - картка «Фактичний стан світла» з чипом «EcoFlow» і всіма станами з `ecoflow-panel.html`: не підключено, форма, перевірка, станції, прев'ю, помилки, підключено.
- Поведінка форми EcoFlow не змінюється (усі наявні тести на логіку лишаються).
- [ ] Тести оновлено; знімки обох тем, підключено / не підключено, усі стани панелі.
- [ ] Commit — `Restyle settings and the EcoFlow panel to match the design`

### Task 7: Майстер першого запуску

**Files:** `src/renderer/src/app/{SetupWizard.tsx, Autocomplete.tsx, app.css}`, `src/shared/ipc.ts` + `src/preload/index.ts` + `src/main/ipc.ts` + `src/main/index.ts` (D11 `openDtekSite`), тести `tests/renderer/setup-wizard.test.tsx`.
**Еталон:** `setup-wizard.html`, плитки `setup-wizard-*.png`.
- **Ліва колонка** «Перше налаштування»: 7 кроків. Пройдений — ✓ у темному колі; поточний — підсвічений рядок з номером у колі; майбутній — номер. «Лінія» має підпис «якщо в будинку дві лінії».
- **Контент:** «Крок N з 7», заголовок, підрядок.
- **Кроки:**
  1. Регіон — картки-радіо (D4);
  2. Місто — поле з випадним списком, збіг виділено жирним;
  3. Вулиця — чип міста над полем;
  4. Будинок — як у макеті;
  5. Лінія — картки ліній з міні-смужкою на сьогодні і текстом інтервалів, посилання «Відкрити графік на сайті ДТЕК» (D11);
  6. Стиль — мініатюри (D7);
  7. Готово — підсумок з галочкою, перемикач автозапуску, підказка «Фактичний стан світла можна підключити пізніше: Налаштування → EcoFlow».
- Кнопки «Назад» / «Далі» / «Завершити».
- Логіка кроків і пропуск «Лінії» не змінюються.
- [ ] Тести оновлено + тест посилання на сайт ДТЕК (викликає `api.openDtekSite`); знімки кожного кроку.
- [ ] Commit — `Restyle the setup wizard to match the design`

### Task 8: Іконки трею, меню macOS і режим переміщення

**Files:** `scripts/gen-tray-icons.mjs` (або новий генератор через стенд), `resources/tray/*.png` (+ `@2x`), `src/main/tray.ts`, `src/main/tray-menu.ts` (заголовок на macOS — D5), `src/renderer/src/widget/{WidgetRoot.tsx, widget.css}` (D6), тести `tests/main/tray-menu.test.ts`, `tests/renderer/widget-root.test.tsx`.
**Еталон:** `tray-menu.html`, плитки `tray-menu-*.png`.
- Іконки 16 і 32 px (`@2x`) для on/off/emergency/unknown з гліфами з макета; згенеровані скриптом, PNG закомічені.
- `buildTrayMenu(state, actions, platform)`: на `darwin` перший пункт — неактивний заголовок «<статус>» з рядком під ним (`sublabel` або два пункти), далі роздільник. На win32 меню без змін.
- Режим переміщення (D6): пунктирна подвійна рамка, гліф переміщення в куті, пігулка «Перетягніть віджет у потрібне місце» + «Готово» всередині картки.
- [ ] Тести меню (darwin vs win32) і режиму переміщення; знімки трьох стилів у режимі переміщення.
- [ ] Commit — `Add state glyph tray icons, a macOS menu header and the new move mode`
