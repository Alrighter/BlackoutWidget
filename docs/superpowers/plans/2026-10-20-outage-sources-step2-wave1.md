# Outage Sources Step 2, Wave 1 (Ternopil, Lviv, Mykolaiv) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three plain-HTTPS schedule sources: Ternopiloblenergo (`toe`), Lvivoblenergo (`loe`) and Mykolaivoblenergo (`mkoe`). Add the shared pieces they need: one HTTP helper, lines fetched when the house is picked, the «Не входить до ГПВ» line, and resolving saved labels back to operator records.

**Architecture:** Each source is a `ScheduleProvider` in `src/main/providers/<id>/`. It runs in the main process over the injected `HttpFetch` (`net.fetch` in the app), the way `voe` does today. Volyn's request plumbing moves into a shared `HttpSource`, which every plain-HTTPS provider uses. An optional `houseLines()` on the provider, an IPC call and a wizard state let a source answer for one house after it is picked.

**Tech Stack:** Electron 44, electron-vite 6, TypeScript, React 19, vitest (jsdom for renderer tests). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-20-outage-sources-step2-design.md`. Research with exact endpoints and shapes: `docs/superpowers/research/2026-10-20-outage-sources-step2/{ternopil,lviv,mykolaiv}.md`, saved responses in `…/<op>-raw/`. Wave 2 (Zhytomyr, Chernivtsi, CEK) is a separate plan.

## Global Constraints

- No new runtime or dev dependencies. HTML and text are parsed without a DOM library.
- **Network.** All network code goes through `HttpFetch` (`src/main/providers/http.ts`). In the app this is `electronHttp`; in tests, fixture routers. Requests of one provider run one at a time (`HttpSource.serial`). Each public provider method wraps its body in `serial` once, and internal steps call unwrapped helpers, because a nested `serial` deadlocks.
- **Privacy.** Never read, keep, log or show the `koment` field of any API. A thrown error's message or cause, and every log call, never contains a response body or any part of one.
- **Fail closed.** Any answer of an unknown shape is a `ProviderError` («Не вдалося прочитати графік {name}»), never all `on`. A quiet day is only the specific shape each task names.
- Saved settings keep their shape: `Address { providerId, city, street, house, lineIndex, groupId }` with labels, and `groupId: 'none'` for the always-on line.
- Copy, exact:
  - not in the schedule: «Не входить до ГПВ»;
  - a queue line: «Черга N.M»;
  - the address is gone: «Адресу не знайдено у {name} — оберіть її в налаштуваннях заново»;
  - the quiet note: «{name} не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає» (all three wave-1 names are neuter);
  - the four request errors from `sourceTexts(name)` (Task 1);
  - the wizard's loading line: «Завантаження ліній…».
- **Smoke scripts.** They use `makeSmokeProfile` / `removeSmokeProfile` (`src/main/smoke-profile.ts`) and never touch `%APPDATA%\Blackout Widget`.
- **Live probes.** Cyrillic never goes into shell literals. Live probes and fixture trimming are Node `.mjs` scripts written with the Write tool, kept in the scratchpad (not in the repo).
- **Commits.** Subject and body only. Never a `Co-Authored-By` trailer or any Claude or «Generated with» line.
- Kyiv dates and times use `src/shared/time.ts` (`kyivDateKey`, `addDays`, `formatHM`, `kyivWallTimeToInstant`). `CurrentOutage.start/end` are strings «HH:MM DD.MM.YYYY» (what `parseDtekDateTime` reads).

## Review Focus

1. **Existing users.** Someone set up on DTEK or Volyn must see no change. The wizard and `previewLines` never call `houseLines` for them, and Volyn's error texts and quiet note stay byte-identical. Tests in Tasks 1 and 2.
2. **A namesake appears after saving.** «Ланівці» was saved, and the list now holds two «Ланівці». The refresh must give «Адресу не знайдено…», never the other village's queue. Test in Task 3.
3. **Lviv just after midnight.** The Today item is still empty, and the Tomorrow item, published yesterday evening, carries today's heading date. Today's schedule must come from it, not show as a quiet day. Test in Task 5.
4. **A failure part-way through a refresh.** Ternopil's precheck passes and then `a_gpv_g` rejects. That is an error, never a quiet day. Test in Task 4.
5. **Ternopil's edge cache.** Two refreshes must send different `time` values, or Cloudflare serves another address's answer. Test in Task 4.
6. **Mykolaiv on a day with outages that skips the saved queue.** That queue is all `on` with no quiet note. An unknown series `type` is an error. Tests in Task 7.

---

### Task 1: Shared HTTP plumbing, with Volyn moved onto it

**Files:**
- Create: `src/main/providers/http-source.ts`
- Move: `src/main/providers/voe/names.ts` → `src/main/providers/names.ts` (update the imports in `voe/html.ts`, `voe/index.ts` and `voe/settlements.ts`)
- Modify: `src/main/providers/voe/index.ts` (use `HttpSource`; delete its own `serial`/`guard`/`call`/`noAnswer`/`text`)
- Test: `tests/providers/http-source.test.ts`; `tests/providers/voe-*.test.ts` must pass unchanged

**Interfaces:**
- Produces:
  ```ts
  export interface SourceTexts { offline: string; noAnswer: string; httpError: string; unreadable: string }
  export function sourceTexts(name: string): SourceTexts;
  export function quietNote(name: string, verb: 'опублікувало' | 'опублікував'): string;
  export type SourceInit = Omit<Parameters<HttpFetch>[1], 'signal'>;
  export interface HttpSourceOptions {
    fetch: HttpFetch; isOnline: () => boolean; log: Logger; tag: string; texts: SourceTexts;
    timeoutMs?: number;            // default 20_000
    minGapMs?: number;             // default 0: the least time between the starts of two requests
    sleep?: (ms: number) => Promise<void>; clock?: () => number; // test seams
  }
  export class HttpSource {
    constructor(o: HttpSourceOptions);
    /** One operation at a time; a failure does not break the chain. Callers only ever see ProviderError. Never nest. */
    serial<T>(op: string, fn: () => Promise<T>): Promise<T>;
    text(url: string, init?: SourceInit): Promise<string>;   // init defaults to { method: 'GET' }
    json(url: string, init?: SourceInit): Promise<unknown>;  // a body that is not JSON → unreadable
    bytes(url: string, init?: SourceInit): Promise<ArrayBuffer>;
    unreadable(cause?: Record<string, unknown>): ProviderError;
  }
  ```
- `nameKey`, `sameName` and `normHouse` keep their signatures in `src/main/providers/names.ts`.

- [ ] **Step 1: Write the failing tests** in `tests/providers/http-source.test.ts`:
  - `sourceTexts('Тернопільобленерго')` equals `{ offline: 'Немає з’єднання з сайтом Тернопільобленерго', noAnswer: 'Сайт Тернопільобленерго не відповідає', httpError: 'Сайт Тернопільобленерго повернув помилку', unreadable: 'Не вдалося прочитати графік Тернопільобленерго' }`.
  - `quietNote('Волиньобленерго', 'опублікувало')` equals `VOE_QUIET_NOTE`.
  - `serial` runs two operations one after the other: the second fetch starts only after the first resolves (use a deferred).
  - A rejected fetch gives `NetworkError(texts.offline)` when `isOnline()` is false, and `ProviderError(texts.noAnswer)` when it is true.
  - A status of 500 gives `ProviderError(texts.httpError)`. A status of 429 gives `ProviderError(texts.noAnswer)`.
  - `json()` on the body `'<html>Замовник Петренко</html>'` gives `ProviderError(texts.unreadable)`.
  - **Privacy.** Neither `JSON.stringify(err.cause)` nor any argument of `log.error` / `log.warn` contains `'Петренко'`.
  - Anything other than a `ProviderError` thrown inside `serial` comes out as `ProviderError(texts.unreadable)`, and `log.error` gets `` `${tag} ${op} failed` ``.
  - With `minGapMs: 1500` and a fake `clock` and `sleep`, the second request waits `1500 - elapsed` ms.
  - The timeout: every fetch gets a `signal` (an `AbortSignal`).
- [ ] **Step 2: Run them and see them fail.** `npx vitest run tests/providers/http-source.test.ts` fails with module not found.
- [ ] **Step 3: Implement `http-source.ts`.** Move `names.ts` and switch `VoeProvider` to `new HttpSource({ …, tag: 'voe', texts: sourceTexts('Волиньобленерго') })`. `VOE_QUIET_NOTE` becomes `quietNote('Волиньобленерго', 'опублікувало')`. Causes may carry `url`, `status`, a field name or a short reason, never body text.
- [ ] **Step 4: Run everything.** `npx vitest run tests/providers` passes, including every `voe-*` test unchanged. `npm run typecheck` is clean.
- [ ] **Step 5: Commit.** «Providers: one HTTP helper for the plain-HTTPS sources; Volyn uses it»

### Task 2: Lines fetched when the house is picked

**Files:**
- Modify: `src/main/providers/types.ts`; `src/shared/types.ts`; `src/shared/ipc.ts`; `src/preload/index.ts`; `src/main/ipc.ts`; `src/renderer/src/app/SetupWizard.tsx`
- Test: `tests/main/ipc-lines.test.ts` (create); `tests/renderer/setup-wizard.test.tsx` (add cases)

**Interfaces:**
- Produces:
  - `ScheduleProvider.houseLines?(city: string, street: string, house: string): Promise<LineInfo[]>`.
  - `HouseInfo.linesPending?: boolean`: «`lines` is not final; ask `houseLines` once the house is picked».
  - `IPC.houseLines = 'addr:house-lines'`.
  - `RendererApi.houseLines(providerId: string, city: string, street: string, house: string): Promise<LineInfo[]>`.
  - In `src/main/ipc.ts`: `export async function houseLinesOf(provider: ScheduleProvider, city: string, street: string, house: string): Promise<LineInfo[]>`. It returns `provider.houseLines(...)` when present, else the `lines` of the matching house from `listHouses`, else `[]`.
  - `previewLines` takes its lines from `houseLinesOf`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/main/ipc-lines.test.ts`:
    - `houseLinesOf` on a provider without `houseLines` calls `listHouses` once and returns the house's lines.
    - On a provider with `houseLines`, it returns that answer and never calls `listHouses`.
    - `previewLines` on a provider with `houseLines` fetches one snapshot per returned line.
  - `tests/renderer/setup-wizard.test.tsx`:
    - **A pending house.** Mock `listHouses` → `[{ house: '7', outageActive: false, lines: [], linesPending: true }]` and `houseLines` → two lines. After picking «7», «Завантаження ліній…» shows, and «Для цього будинку … не публікує графік відключень» does not. Once it resolves, «Далі» leads to the line step with both lines. `houseLines` was called with `('dtek-krem', 'м. Біла Церква', 'бул. Грушевського Михайла', '7')`.
    - **A pending house whose answer is `[]`.** The «не публікує графік» note shows and «Далі» is disabled.
    - **A failed answer.** The message and «Спробувати ще раз» show, and a retry calls `houseLines` again.
    - **Unchanged path.** A house without `linesPending` never calls `houseLines`. The existing tests stay unchanged and pass.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run tests/main/ipc-lines.test.ts tests/renderer/setup-wizard.test.tsx`
- [ ] **Step 3: Implement.**
  - In the wizard, `houseLines` state becomes `LineInfo[] | null`, where `null` means loading, and an error state is kept beside it.
  - `pickHouse` asks `api.houseLines` when `h.linesPending`.
  - `noLines` needs the lines to be known.
  - `canNext` on the house step waits for them.
  - A stale answer, for a house no longer picked, is dropped.
- [ ] **Step 4: Run everything.** The tests above, `npx vitest run tests/renderer`, and `npm run typecheck`.
- [ ] **Step 5: Commit.** «Wizard: a source can give a house's lines after the house is picked»

### Task 3: Shared provider helpers, and the registry in card order

**Files:**
- Create: `src/main/providers/lines.ts`, `src/main/providers/resolve.ts`
- Modify: `src/main/providers/registry.ts` (order the providers by `Object.keys(PROVIDERS)`)
- Test: `tests/providers/lines.test.ts`, `tests/providers/resolve.test.ts`, `tests/providers/registry.test.ts`

**Interfaces:**
- Produces, in `lines.ts`:
  ```ts
  export const NONE_GROUP = 'none';
  export const NOT_IN_SCHEDULE = 'Не входить до ГПВ';
  export function queueLabel(groupId: string): string;    // 'none' → NOT_IN_SCHEDULE, else `Черга ${groupId}`
  /** Distinct queue ids (only /^\d+\.\d+$/), sorted numerically (1.2 < 2.1 < 10.1), index from 1; none left → [the 'none' line]. */
  export function linesOf(groupIds: readonly string[]): LineInfo[];
  export const daySlots = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
  ```
- Produces, in `resolve.ts`:
  ```ts
  export class AddressNotFoundError extends ProviderError {}
  export function addressNotFound(name: string): AddressNotFoundError; // the copy in Global Constraints
  /** Labels in list order: the trimmed name; a name shared (nameKey) by several items gets ` (${group})`; a label still repeated gets ` (2)`, ` (3)`… in list order. */
  export function uniqueLabels<T>(items: readonly T[], name: (t: T) => string, group: (t: T) => string | undefined): string[];
  /** The spec's rule: the exact label; else the only item whose name (nameKey) equals the label or the label minus a trailing « (…)»; else AddressNotFoundError. */
  export function resolveByLabel<T>(items: readonly T[], labels: readonly string[], label: string, name: (t: T) => string, company: string): T;
  ```
- The registry (`createProviders`) returns providers in `Object.keys(PROVIDERS)` order. Each provider task adds its `PROVIDERS` entry in card order and its constructor here.

- [ ] **Step 1: Write the failing tests.**
  - `lines.test.ts`:
    - `linesOf(['2.2','4.1','2.2'])` → `[{index:1,groupId:'2.2',label:'Черга 2.2'},{index:2,groupId:'4.1',label:'Черга 4.1'}]`.
    - `linesOf(['Не входить',''])` → `[{index:1,groupId:'none',label:'Не входить до ГПВ'}]`.
    - `linesOf(['10.1','2.1'])` puts 2.1 first.
  - `resolve.test.ts`, with the list `[{id:1,name:'Ланівці',g:'Лановецька'},{id:2,name:'Ланівці',g:'Борщівська'},{id:3,name:'Збараж',g:'Збаразька'}]`:
    - Labels are `['Ланівці (Лановецька громада)', …]` when `group` returns `` `${g} громада` ``.
    - `resolveByLabel(…, 'Ланівці (Борщівська громада)')` → id 2.
    - `'Збараж'` → id 3.
    - **(Review Focus 2.)** A saved `'Ланівці'` against the two-item list throws `AddressNotFoundError` with «Адресу не знайдено у Тернопільобленерго — оберіть її в налаштуваннях заново».
    - A saved `'Збараж (Збаразька громада)'`, the only Збараж, → id 3.
    - `'Збараж'` with a U+2019/U+0027 or Latin-look-alike difference still resolves (via `nameKey`).
  - `registry.test.ts`: the order test reads `Object.keys(PROVIDERS)`, and it stays `['dtek-kem','voe','dtek-dnem','dtek-krem','dtek-oem']` until the provider tasks add theirs.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run tests/providers/lines.test.ts tests/providers/resolve.test.ts tests/providers/registry.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; they pass.** Also run `npm run typecheck`.
- [ ] **Step 5: Commit.** «Providers: queue lines, the always-on line, labels that resolve back to records»

### Task 4: Ternopil (`toe`)

**Files:**
- Create: `src/main/providers/toe/index.ts` (the provider), `src/main/providers/toe/parse.ts` (pure parsers), `src/main/smoke-toe.ts`
- Create fixtures: `tests/fixtures/toe/`, copied from `docs/superpowers/research/2026-10-20-outage-sources-step2/ternopil-raw/`:
  - `pw_cities_all.json`, trimmed by a Node script to about 60 entries that keep the empty-name rows, the «Ланівці» namesakes and Тернопіль (1032);
  - `pw_streets_city1032.json`;
  - both `building-names_*.json`;
  - `building-groups_1032_47931_1-A.json`;
  - the three `a_gpv_g_*` files;
  - both `pw_accident*` files.
- Modify: `src/shared/providers.ts` (the `toe` entry, last in card order), `src/main/providers/registry.ts`, `electron.vite.config.ts` (the `smoke-toe` input)
- Test: `tests/providers/toe-parse.test.ts`, `tests/providers/toe-provider.test.ts`

**Interfaces:**
- Consumes:
  - `HttpSource`, `sourceTexts` and `quietNote` (Task 1);
  - `houseLines` and `linesPending` (Task 2);
  - `linesOf`, `queueLabel`, `daySlots`, `NONE_GROUP`, `uniqueLabels`, `resolveByLabel` and `AddressNotFoundError` (Task 3).
- Produces: `export class ToeProvider implements ScheduleProvider { readonly id = 'toe'; constructor(deps: { fetch: HttpFetch; isOnline: () => boolean; log?: Logger; now?: () => Date }) }` and `export const TOE_QUIET_NOTE`.
- The `PROVIDERS.toe` entry: `{ name: 'Тернопільобленерго', shortName: 'Тернопільобленерго', region: 'Тернопільська область', siteUrl: 'https://poweron.toe.com.ua/' }`.

Behaviour (`ternopil.md` §1–§3):
- **API.** The base is `https://api-poweron.toe.com.ua/api`. Send `Accept: application/ld+json` and never an `Origin` header.
- **`listCities()`.** One call, `GET /pw_cities?pagination=false&otg.id=`, cached for the run.
  - Rows with an empty name are dropped.
  - Labels come from `uniqueLabels(name, otg.name + ' громада')`, sorted with `localeCompare('uk')`.
