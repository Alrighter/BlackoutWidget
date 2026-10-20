# More Outage Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kyiv city, Odesa and Dnipro (DTEK) and Volyn/Kovel (Volynoblenergo) as schedule sources. Every source shows a quiet day as «світло є» with a note.

**Architecture:**
- **DTEK.** The single `dtek-krem` provider becomes one `DtekProvider` configured per site. Each site gets its own lazy hidden-browser session.
- **Volyn.** A new `voe` provider talks plain HTTPS from the main process. It reads the oblast schedule PNG with an in-house decoder and grid sampler, and parses two HTML forms for the address-to-queue lookup and the current outage.
- **Shared.** Provider metadata (names, short name, region, site, single city) lives in `src/shared/providers.ts` and drives every per-provider text.

**Tech Stack:** Electron 44, TypeScript, React 19, vitest; `node:zlib` for PNG.

**Spec:** `docs/superpowers/specs/2026-10-20-more-outage-sources-design.md`. Research and fixtures: `docs/superpowers/research/2026-10-20-outage-sources/`.

## Global Constraints

- No new runtime or dev dependencies (`package.json` unchanged). The PNG is decoded with `node:zlib`. HTML tables are parsed without a DOM library.
- Provider modules under `src/main/providers/**` import no `electron`, except `browser-session.ts` and the new `electron-http.ts`.
- Main-process HTTP goes through Electron `net.fetch` with `cache: 'no-store'`. Each request carries a 20 s `AbortSignal.timeout`.
- Never «світло є» from a failed or unreadable fetch. Failures throw `ProviderError`/`NetworkError`.
- No hidden browser window for a provider that is not used. Sessions stay lazy, and a window exists only after `ensureReady`.
- Tests run offline. Smoke scripts never touch `%APPDATA%\Blackout Widget`.
- Exact texts (Ukrainian, verbatim):
  - quiet note, DTEK: «ДТЕК не опублікував графік на сьогодні — зазвичай це означає, що відключень за графіком немає»
  - quiet note, Volyn: «Волиньобленерго не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає»
  - Volyn offline: «Немає з’єднання з сайтом Волиньобленерго»
  - Volyn not answering: «Сайт Волиньобленерго не відповідає»
  - Volyn HTTP error: «Сайт Волиньобленерго повернув помилку»
  - Volyn unreadable: «Не вдалося прочитати графік Волиньобленерго»
  - «Не залучено до ГПВ»
  - «Черга 6.1»
  - badge «Планове»
  - settings row title «Графік відключень»
- Commits: subject + body only. No `Co-Authored-By` or any Claude/AI attribution line.

## Review Focus

1. **A truncated or half-uploaded PNG** (zlib error, missing IEND) must give «Не вдалося прочитати графік Волиньобленерго». It must never crash and never read as all-on. Tests in Task 6.
2. **Midnight:** at 00:05 the image that was «tomorrow» is today's, keyed by `dateGraph`, and it is not a quiet day. Test in Task 9.
3. **A saved Volyn address whose label is missing from the bundled list** (list regenerated) still refreshes, from the bare name in the label. Test in Task 9.
4. **DTEK `fact.data` with today for other groups but not the saved one** keeps today's unknown behaviour; it is not a quiet day. Test in Task 4.
5. **Switching provider in the wizard after a city or street was picked** clears city, street, house and line. A Kyiv-oblast city is never sent to another provider. Test in Task 5.

---

### Task 1: Provider metadata and per-provider texts

**Files:**
- Modify: `src/shared/providers.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc.ts`, `src/main/index.ts`, `src/renderer/src/app/ScheduleView.tsx`, `src/renderer/src/app/SettingsView.tsx`, `src/renderer/src/app/SetupWizard.tsx`
- Test: `tests/shared/providers.test.ts` (new), `tests/renderer/schedule-view.test.tsx`, `tests/renderer/setup-wizard.test.tsx`, `tests/renderer/settings-view.test.tsx`

