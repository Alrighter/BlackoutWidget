# Outage Sources Step 2, Wave 2 (Zhytomyr, Chernivtsi, CEK) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the last three plain-HTTPS schedule sources: Zhytomyroblenergo (`ztoe`), Chernivtsioblenergo (`cvoe`) and ПЕЕМ «ЦЕК» (`cek`). Before that, pull the helpers that wave 1 copied into three providers into shared modules.

**Architecture:** Each source is a `ScheduleProvider` in `src/main/providers/<id>/`, on the shared `HttpSource`, the label resolution and the line rules of wave 1. The pure readers (HTML/JSON → records) live apart from the provider class, as in `toe/parse.ts`. Zhytomyr and Chernivtsi bundle their settlement lists through generator scripts. CEK reads its own address map once per run. Two small shared additions serve CEK: a per-house note in the wizard, and DTEK Dnipro's hint pointing to CEK.

**Tech Stack:** Electron 44, electron-vite 6, TypeScript, React 19, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-outage-sources-step2-design.md` (sections «Zhytomyr», «Chernivtsi», «CEK», the shared sections, and «Setup wizard»).
- Research: `docs/superpowers/research/2026-10-20-outage-sources-step2/{zhytomyr,chernivtsi,cek}.md`, with saved responses in `…/<op>-raw/`.
- Wave 1 plan: `docs/superpowers/plans/2026-10-20-outage-sources-step2-wave1.md`. Its rulings R1–R15 are in `.superpowers/sdd/2026-10-20-outage-sources-step2-wave1/progress.md`.

## Global Constraints

- No new runtime or dev dependencies. HTML is parsed with regular expressions, never a DOM library. Windows-1251 is decoded with `new TextDecoder('windows-1251')` over `HttpSource.bytes()`, never `text()`.
- **Network.**
  - All network code goes through `HttpFetch`.
  - Each public provider method wraps its body in `HttpSource.serial` once. Internal steps call unwrapped helpers, because a nested `serial` deadlocks.
  - Every new provider sets `minGapMs: 1000`.
  - POST bodies are `new URLSearchParams(...).toString()`, sent with `Content-Type: application/x-www-form-urlencoded`.
- **Privacy.** A thrown error's message or cause, and every log call, never contains a response body or any part of one. Logged errors go through `loggable`.
- **Fail closed.**
  - An answer of an unknown shape is `ProviderError(«Не вдалося прочитати графік {name}»)`, never all `on`.
  - A group or queue value we do not know is unreadable, never the `'none'` line.
  - Only the shapes each task names count as a quiet day.
- **Address side on refresh.** This rule is decided here so that no task has to rule on it, unlike R2 and R7 in wave 1.
  - All three schedules are oblast-wide or keyed by queue. So for a queue line, a failed address step logs a warning and keeps the saved line, and the snapshot is still delivered (`addressSide`, Task 1).
  - `AddressNotFoundError` is thrown when a list that was read successfully lacks the saved settlement, street or house.
  - For Zhytomyr's `'none'` line, any failure of the address step fails the snapshot (R7).
  - Chernivtsi and CEK have no `'none'` line.
- Saved settings keep their shape. `Address` stores labels only.
- **Copy, exact.**
  - **Request errors.** `sourceTexts('Житомиробленерго')`, `sourceTexts('Чернівціобленерго')` and `sourceTexts('ЦЕК')` give them, so the not-found text for CEK is «Адресу не знайдено у ЦЕК — оберіть її в налаштуваннях заново».
  - **Zhytomyr.** There is no quiet note. The operator's banner is the note when present (Task 2).
  - **Chernivtsi, stale table:** «Чернівціобленерго не опублікувало графік на сьогодні (останній — на DD.MM.YYYY) — зазвичай це означає, що відключень за графіком немає».
  - **Chernivtsi, emergency mode:** the current outage text is «Аварійні відключення — графік не діє».
  - **Chernivtsi lines** and its `groupLabel` read «Група N», never «Черга».
  - **CEK, quiet day:** «ЦЕК не опублікувала графік на сьогодні — зазвичай це означає, що відключень за графіком немає». «ЦЕК» is a компанія, so the verb is feminine; `quietNote` gains the verb `'опублікувала'`.
  - **CEK, a house DTEK switches:** «Цей будинок відключає ДТЕК — оберіть «ДТЕК Дніпровські електромережі»».
  - **DTEK Dnipro, no group:** «Для цього будинку ДТЕК не публікує графік відключень. Якщо ваш будинок обслуговує ЦЕК, оберіть «ПЕЕМ «ЦЕК»»».
- **Cards.** The final `Object.keys(PROVIDERS)` order is `['dtek-kem','voe','dtek-dnem','cek','ztoe','dtek-krem','loe','mkoe','dtek-oem','toe','cvoe']`. That is Kyiv city first, then the oblasts alphabetically, with CEK after DTEK in Дніпропетровська. Each provider task updates the registry order test to the order so far.
- **Fixtures.**
  - Copy them from `…/<op>-raw/` into `tests/fixtures/<id>/`.
  - Read windows-1251 fixtures as raw `Buffer`s. The test router's `arrayBuffer()` returns those bytes, and its `text()` must not be used for them.
  - The Chernivtsi pages from Roma7-7-7/sso-notifier are MIT-licensed. `tests/fixtures/cvoe/README.md` names the source, the licence and the copyright line.
- **Live probes and fixture captures.**
  - They are Node `.mjs` scripts kept in the scratchpad (not in the repo), at least 1 s between requests.
  - Cyrillic never goes into shell literals.
  - Generator scripts go in `scripts/` and check what they write: the expected counts, no duplicate ids, no empty names.
- **Smoke scripts** use `makeSmokeProfile` / `removeSmokeProfile` and never touch `%APPDATA%\Blackout Widget`. Never run the packaged app.
- **Commits.** Subject and body only. Never a `Co-Authored-By` trailer or any Claude or «Generated with» line.

## Review Focus

1. **Zhytomyr just after midnight.** The page still holds only yesterday's table. That must be unreadable, never «світло є» and never yesterday's slots. Test in Task 3.
2. **Chernivtsi tables of other dates.**
   - A table dated before today is the quiet day with the dated note.
   - A default page whose table is dated tomorrow or later is unreadable.
   - A `?next` table dated anything but tomorrow is ignored.
   - Tests in Task 6.
3. **Chernivtsi groups never become an always-on house.** `linesOf` would turn `'8'` into the `'none'` line. So a group outside 1–12, or not an integer, is unreadable. A house on groups 8 and 12 gets the lines «Група 8» and «Група 12». Tests in Task 5.
4. **A house the operator spells two ways.** Zhytomyr's «91-А» and «91А» are one house. Chernivtsi's «буд. 12 а» is the saved «12А». The refresh finds the house whichever spelling the operator uses that day. Tests in Tasks 2, 3, 5 and 6.
5. **The CEK form answering something else.** The empty form page (no heading, no sentinel), a page with both the sentinel and tables, or a Joomla 404 is unreadable, never a quiet day. Test in Task 8.

## Calls made in this plan (to report with the rulings)

1. **Chernivtsi, default page dated tomorrow:** unreadable. Today's table is gone with no stale table to show, and the shape has never been seen.
2. **Chernivtsi, both shapes:** a page with both `#gsv` and the emergency article is unreadable.
3. **CEK, a day with tables but no block for the saved queue:** that queue is all `on`, as in Mykolaiv (Review Focus 6 in wave 1).
4. **CEK, an unknown map value:** it makes that street's house list unreadable, as R15 does, not the whole map.
5. **CEK's quiet note is feminine:** «ЦЕК не опублікувала».
6. **Zhytomyr's banner:** its `<br>` breaks become spaces.
7. **Zhytomyr reads twice per refresh,** following the spec: the schedule by GET, and the house check by the form POST. The POST page also carries the schedule, but the spec names the GET.
8. **Chernivtsi's current outage** matches the street by its set of words, so word order and a leading «вул.» do not matter. Rows of a namesake street therefore never count.