- **`listStreets(city)`.** Resolve the city with `resolveByLabel`, then `GET /pw_streets?pagination=false&city.id=<id>`. Names are trimmed, repeats get `uniqueLabels`, and the list is sorted.
- **`listHouses(city, street)`.** `GET /pw-accounts/building-names?cityId=<id>&streetId=<id>`.
  - The house is `buildingName` byte for byte; rows with an empty one are skipped.
  - `lines = linesOf([chergGpv])` and `linesPending: true`.
  - Read only `buildingName` and `chergGpv`.
- **`houseLines(city, street, house)`.** `GET /pw-accounts/building-groups?cityId=&streetId=&buildingNames=<house>` → `linesOf(buildingGroups.map(g => g.chergGpv))`.
  - An empty `buildingGroups` gives `linesOf([])` (the `'none'` line) when the house is in `building-names`, else `[]`.
- **`fetchSnapshot(a)`**, in this order:
  1. Resolve the city and street ids. Get the house's queues through the `houseLines` logic, as an unwrapped helper: never call the public `serial`-wrapped method from inside `fetchSnapshot`. An answer of `[]` (the house is not in `building-names`) throws `AddressNotFoundError`.
  2. **`a.groupId === 'none'`.** If the queues are `none`, return `days: [today all 'on']`, `lines`, and the current outage. Read no schedule and add no note.
  3. **The saved queue is not among the house's queues.** Return `days: [today all 'unknown']`, the new `lines` and the current outage. This is the spec's «лінія змінилась» path, not an error.
  4. **Otherwise,** `GET /a_gpv_g?before=<Kyiv tomorrow>T00:00:00%2B00:00&after=<Kyiv yesterday>T12:00:00%2B00:00&time=<unique per call>`, with the header `X-debug-key: base64(utf8('<cityId>/<streetId>/<house>'))`.
     - Validate: `@type === 'hydra:Collection'`, `hydra:totalItems` a number, `hydra:member` an array or `null`. Anything else is unreadable.
     - Group members by `dateGraph.slice(0,10)`. For the same date, the larger `dateCreate`, then the larger `id`, wins.
     - Strip a `#…` suffix from `dataJson` keys.
     - A member for today or tomorrow without the saved queue is unreadable (the precheck said it is there).
     - `times` must have exactly the 48 keys `00:00`…`23:30`, with `"0"` → on, `"1"` → off, `"10"` → maybe-off. Anything else is unreadable.
  5. **No member for today:** today all `on` and `note: TOE_QUIET_NOTE`. Tomorrow is present only if its member is.
  6. **`sourceUpdatedAt`** comes from today's `dateCreate`. Its digits are taken as Kyiv wall clock (no zone conversion) and written «HH:MM DD.MM.YYYY».
  7. **Current outage.** `GET /pw_accidents?page=1&city.id=&street.id=` and `GET /pw_accident_planeds?page=1&city.id=&street.id=`.
     - A row counts when the house is in `buildingNames` (split on `,`, trimmed, exact) and `dateEvent ≤ now ≤ datePlanIn`, the digits read as Kyiv wall clock. An emergency row without `datePlanIn` counts once it has started.
     - `switchSubReason` 0, 1 and 3 → `{kind:'emergency', text:'Аварійне відключення'}`; 2 → skipped. Planned rows → `{kind:'planned', text:'Планові роботи'}`.
     - Emergency wins over planned.
     - A failure here is logged and gives no `currentOutage`; it never fails the snapshot.