**Interfaces:**
- **Produces, in `src/shared/providers.ts`:**
  - `interface ProviderInfo { name: string; shortName: string; region: string; siteUrl: string; singleCity?: string }`
  - `const PROVIDERS: Record<string, ProviderInfo>`, with these five entries:

    | id | name | shortName | region | siteUrl | singleCity |
    |---|---|---|---|---|---|
    | `dtek-kem` | ДТЕК Київські електромережі | ДТЕК | м. Київ | https://www.dtek-kem.com.ua/ua/shutdowns | м. Київ |
    | `voe` | Волиньобленерго | Волиньобленерго | Волинська область | https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/ | — |
    | `dtek-dnem` | ДТЕК Дніпровські електромережі | ДТЕК | Дніпропетровська область | https://www.dtek-dnem.com.ua/ua/shutdowns | — |
    | `dtek-krem` | ДТЕК Київські регіональні електромережі | ДТЕК | Київська область | https://www.dtek-krem.com.ua/ua/shutdowns | — |
    | `dtek-oem` | ДТЕК Одеські електромережі | ДТЕК | Одеська область | https://www.dtek-oem.com.ua/ua/shutdowns | — |

  - Functions:
    - `providerDisplayName(id)` (kept);
    - `providerRegion(id)` (kept);
    - `providerShortName(id): string`, which falls back to the id;
    - `providerSiteUrl(id): string | undefined`;
    - `providerSingleCity(id): string | undefined`.
  - Remove `PROVIDER_NAMES`/`PROVIDER_REGIONS` if nothing else imports them.
- **Produces, IPC:**
  - `IPC.openProviderSite = 'addr:provider-site'` replaces `openDtekSite`.
  - In `RendererApi`: `openProviderSite(providerId: string): void` and `solveCaptcha(providerId?: string): Promise<void>`.
  - Main deps: `openProviderSite(providerId: string): void` and `solveCaptcha(providerId?: string): Promise<void>`.

- [ ] **Step 1: Write failing tests.**
  - `tests/shared/providers.test.ts`:
    - the five ids above have exactly those values;
    - `providerShortName('x') === 'x'`;
    - `providerSiteUrl('x') === undefined`.
  - Schedule view, with a snapshot of `providerId: 'voe'` and a current outage `{kind:'emergency', text:'Аварійний випадок в мережах'}` active now: the banner text is `Волиньобленерго: «Аварійний випадок в мережах»`. With `sourceUpdatedAt: '22:26 19.10.2026'`, the foot reads `… · графік Волиньобленерго від 22:26 19.10.2026`.
  - Settings view: the row title is «Графік відключень».
  - Wizard, line step for `dtek-krem`:
    - the link reads «Відкрити графік на сайті ДТЕК», and clicking it calls `api.openProviderSite('dtek-krem')`;
    - the house-without-lines note reads «Для цього будинку ДТЕК не публікує графік відключень» (the text is built from `providerShortName`);
    - the line-step subline reads «… з сайтом ДТЕК і оберіть свою.»;
    - the captcha retry calls `api.solveCaptcha('dtek-krem')`.
- [ ] **Step 2: Run them and see them fail.** Command: `npx vitest run tests/shared/providers.test.ts tests/renderer`.
- [ ] **Step 3: Implement.**
  - Main: `openProviderSite` looks the URL up with `providerSiteUrl`. An unknown id is logged and ignored, and the renderer never passes a URL.
  - `solveCaptcha(providerId)` picks `providerId ?? store.getSettings().address?.providerId`. It does nothing when both are missing, instead of falling back to `providers[0]`.
  - The ScheduleView emergency legend keeps «Аварійне».
- [ ] **Step 4: Run the full suite and the typecheck.** Commands: `npx vitest run` and `npm run typecheck`. Both must pass.
- [ ] **Step 5: Commit.** Subject: «Per-provider names, site link and captcha routing».

### Task 2: Snapshot note and planned outages

**Files:**
- Modify: `src/shared/types.ts`, `src/shared/widget-state.ts`, `src/renderer/src/app/ScheduleView.tsx`
- Test: `tests/shared/widget-state.test.ts`, `tests/renderer/schedule-view.test.tsx`

**Interfaces:**
- **Produces:**
  - `ScheduleSnapshot.note?: string`;
  - `CurrentOutage.kind: 'emergency' | 'planned' | 'other'`;
  - `OutageBadgeText = 'Аварійне' | 'Екстрене' | 'Планове'`.

