# EcoFlow IoT Open API research (for AC/grid-presence detection)

Research date: 2026-10-17. Read-only.

IMPORTANT CAVEAT: developer.ecoflow.com and developer-eu.ecoflow.com are JS single-page apps. WebFetch returned only the title "Ecoflow Developer". I could NOT read the official docs text directly. Everything below is from (a) a forum post that quotes the official steps, (b) open-source clients that implement the official docs (several state that their code or comments are copied from the official docs), (c) per-device tables in open-source repos. Each fact has a source URL. Anything not confirmed is marked UNCONFIRMED.

Official doc pages (not directly readable): https://developer-eu.ecoflow.com/us/document/generalInfo , https://developer.ecoflow.com/us/document/introduction , https://developer.ecoflow.com/us/document/delta3maxplus

---

## 1. Signing

### 1.1 Official steps (quoted on a forum, paraphrasing the official doc)
Source: https://forum.iobroker.net/topic/76703/verbindung-mit-neuer-ecoflow-api/15?lang=en-GB (quotes EcoFlow doc)

- Step 1: "request parameters must be sorted by ASCII value and concatenated with characters =, &" (e.g. `str=param1=value1&param2=value2`)
- Step 2: "if the type is nested, expand and splice according to the method of step 1."
- Step 3: "concatenate accessKey, nonce, timestamp" (e.g. `str=param1=value1&param2=value2&accessKey=***&nonce=...&timestamp=...`)
- Step 4: "encrypt" `byte[] signBytes = HMAC-SHA256(str, secretKey)`
- Step 5: convert byte[] to hex string -> `sign`
- Step 6: "add accessKey, nonce, timestamp, sign to HTTP header"

### 1.2 Worked example / unit-test vector (VERIFIED by me with node crypto, output matched)
Sources (same vector in all): https://github.com/rgerhards/ecoflow-iot-developer-api-sample/blob/main/ecoflow_api_sample.py (header comment: "signature calculation from the api sample at https://developer.ecoflow.com/us/document"), https://github.com/zarbjustin/uk.co.zarb.ecoflow/blob/main/test/sign.test.js ("documented golden vector"), https://github.com/hobbyquaker/ecoflow2mqtt/blob/main/RESEARCH.md ("Official test vector"). The doc's request body: `{"sn":"123456789","params":{"cmdSet":11,"id":24,"eps":0}}`

Verbatim from rgerhards sample:
```
accessKey="Fp4SvIprYSDPXtYJidEtUAd1o"
secretKey="WIbFEKre0s6sLnh4ei7SPUeYnptHG6V"
nonce=345164
timestamp=1671171709428
params = "params.cmdSet=11&params.eps=0&params.id=24&sn=123456789"
oksig = "07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e"
okkvstring = "params.cmdSet=11&params.eps=0&params.id=24&sn=123456789&accessKey=Fp4SvIprYSDPXtYJidEtUAd1o&nonce=345164&timestamp=1671171709428"
```
Signature = lowercase hex of HMAC-SHA256(key = secretKey UTF-8, message = okkvstring UTF-8).

Node check I ran: `crypto.createHmac('sha256','WIbFEKre0s6sLnh4ei7SPUeYnptHG6V').update(okkvstring).digest('hex')` -> `07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e` (matches).