---

### Task 1: Shared provider helpers (M6) and the inneti outage reader

**Files:**
- Create:
  - `src/main/providers/shape.ts`;
  - `src/main/providers/snapshot.ts`;
  - `src/main/providers/inneti.ts`;
  - `src/main/providers/loe/parse.ts` (LOE's address and outage readers, moved out of `loe/index.ts`).
- Modify:
  - `src/main/providers/http-source.ts`, `resolve.ts`;
  - `src/shared/time.ts`;
  - `src/main/providers/{toe,loe,mkoe}/*.ts`;
  - `docs/superpowers/research/2026-10-20-outage-sources-step2/ternopil.md` (the line saying «null or []» now says `null` only, per R4).
- Test:
  - `tests/providers/snapshot.test.ts` and `tests/providers/inneti.test.ts` (both new);
  - additions to `tests/providers/{http-source,resolve,loe-provider}.test.ts` and `tests/shared/time.test.ts` (create it if missing).
  - Existing toe/loe/mkoe/voe tests change **only** in import paths.

**Interfaces:**
- Produces:
  ```ts
  // shape.ts
  export type Obj = Record<string, unknown>;
  export const isObj: (v: unknown) => v is Obj;
  export const isInt: (v: unknown) => v is number;
  /** Base of every provider's «unknown shape» error (ToeShapeError, LoeShapeError, MkoeShapeError extend it). The message is a fixed reason of ours. */
  export class ShapeError extends Error {}
  /** An instant written with its zone (`Z` or `±HH:MM`); a bare wall time or a bad date is undefined. */
  export function instant(v: unknown): Date | undefined;

  // http-source.ts (additions)
  export interface PlainHttpDeps { fetch: HttpFetch; isOnline: () => boolean; log?: Logger; now?: () => Date; sleep?: (ms: number) => Promise<void>; clock?: () => number }
  // class HttpSource:
  /** A ShapeError or QueueValueError from `parse` as unreadable({ what, reason: e.message }); anything else rethrown. */
  read<T>(what: string, parse: () => T): T;

  // time.ts
  export function kyivStamp(d: Date): string; // 'HH:MM DD.MM.YYYY' in Kyiv time

  // resolve.ts (additions)
  export interface Labeled<T> { items: T[]; labels: string[] }
  /** Items in id order (R6: a « (2)» follows its record) with their uniqueLabels; `group` defaults to noGroup. */
  export function labeled<T extends { id: number }>(items: readonly T[], name: (t: T) => string, group?: (t: T) => string | undefined): Labeled<T>;
  export const noGroup: () => undefined;
  export function sortedLabels(labels: readonly string[]): string[]; // localeCompare 'uk'

  // snapshot.ts
  export interface ScheduleDays { days: DaySchedule[]; sourceUpdatedAt?: string; note?: string }
  /** The spec's line rules: the saved queue not in `lines` → today 'unknown'; the 'none' line → today 'on'; else `schedule()`. */
  export function daysForLine(lines: readonly LineInfo[], groupId: string, today: string, schedule: () => Promise<ScheduleDays>): Promise<ScheduleDays>;
  /** The snapshot; optional fields only when set (no `sourceUpdatedAt: undefined` keys). */
  export function snapshotOf(p: { providerId: string; address: Address; now: Date; groupLabel: string; lines: LineInfo[]; currentOutage?: CurrentOutage } & ScheduleDays): ScheduleSnapshot;
  /** A refresh's address step. AddressNotFoundError always rethrows; for groupId 'none' anything rethrows; otherwise log.warn(`${what} failed, keeping the saved line`, loggable(e)) and undefined. */
  export function addressSide<T>(groupId: string, log: Logger, what: string, step: () => Promise<T>): Promise<T | undefined>;
  /** A step that never fails the snapshot: log.warn(`${what} failed`, loggable(e)) and undefined. */
  export function bestEffort<T>(log: Logger, what: string, step: () => Promise<T | undefined>): Promise<T | undefined>;

  // inneti.ts: the inneti «poweron» APIs (Тернопіль, Житомир). Hydra lists; stamps are Kyiv wall clock labelled Z/+00:00.
  export interface Place { cityId: number; streetId: number }
  export interface OutageRow { kind: CurrentOutage['kind']; text: string; houses: string[]; start: string; end?: string }
  /** How a source reads a `pw_accidents` row's `switchSubReason`: its kind and text, or undefined to skip the row. */
  export type SubReason = (value: unknown) => Pick<OutageRow, 'kind' | 'text'> | undefined;
  export function accidentRows(body: unknown, place: Place, subReason: SubReason): OutageRow[];
  export function plannedRows(body: unknown, place: Place): OutageRow[]; // kind 'planned', text 'Планові роботи'
  /** Running now (start ≤ now ≤ end; a row without an end counts once started unless it is planned); emergency > planned > other. */
  export function currentOutageOf(rows: readonly OutageRow[], house: string, now: Date, sameHouse?: (a: string, b: string) => boolean): CurrentOutage | undefined;
  export function wallStamp(iso: string | null | undefined): string | undefined;
  export function wallInstant(iso: string | null | undefined): Date | undefined;
  ```
- **Moves only.** Move only copies that are identical in all three providers. Do not unify `members()`: loe accepts an array or Hydra, and toe accepts Hydra with `null`. Every log message stays byte-identical.
- **Ternopil's `SubReason`:** `v === 2 ? undefined : { kind: 'emergency', text: 'Аварійне відключення' }`. Its behaviour is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `snapshot.test.ts`:
    - `daysForLine([Черга 1.2], '5.1', …)` gives today 48 × `unknown` and never calls `schedule`.
    - `daysForLine([none], 'none', …)` gives today 48 × `on` and never calls `schedule`.
    - With `[1.2]` and `'1.2'`, it returns `schedule()`'s result.
    - `snapshotOf` without a note has no `note` key.
    - `addressSide`:
      - `AddressNotFoundError` rethrows for a queue line.
      - A `ProviderError` rethrows for `'none'`.
      - For `'1.2'` it gives `undefined` and one `warn` whose arguments contain no response text.
  - `inneti.test.ts`, with a ZTOE-like `SubReason` (0 → emergency, 1 → other «Відключення за операційною безпекою»):
    - A running sub-1 row without `datePlanIn` counts.
    - An emergency outranks a planned row, which outranks an `other` row, whatever their order.
    - `sameHouse` decides the house match.
    - The Ternopil fixtures give the same results as before (copy the existing cases).
  - `time.test.ts`: `kyivStamp(new Date('2026-10-20T10:09:00Z')) === '13:09 20.10.2026'`.
  - `resolve.test.ts`:
    - `labeled([{id:5,name:'A'},{id:2,name:'A'}], x => x.name)` gives the items `[2,5]` and the labels `['A','A (2)']`.
    - Two items sharing name and group, with a saved «A (G)», throw `AddressNotFoundError`.
    - A group suffix that differs only by U+2019 vs U+0027 resolves.
  - `http-source.test.ts`:
    - `read('x', () => { throw new ShapeError('bad') })` gives `ProviderError(texts.unreadable)` with cause `{ what: 'x', reason: 'bad' }`.
    - A plain `Error` rethrows as it is.
  - `loe-provider.test.ts`: a `pw_accidents` row whose `datePlanIn` is present but not an instant (`'скоро'`) is skipped, not treated as open-ended.
- [ ] **Step 2: Run them; they fail** (modules missing). `npx vitest run tests/providers/snapshot.test.ts tests/providers/inneti.test.ts`
- [ ] **Step 3: Implement.**
  - Create the modules and move the copies.
  - `ToeShapeError`, `LoeShapeError` and `MkoeShapeError` stay, as `extends ShapeError`.
  - Each provider's private `read` becomes `this.http.read`.
  - Ternopil's outage readers and `wallStamp`/`wallInstant` move to `inneti.ts`.
  - LOE's readers move to `loe/parse.ts`.
  - The three providers use `labeled`, `sortedLabels`, `snapshotOf`, `daysForLine` (mkoe keeps its own unknown-queue branch in front of it) and `bestEffort`.
  - loe and mkoe use `addressSide` for their soft steps. Ternopil's precheck stays hard (R2), so it does not use it.
- [ ] **Step 4: Run everything.** `npm test` passes, with the count reported, and `npm run typecheck` is clean. Show `git diff --stat tests/`: the existing test files changed only in imports.
- [ ] **Step 5: Commit.** «Providers: shared shape, label, snapshot and inneti helpers (one copy each)»

### Task 2: Zhytomyr settlements and page readers

**Files:**
- Create:
  - `scripts/gen-ztoe-settlements.mjs`;
  - `src/main/providers/ztoe/settlements.data.json`, `settlements.source.md`, `settlements.ts`;
  - `src/main/providers/ztoe/page.ts`;
  - `src/main/providers/html.ts`.
- Modify: `src/main/providers/names.ts` (add `houseKey`)
- Fixtures: `tests/fixtures/ztoe/`, raw bytes.
  - Copy the three `unhooking-search-*` pages and both `address-result-*-all`/`berezivka` fragments, plus the `-first10` fragment.
  - **Capture live** with a Node script: `post-rem5-ns16205-cp1251.html` (POST `rem_id=5&naspunkt_id=16205`: the street select) and `post-rem5-ns16205-st168893-all-cp1251.html` (POST `…&vulica_id=168893&all=1`). Save them as received.
- Test: `tests/providers/ztoe-page.test.ts`, `tests/providers/ztoe-settlements.test.ts`, `tests/providers/names.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  // html.ts
  export function decodeEntities(s: string): string; // &amp; &lt; &gt; &quot; &nbsp; &#039; &#NN; &#xNN;
  /** A fragment as text: <br> → space, tags dropped, entities decoded, whitespace collapsed, trimmed. */
  export function htmlText(fragment: string): string;

  // names.ts
  /**
   * The key two spellings of one house share:
   * - drop a leading «буд.»/«буд»/«сад.»/«сад»;
   * - Latin look-alikes → Cyrillic, upper case;
   * - drop quotes ("'«»“”„’ʼ);
   * - drop any run of [\s\-._,] between a digit and a letter;
   * - drop the remaining whitespace.
   * «/» and other hyphens are kept.
   */
  export function houseKey(s: string): string;

  // ztoe/settlements.ts
  export interface ZtoeSettlement { label: string; id: number; name: string; remId: number; rem: string }
  export function ztoeSettlements(): ZtoeSettlement[]; // labels via labeled(name, s => `${s.rem} РЕМ`), then sorted by label ('uk'); cached

  // ztoe/page.ts (throws ZtoeShapeError extends ShapeError; QueueValueError for a queue cell)
  export function decodeCp1251(bytes: ArrayBuffer): string;
  export interface ZtoeSchedule { updatedAt: string /* 'HH:MM DD.MM.YYYY' */; banner?: string; days: Map<string /* YYYY-MM-DD */, Record<string, Slot[]>> }
  export function parseZtoeSchedule(html: string): ZtoeSchedule;
  export function parseOptions(html: string, select: 'rem_id' | 'naspunkt_id' | 'vulica_id'): { id: number; name: string }[];
  export interface ZtoeRow { houses: string[]; queue: string /* 'N.M' | 'none' */; household: boolean }
  export function parseResultRows(html: string): ZtoeRow[];
  export function ztoeHouses(rows: readonly ZtoeRow[]): HouseInfo[];
  ```
- The data file holds `{ id, name, remId, rem }[]`, sorted by id. `name` is entity-decoded and trimmed. `rem` is the select's text («Хорошівський»).

Rules (`zhytomyr.md` §1–§2):
- **`parseZtoeSchedule`.**
  - The stamp is `/Дата оновлення інформації\s*-\s*(\d{2}):(\d{2})\s+(\d{2})\.(\d{2})\.(\d{4})/`. If it is missing, the reader throws (this also catches mojibake).
  - A date table is a `<table` segment holding `<b style="font-size:12pt;">DD.MM.YYYY</b>`.
  - In each date table:
    - Exactly 12 data rows, labelled (`color:black;">N.M</b>`) `1.1, 1.2, 2.1 … 6.2` in that order.
    - Each row has exactly 48 `background:\s*#xxxxxx` cells. `#ffffff` → `on` and `#ff3333` → `off`, case-insensitive. Any other colour throws.
    - The label cells use the word `white` and do not count.
  - A repeated date throws. Every date table is checked, whatever its date.
  - **`banner`** is the `<h3>` that starts «УВАГА! ВАЖЛИВА ІНФОРМАЦІЯ!». Take its `htmlText` without that heading and without the trailing «Пошук черги та підчерги за адресою». It is `undefined` when that leaves nothing or there is no such `<h3>`.
- **`parseOptions`.**
  - Read the options of `<select name="{select}"…>`, excluding value `0`. Names are `htmlText`.
  - A missing select, or a `disabled` one, throws. A select holding only option 0 gives `[]`.
- **`parseResultRows`.**
  - «За Вашим запитом знайдено записів: N» must be present, and N must equal the count of 7-cell data rows.
  - Any `name="all"` button (a pager) throws.
  - The note cell must be «побутові споживачі» (household) or «непобутові (юридичні) споживачі».
  - Queue and sub-queue cells:
    - both digits → `'Q.S'`;
    - both exactly «В цей час не вимикається, за винятком випадків аварійних відключень» → `'none'`;
    - anything else → `QueueValueError`.
  - Houses are the cell split on `,`, trimmed, with empties dropped.
- **`ztoeHouses`.**
  - Group houses by `houseKey`; the shown text is the first spelling in row order.
  - A house's lines come from `linesOf` of its household rows' queues. When it has no household row, its legal rows' queues are used instead.
  - Order the houses with `Intl.Collator('uk', { numeric: true })`. `outageActive: false`.
- **Generator.**
  - It GETs the page for the `rem_id` list (it must hold 19 REMs), then POSTs `rem_id=N` for each, 1 s apart. It reads `naspunkt_id` with the same option rules and writes the data file and the source note.
  - It fails if a REM has no settlements, ids repeat, or the total is outside 1,700–1,800.
  - If the site is unreachable, build the data from `zhytomyr-raw/settlements-by-rem-2026-10-20.json` and say so in the source note.

- [ ] **Step 1: Write the failing tests.**
  - **`names.test.ts`.** `houseKey` maps:
    - `'буд. 12-А'`, `'12 а'`, `'12.А'`, `'12,А'`, `'12 "Б"'`→`'12Б'`, `'50A'` (Latin) → `'50А'`;
    - `'16-А'` and `'16А'` to the same key;
    - `'108/56-а'` → `'108/56А'`;
    - and keeps `'9/9'`, `'9-9'`, `'74/А'`, `'ТП-334'` and `'001'` as they are.
  - **`ztoe-page.test.ts`.**
    - **The 20.10 live page:**
      - `updatedAt === '17:00 20.10.2026'`;
      - one day, `'2026-10-20'`;
      - `1.1` is off in slots 28–33 and 44–47 and on elsewhere;
      - 118 `off` slots over all 12 rows;
      - `banner` starts «На 12:30 20.10.2026р. НЕК "Укренерго"», ends «з 22:00 до 24:00 - 1,0 черга», and holds no `<`, `&quot;` or «Пошук черги».
    - **The 13.10 page:** the days `2026-10-13` and `2026-10-14`, `updatedAt '22:30 13.10.2026'`, and 230 `off` slots in all.
    - **The 26.04 page:** 576 `on`, and a banner containing «не надходило».
    - **Throws:** a row with 47 cells; a `#ff0000` cell; rows out of order; a missing stamp; the same date twice.
    - **`parseOptions(streetsPage, 'vulica_id')`** gives Вишнева 168893, Садова 168894, Центральна 168895 and КТП-2 169498, in page order. On the plain GET page, `'vulica_id'` throws (disabled).
    - **`parseResultRows` on Київська-all** gives 77 rows. On `-first10` it throws (pager).
    - **`ztoeHouses` on Київська-all:**
      - «84» → `[1.1]`;
      - «56» → `[3.1, 6.2]`;
      - «77» (legal rows only) → `[1.1, 3.2]`;
      - «72» → the `'none'` line;
      - «91-А» and «91А» → one house shown «91-А», with the `'none'` line;
      - «1» → `[1.1, 1.2, 5.2]`.
    - **Berezivka:** «18» (legal only) → `[5.1]`.
    - A queue cell «5а» throws `QueueValueError`.
  - **`ztoe-settlements.test.ts`:**
    - the count is between 1,700 and 1,800, and labels are unique;
    - no label contains `&#` or has outer spaces;
    - `'місто Житомир'` (16657, rem 7) is present;
    - both «місто Андрушівка» entries carry their REM: `'місто Андрушівка (Андрушівський РЕМ)'` and `'місто Андрушівка (Попільнянський РЕМ)'`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Run the generator and implement.**
- [ ] **Step 4: Run them; they pass.** Also run `npm run typecheck`.
- [ ] **Step 5: Commit.** «Zhytomyr: bundled settlements (19 РЕМ) and the page readers»

### Task 3: Zhytomyr provider (`ztoe`)

**Files:**
- Create: `src/main/providers/ztoe/index.ts`, `src/main/smoke-ztoe.ts`
- Fixtures: add to `tests/fixtures/ztoe/`:
  - `inneti-pw_otgs.json`, `inneti-pw_streets-city2622.json`, `inneti-pw_accidents-city2622-berezivka.json` and `inneti-pw_accident_planeds-first5.json`;
  - **captured live:** `inneti-pw_cities-otg5-Березівка.json` (`pw_cities?pagination=false&otg.id=5&name=Березівка`).
- Modify: `src/shared/providers.ts` (the `ztoe` entry), `src/main/providers/registry.ts`, `electron.vite.config.ts`, `tests/providers/registry.test.ts`
- Test: `tests/providers/ztoe-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 (all) and Task 2 (all).
- Produces: `export class ZtoeProvider implements ScheduleProvider { readonly id = 'ztoe'; constructor(deps: PlainHttpDeps) }`.
- `PROVIDERS.ztoe` is `{ name: 'Житомиробленерго', shortName: 'Житомиробленерго', region: 'Житомирська область', siteUrl: 'https://www.ztoe.com.ua/unhooking-search.php' }`, placed between `dtek-dnem` and `dtek-krem` (Task 8 puts `cek` in front of it). The order test becomes `['dtek-kem','voe','dtek-dnem','ztoe','dtek-krem','loe','mkoe','dtek-oem','toe']`.

Behaviour. `SITE = 'https://www.ztoe.com.ua/unhooking-search.php'`; `INNETI = 'https://api-ztoe-poweron.inneti.net/api'`. Every page is `decodeCp1251(await http.bytes(…))`.
- **`listCities`** returns the bundle's labels, with no request.
- **`listStreets(city)`.** Resolve the settlement in the bundle. POST `rem_id&naspunkt_id`, then `parseOptions(…, 'vulica_id')` → `labeled` → `sortedLabels`. Cache per settlement id for the run.
- **`listHouses(city, street)`.** POST `rem_id&naspunkt_id&vulica_id&all=1` → `parseResultRows` → `ztoeHouses`. Cache per street id for the run, so the wizard's previews do not fetch it again.
- **`fetchSnapshot(a)`.**
  1. The settlement comes from the bundle. If it is gone, throw `AddressNotFoundError`.
  2. Run the house check inside `addressSide(a.groupId, …, 'ztoe fetchSnapshot: address check')`:
     - resolve the street id (from the run-cached list);
     - POST with `all=1` again, never from the cache;
     - find the house by `houseKey(a.house)`; if it is missing, throw `AddressNotFoundError`;
     - the house's lines are the result.
     - The saved line is used when the check gives `undefined`.
  3. `daysForLine(lines, a.groupId, today, schedule)`. The `schedule` step:
     - GET `SITE` and run `parseZtoeSchedule`.
     - **Today's table is required:** without it the snapshot is unreadable. This holds just after midnight too (Review Focus 1).
     - Tomorrow is included when its table is there.
     - `sourceUpdatedAt = updatedAt` and `note = banner`.
     - An all-white table is plain `on`, with no quiet note.
  4. `currentOutage` comes from `bestEffort(log, 'ztoe fetchSnapshot: current outage lookup', …)`, an inneti join by name:
     - **The otg.** `pw_otgs?pagination=false` (cached for the run). The otg whose `nameKey(name)` without a trailing «РЕМ» equals `nameKey(settlement.rem)`.
     - **The cities.**
       - Take the bare name: the settlement name without a leading `с.`, `село`, `селище`, `смт`, `м.`, `місто` or `с-ще`. A name starting «с/рада» gives no lookup.
       - Then `pw_cities?pagination=false&otg.id=<otg>&name=<bare, URI-encoded>`.
     - **The street.** For each city, `pw_streets?pagination=false&city.id=<id>` and the streets with `nameKey(name) === nameKey(a.street)`.
       - Exactly one (city, street) pair is the place. Zero or several give no outage.
       - Cache the place, or its absence, for the run, per address.
     - **The outages.**
       - `pw_accidents?page=1&city.id=&street.id=`, through `accidentRows` with Zhytomyr's `SubReason`:
         - 0 → emergency «Аварійне відключення»;
         - 1 → `other` «Відключення за операційною безпекою»;
         - anything else is skipped (2 repeats the schedule).
       - `pw_accident_planeds?page=1&city.id=&street.id=`, through `plannedRows`.
       - The house is matched with `currentOutageOf(…, (x, y) => houseKey(x) === houseKey(y))`.
     - Send `Accept: application/ld+json`.
  5. `snapshotOf(…, groupLabel: queueLabel(a.groupId))`.

- [ ] **Step 1: Write the failing tests.** The router is keyed by method, path and form body. Pin the clock per test.
  - `listStreets('с. Березівка')` POSTs `rem_id=5&naspunkt_id=16205`. Read the label for 16205 from the bundle, and add its REM if it has namesakes.
  - `listHouses` POSTs `…&all=1`. The second call for the same street makes no request.
  - **The 20.10 schedule.** `fetchSnapshot` for Березівка / вул. Вишнева / «1», line `5.1`, at 2026-10-20 12:00 Kyiv:
    - today's slots match the 20.10 page's `5.1`;
    - `sourceUpdatedAt === '17:00 20.10.2026'`;
    - `note` is the banner.
  - **(Review Focus 1.)** At 2026-10-21 00:10, with the 20.10 page, the snapshot is unreadable.
  - **(Review Focus 4.)** A saved house «91А» on Київська resolves to the row written «91-А».
  - **The `'none'` line.** Saved `'none'` on Київська «72»: today all `on`, and `unhooking-search.php` is never GET.
  - **A failed house check.**
    - For line `5.1`, a rejected POST still delivers the schedule with the saved line and logs one warn.
    - For `'none'`, a rejected POST fails the snapshot.
  - **A house gone** (rows read fine) throws `AddressNotFoundError`.
  - **A moved queue.** Saved `3.1` where the rows say `5.1`: today is `unknown`, and `lines` is `[Черга 5.1]`.
  - **Current outage at 2026-10-20 14:00** for Березівка / вул. Вишнева / «1»: `emergency`, start «11:15 20.10.2026», end «17:00 20.10.2026». At 18:00 there is none.
  - **A rejected `pw_accidents`** still delivers the schedule.
  - **Encoding.** The router answers the schedule as raw cp1251 bytes, and the snapshot's banner is readable Cyrillic.
  - The order test is updated.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** `index.ts`, the `PROVIDERS` entry and the registry line.
- [ ] **Step 4: Write `smoke-ztoe.ts`,** shaped like `smoke-mkoe.ts`.
  - It goes `listCities` → «місто Житомир» → `listStreets` → the first street with houses → a house → `fetchSnapshot`, then repeats for «с. Березівка» → «вул. Вишнева».
  - It prints each request's path and status, and whether the stamp was found (that proves windows-1251 decodes in Electron).
  - Add it to `electron.vite.config.ts`.
- [ ] **Step 5: Verify.**
  - `npx vitest run tests/providers` and `npm run typecheck` pass.
  - Then `npm run build` and `npx electron out/main/smoke-ztoe.js`. It must exit 0 with a snapshot. Record the output.
- [ ] **Step 6: Commit.** «Zhytomyr: schedule, address lookup and current outages from Житомиробленерго»

### Task 4: Chernivtsi settlement index (bundled)

**Files:**
- Create:
  - `scripts/gen-cvoe-settlements.mjs`;
  - `src/main/providers/cvoe/settlements.data.json`, `settlements.source.md`, `settlements.ts`.
- Test: `tests/providers/cvoe-settlements.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** The search pages' district ids: 1 is the city (no settlement column), 2–12 the operator's дільниці. */
  export const CVOE_DISTRICTS: Record<number, string>;
  // 1 'ЧЕРНІВЦІ', 2 'Вижницька', 3 'Герцаївська', 4 'Глибоцька', 5 'Заставнівська', 6 'Кіцманська',
  // 7 'Кельменецька', 8 'Новоселицька', 9 'Путильська', 10 'Сокирянська', 11 'Сторожинецька', 12 'Хотинська'
  export interface CvoeSettlement { label: string; district: number; name: string }
  /** Labels via uniqueLabels(name, s => s.district === 1 ? undefined : `${CVOE_DISTRICTS[s.district]} дільниця`), sorted by label ('uk'); cached. */
  export function cvoeSettlements(): CvoeSettlement[];
  ```
- The data file holds `{ district, name }[]`. District 1 has exactly one entry, `name: 'м. Чернівці'`.

**Generator** (`chernivtsi.md` §2):
- GET `https://oblenergo.cv.ua/shutdowns-search/{N}/` for N = 2…12, at least 1.2 s apart.
- Read the `<s>` settlement of every row in `#obl_tbl`. Take its text, trimmed and with single spaces.
- Group per district by a key that copies `nameKey`'s rules exactly: the same Latin table, the same apostrophe fold, single spaces, lower case.
- The shown name is the spelling with the most rows; ties go to the first one seen.
- Add `{ district: 1, name: 'м. Чернівці' }`.
- It fails when a page has no `#obl_tbl` or no rows, a name is empty, or a (district, key) pair repeats.
- The source note records the date, the row and settlement counts per district, and how to regenerate.
- It is a live-only script: there is no fixture fallback, because the research saved only trimmed pages. If the site is unreachable, report it as a blocker.

- [ ] **Step 1: Write the failing tests.**
  - The count is between 400 and 650, and labels are unique with no outer or double spaces.
  - Exactly one entry has `label === 'м. Чернівці'` and `district: 1`.
  - The entries whose `nameKey(name)` is `nameKey('с. Остриця')` are in districts 3 and 8, labelled «… (Герцаївська дільниця)» and «… (Новоселицька дільниця)».
  - No two entries of one district share a `nameKey`.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Run the generator and implement `settlements.ts`.**
- [ ] **Step 4: Run them; they pass.** Also run `npm run typecheck`.
- [ ] **Step 5: Commit.** «Chernivtsi: the bundled settlement index (12 дільниць)»

### Task 5: Chernivtsi readers

**Files:**
- Create: `src/main/providers/cvoe/parse.ts`
- Fixtures: `tests/fixtures/cvoe/`.
  - Copy all of `chernivtsi-raw/` except the district-list shell.
  - Add `README.md` with the MIT notice.
- Test: `tests/providers/cvoe-parse.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ShapeError`) and Task 2 (`houseKey`, `htmlText`).
- Produces (throws `CvoeShapeError extends ShapeError`):
  ```ts
  export type CvoePage =
    | { kind: 'table'; date: string /* YYYY-MM-DD */; updatedHM: string /* HH:MM */; groups: Record<string, Slot[]>; nextLink: boolean }
    | { kind: 'emergency' };
  export function parseCvoePage(html: string): CvoePage;
  export interface CvoeRow { settlement?: string; street: string; house: string; group: string }
  export function parseDistrictPage(html: string, district: number): CvoeRow[];
  /** Distinct groups as lines «Група N»; each must be an integer 1–12, anything else throws. Numeric order, index from 1. */
  export function groupLines(groups: readonly string[]): LineInfo[];
  export const groupLabel: (groupId: string) => string; // `Група ${groupId}`
  /** Streets of one settlement: grouped by nameKey; shown as the spelling with the most rows (ties: first seen). */
  export function cvoeStreets(rows: readonly CvoeRow[]): string[];
  /** Houses of one street: grouped by houseKey; shown as the first spelling without «буд.»/«сад.»; lines via groupLines. */
  export function cvoeHouses(rows: readonly CvoeRow[]): HouseInfo[];
  export interface CvoeOutageRow { settlement: string; street: string; houses: string[]; start: string; end: string /* 'YYYY-MM-DD HH:MM:SS' */ }
  /** The current-outage reply: rows and the last page number. «Нічого не знайдено» → no rows; required_error or anything else throws. */
  export function parseOutageReply(body: unknown): { rows: CvoeOutageRow[]; pages: number };
  /** Word sets for matching across the two forms: nameKey, split on anything but letters and apostrophes, empties dropped. */
  export function streetWords(s: string): string[]; // also drops a leading «вул»/«вулиця»; sorted
  export function placeWords(s: string): string[];  // drops leading м/с/смт/селище/село/місто/ще tokens; sorted
  ```