- [ ] **Step 1: Write failing tests.**
  - `widget-state`: a `{kind:'planned', text:'Планові ремонтні роботи', start:'20.10.2026 09:36', end:'20.10.2026 19:00'}` at 10:00 that day gives:
    - `state: 'emergency'`;
    - `title: 'Світла немає'`;
    - `outageBadge: 'Планове'`.
  - `widget-state`: the same outage at 19:30 does not override.
  - `widget-state`: `kind: 'other'` still never overrides (keep the existing test).
  - Schedule view: a snapshot with `note: 'X'`, viewed on today, shows `X` in an element with `data-capture="note"`. On tomorrow's tab it does not show.
  - Schedule view: with a planned outage active, the banner title is «Планове відключення».
- [ ] **Step 2: Run them and see them fail.** Command: `npx vitest run tests/shared/widget-state.test.ts tests/renderer/schedule-view.test.tsx`.
- [ ] **Step 3: Implement.**
  - `activeEmergency` accepts `'emergency' | 'planned'`.
  - `badgeFor` returns «Планове» for `'planned'`.
  - ScheduleView renders `snapshot.note` as a muted line above the foot, only when the viewed day is today.
  - The emergency legend uses `view.outageBadge ?? 'Аварійне'`.
- [ ] **Step 4: Run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Commit.** Subject: «Snapshot note and planned outages».

### Task 3: One DTEK provider for four sites

**Files:**
- Move: `src/main/providers/dtek-krem/` → `src/main/providers/dtek/` (`git mv`). `DtekKremProvider` becomes `DtekProvider`.
- Modify: `src/main/providers/dtek/{index,page-scripts}.ts`, `src/main/providers/registry.ts`, `src/main/providers/browser-session.ts`, `src/main/index.ts` (imports only), `src/main/smoke-dtek.ts`
- Test: `tests/providers/dtek-provider.test.ts`, `tests/providers/dtek-parse.test.ts` (imports), `tests/providers/registry.test.ts` (new). Move `tests/fixtures/dtek-krem/` → `tests/fixtures/dtek/`.

**Interfaces:**
- **Consumes:** `providerSiteUrl`, `providerDisplayName` and `providerSingleCity` from Task 1.
- **Produces:**
  - `class DtekProvider implements ScheduleProvider`, with `constructor(site: { id: string; cityLevel: boolean }, session: PageSession, log?: Logger)`.
  - `DTEK_SITES: ReadonlyArray<{ id: string; cityLevel: boolean }>`:
    - `dtek-kem` false;
    - `dtek-dnem` true;
    - `dtek-krem` true;
    - `dtek-oem` true.
  - `readStreetsScript(city: string | null)` and `getHomeNumScript(city: string | null, street: string, updateFact: string)`. `null` means the site has no city level: read the flat `DisconSchedule.streets` array, and send no `city` field.
  - `createProviders(makeSession, log)` returns, in order: `dtek-kem`, `dtek-dnem`, `dtek-krem`, `dtek-oem`. Task 9 inserts `voe` second.

- [ ] **Step 1: Write failing tests.**
  - `registry.test.ts`:
    - the ids come out in the order above;
    - `makeSession` gets `{ url: providerSiteUrl(id), partition: 'persist:<id>', allowedHosts: ['dtek-kem.com.ua'] /* host without www */ }` for each, with the same `readyCheck`, `afterReady` and `blockRequest` as today;
    - no session method is called during `createProviders`.
  - `dtek-provider.test.ts`, existing tests ported to `new DtekProvider({id:'dtek-krem', cityLevel:true}, …)`, plus:
    - Kyiv `listCities()` resolves `['м. Київ']` without calling `session.ensureReady`;
    - Kyiv `listStreets('м. Київ')` evaluates `readStreetsScript(null)`;
    - Kyiv `listHouses` evaluates a script whose form fields contain no `city`;
    - a failure logs `dtek-kem fetchSnapshot failed`, not `dtek-krem`.
  - `getHomeNumScript(null, 'вул. Хрещатик', 'u')` does not contain `'city'`. `getHomeNumScript('м. Буча', …)` still does.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - `REAL_PAGE_CHECK` in `browser-session.ts` tests `/ДТЕК|dtek-/i`.
  - `smoke-dtek.ts` takes `--provider <id>` (default `dtek-krem`) and partition `persist:<id>`. It walks `listCities` → first city → `listStreets` → first street → `listHouses` → first house with lines → `fetchSnapshot`, and prints what it got.