- **Labels.** `groupLabel = queueLabel(a.groupId)`.

- [ ] **Step 1: Write the failing parser tests** (`toe-parse.test.ts`).
  - The 17.10 fixture for `1.2`: slot 21 (10:30) is `maybe-off`, slots 22–27 are `off`, slot 28 (14:00) is `maybe-off`, and the rest are `on`. `dateCreate` gives `'18:52 17.10.2026'`.
  - The two-queue fixture holds `2.2` and `4.1`.
  - A `times` map with 47 keys, or the value `"2"`, throws.
  - `{"hydra:member": {}}` throws.
  - `null` members and `[]` members both give "no day".
  - A `#x` key suffix is stripped.
- [ ] **Step 2: Write the failing provider tests** (`toe-provider.test.ts`). Use a fixture router as in `voe-provider.test.ts`, with the clock pinned to 2026-10-17 12:00 Kyiv unless stated.
  - `listCities` drops empty names and labels both «Ланівці» with their громада.
  - `listHouses` returns `linesPending: true` with the `building-names` queue.
  - `houseLines` for house «29» returns the lines `2.2` and `4.1`.
  - `fetchSnapshot` for `1032/47931/'1'`, line `1.2`, gives the 17.10 slots and `sourceUpdatedAt '18:52 17.10.2026'`.
  - The `X-debug-key` header decodes to `'1032/47931/1'`.
  - No request carries an `Origin` header.
  - **(Review Focus 5.)** Two calls send two different `time` values.
  - **Quiet day.** On 2026-10-20, a `null` member gives today all `on` and `note === 'Тернопільобленерго не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає'`.
  - **Moved queue.** The saved line is `5.1` and `building-groups` says `1.2`: `days[0]` is all `unknown`, `lines` is `[Черга 1.2]`, and nothing is thrown.
  - **`'none'` saved.** `building-groups` gives `[]`, and the house is in `building-names` with «Не входить». `a_gpv_g` is never requested, and today is all `on`.
  - **A house gone from `building-names`** throws `AddressNotFoundError`.
  - **(Review Focus 4.)** The precheck passes but `a_gpv_g` rejects: a `ProviderError`, never a quiet day.
  - **Current outage at 2026-10-20 14:00.** The Збараж row (`dateEvent 03:31`, `datePlanIn 13:00`) is over and gives no outage. At 10:00 it gives `emergency` with start «03:31 20.10.2026» and end «13:00 20.10.2026».
  - **A rejected `pw_accidents`** still delivers the schedule.
  - **Privacy.** `koment` never appears in the snapshot (`JSON.stringify(snap)` has no «Пошкодження»).
