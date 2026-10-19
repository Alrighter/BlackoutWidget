# EcoFlow account sign-in (private MQTT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** add a second EcoFlow source, `ecoflow-app`. It signs in with the EcoFlow account's email and password and reads the grid state over the app MQTT. The keys source stays as an alternative.

**Architecture:**
- A new HTTP client `EcoflowAppApi` handles login, the MQTT certification and the device list.
- A new `EcoflowAppSource` handles MQTT only: a push topic, plus `latestQuotas` snapshots on a timer.
- It shares the map, freshness and evaluation logic with `EcoflowSource`, through a helper extracted from `source.ts`.
- The renderer form gets an account mode. Actions, IPC and settings take a tagged input `mode: 'keys' | 'account'`.

**Tech Stack:** Electron 44, TypeScript 7, React 19, vitest 5, `mqtt` 5.16.0. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-18-ecoflow-account-source-design.md`. Research: `docs/superpowers/specs/assets/ecoflow-private-api-research.md`, cited as R§N.

## Global Constraints
- **Secrets stay hidden.** These never appear in Settings, AppState, IPC results, logs or error texts: the email, the password, its base64, the token, `certificatePassword`, the userId. Logs go through a scrubber that covers all of them. Settings show `accountHint` only, the masked email `r…@domain`.
- **Read-only client.** It publishes only `latestQuotas` to `/app/<userId>/<sn>/thing/property/get`, and never anything to `/set`.
- **Login politeness.**
  - Log in once at start.
  - Re-login only on CONNACK 4/5/134/135: once immediately, then after pauses of 30, 60, then 120 minutes (reset by a proven session).
  - A login rejection retries after 30, 60, then 120 minutes, staying at 120.
  - Never delete the stored credentials because of an EcoFlow error.
- **The keys source (`ecoflow`) keeps its behaviour.** Its existing tests may change only imports.
- **Code boundaries.**
  - No new dependencies.
  - Pure modules never import electron.
  - The app and widget bundles never import each other.
- **UI.** Copy is in Ukrainian. The look follows the design-refresh tokens and classes.
- **Safety.**
  - Never use real credentials, the user's real app data, or the installed app.
  - Tests use fake fetch and fake MQTT.
  - The capture rig stubs the API.
- **Commits.** Subject and body only. No `Co-Authored-By` and no Claude attribution lines.

## Review Focus
1. **Property topic refused (SUBACK 128).**
   - Snapshots must keep coming on the get timer.
   - A steady grid then honestly reads «дані станції не оновлюються».
   - The source must never sit in «чекаю» forever without a reason.
2. **Phone app opened, then closed** (pushes stop). The stall watchdog reconnects once with the same credentials, with no login.
3. **Wrong password or region (`2026`).**
   - Show a clear message.
   - Retry slowly.
   - The stored credentials stay.
4. **Protobuf model** (River 3 etc.). Show an explicit «не підтримується» with one log line, never a silent wait.
5. **Save, then restart the app.** The persisted clientId uuid is reused. The secrets load under `ecoflow-app`. If they are missing, show the account-specific reason.

---

### Task 1: App HTTP client, error texts, secret scrubbing

**Files:**
- Create `src/main/actual/ecoflow/app-api.ts`.
- Modify `src/main/actual/ecoflow/api.ts`: widen `FetchLike`, add error texts.
- Modify `src/main/actual/secrets.ts`: add `maskEmail` and a general scrubber.
- Modify the real fetch adapter in `src/main/actual/electron-deps.ts`, so that it passes `method` and `body`.
- Tests: `tests/main/actual/ecoflow-app-api.test.ts`, `tests/main/actual/secrets.test.ts`.

**Interfaces:**
- `FetchLike` init becomes `{ method: 'GET' | 'POST'; headers: Record<string,string>; body?: string; signal?: AbortSignal }`. Existing callers keep `'GET'`.
- `export interface AppAccount { email: string; password: string }`
- `export interface AppSession { token: string; userId: string }`
- `export interface EcoflowAppApiLike { login(): Promise<AppSession>; getCertification(s: AppSession): Promise<MqttCertificate>; listDevices(s: AppSession): Promise<EcoflowDevice[]> }`
- `export class EcoflowAppApi implements EcoflowAppApiLike`, constructed as `(region: EcoflowRegion, account: AppAccount, deps: { fetch: FetchLike; timeoutMs?: number })`. It reuses `ECOFLOW_HOSTS`, `NetworkError`, `EcoflowApiError` and the timeout pattern of `EcoflowApi`.
- `describeEcoflowError`:
  - adds `'2026'`, worded as the spec gives it;
  - adds `'1005'`: «EcoFlow не прийняв формат пароля (1005). Це помилка застосунку — повідомте розробника.»
  - `2026` is NOT `keyProblem`.
- `export function maskEmail(email: string): string` returns the first character, `…`, then `@domain` (e.g. `r…@dully.io`). Input without `@` gives `…`.
- `export function scrubSecrets(text: string, secrets: readonly string[]): string` replaces every non-empty secret with `…`. The longest secret is replaced first. `scrubKeys` keeps its current behaviour.

**Steps:**
- [ ] Write the failing tests, with exact values from R§1–R§4:
  - **Login request.** The body is exactly `{"email":"a@b.c","password":"<base64 of 'pässword'>","scene":"IOT_APP","userType":"ECOFLOW"}` (check the UTF-8 base64 with `ä`). It is a POST to `https://api-e.ecoflow.com/auth/login` for `eu`, and to `https://api.ecoflow.com/auth/login` for `us`. The headers include `content-type: application/json`, `lang: en_US`, `platform: android`, `version: 4.1.2.02`, `user-agent: okhttp/3.14.9`.
  - **Login response.** `{"code":"0","message":"Success","data":{"token":"T","user":{"userId":"1234567890123456789"}}}` gives `{token:'T', userId:'1234567890123456789'}`, kept as a string. A numeric `userId` becomes a string; note the precision caveat in a comment.
  - **Login errors.** `{"code":"2026","message":"Account doesn't exist or incorrect password"}` throws `EcoflowApiError` with code `2026`, `keyProblem` false, and the spec text. HTTP 500 throws `http-500`. A timeout throws `timeout`. Non-JSON throws `bad-json`. A fetch reject throws `NetworkError`.
  - **Certification.** It is a GET to `/iot-auth/app/certification?userId=1234567890123456789` with `authorization: Bearer T`. `{"code":"0","data":{"url":"mqtt-e.ecoflow.com","port":"8883","protocol":"mqtts","certificateAccount":"app-x","certificatePassword":"p"}}` gives `{host:'mqtt-e.ecoflow.com', port:8883, account:'app-x', password:'p'}`.
  - **Device list.** It is a GET to `/iot-service/user/device?userId=…` with Bearer. Its `data.bound` keyed by SN `{"R601ABC":{"deviceName":"River","online":1}}` plus `data.share` as a list `[{"sn":"R602","deviceName":"Shared","online":0}]` gives two `EcoflowDevice` with the right `online` booleans. An empty or missing `data` gives `[]`.
  - **Secrets helpers.** `maskEmail('roman@dully.io') === 'r…@dully.io'`. `scrubSecrets('pw=secret token=T', ['secret','T']) === 'pw=… token=…'`.