- [ ] **Step 4: Run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Live check.**
  - Run `npm run build`, then `npx electron out/main/smoke-dtek.js --provider <id>` for `dtek-kem`, `dtek-oem` and `dtek-dnem`. Expect a snapshot for each. An Imperva block on the first try may need one rerun; report that as is.
  - **CEK check:** with a small script or a temporary smoke flag, find a CEK-served house on `dtek-dnem` and see whether `getHomeNum` gives it a `GPV1001.x` group. To find one, look through houses in Дніпро streets until one's `sub_type_reason` names `GPV1001.*` or its `cek` field is filled.
  - Record the outcome in the ledger. If no CEK house ever carries a group, rule «CEK dropped from this step» and make no code change.
- [ ] **Step 6: Commit.** Subject: «One DTEK provider for Kyiv, Kyiv oblast, Odesa and Dnipro».

### Task 4: DTEK quiet day

**Files:**
- Modify: `src/main/providers/dtek/parse.ts`, `src/main/providers/dtek/index.ts`
- Test: `tests/providers/dtek-parse.test.ts`, `tests/providers/dtek-provider.test.ts`

**Interfaces:**
- **Consumes:** `ScheduleSnapshot.note` from Task 2.
- **Produces:**
  - `isQuietToday(fact: DtekFact, todayKey: string): boolean`. It is true only when `fact.update` is a non-blank string and no key of `fact.data` maps (via `kyivDateKey(new Date(Number(ts)*1000))`) to `todayKey`.
  - `DTEK_QUIET_NOTE`, holding the exact text from Global Constraints.

- [ ] **Step 1: Write failing tests.**
  - `isQuietToday({data:{}, update:'12:17 17.10.2026', today:0}, '2026-10-20')` → true.
  - With `update: ''` → false.
  - `data` holding today's timestamp for other groups only → false.
  - Provider, `fact.data` empty, now 2026-10-20 10:00 Kyiv: `days` is `[{date:'2026-10-20', slots: 48×'on'}]` and `note === DTEK_QUIET_NOTE`.
  - Provider, `fact.data` with tomorrow only: today is all on with the note, and tomorrow is kept.
  - Provider, `fact.data` with today for other groups only: no note, and no day for today, as now.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement it in `fetchSnapshot`, after `factToDays`.**
- [ ] **Step 4: Run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Commit.** Subject: «DTEK: a day without a published schedule shows power on with a note».

### Task 5: Wizard: choosing among providers

**Files:**
- Modify: `src/renderer/src/app/SetupWizard.tsx`
- Test: `tests/renderer/setup-wizard.test.tsx`

**Interfaces:**
- **Consumes:** `providerSingleCity`, `providerShortName` and `solveCaptcha(providerId)` from Task 1.

- [ ] **Step 1: Write failing tests.**
  - With `listProviders` returning five providers:
    - no card is checked;
    - «Далі» is disabled until one is clicked;
    - the cards appear in the order the list gives.
  - With one provider, it stays preselected, as now.
  - Choosing `dtek-kem` and pressing «Далі»:
    - lands on the street step;
    - the city chip reads «м. Київ»;
    - `listStreets` is called with `('dtek-kem', 'м. Київ')`;
    - «Назад» from the street step returns to the provider step;
    - the rail shows the city step as done.
  - Review Focus 5:
    - pick `dtek-krem`, choose city «м. Буча», go back to the provider step, and pick `voe`;
    - `listCities` is called for `voe`, and the city field is empty;
    - `listStreets` is never called with `('voe', 'м. Буча')`.
  - An empty street list shows the note «Для цього населеного пункту немає адрес у {short name}», for example «… у Волиньобленерго».
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - Preselect only when the list has exactly one provider.
  - The step order drops `'city'` when `providerSingleCity(providerId)` is set, and the city is set to that value when the provider is picked.
  - Changing the provider runs `resetBelow('city')` and clears the city.
- [ ] **Step 4: Run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Commit.** Subject: «Wizard: pick the region, skip the city for Kyiv».

### Task 6: PNG reader and Volyn grid sampler

**Files:**
- Create: `src/main/providers/voe/png.ts`, `src/main/providers/voe/gpv-image.ts`
- Create fixtures by copying from the research folder:
  - `tests/fixtures/voe/gpv-2026-10-17.png`;
  - `tests/fixtures/voe/gpv-2026-10-20.png`.
- Test: `tests/providers/voe-image.test.ts`