Rules:
- **`parseCvoePage`.**
  - **`#gsv` present:**
    - The date comes from `<ul>\s*<p>\s*DD.MM.YYYY`.
    - `updatedHM` comes from «станом на <b>HH:MM</b>» in `#gsv_a`.
    - There must be exactly 12 `div#infN[data-id=N]`, N = 1–12. Each body is exactly 48 tokens from `<u>з</u>` (on), `<o>в</o>` (off) and `<s>мз</s>` (maybe-off), with only whitespace between them.
    - The time header also uses `<u>`, so only the `inf` divs are read.
    - `nextLink` is whether `href="/shutdowns/?next"` occurs.
  - **No `#gsv`, but an `article` whose class has `wrap_article_v2_emergency`:** `{ kind: 'emergency' }`.
  - **Both shapes, or neither:** throw.
- **`parseDistrictPage`.**
  - The container is `#city_tbl` for district 1 and `#obl_tbl` for the others, after its `h_line` header.
  - City rows are `<div><p>street</p><b>house</b><u>group</u></div>`. District rows have `<s>settlement</s>` first.
  - Values are `htmlText`.
  - A row element of another shape inside the container throws. An empty container throws.
  - Group text is kept raw: `groupLines` judges it per street, so one odd row breaks only its street.
- **`cvoeHouses`.** Exact duplicate rows count once. Use the numeric `uk` collator.
- **`parseOutageReply`.**
  - The body must be an object with a string `data` holding `<tbody>`.
  - A row has 6 `<td>`:
    - published;
    - district;
    - settlement (`htmlText`);
    - address: the street is the `htmlText` before `,<br>`, and the houses are the `<span>` split on `,`;
    - off and on, both `YYYY-MM-DD HH:MM:SS`, else throw.
  - The pager row (`shop_pages`) gives `pages` = the largest `data-page`, or 1.