- [ ] Run `npx vitest run tests/main/actual/ecoflow-app-api.test.ts tests/main/actual/secrets.test.ts`. Expect them to FAIL.
- [ ] Implement.
- [ ] Run the same tests, then `npx vitest run` and `npm run typecheck`. Expect all to PASS, with the existing EcoFlow tests unchanged.
- [ ] Commit `Add the EcoFlow app sign-in client`.

### Task 2: Shared quota tracker and `EcoflowAppSource`

**Files:**
- Create `src/main/actual/ecoflow/quota-tracker.ts`.
- Create `src/main/actual/ecoflow/app-source.ts`.
- Modify `src/main/actual/ecoflow/source.ts` to use the tracker.
- Modify `src/main/actual/ecoflow/mqtt-message.ts`: add `parseGetReply` and `isProtobufPayload`.
- Modify `src/main/actual/ecoflow/index.ts`: add the factory `ecoflow-app`.
- Modify `src/main/actual/registry.ts`: register it.
- Tests: `tests/main/actual/ecoflow-app-source.test.ts`, `tests/main/actual/mqtt-message.test.ts`. The existing `ecoflow-source` tests stay unchanged.

**Interfaces:**
- `MqttClientLike` gains `publish(topic: string, payload: string, opts: { qos: 1 }, cb?: (err?: Error) => void): void`. The `mqtt` adapter in `electron-deps.ts` already returns an mqtt.js client that has it.
- `quota-tracker.ts`: extract the merge/freshness/evaluation state shared by both sources: the null-prototype map, the R8 MQTT keys, `canonical` change detection, `freshAt`, and the evaluation into an `ActualReading` with the existing reasons. `EcoflowSource` must behave the same, and its tests must pass unchanged. Name it as you see fit and document it.
- `mqtt-message.ts`:
  - `parseGetReply(msg: unknown): { online: boolean; quota: Record<string, unknown> | null } | null` returns non-null only for `operateType === 'latestQuotas'` with `code === '0'`.
  - `isProtobufPayload(buf: Buffer): boolean` returns true when the payload is not valid JSON-object text. A leading `0x0a` is the typical case.