**Interfaces:**
- **Produces:**
  - `interface RgbImage { width: number; height: number; channels: 3 | 4; pixels: Uint8Array }`.
  - `decodePng(buf: Uint8Array): RgbImage`. It supports bit depth 8, colour type 2 or 6, no interlace, and all five filter types. Anything else, a bad signature, or a zlib failure throws `ProviderError('Не вдалося прочитати графік Волиньобленерго')`.
  - `GPV_GROUPS = ['1.1','1.2','2.1','2.2','3.1','3.2','4.1','4.2','5.1','5.2','6.1','6.2'] as const`.
  - `readGpvGrid(img: RgbImage): Record<string, Slot[]>`, with 48 slots per group.
    - Geometry:
      - size 1750×2250, otherwise throw;
      - columns span x 176…1726, 24 per half-day;
      - rows span y 417…1131 for 00:00–12:00 and y 1304…2019 for 12:00–24:00, 12 each in `GPV_GROUPS` order.
    - Sampling: average a 3×3 patch at each cell centre.
    - Classification:
      - Euclidean distance ≤ 60 to light (184,200,216) → `on`;
      - ≤ 60 to dark (68,111,155) → `off`;
      - anything else throws the same error. There is no `unknown` slot.

- [ ] **Step 1: Write failing tests.**
  - `decodePng` on the 17.10 fixture: 1750×2250, `channels: 3`.
  - `readGpvGrid` on 17.10: every group is `on` except these off ranges, as half-open slot indices:
    - 1.1 [20,28);
    - 1.2 [28,35);
    - 2.1 [35,42);
    - 2.2 [29,36);
    - 3.1 [22,28);
    - 3.2 [22,28);
    - 4.1 [28,35);
    - 4.2 [28,35);
    - 5.1 [35,37);
    - 5.2 [35,38);
    - 6.1 [36,44);
    - 6.2 [42,44).

    Off-slots ÷ 2 equal the image header: 4, 3.5, 3.5, 3.5, 3, 3, 3.5, 3.5, 1, 1.5, 4, 1.
  - `readGpvGrid` on 20.10: all 576 slots are `on`.
  - Throws:
    - the fixture buffer cut to half its length (Review Focus 1);
    - an image whose width is 1749;
    - a copy of the 17.10 pixels with the centre patch of row 1.1, column 0 painted (255,0,0);
    - a palette PNG (colour type 3), built in the test by patching the IHDR byte.
- [ ] **Step 2: Run them and see them fail.** Command: `npx vitest run tests/providers/voe-image.test.ts`.
- [ ] **Step 3: Implement.** Parse the chunks, concatenate the IDATs, `inflateSync`, then unfilter row by row (None/Sub/Up/Average/Paeth).
- [ ] **Step 4: Run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Commit.** Subject: «Volyn: read the hourly schedule image».

### Task 7: Volyn HTML parsers

**Files:**
- Create: `src/main/providers/voe/html.ts`
- Create fixtures:
  - `tests/fixtures/voe/cherga-kovel-all.html` and `tests/fixtures/voe/chomu-nemaie-kovel.html`, copied from `docs/superpowers/research/2026-10-20-outage-sources/volyn-raw/`;
  - `tests/fixtures/voe/archive-page1.json`, from the same folder.
- Test: `tests/providers/voe-html.test.ts`

**Interfaces:**
- **Produces:**
  - `interface QueueRow { raion: string; settlement: string; street: string; houses: string[]; gpv: string /* '6.1' or 'none' */ }`.
  - `parseQueueTable(html: string): QueueRow[]`:
    - reads the `<table class='table table-sm …'>` rows;
    - decodes the entities `&lt; &gt; &amp; &quot; &#039;`;
    - «Не залучено» becomes `'none'`;
    - houses are split on `,`, trimmed, and kept only when they match `/^\d+(?:-?\p{L})?(?:\/\d+(?:-?\p{L})?)?$/u`.
  - `housesOf(rows: QueueRow[], street: string): HouseInfo[]`:
    - one entry per house, sorted with `localeCompare(…, 'uk', { numeric: true })`;
    - `lines` holds the distinct queues, real ones ascending first and `'none'` last, indexed from 1;
    - labels are `Черга 6.1` / `Не залучено до ГПВ`;
    - `outageActive: false`.
  - `interface OutageRow { settlement: string; street: string; houses: string[]; type: string; reason: string; start: string; end: string }`. The dates are converted from `2026-10-20 09:50` to `20.10.2026 09:50`.
  - `parseOutageTable(html: string): OutageRow[]`.
  - `matchOutage(rows: OutageRow[], at: { settlement: string; street: string; house: string }, now: Date): CurrentOutage | undefined`. It matches the settlement, the street and the house in the list exactly.
    - Types map as follows:
      - `Аварійне вимкнення` → `'emergency'`;
      - `Планове вимкнення` → `'planned'`;
      - a type mentioning `графік` → skipped;
      - anything else → `'other'`.
    - Which row wins:
      1. a row active now, emergency before planned before other;
      2. else the earliest that starts later today;
      3. else `undefined`.
    - The `text` is the «Причина».