Second flatten vector (zarbjustin test, derived from the doc's example, not a sign value): input `{name:'demo1', ids:[1,2,3], deviceInfo:{id:1}, deviceList:[{id:1},{id:2}]}` -> `deviceInfo.id=1&deviceList[0].id=1&deviceList[1].id=2&ids[0]=1&ids[1]=2&ids[2]=3&name=demo1` (https://github.com/zarbjustin/uk.co.zarb.ecoflow/blob/main/test/sign.test.js)

### 1.3 Flattening rules (confirmed by several implementations)
- Nested objects: dot notation `parent.child=value`. Arrays: `key[i]=value`, object-in-array `deviceList[0].id=1`. Sorted by ASCII key order. (https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/apis/ecoFlowHttpApiManager.ts `composeSignMessage`; https://github.com/shuette42/ecoflow-energy-ha/blob/main/custom_components/ecoflow_energy/ecoflow/cloud_http.py `_flatten`)
- accessKey, nonce, timestamp are APPENDED AT THE END, in that fixed order, NOT sorted into the params: `<sorted params>&accessKey=..&nonce=..&timestamp=..`. When there are no params, the string is just `accessKey=..&nonce=..&timestamp=..`. (tolwi: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/api/public_api.py `__gen_sign`; homebridge above; the doc vector above)
- GET requests: the query string params ARE the signed params (e.g. `sn=...`). Example from homebridge spec: URL `.../iot-open/sign/device/quota/all?sn=sn1` signed with `sn=sn1&accessKey=...&nonce=...&timestamp=...`. tolwi: `target_str = query_params + "&" + target_str`. shuette42: "for GET use query params". (links above; spec https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/apis/ecoFlowHttpApiManager.spec.ts)
- Values are not URL-encoded in the signed string. Booleans must be signed as `true`/`false` (Python `True` gave 8521). Null as `null`. (shuette42 cloud_http.py `_flatten`; htims1989 CHANGELOG "Control set commands failed with `8521: signature is wrong`. Booleans are now ..." https://github.com/htims1989/ecoflow-public-api/blob/main/CHANGELOG.md)
- Headers: `accessKey`, `nonce`, `timestamp` (ms since epoch), `sign`. Nonce: 6-digit random (tolwi uses randint(10000,1000000), homebridge pads to 6 digits). Timestamp must be close to server time: 8521/8524 rejections have been tied to clock skew (tesseractAZ/power rest.ts: "a timestamp-class rejection (8521 signature / 8524 timestamp) is the vendor telling us our signing clock is WRONG" https://github.com/tesseractAZ/power/blob/main/server/src/ecoflow/rest.ts) - secondary source.
- Content-Type on GET: shuette42 notes that setting Content-Type on a GET makes the server validate the signature as if a body were present and reject with 8521. (cloud_http.py link above) - secondary, UNCONFIRMED in official docs.
- Hosts: `https://api.ecoflow.com` (global/US), `https://api-e.ecoflow.com` (EU), `https://api-a.ecoflow.com` (Americas in homebridge spec). Accounts are region-bound. (https://github.com/hobbyquaker/ecoflow2mqtt/blob/main/RESEARCH.md sect 3.1; homebridge spec above)
- Success response: `{"code":"0","message":"Success","data":...}` (https://github.com/rustyy/ecoflow-api/blob/main/packages/schemas/src/shared/deviceListResponseSchema.ts)

---

## 2. MQTT for the Open API

### 2.1 GET /iot-open/sign/certification
Response schema (rustyy zod, https://github.com/rustyy/ecoflow-api/blob/main/packages/schemas/src/shared/certificationResponseSchema.ts), verbatim:
```
code: z.literal("0"), message: z.literal("Success"),
data: { certificateAccount: z.string(), certificatePassword: z.string(), url: z.string(), port: z.string(), protocol: z.literal("mqtts") }
```
Sample (https://github.com/hobbyquaker/ecoflow2mqtt/blob/main/RESEARCH.md sect 3.3): `{"code":"0","data":{"certificateAccount":"open-57c13…","certificatePassword":"9592…","url":"mqtt.ecoflow.com","port":"8883","protocol":"mqtts"}}`. EU accounts: `mqtt-e.ecoflow.com` (same file). TLS on 8883 with public CA; username = certificateAccount, password = certificatePassword (tolwi ecoflow_mqtt.py uses `tls_set(cert_reqs=CERT_REQUIRED)` with system CAs: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/api/ecoflow_mqtt.py). Regenerating access keys yields a new certificateAccount (hobbyquaker RESEARCH.md 3.1).

### 2.2 clientId
- No official format/prefix found. tolwi uses `Hassio-{certificateAccount}-{group}` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/api/public_api.py `login`). Official doc rule: UNCONFIRMED (docs not readable). Common community advice: use a stable, static clientId.
- Limit: "only 10 unique client IDs are allowed per day" (quoted from an EcoFlow Facebook group in the comment at top of tolwi public_api.py: "If you are using MQTT to connect to the API be aware that only 10 unique client IDs are allowed per day. As such, it is suggested that you choose a static client_id..."). Exceeding it -> CONNACK rc 5, only fix = new keys (tolwi issues #306, #351 per hobbyquaker RESEARCH.md 3.5). Secondary source; UNCONFIRMED in official docs.
- Two connections using the same clientId kick each other off (htims1989 README "mutual-kickout disconnect loop" https://github.com/htims1989/ecoflow-public-api/blob/main/README.md). openHAB docs warn that parallel use of one developer account "will disturb event updates" (https://www.openhab.org/addons/bindings/ecoflow/ , quoted in meshforge research).
- Max number of simultaneously connected clients per account: UNCONFIRMED.
- tolwi connects with clean_session=True, keepalive=15, subscribe QoS 1.

### 2.3 Topics
From tolwi `_create_device_info` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/api/public_api.py):
- `/open/{certificateAccount}/{sn}/quota` (telemetry)
- `/open/{certificateAccount}/{sn}/set`
- `/open/{certificateAccount}/{sn}/set_reply`
- `/open/{certificateAccount}/{sn}/status`
- also `/get`, `/get_reply` per hobbyquaker RESEARCH.md 3.3.
Status topic EXISTS. Payload: `{"id":"…","version":"1.0","timestamp":…,"params":{"status":0|1}}` (hobbyquaker RESEARCH.md 3.3; tolwi `_prepare_data_status_topic`: `if "params" in data and "status" in data["params"]: ... int(data["params"]["status"]) == 1` -> online https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/__init__.py). So status = device online(1)/offline(0), not AC state. Note `online` in /device/list "lags up to ~15 min" (hobbyquaker, secondary).
Set reply codes: 0 ok, -1 device not owned, -2 offline (hobbyquaker RESEARCH.md).

### 2.4 Does the device push continuously?
NOT reliably. Devices/cloud throttle pushes when nobody is "watching". hobbyquaker RESEARCH.md sect 2: reports that updates are only received while the EcoFlow app is open, otherwise maybe every 13-16 min (openHAB forum, STREAM Micro); app keeps the stream alive by publishing every ~20 s to `/open/{account}/{sn}/get`:
`{"id": <ms>, "version": "1.1", "moduleType": 0, "operateType": "latestQuotas", "params": {}, "sn": "<SN>"}`
(reverse-engineered from the app by MichelFR/ha-ecoflow-iot, https://github.com/MichelFR/ha-ecoflow-iot ; summarized in https://github.com/hobbyquaker/ecoflow2mqtt/blob/main/RESEARCH.md sect 3.4). Reply comes on `get_reply` (data.quotaMap / online) and/or `quota`. tolwi handles get_reply payload with `online` + `quotaMap` (devices/__init__.py `_prepare_data_get_reply_topic`). Whether this works for all models on the Open API: UNCONFIRMED. For power stations, data is typically pushed periodically (Delta 2 / River 2 style messages every few seconds) while the app/other clients are active; behaviour when idle is UNCONFIRMED. Recommended design: keep MQTT subscription AND poll `GET /iot-open/sign/device/quota/all?sn=` as fallback (shuette42 / hobbyquaker both do this).
HTTP quota/all is server-cached and returns even when device offline (hobbyquaker RESEARCH.md 3.2) - so check `online` / status before trusting values.

### 2.5 Message JSON shapes
Different families use different envelopes on `/quota`:

a) Delta 2 / River 2 / Delta Max / Delta Pro family (typeCode style, `params`). Each message carries one module:
```
{ "typeCode": "invStatus", "params": { "acInVol": 228652, "acInFreq": 50, "inputWatts": 0, ... } }
```
typeCode values: `pdStatus`, `mpptStatus`, `invStatus`, `bmsStatus`, `emsStatus` (+ `bmsSlaveStatus`, `bmsInfo`). Source: https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/accessories/batteries/delta2/interfaces/delta2MqttApiContracts.ts (enum `Delta2MqttMessageType`) and the simulator https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/accessories/batteries/delta2/simulations/delta2Simulator.ts (messages `{typeCode: 'invStatus', params: {...}}`). tolwi maps typeCode->quota prefix: pd->`pd.`, mppt->`mppt.`, inv->`inv.`, emsStatus->`bms_emsStatus.`, bmsStatus->`bms_bmsStatus.` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/public/data_bridge.py). Quota HTTP keys therefore are `inv.acInVol` etc., while in the MQTT message the key is just `acInVol` inside `params` of the `invStatus` message. Messages are partial (only changed/selected fields) - merge them.

b) cmdId/cmdFunc style (PowerStream and similar; `param` singular, bare keys): `{"cmdId":1,"cmdFunc":20,"param":{...}}`; HTTP uses `20_1.` prefix. Source: hobbyquaker RESEARCH.md 3.3 (above) and data_bridge.py (`elif "cmdFunc" in raw_data and "cmdId" in raw_data: prefix = f"{cmdFunc}_{cmdId}."`; also handles both `param` and `params`).

c) Delta Pro 3 / Delta 3 family on Open API: FLAT camelCase keys (`DeltaPro3MqttQuotaMessage extends MqttQuotaMessage, DeltaPro3AllQuotaData`), e.g. `powGetAcIn`, `plugInInfoAcInFeq`. Source: https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/accessories/batteries/deltapro3/interfaces/deltaPro3MqttApiContracts.ts . SET commands for these use `cmdId:17, cmdFunc:254, dirDest:1, dirSrc:1, dest:2` (tolwi public/delta_pro_3.py, public/delta3_max_plus.py).

d) Delta Pro Ultra: `{ "addr": "hs_yj751_pd_appshow_addr", "param": {...} }` (homebridge deltaProUltraMqttApiContracts.ts https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/accessories/batteries/deltaproultra/interfaces/deltaProUltraMqttApiContracts.ts); HTTP keys prefixed `hs_yj751_pd_appshow_addr.` / `hs_yj751_pd_backend_addr.` (tolwi public/delta_pro_ultra.py).

Complete official example payloads for each model: UNCONFIRMED (docs unreadable).

---

## 3. AC / grid input keys per model (public API, camelCase)

General warning on DERIVING "grid present": missing field must NOT be read as 0 (meshforge note on ha-ef-ble River 2: missing `input_watts` defaulting to 0 looks like grid lost https://github.com/Nursedude/meshforge/blob/main/.claude/research/ecoflow_api_2026_10_05.md). Voltage-present is a better signal than watts (watts can be 0 when battery is full / charging paused while grid is present). Real data: Delta 2 sample `inv.acInVol: 228652`, `inv.acInFreq: 50`, `inv.inputWatts: 0` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/diag/delta2.json lines 82-97) - voltage present with 0 W input.

### 3.1 Gen-2 "typeCode" family: River 2, River 2 Max, River 2 Pro, Delta 2, Delta 2 Max, Delta Max, Delta Pro
Group: `inv` (typeCode `invStatus`). Same keys across all of them. HTTP quota key / MQTT key-inside-invStatus:

| quota key (HTTP) | MQTT key in `invStatus.params` | unit | note |
|---|---|---|---|
| `inv.acInVol` | `acInVol` | millivolts (mV). 228652 = 228.652 V. | tolwi uses `InMilliVoltSensorEntity` for it on every model below; ioBroker doc: "acInVol 0-250 V, scale 0.001, Inverter input voltage" |
| `inv.acInFreq` | `acInFreq` | Hz (scale 1) | ioBroker doc "Inverter input frequency" 0-62 Hz |
| `inv.acInAmp` | `acInAmp` | mA (scale 0.001 -> A) | ioBroker doc |
| `inv.inputWatts` | `inputWatts` | W (see below) | tolwi: `InWattsSensorEntity(... "inv.inputWatts", AC_IN_POWER)`; rustyy River 2 Pro schema comment: "AC input real-time power." |

Note ioBroker doc lists `inputWatts` with scale 0.1 in some groups (pd/mppt "Input power") and scale 1 in the inv group "Charging power": treat inv.inputWatts as plain W (tolwi shows it as W with no scaling; real data Delta 2 Max `inv.inputWatts` is integer W). UNCONFIRMED scale beyond tolwi's treatment.
Explicit "AC input connected" flag: none documented for this family in the sources. Closest: `bms_emsStatus.chgLinePlug` (Delta 2 Max real data: 52, 54, 36 - bitfield-like, meaning UNCONFIRMED; tolwi diag https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/diag/delta_2_max.json) and `inv.chargerType`. Not recommended without verification. Use `inv.acInVol` > ~(e.g.) 80000 mV and/or `inv.acInFreq` > 0.
Real-data check Delta Pro (offline AC): `inv.acInVol: 0, inv.acInFreq: 0, inv.inputWatts: 0` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/diag/delta_pro.json lines 75-77, 95).

Per-model sources (all list `inv.inputWatts`, `inv.acInVol`; AC In Volts):
- River 2: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/RIVER_2.md (internal/app-API list; public registry has RIVER_2 commented out, so River 2 is NOT in tolwi's public-API support list) - public keys UNCONFIRMED for River 2 but same family as River 2 Pro. Note in tolwi code: "River 2 reports live PV telemetry under mppt.*; inv.dcIn* stays at 0" (internal/river2.py).
- River 2 Max: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/RIVER_2_MAX.md (public registry commented out; same keys; ioBroker doc https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/main/doc/devices/river2max.md has acInVol/acInFreq/acInAmp)
- River 2 Pro: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/RIVER_2_Pro-Public.md (public registry: "RIVER 2 Pro" enabled). Also rustyy schema `"inv.inputWatts": integer` (https://github.com/rustyy/ecoflow-api/blob/main/packages/schemas/src/river2Pro/getProperties.ts). Voltage/freq: `inv.acInVol`/`inv.acInFreq` per ioBroker river2pro.md.
- Delta 2: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/DELTA_2-Public.md ("AC In Power (`inv.inputWatts`)", "AC In Volts (`inv.acInVol`)")
- Delta 2 Max: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/DELTA_2_Max-Public.md ; real data diag_delta_2_max.json: `inv.acInVol: 234411`, `inv.acInFreq: 50`
- Delta Max: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/DELTA_Max-Public.md
- Delta Pro (gen 1): https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/docs/devices/DELTA_Pro-Public.md ; ioBroker deltapro.md has acInFreq/acInVol/acInAmp.
Tolwi doc line (verbatim, DELTA_2-Public.md): "- AC In Power (`inv.inputWatts`) (energy:  _[Device Name]_ AC In  Energy)" / "- AC In Volts (`inv.acInVol`)".

### 3.2 Gen-3 "flat" family (Delta 3 / Delta 3 Plus / Delta 3 Max Plus / Delta Pro 3 / River 3 / River 3 Plus)
Flat camelCase keys, no group prefix (these protobuf-derived devices report flat keys; floats in real units). Source tables: ioBroker docs generated from EcoFlow's developer docs (format `|key|min|max|unit|scale|description|`):
- `powGetAcIn` - W, "Real-time AC input power" (range 0-4000 Delta 3/3 Plus/3 Max Plus; 0-8000 Delta Pro 3, River 3)
- `plugInInfoAcInVol` - V, range 0-250, "plug in info ac in vol" (Delta Pro 3 line 237; River 3 line 41; Delta 3 line 23; Delta 3 Max Plus line 25). NOTE: volts, NOT mV, in this family. Real data Delta 3: `"plugInInfoAcInVol": 118.09835` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/diag/delta_3_3.json line 207)
- `plugInInfoAcInFeq` - Hz, "AC input frequency" (49-61 Delta 3 family; 50-60 Delta Pro 3; 0-61 River 3). Real data: `"plugInInfoAcInFeq": 60`
- `plugInInfoAcInAmp` - A (Delta 3 Max Plus scale 0.01; others scale 1), real data `0.35376114`
- `plugInInfoAcInFlag` - EXPLICIT FLAG: "Indicates whether the AC charging port is connected" with values `{0:disconnected,1:connected}`. Real data: `"plugInInfoAcInFlag": 1`
- `plugInInfoAcChargerFlag` - "Indicates whether the charger is connected to the AC port" `{0:not charging?,1:charging?}` (real data shows boolean `true`)
Sources (ioBroker per-model docs): 
- Delta 3: https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/main/doc/devices/delta3.md (lines 23, 114, 115, 180, 186)
- Delta 3 Plus: .../doc/devices/delta3plus.md (lines 25, 120, 121, 190, 196)
- Delta 3 Max Plus: .../doc/devices/delta3maxplus.md (lines 25, 136, 137, 206, 212)
- Delta Pro 3: .../doc/devices/deltapro3.md (lines 63 powGetAcIn, 91 plugInInfoAcInFeq, 165 plugInInfoAcInFlag, 175 plugInInfoAcChargerFlag, 237 plugInInfoAcInVol)
- River 3: .../doc/devices/river3.md (41, 134, 135, 200, 210); River 3 Plus: river3plus.md (same)
Caveat: ioBroker repo covers both private-app and public MQTT; tables share camelCase names with the public API, but whether the Open API exposes every one (esp. `plugInInfoAcInFlag`) is UNCONFIRMED for each model.

tolwi PUBLIC-API support (verified from file contents):
- Delta 3 Max Plus (productName "DELTA 3 Max Plus"): public/delta3_max_plus.py exposes `powGetAcIn` only (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/public/delta3_max_plus.py); header comment: "Field set verified against the official EcoFlow developer docs at https://developer.ecoflow.com/us/document/delta3maxplus ... Wire format is camelCase." Volt/freq/flag keys not used there but exist per ioBroker.
- Delta Pro 3 (productName "Delta Pro 3"): public/delta_pro_3.py uses `powGetAcIn` and `plugInInfoAcInFeq` (https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/public/delta_pro_3.py). Docs: Delta_Pro_3-Public.md.
- Delta 3 (non-Plus) and River 3 / River 3 Plus: NOT enabled in tolwi's public registry (`# "DELTA 3": public_delta3.Delta3` commented out; only private/app API). windsurf/hassio-ecoflow-eu says REST for D361/D362/D381/R641/R651 returns 1006 and "River 3 and River 3 Plus are not supported by EcoFlow REST API (error 1006)" (https://github.com/TarasKhust/ecoflow-api-mqtt/blob/main/custom_components/ecoflow_api/api.py line ~282; meshforge research). So River 3 / Delta 3 / Delta 3 Plus availability on the Open API is UNCONFIRMED/likely limited. Conversely MacPhobos observed a DELTA 3 Plus in the Open API device list (see sect 5), so listing works at least.
- Internal-API-only key shapes (NOT public): tolwi internal Delta 3 / River 3 / Delta Pro 3 use snake_case `pow_get_ac_in`, `plug_in_info_ac_in_vol`; ha-ef-ble BLE uses `plug_in_info_ac_charger_flag` (meshforge research). Don't use for Open API.

### 3.3 Delta Pro Ultra
Group-prefixed, flat inside `hs_yj751_pd_appshow_addr` and `hs_yj751_pd_backend_addr` (tolwi public/delta_pro_ultra.py https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/public/delta_pro_ultra.py):
- `hs_yj751_pd_appshow_addr.inAcC20Pwr` - W, AC input power (the C20 AC IN inlet) (ioBroker deltaproultra.md line 110: "inAcC20Pwr|0|2800|W|1|Input power AC IN")
- `hs_yj751_pd_backend_addr.inAcC20Vol` - V (`VoltSensorEntity`; ioBroker line 206 "inAcC20Vol|0|250|V|1|Input voltage AC IN")
- `hs_yj751_pd_backend_addr.inAcC20Amp` - A (ioBroker line 207)
- `acInFreq` - Hz "AC input frequency" (ioBroker line 171: 50-60 Hz; exact group/prefix for public key UNCONFIRMED)
- Also the 5P8 power in/out port: `inAc5p8Pwr` (W), `inAc5p8Vol`/`Amp` - not the grid inlet.
Source: https://github.com/foxthefox/ioBroker.ecoflow-mqtt/blob/main/doc/devices/deltaproultra.md
MQTT envelope: `{addr: "hs_yj751_pd_appshow_addr", param: {...}}` (sect 2.5d). Explicit AC-connected flag: none found (UNCONFIRMED).

### 3.4 Summary for a "grid present" rule (design suggestion, not a source fact)
- Gen-2 family: grid present if `inv.acInVol` (mV) > threshold (e.g. 90000) OR `inv.acInFreq` > 0; do not rely on `inv.inputWatts` (0 when full).
- Gen-3 flat family: prefer `plugInInfoAcInFlag == 1` (if present), else `plugInInfoAcInVol` (V) > threshold, else `powGetAcIn` > 0.
- Delta Pro Ultra: `...backend_addr.inAcC20Vol` (V) > threshold, else `...appshow_addr.inAcC20Pwr` > 0.
- Always require data freshness (timestamp of last message / `online` status) before declaring grid lost; MQTT may stay silent for minutes when no app is active, and HTTP quota/all returns cached data even when the device is offline.

---

## 4. Error codes and rate limits

Official error-code table: UNCONFIRMED (not readable). Codes seen in client code/issues (all secondary, not official text):
- `0` / "Success" - OK (https://github.com/rustyy/ecoflow-api/blob/main/packages/schemas/src/shared/deviceListResponseSchema.ts). Error `code` is a string matching /^[1-9]\d*$/ with `message` (rustyy error.ts https://github.com/rustyy/ecoflow-api/blob/main/packages/schemas/src/shared/error.ts). Responses also carry `eagleEyeTraceId` (tesseractAZ rest.ts).
- `1006` - "current device is not allowed to get device info" (hobbyquaker RESEARCH.md 3.5: "error **1006 "current device is not allowed to get device info"** for STREAM Micro / some Delta Max since mid-2025 (tolwi #540)"; also seen with sub-devices behind a gateway: https://github.com/evcc-io/evcc/issues/27677; windsurf/TarasKhust comments: "not allowed to be controlled" on REST SET for newer devices https://github.com/TarasKhust/ecoflow-api-mqtt/blob/main/custom_components/ecoflow_api/api.py). shuette42 treats it as "device not linked to API key" (cloud_http.py line ~302).
- `8521` - "signature is wrong" (bad signing: booleans, clock skew, Content-Type on GET) (https://github.com/tesseractAZ/power/blob/main/server/src/ecoflow/rest.ts ; https://github.com/shuette42/ecoflow-energy-ha/blob/main/custom_components/ecoflow_energy/ecoflow/cloud_http.py). shuette42 also treats it as sometimes transient: "EcoFlow error 8521 is a transient server-side error - retry".
- `8524` - timestamp rejection (tesseractAZ rest.ts) - message text UNCONFIRMED.
- `8513` - region misdetected (wrong API host for the account), per evcc docs (https://docs.evcc.io/de/meters/ecoflow-stream), secondary.
- "accessKey is invalid" / "Account doesn't exist" when wrong region host (hobbyquaker RESEARCH.md 3.1) - numeric code UNCONFIRMED.
- HTTP-level 500 for throw in homebridge (client-side synthetic), ignore.
Rate limits: NOT documented anywhere I could read. htims1989 README says "the per-second burst limit" exists and spaces requests ~1 s apart, polls aggregates every 5 min (https://github.com/htims1989/ecoflow-public-api/blob/main/README.md); no HTTP 429 reports found (hobbyquaker RESEARCH.md: "Rate limits: not documented. No 429 reports found... Treat HTTP polling >= 30 s as safe"). MQTT: ~10 unique clientIds per day (see 2.2); reconnect storms can get an account temporarily blacklisted (htims1989 README; secondary). Control latency up to ~90 s reported.

---

## 5. productName strings in /iot-open/sign/device/list

Response item shape: `{ "sn": "...", "online": 0|1, "deviceName"?: "...", "productName"?: "..." }` - `deviceName` and `productName` are OPTIONAL (rustyy schema comment links to https://developer-eu.ecoflow.com/us/document/generalInfo).
Evidence of real strings:
- `"productName": "RIVER 2 Pro"` for a RIVER 2 Pro, with `"deviceName": "My RIVER"`, `"online": 1`, `"sn": "R621..."` ("Observed shape for a RIVER 2 Pro on the same account", https://github.com/MacPhobos/ecoflow-controller/blob/main/tests/test_client.py ).
- A DELTA 3 Plus item had NO productName at all: `{"deviceName": "DELTA 3 Plus-XYZ", "online": 0, "sn": "P351..."}` (same file). tolwi falls back to `deviceName.lower().startswith(<registry key>.lower())`.
- tolwi `device_by_product` keys (matched against productName, so likely the real strings; not directly proven per model): "DELTA Max", "DELTA Pro", "DELTA Pro Ultra", "DELTA 2", "DELTA 2 Max", "RIVER 2 Pro" (River 2 and River 2 Max entries exist but commented out: `"RIVER 2"`, `"RIVER 2 Max"`), "Delta Pro 3", "DELTA 3 Max Plus", "Smart Plug", "PowerStream", "WAVE 2", "Power Kits", "Smart Meter", "Stream AC", "Stream PRO", "Stream Ultra", "Stream Ultra X", "Stream Microinverter", "Smart Home Panel", "Smart Home Panel 2", "Power Ocean". Source: https://github.com/tolwi/hassio-ecoflow-cloud/blob/main/custom_components/ecoflow_cloud/devices/registry.py
- Exact productName for plain River 2 / River 2 Max / River 3 / Delta 3 / Delta Pro Ultra: UNCONFIRMED. Recommended: do NOT depend on productName; identify the family by SN prefix instead (R601/R603 River 2, R611/R613 River 2 Max, R621/R623 River 2 Pro, P231 Delta 3, P351 Delta 3 Plus, D361/D365 Delta 3 1500 per https://github.com/Nursedude/meshforge/blob/main/.claude/research/ecoflow_api_2026_10_05.md citing rabits/ha-ef-ble device_mappings.py - only P231, P32x, P351, D361/D365, R621/R623 are confirmed there; other prefixes are my UNCONFIRMED recollection) and/or detect by which quota keys are present (`inv.acInVol` vs `plugInInfoAcInVol`).

---

## 6. Other notes
- Device list only returns devices bound to the key's own account, not shared ones (hobbyquaker RESEARCH.md 3.1).
- Developer access requires approval ("Become a Developer", manual review) (same).
- Quota endpoints: GET `/iot-open/sign/device/quota/all?sn=SN`; POST `/iot-open/sign/device/quota` with `{"sn","params":{"quotas":["inv.acInVol",...]}}`; PUT same path for SET (never use for read-only app). (hobbyquaker RESEARCH.md 3.2; homebridge spec shows a GET variant `quota?params.quotas[0]=inv.cfgAcOutVol&params.quotas[1]=pd.carWatts&sn=sn1`.)
- Unofficial JS client: `@ecoflow-api/rest-client` + `@ecoflow-api/schemas` (https://github.com/rustyy/ecoflow-api), has `getMqttCredentials()` and typed River 2 Pro quota schema; no Delta 3/River 3/River 2 classes. Reference signer in TS: https://github.com/PietroLubini/homebridge-ecoflow/blob/main/src/apis/ecoFlowHttpApiManager.ts
- "snell-evan-itt/hassio-ecoflow-cloud-US" is a fork of tolwi; not independently examined.