- [ ] **Step 1: Write the failing tests.**
  - **Page `2025-11-05` (the `?next` view):**
    - `date '2025-11-05'` and `updatedHM '20:00'`;
    - 52 `off` and 22 `maybe-off` slots in total;
    - group 12 is `maybe-off` in slot 30, `off` in 31–35, and `maybe-off` in 36.
  - **Page `2025-10-31`:** `nextLink: false` and group 12's slot 27 is `maybe-off`.
  - **The live page:** `date '2026-10-18'` and all `on`.
  - **The emergency page** gives `{ kind: 'emergency' }`.
  - **Throws:** a group with 47 cells; a `<b>з</b>` cell; a missing `inf7`; the emergency article added to a table page.
  - **District 3:** the first row is `{ settlement: 'с. Остриця', street: 'вул. Кишинівська', house: 'буд. 12', group: '1' }`.
  - **District 1:** rows have no settlement.
  - **`groupLines`:**
    - `['8','12','8']` → «Група 8», «Група 12»;
    - **(Review Focus 3)** `['13']`, `['А']`, `['']` and `['8.1']` throw.
  - **`cvoeHouses`.** Rows `буд. 12А`/`8`, `12 а`/`12` and `буд. 12-А`/`8` give one house `12А` with lines «Група 8», «Група 12».
  - **`parseOutageReply`:**
    - The planned fixture gives a КАДЕНЮКА ЛЕОНІДА row, with houses including `буд. 22А` and start `'2026-10-21 09:00:00'`, and `pages` from its pager.
    - The empty fixture gives `{ rows: [], pages: 1 }`.
    - The `required_error` fixture throws.
  - **`streetWords`:** «вул. КАДЕНЮКА ЛЕОНІДА» equals «КАДЕНЮКА ЛЕОНІДА» and differs from «вул. КАДЕНЮКА ЛЕОНІДА ПРОВ.». «ПРОВ. КАДЕНЮКА ЛЕОНІДА» equals the last one. A Latin `I` folds.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Also run `npm run typecheck`.