- [ ] **Step 1: Write failing tests (all on the fixtures).**
  - `parseQueueTable(cherga)`:
    - 1,908 rows. Confirm the count against the file; if it differs, check the row rules, not the number;
    - the distinct streets with `settlement === 'Ковель'` number 300;
    - a row `{raion:'Ковельський', settlement:'Ковель', street:'Незалежності', houses:['101','101А','89'], gpv:'2.2'}` exists;
    - no house equals `'<>'`.
  - `housesOf` for Ковель rows, street «Незалежності»:
    - house `25` has lines `[{index:1, groupId:'4.2', label:'Черга 4.2'}, {index:2, groupId:'none', label:'Не залучено до ГПВ'}]`;
    - house `101А` has `[{index:1, groupId:'2.2', label:'Черга 2.2'}]`.
  - The house filter, unit-tested: it keeps `2А`, `15/2`, `7-А`, and drops `<>`, `Адреса невідома`, `біля буд. 122`, `гараж 17`, `142/` and `62А/гараж 47`.
  - `matchOutage`, with `now` = 2026-10-20 10:00 Kyiv:
    - Ковель / Самійла Величка / `7А` → `{kind:'emergency', text:'Аварійний випадок в мережах', start:'20.10.2026 09:50', end:'20.10.2026 11:51'}`;
    - Воля-Ковельська / Воля / `28А` → `kind:'planned'`, `text:'Планові ремонтні роботи'`;
    - Ковель / Самійла Величка / `2` → `undefined`;
    - Ковель / Воля / `28А` → `undefined`, because settlement matching is exact;
    - Ковель / Самійла Величка / `7А` at 12:00 → `undefined`, because the outage ended at 11:51 and nothing comes later.
  - UTF-8 check: reading the saved file as UTF-8 yields a row whose settlement is exactly «Ковель».
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Use regex row and cell extraction, scoped to the first `<table class='table table-sm` element.
- [ ] **Step 4: Run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Commit.** Subject: «Volyn: parse the queue lookup and the current-outage list».

### Task 8: Volyn settlements list

**Files:**
- Create:
  - `src/main/providers/voe/settlements.json`;
  - `src/main/providers/voe/settlements.ts`;
  - `src/main/providers/voe/settlements.source.md`, which records the КАТОТТГ edition, the URL, the date, how the list was generated, and the live spelling checks.
- Test: `tests/providers/voe-settlements.test.ts`

**Interfaces:**
- **Produces:**
  - The JSON entries: `{ name: string; kind: 'м' | 'с-ще' | 'с'; raion: string; operatorName?: string }`. КАТОТТГ categories map as М→`м`, Т and Х→`с-ще`, С→`с`. `raion` is the post-2020 district name without «район».
  - `interface VoeSettlement { label: string; name: string; raion: string; operatorName?: string }`.
  - `voeSettlements(): VoeSettlement[]`:
    - the label is `${prefix} ${name}`, with prefix `м.`, `с-ще` or `с.`;
    - when that label occurs more than once, ` (${raion} р-н)` is appended;
    - same label and same district means one entry;
    - labels are unique and sorted with `localeCompare(…, 'uk')`.
  - `findSettlement(label: string): VoeSettlement | undefined`.
  - `bareName(label: string): string`. It strips the prefix and any ` (… р-н)`; this is the Review Focus 3 fallback.
  - `operatorCity(s: VoeSettlement): string` returns `s.operatorName ?? s.name`.

- [ ] **Step 1: Generate the list.**
  - Fetch the current КАТОТТГ edition from the official publication (data.gov.ua or the ministry site) and take every Volyn oblast (UA07) settlement of category М, Т, С or Х, with its district.
  - Any tool may be used for the one-off conversion as long as `package.json` does not change. Write the JSON and the source note.
