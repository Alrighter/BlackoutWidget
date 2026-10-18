# EcoFlow private (app-account) API research: email + password login and app MQTT

Research date: 2026-10-18. Read-only. Companion to `ecoflow-research.md` (the official Open API with developer keys).

IMPORTANT CAVEAT: this path is NOT documented by EcoFlow. It is what the EcoFlow mobile app does, reverse-engineered by the community in 2022-2023. There is no official text to quote. Everything below comes from:
- open-source code, with permalinks pinned to the commits listed in section 0;
- real captures checked into those repos (diagnostic dumps, test fixtures, issue logs);
- GitHub issues, with dates.

Nothing was run live: there are no credentials, and none were used. Anything I could not see in code or in a real capture is marked UNCONFIRMED. A "secondary" source is a write-up that summarises others; it is used only where no code says the same thing.

---

## 0. Sources (pinned commits)

| Project | Commit (date) | Role |
|---|---|---|
| tolwi/hassio-ecoflow-cloud | `de02d680cdfe1adcec60c43047ff3ed3da15e0ee` (2026-10-08) | HA integration, "Internal/Private API" mode; River 2 is supported there |
| foxthefox/ioBroker.ecoflow-mqtt | `49ce50cc1a1f39310742ca7e3e703d29e3fce86f` (main, 2026-10-05); branch `1.4.10` = `d1dd3b2f2fef00ca5169b7108313229a7eca3f30` (2026-08-11) | ioBroker adapter, app MQTT only |
| tess1o/go-ecoflow | `2ccc15a17e29d22ea98f968f8ee68c473d3a6a78` (2025-10-03) | Go library; README: "The library was tested on Ecoflow Delta 2 and Ecoflow River 2." |
| tess1o/go-ecoflow-exporter | `b14e734216284ee045c9e35e4cd07df2b754f35d` (2026-10-18) | Prometheus exporter built on go-ecoflow, MQTT mode |
| hobbyquaker/ecoflow2mqtt | `d77ab9812ac9d2319067ba486d4293d4c899b04a` (2026-09-16) | Node.js; app path verified live on an EU account in 2026-08 (STREAM Micro) |
| shuette42/ecoflow-energy-ha | `8c9330038106ab12b1b7ffe4f5e0d2a03ab81fb3` (2026-10-18) | HA integration; app login, device list, "enhanced" certification |
| PetroVoronov/ecoflow-mqtt-to-svitlobot | `071b233867fcee074076fbd7ad64c8a6c0350046` (2024-11-05) | Ukrainian project, same use case (reports grid presence to SvitloBot); tested on Delta Pro |
| windsurf/hassio-ecoflow-eu | `b73e91648672a992210b9e9ee859d0d3f9d6d50e` (2026-04) | Only for its comments on login error codes (secondary) |
| mmiller7/ecoflow-withoutflow, Netfreak25/EcoFlow_MQTT_Creds, energychain/ecoflow_mqtt_credentials | 2022-2023 | The original credential scripts |
| Seb0815/ecoflow-mqtt | — | Does NOT exist (GitHub 404). The user's repo is `Seb0815/ecoflow-mqtt-docker` (`ac48571e…`, 2025-11-14), a STREAM Ultra bridge. Its login matches the others, but its device-list code tries 12 guessed endpoints (`/iot-user/app/devices`, …), so it is not used as evidence here (https://github.com/Seb0815/ecoflow-mqtt-docker/blob/ac48571e345b60fe33d652b024928e1391f31a32/lib/ecoflowCloud.js#L47-L60). |

---

## 1. Login

### 1.1 Endpoint, host, method

`POST https://<api-host>/auth/login`, JSON body, no signature or HMAC.