- [ ] **Step 3: Run them and see them fail.** `npx vitest run tests/providers/toe-parse.test.ts tests/providers/toe-provider.test.ts`
- [ ] **Step 4: Implement** `parse.ts`, `index.ts`, the `PROVIDERS` entry and the registry line. Update the registry order test to end with `'toe'`.
- [ ] **Step 5: Write `smoke-toe.ts`**, shaped like `smoke-voe.ts`. It goes from `listCities` to «Тернопіль» (resolved by label), then the first street with houses, a house via `houseLines`, and `fetchSnapshot`. It prints the JSON summary plus the HTTP status of `a_gpv_g`. Add it to `electron.vite.config.ts`.
- [ ] **Step 6: Verify.** `npx vitest run tests/providers` passes and `npm run typecheck` is clean. Then `npm run build` and `npx electron out/main/smoke-toe.js`: it ends with exit 0 and a snapshot (today on 2026-10-20 is a quiet day with the note). Record the output in the report, including whether `net.fetch` got a 200 without `Origin`. If it got a 403, say so: that is a reported concern, and no workaround is added without a ruling.
- [ ] **Step 7: Commit.** «Ternopil: schedule, address lookup and current outages from Тернопільобленерго»

### Task 5: Lviv (`loe`)

**Files:**
- Create: `src/main/providers/loe/index.ts`, `src/main/providers/loe/schedule.ts` (the text parser and revision picker), `src/main/smoke-loe.ts`
- Create fixtures: `tests/fixtures/loe/`.
  - Copy all of `lviv-raw/`.
  - Add `pw_cities-sample.json`. It is a **new** trimmed live sample (one `GET https://power-api.loe.lviv.ua/api/pw_cities?pagination=false&otg.id=` from a Node script) of about 60 rows with `codeOtg`. Keep the «Винники» namesakes, Львів (693), Брюховичі (1174), Червоноград (1046) and two rows whose `codeOtg` does not start with `UA46`.