- [ ] **Step 5: Commit.** «Chernivtsi: readers for the schedule page, district pages and outage replies»

### Task 6: Chernivtsi provider (`cvoe`)

**Files:**
- Create: `src/main/providers/cvoe/index.ts`, `src/main/smoke-cvoe.ts`
- Modify: `src/shared/providers.ts` (the `cvoe` entry, last), `registry.ts`, `electron.vite.config.ts`, `tests/providers/registry.test.ts`
- Test: `tests/providers/cvoe-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 (`houseKey`, `htmlText`), 4 and 5.
- Produces: `export class CvoeProvider implements ScheduleProvider { readonly id = 'cvoe'; constructor(deps: PlainHttpDeps) }` and `export function cvoeStaleNote(dateKey: string): string` (the copy in Global Constraints, date as DD.MM.YYYY).
- `PROVIDERS.cvoe` is `{ name: 'Чернівціобленерго', shortName: 'Чернівціобленерго', region: 'Чернівецька область', siteUrl: 'https://oblenergo.cv.ua/shutdowns/' }`. The order test becomes `[…,'toe','cvoe']`.

Behaviour (`chernivtsi.md` §1–§3). The base is `https://oblenergo.cv.ua`.
- **`listCities`** returns the bundle's labels, with no request.
- **The district page.** `GET /shutdowns-search/{district}/`, through `parseDistrictPage`. Cache the parsed rows per district for the run, set only on success.
  - For district 1, all rows belong to «м. Чернівці».
  - Otherwise a row belongs to the settlement when `nameKey(row.settlement) === nameKey(entry.name)`.