go-ecoflow (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_client.go#L16-L21):
```go
ecoflowLoginUrl         = "https://api.ecoflow.com/auth/login"
ecoflowScene            = "IOT_APP"
ecoflowUserType         = "ECOFLOW"
ecoflowCertificationUrl = "https://api.ecoflow.com/iot-auth/app/certification"
```
tolwi (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L29-L40):
```python
url = f"https://{self.api_domain}/auth/login"
headers = {"lang": "en_US", "content-type": "application/json"}
...
resp = await session.post(url, headers=headers, json=data)
```

Hosts:
- hobbyquaker region table (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L11-L18):
  ```js
  eu: 'api-e.ecoflow.com',
  us: 'api.ecoflow.com',
  global: 'api.ecoflow.com',
  americas: 'api-a.ecoflow.com',
  cn: 'api-cn.ecoflow.com',
  ```
  Comment there: "Only `eu` is verified on hardware".
- tolwi private mode defaults to `api.ecoflow.com` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/config_flow.py#L260-L266).
- tolwi README (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/README.md#L22-L25):
  ```
  EcoFlow strictly separates accounts by region. If you encounter the error `Account doesn't exist or incorrect password` during the integration setup, verify your `api_host` setting:
  - **Global / US:** `api.ecoflow.com` (Default)
  - **Europe:** `api-e.ecoflow.com`
  ```
- Conflicting evidence on how strict the region binding is. ioBroker (mostly German users), go-ecoflow, mmiller7 and PetroVoronov all hard-code `api.ecoflow.com` and offer no region choice (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L3329-L3343). shuette42 tries EU first and then global (https://github.com/shuette42/ecoflow-energy-ha/blob/8c9330038106ab12b1b7ffe4f5e0d2a03ab81fb3/custom_components/ecoflow_energy/ecoflow/enhanced_auth.py#L35-L39):
  ```python
  _AUTH_BASE_URLS = [
      IOT_API_BASE,  # https://api-e.ecoflow.com (EU)
      "https://api.ecoflow.com",  # global fallback
  ]
  ```
  Whether an EU account always fails on `api.ecoflow.com`: UNCONFIRMED. Practical answer: let the user's existing EU/US region choose the host, and use the same host for every later call. shuette42 does this: "Remember the host that accepted the login so subsequent calls (device list, MQTT credentials) hit the same region." (https://github.com/shuette42/ecoflow-energy-ha/blob/8c9330038106ab12b1b7ffe4f5e0d2a03ab81fb3/custom_components/ecoflow_energy/ecoflow/app_api.py#L127-L129)

### 1.2 Headers

- Minimal set, as used by tolwi, go-ecoflow and the exporter: `lang: en_US` and `content-type: application/json` (go-ecoflow https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_client.go#L140-L141).
- App-like set, as used by ioBroker (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L3333-L3342):
  ```js
  Host: 'api.ecoflow.com',
  lang: 'de-de',
  platform: 'android',
  sysversion: '11',
  version: '4.1.2.02',
  phonemodel: 'SM-X200',
  'content-type': 'application/json',
  'user-agent': 'okhttp/3.14.9',
  ```
  hobbyquaker sends a subset: `lang: 'en_US', platform: 'android', version: '4.1.2.02', 'user-agent': 'okhttp/3.14.9'`. Its comment: "Headers the app sends; some EcoFlow endpoints answer differently without them." (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L22-L29). Which endpoints, and how: UNCONFIRMED.
- Newer app version strings, from a working script posted 2026-06-28 against `api-e.ecoflow.com` (tolwi issue #830 comment, https://github.com/tolwi/hassio-ecoflow-cloud/issues/830):
  ```
  -H "platform: android" -H "version: 6.14.5.82" -H "systemname: user_app" -H "lang: en-us"
  -H "countrycode: DE" -H "sysversion: 16" -H "phonemodel: sdk_gphone64_arm64"
  -H "x-appid: -1" -H "package: com.ecoflow" -H "user-agent: okhttp/4.11.0"
  ```
  The script's author wrote: "not sure if anything is needed here...". Both the old `4.1.2.02` set and the minimal set still log in during 2026 (sect. 6), so no minimum app version is enforced as far as anyone has reported.

### 1.3 Request body

The password is standard base64 of the UTF-8 password. It is NOT encrypted, hashed or salted; TLS is the only protection. `scene` and `userType` are identical in every implementation:
```
"scene": "IOT_APP"
"userType": "ECOFLOW"
```
tolwi (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L31-L36):
```python
data = {
    "email": self.ecoflow_username,
    "password": base64.b64encode(self.ecoflow_password.encode()).decode(),
    "scene": "IOT_APP",
    "userType": "ECOFLOW",
}
```
ioBroker adds app fields (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L3344-L3352):
```js
appVersion: '4.1.2.02',
email: email,
os: 'android',
osVersion: '30',
password: Buffer.from(password).toString('base64'),
scene: 'IOT_APP',
userType: 'ECOFLOW',
```
The tolwi #830 script (2026) also adds `"countryCode":"DE"`:
```
{"appVersion":"6.14.5.82","email":"$EMAIL","os":"android","osVersion":"16","password":"$PW_B64","scene":"IOT_APP","userType":"ECOFLOW","countryCode":"DE"}
```
hobbyquaker's comment (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L1-L4): "No signature, no OAuth — the password goes base64 encoded (not encrypted) over TLS, exactly like the Android app".

### 1.4 Response

Success:
```json
{"code":"0","message":"Success","data":{"token":"<JWT>","user":{"userId":"<19-digit>","name":"…","email":"…", …}}}
```
- `code` is the string `"0"`. go-ecoflow types it `Code string` (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_model.go#L42-L63). tolwi treats `message.lower() != "success"` as an error (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/__init__.py#L117-L136).
- Fields read by everyone: `data.token` and `data.user.userId`. tolwi: `response["data"]["token"]` and `response["data"]["user"]["userId"]` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L50-L53).
- Other `user` fields in the go-ecoflow struct: `email, name, icon, state, regtype, createTime, destroyed, registerLang, source, administrator, appid, countryCode`.
- `userId` is 19 digits (ioBroker README: "UserID - a 19 digit number", https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/README.md). go-ecoflow types it `UserId string`, and Go's `json.Unmarshal` fails on a number into a string field, so the wire value is a JSON string (my inference). Keep it a string in TS anyway, because 19 digits exceed `Number.MAX_SAFE_INTEGER`. hobbyquaker does `String(data.user.userId)` (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L113-L116).

Error responses also carry `eagleEyeTraceId` and `tid` (real response in sect. 1.5).

### 1.5 Error codes

- `2026` / `"Account doesn't exist or incorrect password"`. Real response pasted in tolwi issue #312, 2024-09-02 (https://github.com/tolwi/hassio-ecoflow-cloud/issues/312):
  ```
  "code": "2026",
      "message": "Account doesn't exist or incorrect password",
      "eagleEyeTraceId": "ea1a2a623f17252911577408450d0007",
      "tid": ""
  ```
  The same code covers several cases that cannot be told apart:
  - an unknown account;
  - a wrong password;
  - the wrong region host (tolwi README, sect. 1.1);
  - a transient EcoFlow outage. tolwi PR #902, 2026-08-23 (https://github.com/tolwi/hassio-ecoflow-cloud/pull/902): "EcoFlow's private `/auth/login` response is not a reliable credential verdict. The endpoint can return the same coded rejection for invalid stored credentials and for a transient service failure". hobbyquaker (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L6-L8): "a wrong region answers "Account doesn't exist or incorrect password" — the same message a real outage returns (tolwi #902). Nothing here ever discards credentials because of an error".
- `1005` / `"Incorrect format of password"`: sent when the password is not base64. Secondary, from a code comment (https://github.com/windsurf/hassio-ecoflow-eu/blob/b73e91648672a992210b9e9ee859d0d3f9d6d50e/custom_components/ecoflow_cloud/api_client.py#L301-L304):
  ```
  code=1005 = "Incorrect format of password" -> wrong encoding sent
  code=2026 = "Account doesn't exist or incorrect password" -> wrong base64/credentials
  ```
- Too many attempts or account lock: UNCONFIRMED. No code, message or report was found in any of the projects or their issues. Treat any non-`0` code as "do not retry soon".
- Transport errors: tolwi treats a non-200 HTTP status or a missing `message` as a retryable `EcoflowException` without a code (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L41-L48).

### 1.6 Captcha / 2FA

- None of the implementations handles a captcha, an email code or 2FA, and none needs to; all of them log in with one POST.
- hobbyquaker's research notes (secondary): "No CAPTCHA, signature, 2FA, device limit, or ban reported as of 2026-08." (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/RESEARCH.md#L410-L413)
- Risk: EcoFlow could add any of these at any time. Login by phone number, or for China accounts, is a different flow (UNCONFIRMED, out of scope).

---

## 2. MQTT credentials

### 2.1 Endpoint and auth

`GET https://<same api-host>/iot-auth/app/certification?userId=<userId>` with the header `authorization: Bearer <token>`.

ioBroker (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L3397-L3399):
```js
options.path = `/iot-auth/app/certification?userId=${userid}`;
options.method = 'GET';
options.headers.authorization = `Bearer ${token}`;
```
hobbyquaker (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L124-L129):
```js
url: `https://${host}/iot-auth/app/certification?userId=${encodeURIComponent(userId)}`,
headers: {authorization: `Bearer ${token}`},
```
PetroVoronov sends the same request plus `lang: 'en_US'` (https://github.com/PetroVoronov/ecoflow-mqtt-to-svitlobot/blob/071b233867fcee074076fbd7ad64c8a6c0350046/src/index.js#L443-L445).

How `userId` is passed differs between projects:
- tolwi sends it as a form body on the GET: `data=user_data` with `{"userId": self.user_id}` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L109-L128);
- go-ecoflow sends it as a JSON body on the GET (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_client.go#L83-L96);
- mmiller7 sends no `userId` at all (https://github.com/mmiller7/ecoflow-withoutflow/blob/31471ba4b806f7ed89a856510108be8ab8783ebf/cloud-mqtt/ecoflow_get_mqtt_login.sh#L99).

All of these work, so the server probably takes the user from the token. Recommendation: use the query parameter, as ioBroker, hobbyquaker, PetroVoronov and the 2026 #830 script do.

### 2.2 Response

```json
{"code":"0","message":"Success","data":{"url":"mqtt-e.ecoflow.com","port":"8883","protocol":"mqtts","certificateAccount":"app-…","certificatePassword":"…"}}
```
- Field names and types, from go-ecoflow (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_model.go#L11-L29): `certificateAccount`, `certificatePassword`, `url`, `port` (a string), `protocol`.
- tolwi parses `int(resp_json["data"]["port"])` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/__init__.py#L104-L113).
- `certificateAccount` starts with `app-` (ioBroker README "UserName - something like "app-...."", and hobbyquaker ROADMAP: "Certification host `mqtt-e.ecoflow.com:8883`, account `app-…`", https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/ROADMAP.md#L254). Open API accounts start with `open-` (see ecoflow-research.md 2.1).
- The host can be `mqtt.ecoflow.com` or `mqtt-e.ecoflow.com`. It is sometimes the wrong region. ioBroker README: "In cases where the mqtt-server refuses the connection it might be helpfull to check ... in some cases it will return a different mqtt-broker address". hobbyquaker allows an override: `broker.host = config.mqttHost; // certification occasionally names the wrong region` (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L195-L197).

### 2.3 How long the credentials stay valid

- Expiry of `certificateAccount` / `certificatePassword`: UNCONFIRMED.
- Inference: ioBroker asks the user to fetch them once (script, website or button) and stores UserName, UserID, password and ClientID permanently in the adapter config. It reconnects with those stored values for months, with no login at runtime (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/README.md, section "EF credentials"; https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/main.js#L76-L82). So they are long-lived, probably until the password changes.
- JWT `token` lifetime: UNCONFIRMED. It is only needed for the certification and device-list calls, so there is no need to keep it.
- Refresh strategy used by others: log in and certify again only when the broker refuses the credentials (CONNACK 4/5).
  - hobbyquaker (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/mqtt.js#L156-L164): `if (AUTH_ERRORS.has(code)) { ... this.#restart(); }`, with `AUTH_ERRORS = new Set([4, 5])`.
  - tolwi stops retrying on auth failure: "paho would otherwise retry the rejected credentials forever" (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/ecoflow_mqtt.py#L126-L134).

### 2.4 Second door (not needed)

`GET /iot-auth/enterprise-development/user/certification` returns AES-CFB encrypted credentials, decrypted with key = SHA256(JWT) and IV `ojsajkqjwk1w2dfg`. It comes from the EcoFlow web portal JS (https://github.com/shuette42/ecoflow-energy-ha/blob/8c9330038106ab12b1b7ffe4f5e0d2a03ab81fb3/custom_components/ecoflow_energy/ecoflow/enhanced_auth.py#L30-L33 and #L158-L186). Only worth knowing in case EcoFlow ever closes `/iot-auth/app/certification`.

---

## 3. MQTT session

### 3.1 Broker and TLS

- `mqtts://<data.url>:<data.port>`, in practice port 8883, TLS with a public CA and certificate verification ON. tolwi (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/ecoflow_mqtt.py#L42-L44):
  ```python
  self.__client.username_pw_set(self.__mqtt_info.username, self.__mqtt_info.password)
  self.__client.tls_set(certfile=None, keyfile=None, cert_reqs=ssl.CERT_REQUIRED)
  self.__client.tls_insecure_set(False)
  ```
- The username is `certificateAccount` and the password is `certificatePassword`.
- Protocol MQTT 3.1.1: hobbyquaker sets `protocolVersion: 4, clean: true, keepalive: 30` (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/mqtt.js#L134-L143).
- Clean session in all projects (tolwi `clean_session=True`, ecoflow_mqtt.py#L33-L38).

### 3.2 clientId format

The format must be `ANDROID_<random>_<userId>`:
- tolwi (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L63-L64):
  ```python
  # Should be ANDROID_..str.._user_id !!!
  self.mqtt_info.client_id = f"ANDROID_{str(uuid.random_uuid_hex()).upper()}_{self.user_id}"
  ```
- go-ecoflow: `// ClientID is always should be "ANDROID_%uuid%_%user_id%` and `opts.SetClientID(fmt.Sprintf("ANDROID_%s_%s", uuid.New(), c.UserId))` (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_client.go#L41-L52)
- ioBroker: ``mqttDaten.clientID = `ANDROID_${uuidv4()}_${userid}`;`` (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L3410)
- hobbyquaker: ``const clientId = `ANDROID_${this.uuid}_${this.userId}`;`` with the UUID upper-case hex and no dashes (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/mqtt.js#L131 and https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/clientid.js#L24-L27)
- mmiller7: ``echo "ANDROID_`uuidgen | tr '[:lower:]' '[:upper:]'`_${user_id}"`` (https://github.com/mmiller7/ecoflow-withoutflow/blob/31471ba4b806f7ed89a856510108be8ab8783ebf/cloud-mqtt/ecoflow_get_mqtt_login.sh#L19-L23)

The middle part varies between working projects: upper-case hex without dashes (tolwi, hobbyquaker), lower-case dashed UUIDv4 (ioBroker, go-ecoflow), and an 8-digit timestamp (windsurf). So the broker probably checks only the `ANDROID_` prefix and the `_<userId>` suffix (UNCONFIRMED observation). windsurf's comment (secondary): "The EcoFlow MQTT broker authenticates the client ID and requires the ANDROID_ prefix — other prefixes result in rc=5 (Not Authorized)." (https://github.com/windsurf/hassio-ecoflow-eu/blob/b73e91648672a992210b9e9ee859d0d3f9d6d50e/custom_components/ecoflow_cloud/api_client.py#L345-L363). tolwi's `gen_client_id()`, with an md5 "verify_info" suffix, is dead code, headed `# Failed to connect to MQTT: not authorised` (private_api.py#L66-L75).

Persist the random part. hobbyquaker (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/clientid.js#L1-L8): "EcoFlow's broker filters on that shape (R §4.2) and keeps a session per client id, so the UUID is generated once and then reused for the life of the instance". PetroVoronov caches it the same way: `cache.getItem('mqttClientIdPrefix') || `ANDROID_${uuidv4().toUpperCase()}`` (https://github.com/PetroVoronov/ecoflow-mqtt-to-svitlobot/blob/071b233867fcee074076fbd7ad64c8a6c0350046/src/index.js#L130).

Limits on unique clientIds:
- The "only 10 unique client IDs per day" rule (ecoflow-research.md 2.2) is a claim about the developer Open API.
- For the app broker: UNCONFIRMED. No report of such a limit in any project or issue found; hobbyquaker's notes say "device limit" was never reported (secondary, RESEARCH.md#L410-L413). Persisting one UUID makes the question moot.
- Two connections with the SAME clientId kick each other off (normal MQTT behaviour). So never run the widget and a test script with the same id at the same time.

### 3.3 Does connecting kick the phone app off?

- No report found of a third-party connection logging the phone app out or disconnecting it. The phone uses its own `ANDROID_<uuid>_<userId>` id. windsurf's comment (secondary): "When the EcoFlow mobile app is also connected it uses the same prefix with a different random part, so both sessions can coexist on the broker." (api_client.py#L356-L358)
- The documented effect runs the other way: opening and then closing the phone app makes the cloud stop pushing to the other client.
  - TelosNox, 2026-01-13, tolwi #676: "Open EF app and it "steals" the authentication. Only EF app can then force to update values. If no authenticated updates are triggered, there are only forced updates by some timeout (seems to be 15min)." (https://github.com/tolwi/hassio-ecoflow-cloud/issues/676)
  - go-ecoflow-exporter docs: "there is a strange behavior that MQTT stop sends messages if you open Ecoflow mobile app and then close it" (https://github.com/tess1o/go-ecoflow-exporter/blob/b14e734216284ee045c9e35e4cd07df2b754f35d/docs/prometheus.md#L27-L31)
  - tolwi #830, 2026-06-27, private API: "values in both the wave 3 and stream series appliances stop updating after about 5 minutes after closing the mobile app" (https://github.com/tolwi/hassio-ecoflow-cloud/issues/830)
  - tolwi PR #909, 2026-08-31, measured on the PUBLIC API: re-SUBSCRIBE did nothing, but "reconnect, same credentials, no HTTP | telemetry resumes immediately", and "the registration appears to be account-level, not per-device" (https://github.com/tolwi/hassio-ecoflow-cloud/pull/909). Whether a plain reconnect cures it on the private API: UNCONFIRMED.
  - tolwi PR #860 notes that on the private API every re-login "opens a new app session" (https://github.com/tolwi/hassio-ecoflow-cloud/pull/860).
- Anecdote with an unclear cause: tolwi #933 (2026-10-09), a Delta 2 user on the private API wrote "I opened the Ecoflow app and had to re-login" while the integration was broken. The integration itself was fixed by reinstalling (https://github.com/tolwi/hassio-ecoflow-cloud/issues/933). One report, no causal link shown.

### 3.4 Topics

From tolwi `_create_device_info` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/private_api.py#L102-L106):
```python
data_topic=f"/app/device/property/{device_sn}",
set_topic=f"/app/{self.user_id}/{device_sn}/thing/property/set",
set_reply_topic=f"/app/{self.user_id}/{device_sn}/thing/property/set_reply",
get_topic=f"/app/{self.user_id}/{device_sn}/thing/property/get",
get_reply_topic=f"/app/{self.user_id}/{device_sn}/thing/property/get_reply",
```
ioBroker subscribes to the same five (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L2556-L2569). A status topic is commented out there, so the private API has no `/status` topic:
```js
//topics.push('/app/' + userID + '/' + key + '/status')
//topics.push('/app/device/status+ '/' + key)
```
For a read-only client:
- subscribe to `/app/device/property/<sn>` (push) and `/app/<userId>/<sn>/thing/property/get_reply` (snapshots);
- publish only to `/app/<userId>/<sn>/thing/property/get`.

hobbyquaker subscribes exactly these two, one call per topic (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/mqtt.js#L184-L196). go-ecoflow subscribes only the property topic (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_client.go#L173-L178).

### 3.5 Warning: the property topic was refused for some accounts (2026-07 onwards)

Against the topic:
- ioBroker issue #456, 2026-07-26 (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/issues/456):
  ```
  Verified with mosquitto_sub:
  - /app/device/property/+ → SUBACK 128 (denied)
  - /app/<userID>/<serial>/thing/property/set_reply → SUBACK 0 (OK)
  ```
  Because ioBroker sends all five topics in ONE `subscribe()` call, the one refusal failed the whole subscribe ("es kommen gar keine Daten mehr rein", no data at all). Its `latestQuotas` timer only starts on `!err` (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/main.js#L667-L676).
- The maintainer reproduced it on 2026-08-11 ("Den Fehler konnte ich reproduzieren", I could reproduce the error). Branch `1.4.10` removed the subscription (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/d1dd3b2f2fef00ca5169b7108313229a7eca3f30/lib/ecoflow_utils.js#L2648):
  ```js
  //topics.push(`/app/device/property/${key}`); // #456 no longer supported!
  ```
  The README on that branch lists it under "### 1.4.10 (npm)": "(Tigerlilly28) #456 remove topic /app/device/property/ (the updates) from subscription". So it looks like a published release, not just a branch. The ioBroker main branch (2026-10-05) still subscribes to the topic.

For the topic:
- hobbyquaker, live on an EU account on 2026-08-28, after the ioBroker report: "purely passive subscriber: 147 frames in 8 min, avg 3.2 s, max gap 10.3 s — **no throttling**" (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/ROADMAP.md#L261-L263; the commit history dates that file to 2026-08-28/29).
- tolwi #918, 2026-09-22, base River 2 on the private API, v1.7.1: "all power-flow sensors update live and correctly", including "all AC in/out power/volts/energy" (https://github.com/tolwi/hassio-ecoflow-cloud/issues/918). Apart from one request at integration setup (delta3.py#L183-L186 docstring: "Tolwi's ``PrivateAPIClient.quota_all`` calls ... during integration setup"), tolwi publishes `latestQuotas` for River 2 only after 300 s of silence (`QuotaStatusSensorEntity`, `poll_when_silent=True`, https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/sensor.py#L746-L756 and `DEFAULT_ASSUME_OFFLINE_SEC: Final = 300`, https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/__init__.py#L71). So "live" values mean the push topic works for that user.

Possibly related: tolwi #916, 2026-09-19, a Delta 2 Max on the private API gets no telemetry and shows offline, while the app works (https://github.com/tolwi/hassio-ecoflow-cloud/issues/916).

Conclusion: the refusal hits some accounts or devices. The cause (region, account age, device binding, wildcard vs. exact SN) is UNCONFIRMED. The design must survive it:
- subscribe each topic in its own call, so a refusal can be pinned on one topic;
- treat either a subscribe `err` or a granted QoS of `128` as "refused". In mqtt.js v5 a refused topic arrives as `err` (`ErrorWithSubackPacket`, exactly what #456 shows), not only as granted QoS 128;
- run the `get` timer whether or not the property subscription succeeded;
- when the property topic is refused, the `get_reply` snapshots become the only data, at the `get` interval. Whether they prove the station is live is UNCONFIRMED (sect. 3.6).

### 3.6 "Get all": `latestQuotas`

Push messages are partial: only changed fields, one module per message (see the Delta 2 capture in sect. 5.1). To get a full snapshot, publish a `latestQuotas` request.

Topic: `/app/<userId>/<sn>/thing/property/get`

The exact payload as the EcoFlow Android app sent it, captured in tolwi's River 2 Max diagnostic dump (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/diag/river_2_max.json#L769-L777):
```json
{
  "from": "Android",
  "id": "179531081",
  "moduleType": 0,
  "operateType": "latestQuotas",
  "params": {},
  "version": "1.1"
}
```
tolwi's own payload. The JSONMessage wrapper adds `"from": "HomeAssistant"`, `"id": str(999900000 + random 10000..99999)` and `"version": "1.0"`, then the command overrides `version` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/__init__.py#L202-L211 and https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/message.py#L14-L45):
```python
{"version": "1.1", "moduleType": 0, "operateType": "latestQuotas", "params": {}}
```
go-ecoflow-exporter (https://github.com/tess1o/go-ecoflow-exporter/blob/b14e734216284ee045c9e35e4cd07df2b754f35d/mqtt_exporter.go#L401-L417):
```go
"id":          strconv.FormatInt(time.Now().UnixMilli(), 10),
"version":     "1.1",
"from":        "Android",
"operateType": "latestQuotas",
"params":      map[string]interface{}{},
...
topic := fmt.Sprintf("/app/%s/%s/thing/property/get", m.userId, sn)
token := m.c.Client.Publish(topic, 1, false, payload)
```
It sends one right after subscribing: `// Request initial data from device (like the official app does)` (mqtt_exporter.go#L239-L254).

The reply arrives on `.../thing/property/get_reply`. Real River 2 Max reply, from the same diag file at #L923-L933, abridged; a River 2 Pro (`R621…`) fixture has the same shape (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/test/data/r2test.json):
```json
{"code":"0","id":179531081,"moduleType":0,"operateType":"latestQuotas","version":"1.1",
 "data":{"sn":"*********","productType":71,"model":1,"online":1,
         "quotaMap":{"inv.acInVol":227718,"inv.acInFreq":50,"inv.acInAmp":1655,"inv.inputWatts":356, …169 keys}}}
```
Offline device: `data.online` is 0 and there is no usable `quotaMap`. tolwi (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/__init__.py#L188-L199):
```python
if "operateType" in data and data["operateType"] == "latestQuotas":
    message_data = data["data"]
    online = int(cast(bool | int | str, message_data["online"]))
    if online == 1:
        return PreparedData(online == 1, {"params": message_data["quotaMap"], "time": dt.utcnow()}, data)
    else:
        return PreparedData(False, None, data)
```
ioBroker also flags offline on `payload['data']['online'] === 0` (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/ecoflow_utils.js#L615-L690).

Is a `get_reply` proof of fresh data? UNCONFIRMED, and probably not.
- An offline station still gets an answer (`online: 0`), so the cloud, not the station, sends the reply.
- In tolwi's River 2 Max dump, replies 2 to 18 (17 replies to requests from HomeAssistant) have byte-identical `quotaMap`s across all 169 keys, including `inv.acInAmp: 1570` next to `inv.acInVol: 0`. I checked this with Python over the diag file. That pattern fits a server-side cache, like the frozen Open API quota/all snapshot described in tolwi PR #860, but an idle station could also produce it.
- Design rule: merge `quotaMap` into the map. Count it as fresh only when its content changed since the last reply. Only property-topic pushes count as fresh unconditionally.

Protobuf models (River 3, Delta 3, …) ignore this JSON request. tolwi (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/internal/delta3.py#L640-L650): "The base ``BaseInternalDevice`` returns a JSON ``latestQuotas`` message which the protobuf-only DELTA 3 firmware silently ignores." They need a protobuf "get all" instead: a `HeaderMessage` with one header holding only `src=32, dest=32, seq, from` (delta3.py#L169-L195). Its bytes for a STREAM, from tolwi #830 (2026-06-28):
```
GET_HEX="0a141020182070bb8cc9d501ba0107416e64726f6964"   # = Protobuf-'get'
#   0a 14              msg (Field 1), Lenght 0x14=20  ->  StreamACHeader {
#     10 20              Feld 2  src    = 0x20 = 32
#     18 20              Feld 3  dest   = 0x20 = 32
#     70 bb8cc9d501      Feld 14 seq    = Request-ID
#     ba01 07 "Android"  Feld 23 from   = "Android"
```

### 3.7 Keep-alive and cadence used by others

| Project | MQTT keepalive | `latestQuotas` / get cadence | Source |
|---|---|---|---|
| tolwi | 15 s | once at setup, then only after 300 s of silence (River 2) | ecoflow_mqtt.py#L54; sensor.py#L746-L756; delta3.py#L183-L186 |
| ioBroker | 60 s, `reconnectPeriod: 5000` | on connect, then every 300 s: `}, 300 * 1000); // lastQuot every 5min` | https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/main.js#L640-L676 |
| go-ecoflow-exporter | paho default | on connect, then `defaultStateRefreshIntervalSeconds = 300 // 5 minutes` | https://github.com/tess1o/go-ecoflow-exporter/blob/b14e734216284ee045c9e35e4cd07df2b754f35d/main.go#L28-L37 |
| hobbyquaker | 30 s | `--poll` seconds (protobuf get) | mqtt.js#L134-L143, #L198-L203 |
| tolwi #830 script | n/a | every 60 s (and it logs in on every run, so do not copy it) | issue #830 |

The exporter's 20 s "ping" is a WRITE. `sendRtcTimePing` publishes `"operateType": "setRtcTime"` with the PC's date and time to `/app/<userId>/<sn>/thing/property/set` (https://github.com/tess1o/go-ecoflow-exporter/blob/b14e734216284ee045c9e35e4cd07df2b754f35d/mqtt_exporter.go#L432-L470; `defaultPingIntervalSeconds = 20`). That sets the station's clock. A read-only app must never publish to `/set`.

---

## 4. Device discovery

Yes, there is an app endpoint, so the user does not have to type the serial number:

`GET https://<api-host>/iot-service/user/device` with the header `Authorization: Bearer <token>`. hobbyquaker also adds `?userId=`; shuette42 does not.

hobbyquaker, verified live on a real EU account (https://github.com/hobbyquaker/ecoflow2mqtt/blob/d77ab9812ac9d2319067ba486d4293d4c899b04a/lib/app/login.js#L142-L178):
```
 * Verified on the real account (ROADMAP §6.1): `data.bound` is an **object keyed by SN**, not an
 * array, each value `{deviceName, model, productType, online, productSkuId, createTime}`.
...
url: `https://${host}/iot-service/user/device?userId=${encodeURIComponent(userId)}`,
```
Its ROADMAP adds: "✅ Login on `api-e.ecoflow.com` works; region = `eu`. `/iot-service/user/device` returns `data.bound` as an **object keyed by SN** (not an array)" (ROADMAP.md#L251-L253).

shuette42 handles both groups and both shapes (https://github.com/shuette42/ecoflow-energy-ha/blob/8c9330038106ab12b1b7ffe4f5e0d2a03ab81fb3/custom_components/ecoflow_energy/ecoflow/app_api.py#L353-L384):
```
The Portal API returns devices grouped by ownership:
    {"bound": {SN: {deviceInfo}}, "share": {SN: {deviceInfo}}, ...}
Each group can also contain list-based formats:
    {"bound": {groupKey: [deviceInfo, ...]}}
```
It reads `productName` (falling back to `name`) and `online`. Its docstring says the list "returns ALL devices bound to the user's EcoFlow account, regardless of IoT Developer API key binding" (enhanced_auth.py#L192-L205).

Response shape to code against:
```json
{"code":"0","data":{"bound":{"R60xxxxxxxxxxxx":{"deviceName":"…","model":1,"productType":71,"online":1,"productSkuId":"…","createTime":"…"}},"share":{…}}}
```
- `online` lags. hobbyquaker: "`online` lags by up to ~15 minutes on EcoFlow's side, so it is reported and never used to drop a device".
- The readable model name: `deviceName` is the user-editable name. `productName` exists only per shuette42's parser (UNCONFIRMED in a real response). `model` is a small number of unknown meaning.
- `productType` values seen in real River 2 family data: `71` = River 2 Max (tolwi diag river_2_max.json, `"productType": 71`) and `72` = River 2 Pro (ioBroker r2test.json, SN `R621…`). Base River 2: UNCONFIRMED.

Others:
- tolwi private mode has no discovery; `fetch_all_available_devices` returns `[]` (private_api.py#L77-L78), so the user types the SN.
- go-ecoflow README: "Please note you have to know device's serial number in order to use MQTT api."

Not evidence: Seb0815's 12 guessed endpoints (sect. 0), and windsurf calling the Open API `/iot-open/sign/device/list` with a Bearer token.

---

## 5. Message format

### 5.1 River 2 / River 2 Max / River 2 Pro / Delta 2 / Delta 2 Max / Delta Max / Delta Pro: JSON

These models send JSON. The envelope on `/app/device/property/<sn>` is not the Open API's `typeCode` style. It has a string `moduleType` and a `params` object whose keys are ALREADY dotted with the module prefix, so they are the same strings as the Open API quota/all keys.

Real Delta 2 capture from the app broker, posted 2022-11-28 (https://github.com/v1ckxy/ecoflow-withoutflow/issues/6):
```
{"id":1330299626203776316,"version":"1.0","timestamp":1669603259,"moduleType":"3","params":{"inv.acInVol":123113}}
{"id":1330299635822756850,"version":"1.0","timestamp":1669603260,"moduleType":"3","params":{"inv.acInAmp":66,"inv.acInVol":123084}}
{"id":1330299618754038533,"version":"1.0","timestamp":1669603258,"moduleType":"2","params":{"bms_bmsStatus.minCellTemp":26,"bms_bmsStatus.vol":53494,"bms_bmsStatus.f32ShowSoc":89.7}}
{"id":1330299634793709708,"version":"1.0","timestamp":1669603260,"moduleType":"5","params":{"mppt.carOutVol":46,"mppt.outVol":53331,"mppt.carTemp":36}}
```
Corroboration:
- go-ecoflow types the push as `Id int64`, `Timestamp int`, `ModuleType string` (a string, matching the capture) and `Params map[string]interface{}` (https://github.com/tess1o/go-ecoflow/blob/2ccc15a17e29d22ea98f968f8ee68c473d3a6a78/mqtt_model.go#L31-L38).
- tolwi's private devices just merge `params` into one flat map. There is no `typeCode` handling outside `devices/public/` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/data_holder.py#L115-L118):
  ```python
  def __update_params(self, params: dict[str, Any]):
      if "params" in params:
          self.params.update(params["params"])
  ```
- PetroVoronov (Delta Pro, app broker) reads the same envelope: `typeof data.params?.[ecoFlowACInputVoltage] === 'number'` with `const ecoFlowACInput = 'inv.acIn';` (https://github.com/PetroVoronov/ecoflow-mqtt-to-svitlobot/blob/071b233867fcee074076fbd7ad64c8a6c0350046/src/index.js#L157-L160 and #L308-L320).
- shuette42 accepts both `typeCode` and dotted `params` on the app topic (https://github.com/shuette42/ecoflow-energy-ha/blob/8c9330038106ab12b1b7ffe4f5e0d2a03ab81fb3/custom_components/ecoflow_energy/coordinator/mqtt_ingest.py#L673-L688, comment `# Dot-notation format: {"params": {"pd.soc": 85, ...}}`). A `typeCode` message on the app topic: UNCONFIRMED (no capture); handling both costs nothing.

The `id` is 19 digits and loses precision in `JSON.parse`. That is harmless if it is never used.

The `get_reply` snapshot uses the same dotted keys inside `data.quotaMap` (sect. 3.6).

### 5.2 AC-input keys (River 2 family, app API)

The same keys and units as in the Open API quota/all (ecoflow-research.md 3.1).

| key | unit | real values, River 2 Max get_reply (tolwi diag) |
|---|---|---|
| `inv.acInVol` | mV | grid on: `227718`; grid off: `0` |
| `inv.acInFreq` | Hz | grid on: `50`; grid off: `0` |
| `inv.acInAmp` | mA | grid on: `1655`; grid off: `0` in one sample, but `1570` in 17 later samples while `acInVol` was `0` |
| `inv.inputWatts` | W | grid on: `356`; grid off: `0` |
| `inv.chargerType` | enum | `1` with grid on; `0` in one off sample, but `1` in the later off samples |

Source: https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/diag/river_2_max.json (grid on at #L1002-L1085; grid off from #L1220 on). River 2 Pro fixture with grid on: `"inv.acInVol": 229524`, `"inv.acInFreq": 50`, `"inv.acInAmp": 3779`, `"inv.inputWatts": 850` (ioBroker test/data/r2test.json).

- `inv.acInAmp` and `inv.chargerType` are therefore NOT reliable "plugged in" flags. Voltage and frequency are.
- No explicit "AC plugged in" flag exists for this family (as in the Open API research).
- tolwi's base-River-2 private device reads `inv.inputWatts` and `inv.acInVol` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/internal/river2.py#L61-L63).
- Some base River 2 units use other prefixes for BMS and config keys (`bmsMaster.soc`, `inv.cfgAcEnabled`) instead of the ones tolwi expected, while the AC-in keys work (tolwi #918 table above).
- Push behaviour: `inv.acInVol` is in mV, so with the grid on it changes on every report (the capture shows it every ~1 s). With the grid off it stays `0` and, being unchanged, is probably not re-sent (UNCONFIRMED). Silence on that key therefore means "no change", not "no data". Freshness has to come from any push message of the station, plus a `get_reply` whose content changed (sect. 3.6).
- PetroVoronov's rule `inputVoltage > 0 && inputCurrent > 0 && inputFrequency > 0` (index.js#L319) would call a full battery "no grid", because the current is ~0 when nothing charges. Do not copy it. The app's existing voltage/frequency rule (`grid.ts`) is the right one.

### 5.3 Newer models: protobuf on the app broker

ioBroker routes these device types to its protobuf decoder (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/main.js#L727-L755):
- `delta3`, `delta3plus`, `delta3classic`, `delta3maxplus`, `deltapro3`, `deltaproultra`;
- `river3`, `river3plus`;
- `stream_ac`, `stream_ac_pro`, `stream_pro`, `stream_ultra`, `stream_ultra_x`, `stream_inverter`;
- `pstream`, `plug`, `powerocean*`, `panel2`, `smartmeter`, `glacier55`, `wave3`, `alternator`, `rapidpro320`.

tolwi has `.proto` files for River 3, Delta 3, Delta Pro 3 and STREAM (custom_components/ecoflow_cloud/devices/internal/proto/).

Envelope (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/internal/proto/ef_river3.proto#L5-L36 and #L438-L440):
```proto
message River3Header {
    optional bytes pdata = 1;   optional int32 src = 2;   optional int32 dest = 3;
    optional int32 enc_type = 6; optional int32 cmd_func = 8; optional int32 cmd_id = 9;
    optional int32 seq = 14;    optional string from = 23; ... (fields 4-25)
}
message River3HeaderMessage { repeated River3Header header = 1; }
```
- Dispatch on `cmd_func=254`: `cmd_id=21` is "Display Property Upload" and `cmd_id=22` is "Runtime Property Upload" (ef_river3.proto#L39-L40, #L150-L151).
- XOR obfuscation: `if enc_type == 1 and src != 32`, then every pdata byte is XORed with `seq` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/devices/internal/river3.py#L470-L486).

AC-input fields, River 3 (Delta 3 uses the same numbers, ef_delta3.proto#L63-L67, #L89, #L162, #L171):

| field | number | wire type | message | source |
|---|---|---|---|---|
| `pow_get_ac_in` | 54 | float, W | Display (254/21) | ef_river3.proto#L67 |
| `plug_in_info_ac_in_flag` | 61 | uint32 ("AC input connected flag") | Display | #L68 |
| `plug_in_info_ac_in_feq` | 62 | uint32, Hz | Display | #L69 |
| `plug_in_info_ac_charger_flag` | 202 | uint32 (bool) | Display | #L90 |
| `plug_in_info_ac_in_vol` | 68 | float, V | Runtime (254/22) | #L159 |
| `plug_in_info_ac_in_amp` | 223 | float, mA (per comment) | Runtime | #L168 |

- tolwi exposes them under snake_case keys: `"pow_get_ac_in"`, `"plug_in_info_ac_in_vol"` (river3.py#L213-L215).
- These are NOT the Open API camelCase names (`plugInInfoAcInVol`), so `grid.ts` would need snake_case aliases.
- River 3 units have also been seen sending BMS keys prefixed `msg32_2_1_` (tolwi #936, 2026-10-13, https://github.com/tolwi/hassio-ecoflow-cloud/issues/936).

Can it be decoded without big dependencies? Yes, for this narrow need:
- The protobuf wire format here is just varints, 32-bit floats (wire type 5) and length-delimited fields.
- ioBroker ships a 177-line, dependency-free wire decoder (`decodeVarint`, `decodeProto`) in https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/lib/helper/protobufhelper.js.
- The full adapters use `protobufjs` (ioBroker package.json `"protobufjs": "^8.8.0"`, hobbyquaker `"protobufjs": "^7.4.0"`).
- Size estimate (not a source fact): decoding the header (fields 1, 2, 6, 8, 9, 14) plus the six AC fields above by field number is about 100-150 lines of TS.
- The real costs are elsewhere:
  - per-model field tables;
  - the protobuf "get all" (sect. 3.6);
  - maintaining it when firmware changes, as with the `msg32_2_1_` prefixes;
  - there is no River 3 / Delta 3 hardware to test on.

---

## 6. Status in 2025-2026

Timeline (all dates from the linked pages):
- 2024-09-02. tolwi #312: login answered `2026`. The user moved to the Open API. Possibly region or credentials; not resolved (https://github.com/tolwi/hassio-ecoflow-cloud/issues/312).
- 2025-10-31. go-ecoflow-exporter commit "Fixed MQTT support" (+163 lines). It added the `latestQuotas` request on connect and the `setRtcTime` ping, which means a passive subscriber was no longer enough for its author (https://github.com/tess1o/go-ecoflow-exporter/commit/746581f).
- 2026-01-13. tolwi #676: the phone app "steals" updates (sect. 3.3).
- 2026-06-27/28. tolwi #830: values stop about 5 min after closing the app (private API, STREAM/WAVE 3). The workaround script logs in on `api-e.ecoflow.com` with app version `6.14.5.82`, so login worked in June 2026.
- 2026-07-26 and 2026-08-11. ioBroker #456: SUBACK 128 on `/app/device/property/<sn>`. Branch 1.4.10 stops subscribing to it (sect. 3.5).
- 2026-08-23. tolwi PR #902: a private-login rejection is ambiguous (credentials vs. outage).
- 2026-08-28. hobbyquaker: login, certification, device list and passive push all verified live on an EU account.
- 2026-09-19. tolwi #916: Delta 2 Max, private API, no telemetry. A 2026-10-04 comment there: "I have my Delta Max 2000 still with the Username/Password installed and with that, it is delivering data correctly."
- 2026-09-22. tolwi #918: base River 2, private API, v1.7.1, AC-in and power sensors live.
- 2026-10-13. tolwi #936: River 3, private API, working with new key prefixes.

Summary:
- The private login still works as of 2026-10. The `scene` (`IOT_APP`) and `userType` (`ECOFLOW`) are unchanged since 2022-2023.
- No app-version gate has been reported; the 2023 version string `4.1.2.02` is still sent by working code.
- The two moving parts in 2026 are:
  - stalled pushes after the phone app was used;
  - the property-topic refusal for some accounts.
- The client-ID filter (ANDROID_ prefix) dates from 2023 (hobbyquaker notes, secondary, RESEARCH.md#L298-L302).

ToS: worth telling the user.
- EcoFlow's website terms (https://eu.ecoflow.com/pages/ecoflow-terms-of-use, https://us.ecoflow.com/pages/terms-of-use). The EU page says they also cover the app: "This website/APP is operated by Ecoflow Inc. ("EcoFlow")." The US page says "Lasted update: July 5,2024." Both contain, among the prohibited uses:
  - "(k) to interfere with or circumvent the security features of the Service or any related website, other websites, or the Internet."
  - "We reserve the right to terminate your use of the Service or any related website for violating any of the prohibited uses."
  - Elsewhere: "we also may terminate this agreement at any time without notice".
  These strings were checked verbatim in the raw HTML of both pages with curl on 2026-10-18.
- Product manuals point to an app-specific Terms of Use at `ecoflow.com/policy/terms-of-use`; that URL returned 404 on 2026-10-18 (UNCONFIRMED content).
- No clause found that names unofficial clients or API access explicitly.
- ioBroker README warning: "This adapter uses a non-offical communication with the devices. Wrong communication or setting wrong values can affect the functionality of the device and may lead to exclusion from the service." (https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/49ce50cc1a1f39310742ca7e3e703d29e3fce86f/README.md)
- No case of an account actually banned for this was found.

Plain-language note for the user: this is unofficial and could stop working at any time. It stores the account password (encrypted) on the PC. In theory it breaks the terms of use. A read-only client that only subscribes and sends a rare "get" is the lowest-risk way to use it.

---

## 7. Safety and politeness

Recommendations from the sources above. The numbers are design choices unless a source is given.

- Log in rarely. Do one `/auth/login` plus `/iot-auth/app/certification` at start. Repeat it only on CONNACK 4/5 (bad credentials / not authorised), never on a timer and never on a plain disconnect. hobbyquaker re-certifies only on 4/5 (mqtt.js#L156-L164). PR #860 proposed re-login backoff steps of 5, 10, 20, 40 and 80 min (https://github.com/tolwi/hassio-ecoflow-cloud/pull/860).
- Treat `2026` at runtime as possibly transient. Retry slowly, e.g. after 30 min and then less often. Show the user "check password / region", but never delete the stored credentials (tolwi #902, hobbyquaker login.js#L6-L8).
- Region fallback: at most once, during setup only. A wrong password tried on two hosts doubles the failed attempts.
- No lockout threshold is known (sect. 1.5), so the setup wizard should not allow rapid retries either.
- MQTT reconnect backoff: start at 10 s, double, cap at 300 s. These are hobbyquaker's `MIN_BACKOFF = 10_000`, `MAX_BACKOFF = 300_000` (mqtt.js#L20-L21), the same as the app's existing `MQTT_BACKOFF_MS`. Use one connection and one persisted clientId.
- MQTT keepalive: 30-60 s. tolwi uses 15, hobbyquaker 30, ioBroker 60.
- `latestQuotas`: once on connect, then at most every 60 s. ioBroker and the exporter use 300 s. Use 60-120 s only if the property subscription was refused, so the snapshot is the only data. Never publish to `/set`, which rules out the exporter's `setRtcTime` ping.
- Stall watchdog: if no property-topic push arrives and no changed `get_reply` comes in for about 2× the get interval while connected, reconnect once with the same credentials and no login. Unchanged replies keep arriving from the cloud, so they must not count as signs of life (PR #909's finding on the public API; UNCONFIRMED for private).
- Never log the email, the password or its base64, the token, `certificatePassword` or the userId. tolwi logs the whole certification response at INFO (`_LOGGER.info(f"Received MQTT credentials: {resp_json}")`, https://github.com/tolwi/hassio-ecoflow-cloud/blob/de02d680cdfe1adcec60c43047ff3ed3da15e0ee/custom_components/ecoflow_cloud/api/__init__.py#L105). PR #860 called that out ("Credentials are no longer logged"). Do not copy it.

---

## 8. Implementation notes for this app

How the findings map onto `src/main/actual/ecoflow/*` (read 2026-10-18):

**`mqtt-message.ts`**
- Reuse `normalizeQuotaMessage` as is for the push topic. A private push like `{"moduleType":"3","params":{"inv.acInVol":123113}}` has no `typeCode`, `cmdFunc` or `addr`, so `prefix` stays `''` and the output is `{"inv.acInVol":123113}`. Those are exactly the quota/all keys `grid.ts` already reads.
- Pin this with a unit test that uses the v1ckxy Delta 2 lines from sect. 5.1, including a 19-digit `id`.
- New: `parseGetReply(msg)`. If `operateType === 'latestQuotas'` and `code === '0'`, return `{ online: data.online === 1, quota: data.quotaMap }`. Use the River 2 Max sample (sect. 3.6) as a fixture, plus an `online: 0` case without `quotaMap`.
- `parseStatusMessage` is not used. The private API has no `/status` topic; online state comes from `get_reply.data.online` and the device list.

**`grid.ts`**
- Reusable unchanged for the JSON family (River 2 / 2 Max / 2 Pro, Delta 2 / 2 Max / Max / Pro): same keys, same mV unit.
- The diag data confirm that `inv.acInAmp` and `inv.chargerType` must stay out of the decision, which `detectGrid` already does.
- Protobuf models would need snake_case aliases (`plug_in_info_ac_in_vol`, `plug_in_info_ac_in_feq`, `plug_in_info_ac_in_flag`, `pow_get_ac_in`) AND a decoder (sect. 5.3). Recommend: River 2 family first.
- The existing code does NOT cover protobuf payloads today. In `source.ts` the message handler does `try { msg = JSON.parse(payload.toString()); } catch { return; }`, so a binary frame never reaches the map. `logUnsupported` then returns early on `keys.length === 0`. A River 3 or Delta 3 user would see "чекаю на дані від станції" forever, with no log line.
- So the private source needs an explicit branch: a non-JSON payload (first byte `0x0a`, protobuf field 1 length-delimited) on the property or `get_reply` topic gives "модель поки не підтримується", with one log line.

**`api.ts`**
- Reuse the error and timeout pattern, `NetworkError`, and the host table idea (`eu → api-e.ecoflow.com`, `us → api.ecoflow.com` matches the login hosts).
- New `EcoflowAppApi`:
  - `login(email, password)`: a POST with a JSON body. Today's `FetchLike` is GET-only, so widen it to `method: 'GET' | 'POST'` plus an optional `body`. Send base64 of the UTF-8 password and `scene: 'IOT_APP'`, `userType: 'ECOFLOW'`. Keep `userId` as a string.
  - `getAppCertification()`: `GET /iot-auth/app/certification?userId=` with `authorization: Bearer`.
  - `listAppDevices()`: `GET /iot-service/user/device`. Flatten `bound` and `share`, keyed or list form, into the existing `EcoflowDevice` shape (`sn`, `online`, `deviceName`, `productName?`).
- New error texts: `2026` must say "wrong email/password, wrong region, or EcoFlow is down", because the code cannot tell these apart, and it must NOT set `keyProblem`-style permanent failure. Add `1005` (bad password encoding: a bug, not the user's fault).
- `sign.ts` is not used on this path.

**`source.ts`**
Reusable:
- the MQTT client lifecycle;
- the retained-message ignore (R18);
- `sessionProven` / `SESSION_PROOF_MS`;
- `MQTT_BACKOFF_MS`;
- the `freshAt` / `FRESH_MS` logic;
- the R8 merge of MQTT keys;
- `evaluate` / `reading`.

New or changed:
- `MqttClientLike` needs `publish(topic, payload, { qos: 1 })`. `MqttConnect` opts can stay; use keepalive 30-60.
- The clientId must be `ANDROID_<persisted 32-hex>_<userId>`. Today's `ctx.clientId` (`BlackoutWidget-XXXXXXXX` from `actions.ts makeClientId`) is reported to be refused with rc 5 (secondary sources: the windsurf comment and hobbyquaker's notes; not tested). Persist only the random part, and build the id after login, when `userId` is known.
- Topics: subscribe to `/app/device/property/<sn>` and `/app/<userId>/<sn>/thing/property/get_reply` in SEPARATE `subscribe` calls. Treat a subscribe `err` or `granted[i].qos === 128` as refused. A refused property topic must not stop the get timer (ioBroker #456).
- Freshness: property-topic pushes go through the existing `applyMqttQuota` (always fresh). `get_reply.quotaMap` goes through the `applyQuota` path, where the existing `canonical` / `lastQuota` check advances `freshAt` only when the content changed (sect. 3.6).
- There is no HTTP quota/all and no `/status`. The `quota` poll is replaced by a `latestQuotas` publish timer (on connect, then every 60-300 s). The `devices` poll becomes `listAppDevices` every 5+ min, which needs a valid token. Because the token lifetime is UNCONFIRMED, either re-login for it (costly), or poll the list only at start and on reconnect and rely on `get_reply.online`.
- `AUTH_REFUSED` (4/5/134/135) must now cure with a full re-login plus certification, not just a new certificate. Keep the existing "once, then 30 min pause" rule. Count login failures separately with a slow backoff.
- `FRESH_MS` must stay above the get interval. But no get interval can make a steady station look fresh when the property topic is refused: identical snapshots do not advance `freshAt`. The honest result on such an account, with the grid steady, is "дані станції не оновлюються". Accept that rather than treating a cached snapshot as live.
- A stall watchdog: connected but silent for more than about 2× the get interval → reconnect with the same credentials.
- Secrets: generalise `scrubKeys` to cover the email, password, base64 password, token, `certificatePassword` and userId.

**`index.ts`**
- New factory `ecoflow-app` (or a mode of `ecoflow`) taking `secrets.email` / `secrets.password` and `config.region` / `config.deviceSn`.
- `ecoflowPreview` cannot stay HTTP-only, because there is no quota/all on this path. Either show only the device list (login + `/iot-service/user/device`), or open a short MQTT session (one `latestQuotas`, wait ≤10 s for `get_reply`) with the same persisted clientId.
- `ecoflowTest` becomes login + device list. That also fixes discovery: let the user pick the station from the list instead of typing the SN.
