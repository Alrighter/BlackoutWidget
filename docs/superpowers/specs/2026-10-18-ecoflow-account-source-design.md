# EcoFlow sign-in with an account (private MQTT): design

**Date:** 2026-10-18. **Status:** approved by the user in chat. They were asked «Працює це так: ви вводите email і пароль у формі, я до них не торкаюся. Потім ви самі перевіряєте, чи з'являється «Фактично». Робити?» and answered «оце роби да».

**Research:** `docs/superpowers/specs/assets/ecoflow-private-api-research.md` (cited below as R§N). The existing EcoFlow source and its rulings R1–R18 are in `2026-10-17-actual-power-ecoflow-design.md`.

## Why
The user has no EcoFlow developer keys yet, and EcoFlow can take a week or more to approve them. Meanwhile the user wants the «Фактично» line to work. The EcoFlow phone app signs in with email and password and reads live station data over its own MQTT. Several maintained open-source projects use that same path, and it still worked on River 2 in 2026-09 (R§6).

## Goals
- A second EcoFlow source, **«EcoFlow — вхід через акаунт»**: the user enters the email and password of their EcoFlow account, picks the station from the account's list, and the app reads the AC-input (grid) state live over the app MQTT.
- The keys source (`ecoflow`) stays as it is. The user picks either method in the «Джерело» select of the EcoFlow form.
- It works for the River 2 family and other JSON models (River 2 / 2 Max / 2 Pro, Delta 2 / 2 Max / Max / Pro), using the same keys and units as the keys path (R§5.1–5.2).
- Newer protobuf models (River 3, Delta 3, Delta Pro 3, Stream) get an explicit «модель поки не підтримується» state. They must not wait silently forever (R§5.3, §8).

## Non-goals
- Decoding protobuf.
- Controlling the station. The client is read-only and never publishes to `/set` (R§3.7).
- Phone-number login, China accounts.

## Anti-goals
These would make the feature a failure even if it technically worked:
- The password, its base64, the token, the MQTT password, the email or the userId appear in Settings, AppState, IPC results, logs or error texts.
- Login storms: repeated logins on a timer, on every disconnect, or rapid retries after a rejection. These could get the account noticed or locked (R§7).
- The app deletes the user's stored credentials because EcoFlow answered `2026`. That code is ambiguous and can also mean an outage (R§1.5).
- A cached snapshot is treated as live data (R§3.6).

## Behaviour

**Sign-in (HTTP).** The `eu`/`us` region picks the host (R§1.1), and every later call goes to the same host:
1. `POST /auth/login` with `{email, password: base64(utf8), scene: "IOT_APP", userType: "ECOFLOW"}` and the app-like headers `lang: en_US`, `platform: android`, `version: 4.1.2.02`, `user-agent: okhttp/3.14.9` (R§1.2–1.3). It returns `data.token` and `data.user.userId`. Keep `userId` a string.
2. `GET /iot-auth/app/certification?userId=` with `authorization: Bearer <token>`. It returns the MQTT `url`, `port`, `certificateAccount` and `certificatePassword` (R§2).
3. The device list is `GET /iot-service/user/device?userId=` with Bearer. Flatten `data.bound` and `data.share`; each is either an object keyed by SN or a list (R§4).

Error codes:
- `2026` means «EcoFlow не прийняв вхід. Перевірте email, пароль і регіон. Якщо все правильно — можливо, EcoFlow тимчасово недоступний.» It is not a permanent key error.
- `1005` is a bug message.
- Network, timeout and bad-JSON errors behave as on the keys path.