- Modify: `src/shared/providers.ts` (the `loe` entry, after `dtek-krem`), `src/main/providers/registry.ts`, `electron.vite.config.ts`
- Test: `tests/providers/loe-schedule.test.ts`, `tests/providers/loe-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 as in Task 4.
- Produces:
  ```ts
  export interface LoeRevision { date: string /* YYYY-MM-DD */; updatedAt: string /* 'HH:MM DD.MM.YYYY' */; groups: Record<string, Slot[]> }
  /** Strict: the heading «Графік погодинних відключень на DD.MM.YYYY», «Інформація станом на HH:MM DD.MM.YYYY», exactly the 12 groups 1.1…6.2. Throws on any deviation. */
  export function parseLoeRevision(rawHtml: string): LoeRevision;
  /** The heading date only, or undefined when the heading cannot be read. */
  export function loeHeadingDate(rawHtml: string): string | undefined;
  export class LoeProvider implements ScheduleProvider { readonly id = 'loe'; /* deps as ToeProvider */ }
  export const LOE_QUIET_NOTE: string;
  ```
- The `PROVIDERS.loe` entry: `{ name: 'Львівобленерго', shortName: 'Львівобленерго', region: 'Львівська область', siteUrl: 'https://poweron.loe.lviv.ua/' }`.

Behaviour (`lviv.md` §1–§6):
- **The line grammar** (`lviv.md` §1d): `Група N.M. Електроенергії немає з HH:MM до HH:MM(, з HH:MM до HH:MM)*.` or `Група N.M. Електроенергія є.`
  - Minutes are 00 or 30, and `24:00` may only end a range.
  - Ranges must be non-empty and ascending, and must not overlap.
  - A range fills slots `[start/30, end/30)` with `off`; the rest is `on`.
  - A zero-length range (`з 00:00 до 00:00`) throws.
- **Schedule, every refresh.** `GET https://api.loe.lviv.ua/api/menu_items/238` (Today) and `…/menu_items/256` (Tomorrow).
  - Each must be an object with `name` `'Today'`/`'Tomorrow'`, `menu === '/api/menus/9'`, and string `rawHtml` and `description`. Anything else is unreadable.
  - **The archive.** Read it only when neither item gives a revision dated Kyiv today: `GET https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic&_=<Date.now()>`. Its children are those of the `menuItems` entry named `'Arhiv'` (a missing one is unreadable).
  - **Picking the revision.** Gather the revisions whose heading date is Kyiv today or tomorrow, from every item read. Per date, the latest `updatedAt` wins.
  - An item with empty `rawHtml` is skipped.
  - An archive item whose heading date cannot be read, or is another day, is skipped without parsing its lines.
  - An item headed today or tomorrow whose lines fail the grammar is unreadable. The Today or Tomorrow item failing the grammar is unreadable whatever its date.