- [ ] **Step 2: Check spellings live** with a Node script (not shell literals, which garble Cyrillic). `POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/` with `formCity=<name>&formStreet=%` for:
  - Луцьк, Ковель, Володимир, Нововолинськ;
  - one name that occurs twice in the list.

  Record the row counts and the «Район» values the operator returns.
  - A name with no rows whose old name has rows gets `operatorName`.
  - If the operator's «Район» is not one of the four new districts, note it. Task 9's district filter then falls back to the name alone.
- [ ] **Step 3: Write failing tests.**
  - The labels include `м. Ковель`, `м. Луцьк`, `м. Володимир` and `м. Нововолинськ`.
  - The count is between 1,000 and 1,200.
  - The labels are unique.
  - The duplicate found in Step 2 carries its ` (… р-н)` suffix.
  - `bareName('с. Липне (Луцький р-н)') === 'Липне'` and `bareName('м. Ковель') === 'Ковель'`.
- [ ] **Step 4: Implement `settlements.ts`, then run the full suite and the typecheck.** Both must pass.
- [ ] **Step 5: Commit.** Subject: «Volyn: bundled settlement list from КАТОТТГ».

### Task 9: The Volynoblenergo provider

**Files:**
- Create:
  - `src/main/providers/voe/index.ts`, holding `VoeProvider`;
  - `src/main/providers/http.ts`, holding the `HttpFetch` type;
  - `src/main/providers/electron-http.ts`, with the `net.fetch` adapter;
  - `src/main/smoke-voe.ts`.
- Modify: `src/main/providers/registry.ts`, `src/main/index.ts`, `electron.vite.config.ts` (smoke input)
- Test: `tests/providers/voe-provider.test.ts`, `tests/providers/registry.test.ts`

**Interfaces:**
- **Consumes:**
  - from Task 6: `decodePng` and `readGpvGrid`;
  - from Task 7: `parseQueueTable`, `housesOf`, `parseOutageTable` and `matchOutage`;
  - from Task 8: `voeSettlements`, `findSettlement`, `bareName` and `operatorCity`;
  - from Task 2: `note` and `'planned'`.
- **Produces:**
  - `type HttpFetch = (url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>`.
  - `new VoeProvider(deps: { fetch: HttpFetch; isOnline: () => boolean; log?: Logger; now?: () => Date })`, with `id: 'voe'`.
  - `VOE_QUIET_NOTE`.
  - `createProviders(makeSession, log, http: { fetch: HttpFetch; isOnline: () => boolean })` puts `voe` second.

**Behaviour, decided here:**
- **Calls are serial.** Use the same serial queue as DTEK.
- **Snapshot fetch, step 1: the archive.** `GET https://api-voe-poweron.inneti.net/api/archive_gpv_graphs?page=1` with `Accept: application/ld+json`.
  - An empty `hydra:member`, or a newest `dateGraph` that does not parse, throws «Не вдалося прочитати графік Волиньобленерго».
  - For today and tomorrow (Kyiv), take the member with the highest `id` whose `dateGraph.slice(0, 10)` equals the date.
- **Step 2: the images.** For each picked date, `GET https://api-voe-poweron.inneti.net${imageUrl.contentUrl}`. The parsed grid is cached per `contentUrl`, keeping the last 4.
- **Step 3: the days.**
  - Today with an image → its row, from `GPV_GROUPS`.
  - Today without an image → 48×`on`, plus `VOE_QUIET_NOTE`.
  - Tomorrow appears only when it has an image.
  - `groupId 'none'` gives the same dates, all `on`.
  - `sourceUpdatedAt` is today's image `uploadTimestamp` (UTC) shown in Kyiv time as `HH:MM DD.MM.YYYY`. On a quiet day it is left out.
- **Step 4: the lines.** They come from the queue table of the saved city, cached per label for the run.
  - If that request fails, or the table has no row for the saved house, use `lines = [{index: address.lineIndex, groupId: address.groupId, label}]` and `log.warn`. Only a house that is found with different queues changes `lines`.
  - Cities are resolved by `findSettlement(label)`, falling back to `bareName(label)` (Review Focus 3).
  - The district filter applies only when the operator's rows for that name include the settlement's district.