**MQTT.**
- Connection: `mqtts://<url>:<port>`, TLS verify on, MQTT 3.1.1, clean session, keepalive 30 (R§3.1).
- clientId: `ANDROID_<32 upper-case hex>_<userId>`. The hex part is generated once per installation and persisted in settings as `ecoflowAppClientUuid` (R§3.2).
- Subscriptions: `/app/device/property/<sn>` (push) and `/app/<userId>/<sn>/thing/property/get_reply` (snapshot), each in **its own** subscribe call. A subscribe error or granted QoS 128 marks that topic as refused (R§3.5).
- Snapshot requests: publish `{"from":"Android","id":"<ms>","moduleType":0,"operateType":"latestQuotas","params":{},"version":"1.1"}` (QoS 1) to `/app/<userId>/<sn>/thing/property/get`. Send it on every connect, then every 300 s, or every 120 s when the property topic is refused. The timer runs whatever happened to the subscription (R§3.6, §7).
- Data handling:
  - Property pushes are normalized like Open API pushes (R§8) and always count as fresh.
  - A `get_reply` with `online: 0` means the station is offline.
  - A `get_reply` `quotaMap` is merged in, but counts as fresh only when its content changed (R§3.6).
- Grid detection is the existing voltage/frequency rule (R13 and others).
- The existing rulings keep applying where they fit: R6 confirmation in the service, R12 backoff reset, R15 reasons, R18 retained ignore.
- Protobuf: a non-JSON payload on either topic means the model is unsupported. The source reports unknown «Ця модель EcoFlow поки не підтримується входом через акаунт» and writes one log line.

**Politeness and recovery (R§7).**
- One login plus certification at start.
- A full re-login plus certification only on CONNACK 4/5/134/135: once, then a 30-minute pause, the existing rule.
- A plain disconnect reconnects with the same credentials, using `MQTT_BACKOFF_MS` (10 s doubling to 300 s), reset after a proven session.
- A login rejection retries after 30, then 60, then 120 minutes, staying at 120. A network failure retries on the MQTT backoff.
- Stall watchdog: if the client is connected but nothing fresh arrives for 2× the get interval, it reconnects once with the same credentials.

**Form («Налаштування» → EcoFlow).**
- The «Джерело» select offers «EcoFlow — вхід через акаунт» (the default for a new connection) and «EcoFlow — ключі розробника». When editing an existing connection, the select opens on its current mode.
- Account mode shows «Регіон» (Європа / США, existing), «Email» and «Пароль» (`type=password`, autocomplete off), plus this hint: «Неофіційний спосіб — той самий вхід, що й у застосунку EcoFlow. Може перестати працювати, якщо EcoFlow щось змінить. Пароль зберігається зашифрованим лише на цьому комп'ютері.»
- «Перевірити» logs in and lists the stations. The stations step stays the same.
- The preview opens one short MQTT session with a throw-away `ANDROID_<random hex>_<userId>` id: it sends one `latestQuotas` and waits up to 10 s for the reply. That gives the online state plus a grid verdict, or «стан світла з'явиться після збереження» if no reply came.
- «Зберегти» stores `{email, password}` with safeStorage under the source id `ecoflow-app`. Settings get `actualSource = {id: 'ecoflow-app', region, deviceSn, deviceName, accountHint}`, where `accountHint` is the masked email (`r…@dully.io`).
- The connected card reads «EcoFlow · <station> · акаунт <accountHint>».
- If the stored secrets cannot be read, the source reports «Дані входу EcoFlow не знайдено — увійдіть знову в налаштуваннях».

## Constraints
- No new dependencies; `mqtt` is already present.
- Pure modules (`src/shared/**`, and `src/main/actual/**` except `electron-deps.ts`) never import electron.
- The keys source's behaviour and its tests stay unchanged. Shared freshness and merge logic is extracted rather than copied.
- The UI copy is in Ukrainian and matches the design-refresh look (tokens, `.st-*`, `.sv-*`).
- Never touch the user's real app data, never run the installed app, never use real credentials. Tests use fakes.

## Left to the builder
- The internal structure: how `EcoflowAppSource` shares code with `EcoflowSource`.
- Exact log wording.
- Test fixtures, taken from the research samples.