- **Quiet day.** No revision for today gives today all `on` and `LOE_QUIET_NOTE`. Tomorrow is only shown when it has a revision.
- **`sourceUpdatedAt`** is today's revision's `updatedAt`.
- **Address.** The base is `https://power-api.loe.lviv.ua/api`, and every LOE request goes through one `HttpSource` with `minGapMs: 1500`.
  - **Both shapes.** `pw_cities` and `pw_streets` are accepted as a plain array and as Hydra `{'hydra:member': […]}`.
  - **Cities.** `pw_cities?pagination=false&otg.id=` drops rows whose `codeOtg` does not start with `UA46`. Labels come from `uniqueLabels(name, otg.name + ' громада')`.
  - **Streets.** `pw_streets?pagination=false&city.id=`. Names are trimmed, repeats get `uniqueLabels`, and a city with no streets gives `[]`.
  - **Houses.** `listHouses` comes from `pw_accounts?pagination=false&city.id=&street.id=`, reading only `buildingName` and `chergGpv`, grouped by the exact `buildingName` (empty ones skipped), with `lines = linesOf(distinct chergGpv)`.
  - **Refresh.** `fetchSnapshot` checks the house with `pw_accounts?pagination=false&city.id=&street.id=&buildingName=<exact>`. No rows throws `AddressNotFoundError`. The returned `lines` are that answer's `linesOf`.
  - **The `'none'` line** gives today all `on` and does not read the schedule.
- **Current outage.** `GET pw_accidents?page=1&city.id=&street.id=`.
  - The house matches when the comma-split `buildingNames` and the comma-split `buildingName` share a token (both trimmed).
  - `typeOff` 0 → `planned` «Планове вимкнення»; 1 → `emergency` «Аварійне вимкнення»; 2 → `other` «Оперативні перемикання»; 30 → `other` «Можливе аварійне вимкнення».
  - `dateEvent` and `datePlanIn` are real instants (`+03:00`), formatted in Kyiv time.
  - The row counts once it has started and before its end, if it has one.
  - Never read `koment`. A failure here never fails the snapshot.

- [ ] **Step 1: Write the failing parser tests** (`loe-schedule.test.ts`).
  - Archive item 1108 from the trimmed fixture (17.10.2026) parses to `updatedAt '18:56 17.10.2026'`, and group `1.1` is off in slots 40–43 (20:00–22:00).
  - `Група 6.2. Електроенергія є.` gives all `on`.
  - `з 23:00 до 24:00` gives slots 46–47 `off`.
  - Item 540's `з 00:00 до 00:00` throws.
  - A text missing group `3.2` throws.
  - `з 10:15 до 11:00` throws.
  - `з 12:00 до 11:00` throws.
- [ ] **Step 2: Write the failing provider tests** (`loe-provider.test.ts`), with the clock pinned per test.
  - On 2026-10-20 with Today and Tomorrow empty and the archive's newest day 17.10: a quiet day, `note === LOE_QUIET_NOTE`, and the archive was requested with an `_=` query.
  - On 2026-10-17 at 20:00, from the archive: the latest 17.10 revision is used.
  - **(Review Focus 3.)** On 2026-10-18 at 00:20, Today is empty and Tomorrow holds a revision headed 18.10. Today's schedule comes from it, with no quiet note.
  - A Today item with `name: 'Arhiv'` is unreadable.
  - `listCities` drops the non-UA46 rows and labels «Винники» with their громада.
  - Червоноград's `listStreets` is `[]`.
  - `pw_streets` in the Hydra shape and in the array shape give the same list.
  - `listHouses` on the Кульпарківська fixture merges accounts per building, and building «95» has the lines `5.1` and `5.2`.
  - `fetchSnapshot` sends `buildingName` exactly (`32-А`, Cyrillic А).
  - Accounts gone throws `AddressNotFoundError`.
  - **Current outage.** A `typeOff 1` row covering now gives `emergency` with Kyiv-formatted times. A `typeOff 30` row gives `other`. The redacted `koment` never reaches the snapshot.
  - **Spacing.** Two requests through `LoeProvider` start at least 1500 ms apart (fake clock and sleep).