- **`listStreets` and `listHouses`** come from those rows: `cvoeStreets`, then `sortedLabels`, and `cvoeHouses`. A street is found by `nameKey`.
- **`fetchSnapshot(a)`.**
  1. The settlement comes from the bundle (or `AddressNotFoundError`).
  2. Run the house check inside `addressSide`, against the run-cached rows. Find the street by `nameKey` and the house by `houseKey`. If either is missing, throw `AddressNotFoundError`. The lines come from `groupLines`, so an odd group makes the check unreadable.
  3. **The schedule.** `GET /shutdowns/` → `parseCvoePage`.
     - **Emergency.** Today is 48 × `unknown`, `currentOutage = { kind: 'emergency', text: 'Аварійні відключення — графік не діє' }`, and no outage lookup. `lines` stays as checked, so the saved line is in it and «лінія змінилась» does not fire.
     - **A table dated today.** The saved group's slots (through `daysForLine`), `sourceUpdatedAt = updatedHM + ' ' + the table date`. When `nextLink` is set, GET `/shutdowns/?next`: a table dated tomorrow is tomorrow, and any other date is ignored. Its failure fails the snapshot.
     - **A table dated before today.** Today is all `on`, `note = cvoeStaleNote(date)`, with no `sourceUpdatedAt` and no tomorrow.
     - **A table dated tomorrow or later** is unreadable (call 1).
     - A moved group is handled by `daysForLine`: today `unknown`.
  4. **Current outage** (not in emergency mode): `bestEffort`.
     - POST `/shutdowns/planovi_avarijni_result.php` with:
       - `v_type` 0 (emergency, text «Аварійне відключення»), then 1 (planned, «Планові роботи»);
       - `v_diln` from `FORM_DISTRICT = {1:1, 2:6, 3:2, 4:12, 5:10, 6:7, 7:11, 8:5, 9:3, 10:8, 11:4, 12:9}`;
       - `v_city` = the longest word of `placeWords(entry.name)`, and `v_street` = the longest word of `streetWords(a.street)`. If either is shorter than 3 letters, there is no lookup;
       - `v_house` = the leading digits of `a.house`, left out when there are none;
       - `v_date` = today as DD.MM.YYYY, `v_sort_field=4`, `v_sort_type=0`, `v_page=N`;
       - the header `x-requested-with: XMLHttpRequest`.
     - Read pages 1…`pages`. More than 5 pages gives no outage (logged).
     - **A row counts when:**
       - `placeWords(row.settlement)` equals `placeWords(entry.name)`;
       - `streetWords(row.street)` equals `streetWords(a.street)`;
       - a house token has `houseKey` equal to `houseKey(a.house)`;
       - and `start ≤ now < end`, both read as Kyiv wall clock.
     - Emergency wins.
  5. `snapshotOf(…, groupLabel: groupLabel(a.groupId))`.

- [ ] **Step 1: Write the failing tests.** Build the page variants in the tests from the fixtures by string replacement:
  - a default page with `<b>DD.MM.YYYY</b><a href="/shutdowns/?next">…</a>` in `#gsv_t`;
  - a `?next` page whose date is set to the day wanted;
  - a district-1 page holding the rows of the streets a test needs, in the trimmed fixture's frame. The trimmed fixture ends before «К».

  The cases:
  - **Today's table.** With the 2025-11-05 table as the default page at 2025-11-05 12:00, line 12 gives the parsed slots and `sourceUpdatedAt '20:00 05.11.2025'`.
  - **Tomorrow.** On 2025-11-04 at 21:00, a default page dated 04.11 with `nextLink` and a `?next` dated 05.11 give two days. A `?next` dated 04.11 gives only today.
  - **(Review Focus 2.)**
    - The live page (18.10) at 2026-10-20 gives a quiet day with `note === cvoeStaleNote('2026-10-18')` = «… (останній — на 18.10.2026) …».
    - A default page dated tomorrow is unreadable, and so is one dated the day after.
  - **Emergency mode.** Today is all `unknown`, the outage is emergency with the exact text, `lines` contains the saved line, and the outage form is never POSTed.
  - **A failed district page** keeps the saved line and logs one warn.
  - **A house gone** from rows that were read throws `AddressNotFoundError`.
  - **(Review Focus 4.)** A saved «12А» matches a row `буд. 12 а`.
  - **Current outage.** At 2026-10-21 10:00, «м. Чернівці» / «КАДЕНЮКА ЛЕОНІДА» / «22А» with the planned fixture gives `planned`, start «09:00 21.10.2026», end «20:00 21.10.2026». The same house on «КАДЕНЮКА ЛЕОНІДА ПРОВ.» gives none.
  - **A `required_error` reply** gives no outage and the schedule still comes.
  - **The POST body** has `v_diln=1` for district 1 and `v_diln=2` for district 3.
  - The order test is updated.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement** `index.ts`, the `PROVIDERS` entry and the registry line.