- `export class EcoflowAppSource implements ActualStateSource`, constructed as `(cfg: { sn: string; clientUuid: string }, api: EcoflowAppApiLike, deps: { connect: MqttConnect; log: Logger; now?: () => number; random?: () => number; setTimer?/clearTimer? (follow the EcoflowSource test seams) })`.
- `index.ts`:
  - `createEcoflowAppFactory(deps)` returns `{ id: 'ecoflow-app', displayName: 'EcoFlow', create(config, secrets, ctx) }`. The secrets are `{email, password}`, and `ctx.clientId` is the persisted uuid.
  - `ecoflowAppTest(api)` returns `login` then `listDevices`.
  - `ecoflowAppPreview(api, connect, sn, random)` runs the short session from the spec: a throw-away clientId, at most 10 s, closed in `finally`. It returns `{ online, verdict }`, or `verdict` unknown «стан світла з'явиться після збереження» on no reply. A protobuf reply gives `unsupported`.

**Behaviour to test** (fake MQTT plus fake timers; every value comes from the spec):
- [ ] Start runs `login`, then `getCertification`, then connects to `mqtts://mqtt-e.ecoflow.com:8883` with clientId `ANDROID_<uuid>_1234567890123456789`, the username and password from the cert, `keepalive: 30`, `clean: true` and `reconnectPeriod: 0`.
- [ ] On connect: two **separate** `subscribe` calls for `/app/device/property/R601ABC` and `/app/1234567890123456789/R601ABC/thing/property/get_reply`. Then one publish to `…/thing/property/get`, whose payload is JSON with `operateType:'latestQuotas'`, `version:'1.1'`, `from:'Android'`, `moduleType:0` and `params:{}`.
- [ ] Get timer: next publish after 300 000 ms. If the property subscribe failed (err, or granted qos 128), the next publish comes after 120 000 ms instead, and the timer still runs.
- [ ] A property push `{"moduleType":"3","params":{"inv.acInVol":227718,"inv.acInFreq":50}}` gives a reading `on`. A later push with `inv.acInVol: 0, inv.acInFreq: 0` gives `off`. A push with a 19-digit `id` parses fine.
- [ ] A retained message is ignored (R18).
- [ ] A `get_reply` `{"code":"0","operateType":"latestQuotas","data":{"online":1,"quotaMap":{"inv.acInVol":227718,"inv.acInFreq":50}}}` gives `on`. The same reply again does NOT advance freshness. After `FRESH_MS` with only identical replies, the reading turns unknown with the existing "not updating" reason.
- [ ] `get_reply` with `data.online: 0` gives unknown, with the existing station-offline reason.
- [ ] A protobuf payload (`Buffer.from('0a141020182070', 'hex')`) on either topic gives unknown «Ця модель EcoFlow поки не підтримується входом через акаунт». It is logged once, not on every message.
- [ ] Watchdog: connected, no fresh data for 600 000 ms (2× the get interval). The client is ended and reconnected with the **same** cert. `login` is not called again.
- [ ] Close or error: reconnect with `MQTT_BACKOFF_MS` (10 s, 20 s, …). The backoff resets after a session that lasted `SESSION_PROOF_MS` (R12).
- [ ] CONNACK refusal code 5: one full `login` plus `getCertification`, then reconnect. A second refusal pauses for 30 min (`MQTT_AUTH_PAUSE_MS`).
- [ ] A `login` that throws `EcoflowApiError('2026')` gives unknown with its message as the reason. Retries come after 30 min, 60 min, then 120 min, staying at 120. A `NetworkError` retries on `MQTT_BACKOFF_MS` instead.
- [ ] `stop()` clears all timers and ends the client. No reading is emitted after stop.
- [ ] Logs: capture the logger calls in a test. None contains the email, the password, the token, the cert password or the userId.
- [ ] Preview: publishes `latestQuotas` once, and resolves from the `get_reply` within 10 s. With no reply in 10 s it resolves to the "after saving" verdict and ends the client. The client is always ended.
- [ ] Steps: write the tests → see them fail → extract the tracker, with the existing source tests green → implement the source and factory → run `npx vitest run` and `npm run typecheck`, both PASS → commit `Add the EcoFlow account source over the app MQTT`.

### Task 3: Settings, IPC and actions wiring

**Files:**
- Modify `src/shared/types.ts`, `src/shared/ipc.ts` and `src/preload/index.ts` (types only, if the signatures change).
- Modify `src/main/actual/actions.ts` and `src/main/index.ts`.
- Modify the settings store validation, if `actualSource` is validated (`src/main/store.ts`).
- Tests: `tests/main/actual/actions.test.ts` and the store tests.

**Interfaces:**
- `ActualSourceConfig` becomes a union:
  - `{ id: 'ecoflow'; region; deviceSn; deviceName; accessKeyHint }`
  - `| { id: 'ecoflow-app'; region; deviceSn; deviceName; accountHint }`