- [ ] **Step 3: Run them and see them fail.** `npx vitest run tests/providers/loe-schedule.test.ts tests/providers/loe-provider.test.ts`
- [ ] **Step 4: Implement** `schedule.ts`, `index.ts`, the `PROVIDERS` entry and the registry line, and update the registry order test.
- [ ] **Step 5: Write `smoke-loe.ts`.** It goes from `listCities` to «Львів», then a street, a house, and `fetchSnapshot`. Add it to `electron.vite.config.ts`.
- [ ] **Step 6: Verify.** The vitest suites and `npm run typecheck` pass. Then `npm run build` and `npx electron out/main/smoke-loe.js`: exit 0 and a snapshot. Report any 429.
- [ ] **Step 7: Commit.** «Lviv: schedule text, address lookup and current outages from Львівобленерго»

### Task 6: Mykolaiv settlement list (bundled)

**Files:**
- Create:
  - `scripts/gen-mkoe-settlements.mjs` (live: `GET https://off.energy.mk.ua/api/addr/filii`, then `/api/addr/filii/{id}/ns` for each, 1 s apart);
  - `src/main/providers/mkoe/settlements.data.json`, an array of `{ id: number, name: string /* as the operator writes it */, filiiId: number, filii: string /* fullname */ }`;
  - `src/main/providers/mkoe/settlements.source.md` (source, date, counts, how to regenerate);
  - `src/main/providers/mkoe/settlements.ts`.
- Test: `tests/providers/mkoe-settlements.test.ts`

**Interfaces:**
- Produces: `export interface MkoeSettlement { label: string; id: number; name: string; filii: string }` and `export function mkoeSettlements(): MkoeSettlement[]`.
  - `label` comes from `uniqueLabels(name, filii)`, sorted by `localeCompare('uk')` and cached.
  - The file is named `.data.json` so that it does not share a basename with `settlements.ts`.

- [ ] **Step 1: Write the failing tests.**
  - The count is between 850 and 950.
  - Labels are unique.
  - `'м. Миколаїв'` (id 171), `'м. Миколаїв (Варварівка)'` (764) and `'м. Миколаїв (Корабельний)'` (696) are present.
  - Every «Костянтинівка» label carries its дільниця, e.g. `'Костянтинівка (Арбузинська дільниця)'`.
  - No label has leading or trailing spaces.
- [ ] **Step 2: Run them and see them fail.** `npx vitest run tests/providers/mkoe-settlements.test.ts`
- [ ] **Step 3: Run the generator and implement `settlements.ts`.** If the live site is unreachable, build the data file from `mykolaiv-raw/ns-by-filii-all-2026-10-20.json` and `filii-2026-10-20.json` instead, and say which in `settlements.source.md`.
- [ ] **Step 4: Run them; they pass.** Also run `npm run typecheck`.
- [ ] **Step 5: Commit.** «Mykolaiv: the bundled settlement list (20 дільниць)»

### Task 7: Mykolaiv (`mkoe`)

**Files:**
- Create: `src/main/providers/mkoe/index.ts`, `src/main/providers/mkoe/schedule.ts`, `src/main/smoke-mkoe.ts`
- Create fixtures: `tests/fixtures/mkoe/`, copied from `mykolaiv-raw/`. Keep the file name `SYNTHETIC-schedule-active-shape.json`; a header comment in the test says it is hand-built.
- Modify: `src/shared/providers.ts` (the `mkoe` entry, after `loe`), `src/main/providers/registry.ts`, `electron.vite.config.ts`
- Test: `tests/providers/mkoe-schedule.test.ts`, `tests/providers/mkoe-provider.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 and 6.
- Produces:
  ```ts
  /** One Kyiv day's slots for one queue id from the joined answers; throws on any unknown shape or type. */
  export function mkoeDay(active: unknown, timeSeries: unknown, queues: unknown, date: string, queueName: string): { slots: Slot[]; updatedAt?: string } | undefined; // undefined = no schedule row for that date
  export class MkoeProvider implements ScheduleProvider { readonly id = 'mkoe'; /* deps as ToeProvider */ }
  export const MKOE_QUIET_NOTE: string;
  ```
- The `PROVIDERS.mkoe` entry: `{ name: 'Миколаївобленерго', shortName: 'Миколаївобленерго', region: 'Миколаївська область', siteUrl: 'https://off.energy.mk.ua/' }`.

Behaviour (`mykolaiv.md` §1–§3; the base is `https://off.energy.mk.ua/api`):
- **Validation.**
  - `time-series` must be an array of exactly 48 rows with ids 1–48.
  - `outage-queue/by-type/3` must hold the 12 names `1.1`…`6.2` among its rows where `deleted == 0`.
  - `v2/schedule/active` must be an array. Each row needs a string `from` that parses to a date; a missing `series` is empty, and any other non-array `series` is unreadable.
  - A failure in any of these is unreadable.