- [ ] **Step 4: Write `smoke-cvoe.ts`.**
  - It goes «м. Чернівці» → a street → a house → `fetchSnapshot`, then one oblast settlement the same way.
  - It prints each request's path, status, bytes and duration, and the parsed page kind and date.
  - Add it to `electron.vite.config.ts`.
- [ ] **Step 5: Verify.** The vitest suites and `npm run typecheck` pass. Then `npm run build` and `npx electron out/main/smoke-cvoe.js`: exit 0. Report any Cloudflare block, which is a 403 or an «Attention Required» page.
- [ ] **Step 6: Commit.** «Chernivtsi: schedule, address lookup and current outages from Чернівціобленерго»

### Task 7: Wizard: a house's own note, and a provider's hint for houses without lines

**Files:**
- Modify:
  - `src/shared/types.ts` (`HouseInfo.note?`);
  - `src/shared/providers.ts` (`ProviderInfo.noLinesHint?`, `providerNoLinesHint`, and the hint on `dtek-dnem`);
  - `src/renderer/src/app/SetupWizard.tsx`.
- Test: `tests/renderer/setup-wizard.test.tsx`

**Interfaces:**
- Produces:
  - `HouseInfo.note?: string`: the source's own word on this house. The wizard shows it in place of the empty-lines note.
  - `ProviderInfo.noLinesHint?: string` and `providerNoLinesHint(id): string | undefined`.
  - `PROVIDERS['dtek-dnem'].noLinesHint = 'Якщо ваш будинок обслуговує ЦЕК, оберіть «ПЕЕМ «ЦЕК»»'`.

- [ ] **Step 1: Write the failing tests.**
  - **A house note.** A house with `lines: []` and `note: 'Цей будинок відключає ДТЕК — оберіть «ДТЕК Дніпровські електромережі»'` shows exactly that note, not «Для цього будинку … не публікує», and «Далі» is disabled.
  - **The hint.** For `dtek-dnem`, a house with no lines shows «Для цього будинку ДТЕК не публікує графік відключень. Якщо ваш будинок обслуговує ЦЕК, оберіть «ПЕЕМ «ЦЕК»»».
  - **Other DTEK sites unchanged.** For `dtek-krem`, the note is byte-identical to today's «Для цього будинку ДТЕК не публікує графік відключень».
  - The existing wizard tests pass unchanged.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
  - Keep the picked house's note in state. It is set in `pickHouse` and cleared in `resetBelow`.
  - Write a one-line comment on the `eslint-disable` of the lines effect: `resetBelow` clears `pendingHouse`, so the effect never acts on a stale address (deferred from wave 1).
- [ ] **Step 4: Run them; they pass.** Run `npx vitest run tests/renderer` and `npm run typecheck`.
- [ ] **Step 5: Commit.** «Wizard: a source's note for a house, and DTEK Dnipro's pointer to ЦЕК»

### Task 8: CEK (`cek`)

**Files:**
- Create: `src/main/providers/cek/parse.ts`, `src/main/providers/cek/index.ts`, `src/main/smoke-cek.ts`
- Fixtures: `tests/fixtures/cek/`.
  - Copy the three `cek-gpv-post-*.html.txt` files.
  - **Capture the map page live** (`GET https://cek.dp.ua/index.php/cpojivaham/pobutovi-spozhyvachi/viznachennya-chergy.html`) and trim it to `map-page.html`.
    - Keep the page's own text around `const locations = ` and after the object (`; … function filterCity`) byte for byte.
    - Keep the `\uXXXX` escapes as served.
    - Cut the object down to «м. Дніпро» with a few streets, «м. Жовті Води» and «с. Петриківка», so that every value variant of `cek.md` §2.3 is in it:
      - a «Черга N» house;
      - a «… та …» house;
      - a «Група 3.1 (АТ "ДТЕК ДЕМ")» house;
      - the `4.1` / «Усі дома» house;
      - a house key with spaces around it.