- `Settings` gains `ecoflowAppClientUuid?: string`: 32 upper-case hex characters, generated once on the first account save.
- `EcoflowKeysInput` becomes the union `EcoflowInput`:
  - `{ mode: 'keys'; region; accessKey; secretKey }`
  - `| { mode: 'account'; region; email; password }`
- `RendererApi.ecoflowTest/ecoflowPreview/ecoflowSave` take an `EcoflowInput`. Input with no `mode` is read as `'keys'`, for compatibility.
- `actions.ts`:
  - `readInput` validates both modes. The email must be trimmed, contain `@`, and be at most 200 characters. The password must be non-empty and at most 200 characters, and is NOT trimmed.
  - `test`, `preview` and `save` dispatch by mode.
  - An account save:
    - stores `{email, password}` under `ecoflow-app`;
    - sets `actualSource` to `{id: 'ecoflow-app', region, deviceSn, deviceName, accountHint: maskEmail(email)}`;
    - sets `ecoflowAppClientUuid`, keeping an existing value;
    - removes the other mode's stored secrets once the new ones are saved.
  - `disconnect` removes the secrets of both ids.
  - Errors are scrubbed with `scrubSecrets([email, password, base64(password)])`.
- `createActualRestart`:
  - for `ecoflow-app`, it passes `ctx.clientId = settings.ecoflowAppClientUuid`, generating and persisting one if missing;
  - it loads the secrets for `config.id`;
  - missing `email`/`password` starts a stand-in source with the reason «Дані входу EcoFlow не знайдено — увійдіть знову в налаштуваннях»;
  - the keys path is unchanged.
- `ActualActionsDeps` gains `makeAppApi(region, account): EcoflowAppApiLike` and `connect: MqttConnect` (for the preview). Wire both in `index.ts`.

**Steps:**
- [ ] Failing tests:
  - account `test` returns the device list (fake app api);
  - account `save` stores the secrets under `ecoflow-app`, sets settings with `accountHint: 'r…@dully.io'` and the uuid (`/^[0-9A-F]{32}$/`), and keeps an existing uuid;
  - the invalid inputs fail with `Перевірте введені дані`: an email without `@`, an empty password, an unknown mode;
  - restart with the `ecoflow-app` config and missing secrets gives the reason text above;
  - restart with secrets calls the factory with `clientId` = the uuid;
  - an error message containing the password or its base64 comes back scrubbed;
  - all existing keys-path tests pass unchanged, apart from adding `mode: 'keys'` if needed.
- [ ] Implement.
- [ ] Run `npx vitest run` and `npm run typecheck`. Expect PASS.
- [ ] Commit `Wire the EcoFlow account source into settings and IPC`.

### Task 4: The form's account mode and the connected card

**Files:**
- Modify `src/renderer/src/app/ActualSettings.tsx`, `src/renderer/src/app/app.css` (only if needed), `src/renderer/src/app/ScheduleView.tsx` (only if it shows the source label), and the rig stubs in `scripts/ui-capture/`.
- Tests: `tests/renderer/actual-settings.test.tsx`.

**What:**
- **The «Джерело» select.** Options: «EcoFlow — вхід через акаунт» (value `account`, default for a new connection) and «EcoFlow — ключі розробника» (value `keys`). When editing an existing connection, it starts on that connection's mode.
- **Account fields.** «Email» (`type="email"`, `autoComplete="off"`) and «Пароль» (`type="password"`, `autoComplete="off"`). Both clear on save and on cancel, like the keys.
- **Hint text.** Use the spec text verbatim: «Неофіційний спосіб — той самий вхід, що й у застосунку EcoFlow. Може перестати працювати, якщо EcoFlow щось змінить. Пароль зберігається зашифрованим лише на цьому комп'ютері.» In keys mode the existing hint and the «Як отримати ключі» link stay.
- **«Перевірити», stations, preview, «Зберегти».** Same flow and states as the keys mode, sending `{mode:'account', region, email, password}`.
- **Connected card.** «EcoFlow · <station> · акаунт <accountHint>». The keys mode keeps «ключ <hint>».
- **Never shown.** The DOM never contains the password, in any attribute or text.
- **Tests:**
  - the default mode is account;
  - switching to keys shows the key fields and the help link;
  - account test → stations → save sends exactly `{mode:'account', region:'eu', email, password}`;
  - the connected card shows the account hint;
  - the password never appears in `document.body.innerHTML` after save.
  - All existing keys-mode tests keep holding; update selectors only.
- **Captures.** Use the rig (`--stubs` covers the account flow). Capture both themes: the account form, the stations step and the connected card. No horizontal overflow at 886×604.
- **Commit:** `Add the EcoFlow account option to the settings form`.