- **Building the day.**
  - Rows belong to `kyivDateKey(new Date(from))`.
  - The saved queue's id is found by name in `by-type/3`.
  - Slot `time_series_id - 1` gets `OFF`/`SURE_OFF` → `off` and `PROBABLY_OFF` → `maybe-off`. When rows overlap, the stronger wins: `SURE_OFF` > `OFF` > `PROBABLY_OFF`.
  - Every other slot is `on`. Any other `type`, or a `time_series_id` outside 1–48, is unreadable.
  - `updatedAt` is the newest `series[].updated_at` of the day's rows, in Kyiv time («HH:MM DD.MM.YYYY»).
- **Quiet day.** No row for today gives today all `on` and `MKOE_QUIET_NOTE`. Tomorrow is present when it has a row.
- **Address.**
  - `listCities` reads `mkoeSettlements()`, with no request.
  - `listStreets` is `/addr/ns/{id}/street` (the city resolved with `resolveByLabel` against the bundle), using `nazstreet` names, trimmed, through `uniqueLabels` and sorted.
  - `listHouses` is `/addr/street/{id}/dom`, using `nazdom` trimmed, with `lines: []` and `linesPending: true`.
  - `houseLines` is `/addr/dom/{iddom}/outage-queue`, giving `linesOf` of the `outage.name` of rows with `outage.type_id === 3`.
  - The street and house lists are cached for the run.
- **`fetchSnapshot(a)`.**
  - Resolve the ids; a house missing from the `dom` list throws `AddressNotFoundError`.
  - Fetch the house's `outage-queue`, which gives `lines` and the current outage.
  - For `groupId 'none'`, today is all `on` and the schedule is not read.
  - Otherwise fetch `active`, `time-series` and `by-type/3` and build today and tomorrow. Mykolaiv's schedule is oblast-wide, so a moved queue still has slots: `lines` simply differs, and the app's «лінія змінилась» shows.
- **Current outage.** Rows with `type_id` 1 or 2 and `enabled === 1` give `{kind:'emergency', text: 'Знеструмлення за ГАВ ' + name}` (or `СГАВ`). There are no start, end or `groups`. Type 3 rows are ignored. A failure here never fails the snapshot.

- [ ] **Step 1: Write the failing schedule tests** (`mkoe-schedule.test.ts`). They use the synthetic fixture, plus hand-made variants built in the test.
  - Queue 17 (`2.2`) on its Kyiv date gives `off` in the fixture's slots and `on` elsewhere.
  - `PROBABLY_OFF` gives `maybe-off`.
  - An `OFF` and a `PROBABLY_OFF` on the same slot give `off`.
  - **(Review Focus 6.)** A date with rows but none for `1.1` gives all `on`, not `undefined`.
  - The type `'MAYBE'` throws.
  - `time_series_id: 49` throws.
  - A 47-row time series throws.
  - `by-type/3` without `6.2` throws.
  - `active` as `{}` throws.
  - The `[]` fixture for today gives `undefined`.
- [ ] **Step 2: Write the failing provider tests** (`mkoe-provider.test.ts`).
  - `listCities` makes no request.
  - `listStreets('м. Миколаїв')` requests `/addr/ns/171/street`.
  - `listHouses` gives `linesPending`.
  - `houseLines` on the `dom115392` fixture gives `[Черга 2.2]`.
  - A house with only ГАВ and СГАВ rows gives the `'none'` line.
  - **Quiet day on 2026-10-20** (the real `[]` fixture): the note equals `'Миколаївобленерго не опублікувало графік на сьогодні — зазвичай це означає, що відключень за графіком немає'`.
  - A ГАВ row with `enabled: 1` gives `currentOutage {kind:'emergency', text:'Знеструмлення за ГАВ 8(Р)'}` and no `groups`.
  - A rejected `outage-queue` throws, because the lines and the address check depend on it. A rejected `active` throws.
  - The `'none'` line requests neither `active` nor `time-series`.
- [ ] **Step 3: Run them and see them fail.** `npx vitest run tests/providers/mkoe-schedule.test.ts tests/providers/mkoe-provider.test.ts`
- [ ] **Step 4: Implement** `schedule.ts`, `index.ts`, the `PROVIDERS` entry and the registry line, and update the registry order test to `['dtek-kem','voe','dtek-dnem','dtek-krem','loe','mkoe','dtek-oem','toe']`.
- [ ] **Step 5: Write `smoke-mkoe.ts`.** It goes from `listCities` to «м. Миколаїв», then a street, a house via `houseLines`, and `fetchSnapshot`. Add it to `electron.vite.config.ts`.
- [ ] **Step 6: Verify.** The vitest suites and `npm run typecheck` pass. Then `npm run build` and `npx electron out/main/smoke-mkoe.js`: exit 0, a quiet day today. If `active` is not `[]` when the smoke runs, save that answer to `docs/superpowers/research/2026-10-20-outage-sources-step2/mykolaiv-raw/` and report it: it would be the first real shape.
- [ ] **Step 7: Commit.** «Mykolaiv: schedule, address lookup and switched-on ГАВ from Миколаївобленерго»

### Task 8: Wave check

**Files:** none changed unless a check fails.

- [ ] **Step 1:** `npm test` passes in full, with the count reported, and `npm run typecheck` is clean.
- [ ] **Step 2:** `npm run build`, then the three smoke scripts one after another, each ending with exit 0. Record their outputs in the report.
- [ ] **Step 3:** `npm run dist:win` builds `dist\Blackout Widget Setup 1.0.0.exe`. Record its size and time. Do not run the installer or the app.