- Modify: `src/shared/providers.ts` (the `cek` entry after `dtek-dnem`), `registry.ts`, `electron.vite.config.ts`, `tests/providers/registry.test.ts`, `src/main/providers/http-source.ts` (`quietNote` verb `'опублікувала'`)
- Test: `tests/providers/cek-parse.test.ts`, `tests/providers/cek-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 7 (`HouseInfo.note`).
- Produces:
  ```ts
  // cek/parse.ts (throws CekShapeError extends ShapeError; QueueValueError for a map value)
  export type CekMap = Record<string, Record<string, Record<string, string>>>; // city → street → house → value
  /** The `const locations = {…}` object of the map page: a brace-and-string-aware scan, then JSON.parse; shape city→street→house→string, none empty. */
  export function extractLocations(html: string): CekMap;
  /** One map value as lines; `note` set for a house DTEK switches (then lines []). Unknown value → QueueValueError. */
  export function cekLines(value: string): { lines: LineInfo[]; note?: string };
  /** One day's answer of the schedule form: queue id → 48 slots, or undefined for the quiet sentinel. */
  export function parseCekDay(html: string): Record<string, Slot[]> | undefined;
  export const CEK_DTEK_NOTE: string; // the copy in Global Constraints

  // cek/index.ts
  export class CekProvider implements ScheduleProvider { readonly id = 'cek'; constructor(deps: PlainHttpDeps) }
  export const CEK_QUIET_NOTE: string; // quietNote('ЦЕК', 'опублікувала')
  ```
- `PROVIDERS.cek` is `{ name: 'ПЕЕМ «ЦЕК»', shortName: 'ЦЕК', region: 'Дніпропетровська область', siteUrl: 'https://cek.dp.ua/index.php/cpojivaham/vidkliuchennia/2-uncategorised/921-grafik-pogodinikh-vidklyuchen.html' }`. The order test becomes the final one in Global Constraints.

Rules (`cek.md` §1–§2):
- **`cekLines`**, on the trimmed value. Queue digits must be n ∈ 1–6 and m ∈ 1–2, else `QueueValueError`.
  - `Черга n.m` → `linesOf(['n.m'])`.
  - `Черга a.b та c.d` → `linesOf([a.b, c.d])`.
  - `Черга n` → `linesOf(['n.1','n.2'])`.
  - `n.m` → `linesOf(['n.m'])`.
  - `Група n.m (АТ "ДТЕК ДЕМ")` → `{ lines: [], note: CEK_DTEK_NOTE }`.
  - Anything else → `QueueValueError`.
- **`parseCekDay`.**
  - **Required:** `<select id="queue"` with an option for each of the 12 queues `1.1`…`6.2`, and `id="heading"`.
  - **Then exactly one of:**
    - the sentinel «На цей день відключень немає.», with no `tableView_` → `undefined`;
    - or one or more `id="tableView_n.m"` blocks.
  - **Each block:**
    - its id is one of the 12, and none repeats;
    - every data `<tr>` holds a `<td>HH:MM:SS</td>` start and end pair, and the count of data rows equals the count of pairs, at least 1;
    - hours 00–23, minutes 00–59;
    - an end of `23:59:xx` means 24:00, and the start must be before the end.
  - A slot is `off` when `[30k, 30k+30)` overlaps a `[start, end)`; the rest are `on`.
  - Anything else throws: both the sentinel and blocks, neither, or the form missing.

Behaviour. `minGapMs` 1000.
- **The map** is `GET` of the map page → `extractLocations`, cached for the run, set only on success. It is fetched when `listCities` is first called (the wizard) and on a refresh's first use.
- **`listCities`, `listStreets`, `listHouses`.**
  - Cities and streets are the keys, sorted `uk`. They resolve exactly, else through `nameKey`, else `AddressNotFoundError`.
  - Houses are the trimmed keys. Two keys that trim to the same text become one house, with the union of their lines.
  - Every house of the street goes through `cekLines`, so an unknown value makes the street's list unreadable (call 4).
  - `HouseInfo` carries `note` when `cekLines` gives one. Order with the numeric `uk` collator.
- **`fetchSnapshot(a)`.**
  1. The house check runs inside `addressSide`, against the run-cached map. A missing house is `AddressNotFoundError`. The lines come from `cekLines`; a DTEK house gives `[]`, which reads as moved, so today is `unknown`.
  2. **Today's form:** POST `queue=all&date=<Kyiv today YYYY-MM-DD>` → `parseCekDay`.
     - `undefined` → today all `on` and `note = CEK_QUIET_NOTE`.
     - Otherwise the saved queue's slots, or all `on` when its block is absent (call 3).
  3. **Tomorrow:** the same POST with tomorrow's date. It is included only when it is not `undefined`.
  4. There is no `sourceUpdatedAt` and no current outage.
  5. `snapshotOf(…, groupLabel: queueLabel(a.groupId))`.

- [ ] **Step 1: Write the failing parser tests** (`cek-parse.test.ts`).
  - **`extractLocations(map-page)`** gives the trimmed object, and the escaped Cyrillic is decoded («м. Дніпро» is a key).
  - **`cekLines`:**
    - «Черга 5.2» → `[5.2]`;
    - «Черга 6.1 та 2.1» → `[2.1, 6.1]`;
    - «Черга 2» → `[2.1, 2.2]`;
    - «4.1» → `[4.1]`;
    - «Група 3.1 (АТ "ДТЕК ДЕМ")» → `{ lines: [], note: CEK_DTEK_NOTE }`;
    - «Черга 7.1», «Черга 1.3», «черга 1.1» and «Черга» throw.
  - **`parseCekDay` on the 2026-01-15 page:**
    - `1.1` is off in slots 4–10 (02:00–05:30), 18–31 (09:00–16:00) and 39–47 (19:30–23:59), and on elsewhere;
    - `2.1` is off in slots 0–10, 18–31 and 47;
    - all 12 queues are present.
  - **The quiet page** gives `undefined`. **The single-queue page** gives only `1.1`.
  - **(Review Focus 5.)** Each of these throws:
    - the quiet page with the sentinel removed;
    - the quiet page with a `tableView_1.1` block added;
    - the page without `id="heading"`;
    - a page without the select;
    - an end of `25:00:00`;
    - start not before end;
    - a block with a row that has no time pair;
    - `tableView_7.1`;
    - a block given twice.
- [ ] **Step 2: Write the failing provider tests** (`cek-provider.test.ts`).
  - `listCities` makes one map request, and a second call makes none.
  - `listHouses`:
    - the DTEK house carries `note === CEK_DTEK_NOTE` and `lines: []`;
    - a «Черга 2» house has two lines;
    - a key with spaces around it is shown trimmed.
  - **A day with outages.** At 2026-01-15 12:00 Kyiv, with the 2026-01-15 page for today and the quiet page for tomorrow, line `1.1` gives today's slots, no tomorrow, no note, and no `sourceUpdatedAt`.
  - **The quiet day.** At 2026-10-20, `note === 'ЦЕК не опублікувала графік на сьогодні — зазвичай це означає, що відключень за графіком немає'`.
  - **The request bodies** are `queue=all&date=2026-10-20` and `…2026-10-21`.
  - **A missing block.** A day whose tables lack the saved queue gives that queue all `on`, with no note.
  - **A failed map** keeps the saved line, logs one warn, and still delivers the schedule.
  - **A house gone from the map** throws `AddressNotFoundError`.
  - **The form answering 404** gives `ProviderError` «Сайт ЦЕК повернув помилку».
  - The order test is final.
- [ ] **Step 3: Run them; they fail.**
- [ ] **Step 4: Implement** `parse.ts`, `index.ts`, the `PROVIDERS` entry, the registry line and the `quietNote` verb.
- [ ] **Step 5: Write `smoke-cek.ts`.**
  - It goes map → «м. Дніпро» → a street → a house with one queue → `fetchSnapshot`.
  - It prints each request's path, status and bytes, and the map's city, street and house counts.
  - Add it to `electron.vite.config.ts`.
- [ ] **Step 6: Verify.** The vitest suites and `npm run typecheck` pass. Then `npm run build` and `npx electron out/main/smoke-cek.js`: exit 0.
- [ ] **Step 7: Commit.** «CEK: its own schedule form and address map (ПЕЕМ «ЦЕК»)»

### Task 9: Wave check

**Files:** none change unless a check fails.

- [ ] **Step 1: Tests.** `npm test` passes in full, with the count reported, and `npm run typecheck` is clean.
- [ ] **Step 2: Smokes.** Run `npm run build`, then the six smokes one after another (`smoke-toe`, `smoke-loe`, `smoke-mkoe`, `smoke-ztoe`, `smoke-cvoe`, `smoke-cek`). Each must exit 0; record their outputs.
  - Wave 1's toe, loe and mkoe are included because Task 1 moved their code.
  - **M4.** If `smoke-mkoe` saved a non-empty `active` body, copy it to `docs/superpowers/research/2026-10-20-outage-sources-step2/mykolaiv-raw/` and report it.
- [ ] **Step 3: Installer.** `npm run dist:win` builds `dist\Blackout Widget Setup 1.0.0.exe`. Record its size and time. Do not run the installer or the app.

## Deferred from wave 1 (from `.superpowers/sdd/2026-10-20-outage-sources-step2-wave1/progress.md`)

| Item | Here |
|---|---|
| M6: helper duplication across toe, loe and mkoe | Task 1 |
| Task 5: an unreadable but present `datePlanIn` keeps a Lviv outage open-ended | Task 1 (the row is skipped) |
| Task 5: `loe/index.ts` too long; its readers could move out | Task 1 (`loe/parse.ts`) |
| Task 6: the R6 id-sort step has no test | Task 1 (`labeled`) |
| Task 3: rule 2(b) with two items sharing name and group; an apostrophe-variant group suffix | Task 1 (tests) |
| Task 4: `ternopil.md` still says «null or []» | Task 1 |
| Task 6: the generator has no shape or duplicate checks | Tasks 2 and 4 (the new generators check); mkoe's generator stays as is |
| Task 2: the lines effect's `eslint-disable` needs a comment | Task 7 |
| M4: Mykolaiv queue ids once a real day is captured | Task 9 (`smoke-mkoe`); stays open until a real day is seen |
| Task 1: a Volyn 429 test; the `parseArchive` error factory; a timeout test that checks only that a signal exists | Dropped (Volyn untouched; behaviour covered) |
| Task 2: the raw message of a `houseLines` error | Dropped (plain-HTTPS errors are our own texts) |
| Task 3: `[^()]*` skips groups that contain parentheses | Dropped (it fails safe, as AddressNotFoundError) |
| Task 4: smoke shows the `X-debug-key`; skipped outage rows go unlogged; `later()` compares strings; three test gaps | Dropped (never seen live; fails closed) |
| Task 5: the archive downloads on every quiet refresh; the CMS description; house order | Dropped (spec-mandated or cosmetic) |
| Task 6: where labels are trimmed is not documented | Dropped |
| Final: `role="status"` with its text already inside; M3 not exercised live; `parseBuildingGroups` rejects a `null` chergGpv | Dropped (it fails closed; wait for a live case) |
| M7: a note for a vanished Ternopil house | Dropped (rare) |

Once this plan is committed, nothing in the wave-1 ledger is waiting any more. Its workspace and step 1's (`.superpowers/sdd/2026-10-20-more-outage-sources/`) are deleted after this wave merges.