- **Step 5: the current outage.** `POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/chomu-nemaie-elektropostachannia/` with the form `formCity=<operator city>&formStreet=<street>&searchForm=searchFromForm`, then `matchOutage`. A failure is logged, and the snapshot comes without `currentOutage`.
- **The queue lookup.** `POST https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/cherga/` with the form `formCity=<operator city>&formStreet=%`.
  - `listStreets` gives the unique streets of the exact settlement, sorted `uk`.
  - An unknown city gives `[]`.
- **Errors.**
  - The fetch rejects while offline → `NetworkError` «Немає з’єднання з сайтом Волиньобленерго».
  - The fetch rejects while online → `ProviderError` «Сайт Волиньобленерго не відповідає».
  - A non-OK status → «Сайт Волиньобленерго повернув помилку».
  - Log lines are prefixed `voe`.
- **The rest.** `showVerification()` resolves immediately and `dispose()` does nothing.

- [ ] **Step 1: Write failing tests.** Use a fake `HttpFetch` routing by URL to the fixtures from Tasks 6 and 7. In the fixture archive, map `/media/2026/10/6ad66ecc04352_GPV.png` to the 20.10 PNG, and the highest-id 17.10 entry's `contentUrl` to the 17.10 PNG.
  - Now 2026-10-20 10:00 Kyiv, address `м. Ковель` / `Самійла Величка` / `7А`, group `'6.1'`:
    - one all-`on` day 2026-10-20;
    - no `note`;
    - `sourceUpdatedAt: '22:26 19.10.2026'`;
    - `currentOutage.kind === 'emergency'`.
  - Now 2026-10-17 12:00, group `'1.1'`: today's slots 20–27 are `off`. If the saved archive page holds no 17.10 member, add one to a copy of the fixture inside the test, pointing at the 17.10 PNG.
  - Now 2026-10-21 10:00, with no member for that date: today is all `on`, `note === VOE_QUIET_NOTE`, and there is no tomorrow.
  - Now 2026-10-19 21:00: two days, 19.10 and 20.10.
  - Review Focus 2: now 2026-10-20 00:05 → today is 20.10, from its image, with no note.
  - An empty `hydra:member` → throws «Не вдалося прочитати графік Волиньобленерго».
  - Two `fetchSnapshot` calls download the PNG once.
  - Fetch rejects with `isOnline` false → `NetworkError`; with it true → «Сайт Волиньобленерго не відповідає». An HTTP 500 → «… повернув помилку».
  - The outage form rejects → the snapshot still arrives, without `currentOutage`.
  - The queue form rejects during `fetchSnapshot` → `lines` is the saved line.
  - Review Focus 3: address city `'м. Ковель (Старий р-н)'`, which is not in the bundled list. The POST bodies carry `formCity=Ковель` (from `bareName`), and the snapshot has the schedule and the emergency outage for Самійла Величка 7А.
  - `listStreets('м. Ковель')` has 300 streets. `listHouses('м. Ковель','Незалежності')` matches Task 7.
  - `groupId 'none'` → all `on`.
  - Registry: the ids are `dtek-kem, voe, dtek-dnem, dtek-krem, dtek-oem`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - `electron-http.ts` is `(url, init) => net.fetch(url, { ...init, cache: 'no-store' })`.
  - Main passes `{ fetch: electronHttp, isOnline: () => net.isOnline() }`.
  - `smoke-voe.ts` runs `listStreets('м. Ковель')`, `listHouses(…,'Незалежності')`, then `fetchSnapshot` for house 25 line 1, and prints the result. It is added to `electron.vite.config.ts` main inputs.
- [ ] **Step 4: Run the full suite, the typecheck, and the live smoke.** Commands: `npm run build`, then `npx electron out/main/smoke-voe.js`. Expect 300 streets and a snapshot.
- [ ] **Step 5: Commit.** Subject: «Volyn: the Volynoblenergo schedule provider».

### Task 10: Packaged build check

**Files:**
- Modify: nothing unless a check fails.

- [ ] **Step 1: Build the installer.** Run `npm run dist:win` and confirm `dist\Blackout Widget Setup 1.0.0.exe` is built.
- [ ] **Step 2: Check that the settlement list is in the bundle.** It should be inlined into the built main chunks. After `npm run build`, run a Node script file that reads `out/main/*.js` and checks for «Нововолинськ». Use a script file, because Cyrillic in shell literals gets garbled.
- [ ] **Step 3: Run the full suite and the typecheck one last time.**
- [ ] **Step 4: Commit any fixes.** Subject: «Package the new providers».
