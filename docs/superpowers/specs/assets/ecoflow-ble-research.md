# EcoFlow RIVER 2 over Bluetooth LE: feasibility research

Research date: 2026-10-19. Read-only spike: no product code, nothing installed, no device touched. Companion to `ecoflow-research.md` (Open API) and `ecoflow-private-api-research.md` (app login + app MQTT).

Method: I read the source at pinned commits, the issue and PR threads, and two real captures that are public:
- a Home Assistant log with **decrypted** RIVER 2 Pro BLE packets, attached to ha-ef-ble issue #218. I decoded it myself (sect. 2.6);
- a RIVER 2 Max diagnostics file attached to issue #482. Only its connection-state history is plaintext. Its packets, keys and manufacturer data are encrypted to the ha-ef-ble developer's key (X25519 + AES-GCM, [encryption.py#L66-L102](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/encryption.py#L66-L102)), so I did not try to read them.

Anything I could not see in code or in a real capture is marked **UNVERIFIED**.

---

## 0. Sources (pinned commits)

| Project | Commit (date) | What it is |
|---|---|---|
| [rabits/ha-ef-ble](https://github.com/rabits/ha-ef-ble) | `1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83` (2026-10-17), manifest version 1.2.1, Apache-2.0 | Home Assistant integration, Python + bleak. **Supports RIVER 2 / 2 Pro / 2 Max.** The reference implementation. |
| [GnoX/ha-ef-ble](https://github.com/GnoX/ha-ef-ble) | main `1afd5085…`; branch `fix-auth-refresh-unverified` = `472a9d91da9f4deb692b162a7c73857f0a2cdb3d` (2026-09-13) | The maintainer's fork: test builds and experiments. Its `river2.py` is the same code as upstream. |
| [venturanima/ha-ef-ble](https://github.com/venturanima/ha-ef-ble) | compared with upstream on 2026-10-19 | 10 commits ahead, all SHP3/DPUX. No RIVER 2 work. |
| [rabits/ef-ble-reverse](https://github.com/rabits/ef-ble-reverse) | `9fdc35654c3c89f3382af6a2c81bf568734a678f` (2024-12-14), Apache-2.0 | The original proof-of-concept (`connect.py`), tested on SHP2 and DPU only |
| [lightheaded/bledash-esp32](https://github.com/lightheaded/bledash-esp32) | `39c0154005390ea91bc2f25785b2272bc550fdf4` (2026-08), MIT | ESP32 C++ firmware. **RIVER 2 Max verified on hardware:** advert SoC, plus an authenticated session for watts. |
| [xKhronoz/Ecoflow-BLE-NUTd](https://github.com/xKhronoz/Ecoflow-BLE-NUTd) | `d2b96420d6e727f9c37a60987092d90c900579fe` (2026-10-16), GPL-3.0 | Go daemon for Linux/BlueZ. Read-only; RIVER 2 family listed. |
| [arselzer/ecoflow-bluetooth](https://github.com/arselzer/ecoflow-bluetooth) | `0091725e0e2b573b02cde0e90715a0a941fcc21a` (2026-04-06), MIT | TypeScript + Web Bluetooth (Vue). Tested on River 3 Plus only. |
| [matguig/ecoflowbar](https://github.com/matguig/ecoflowbar) | `c1dd549ada1586607291685bf652bf418a4139f0` (2026-08-15) | macOS menu-bar app that runs vendored ha-ef-ble `eflib` as a Python daemon. Tested on River 3 Plus. |
| [npike/ha-ecoflow-ble](https://github.com/npike/ha-ecoflow-ble) | `0726ed4b20abfdb1b5da38df06f79fe66d6dbfe3`, Apache-2.0 | HA integration. Reads battery % from the advertisement only. Tested on a River 2. |
| [nielsole/ecoflow-bt-reverse-engineering](https://github.com/nielsole/ecoflow-bt-reverse-engineering) | `4fca10d6f4c29947259be07ca677435cc12c030d` (2022–23) | DELTA 2 BLE captures from the plaintext era |
| [avaver/ecoflow-ble](https://github.com/avaver/ecoflow-ble) | `2e82045331438a6fd7189541fe518b6881a66612` (2023-02) | C# DELTA 2 reader from the plaintext era, with no auth |
| [anton-ptashnik/ecoflow-api-py](https://github.com/anton-ptashnik/ecoflow-api-py) | `f8aabe15b77bdfe9b59df95c599f0a9264c8d08d` (2024-03) | DELTA 2 only. River 2 is "pending". |
| [lollokara/ESP32-Ecoflow-BLE](https://github.com/lollokara/ESP32-Ecoflow-BLE) | `de3fc47711a35bf53cd8a9e4cb9be440b7ce2107` | ESP32: Delta 3, Wave 2, DPro 3, Alternator. **No RIVER 2.** |
| [vwt12eh8/hassio-ecoflow](https://github.com/vwt12eh8/hassio-ecoflow) | `c78701faf3cd0318ee7674fbe8eca2a86566979b` (archived 2023) | Gen-1 River/Delta over local TCP 8055. Same `0xAA 0x02` framing and the same inverter struct. |

GitHub search on 2026-10-19 for "ecoflow ble", "ecoflow bluetooth", "ecoflow esphome", "ecoflow esp32", "river 2 ecoflow", "EcoflowBLE" and "ecoflow-ble" found no ESPHome component, Tasmota driver or Node library for the RIVER 2. The C++/ESP32 RIVER 2 port is bledash. The Go one is NUTd.

---

## TL;DR

- **Verdict (a): doable now from public code.** The RIVER 2 BLE session (ECDH on secp160r1, AES-128-CBC, login as `MD5(userId + SN)`) is implemented in public code and has worked on real RIVER 2 Pro and RIVER 2 Max units. Two independent stacks do it: ha-ef-ble in Python and bledash in C++.
- The data we need comes in the **inverter heartbeat** (`src 0x04, cmdSet 0x20, cmdId 0x02`). It is a packed little-endian struct, not protobuf: `acInVol` u32 mV at offset 23, `acInFreq` u8 Hz at offset 31, `inputWatts` u16 at offset 9. I decoded real decrypted RIVER 2 Pro packets and they show `acInVol = 119189` and `acInFreq = 60` on a US grid. The keys and units are the same as the cloud keys `inv.acInVol` / `inv.acInFreq`, so the existing voltage/frequency rule ports one-to-one.
- **Main open risk:** per ha-ef-ble's maintainer, the firmware **stops sending the inverter heartbeat while AC output is off**. This was seen on DELTA 2, and a RIVER 2 Pro user reported the same symptom. Whether the heartbeat still comes when grid is plugged in, AC output is off and the battery is full is **UNVERIFIED**. A one-hour live test on the user's unit settles it (sect. 5).
- The advertisement alone gives SN and SoC %, nothing about grid (sect. 3).

---

## 1. Public implementations that read a RIVER 2 over BLE

### 1.1 rabits/ha-ef-ble: yes, RIVER 2 / Pro / Max, AC input watts exposed

- **Device modules.** [`devices/river2.py`](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2.py#L36-L143) defines `NAME_PREFIX = "EF-R2"` and `SN_PREFIX = (b"R601", b"R603")`. The `device` property maps `R621/R623` to "River 2 Pro" and `R611/R613` to "River 2 Max". [`river2_max.py`](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2_max.py#L8-L11) and [`river2_pro.py`](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2_pro.py#L7-L10) subclass it with their own prefixes.
- **Parsing.** `data_parse` ([river2.py#L107-L143](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2.py#L107-L143)) handles:
  ```python
  case 0x02, 0x20, 0x02: DirectPdHeartbeatPack
  case 0x03, 0x20, 0x02: DirectEmsDeltaHeartbeatPack
  case 0x03, 0x20, 0x32: DirectBmsMDeltaHeartbeatPack
  case 0x04, _, 0x02:    DirectInvDeltaHeartbeatPack
  case 0x05, 0x20, 0x02: Mr330MpptHeart
  ```
  It returns `packet_version = 2` ([#L103-L105](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2.py#L103-L105)).
- **AC input.**
  - Exposed: `ac_input_power = raw_field(pb_inv.input_watts).default_when_missing(0)` ([river2.py#L58](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2.py#L58)).
  - Parsed but not exposed for RIVER 2: AC input voltage and frequency. They are in the struct it parses ([direct_inv_heartbeat_pack.py#L18-L21](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/model/direct_inv_heartbeat_pack.py#L18-L21)).
  - Exposed for DELTA 2, from the same struct: `ac_input_voltage = raw_field(pb_inv.ac_in_vol, pdiv(1000, 2))` ([_delta2_base.py#L54-L66](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/_delta2_base.py#L54-L66)).
- **README.** The device table has "River 2 (Pro, Max)" with sensor "AC Input Power" ([README#L702](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/README.md#L702)).
- **History.**
  - Added in PR [#155](https://github.com/rabits/ha-ef-ble/pull/155) (merged 2026-02-06, `2520924b`): "River 2 Pro tested in #43, Max in #138, **regular one untested**, but there should be no difference."
  - Fixed in [#219](https://github.com/rabits/ha-ef-ble/pull/219): wrong PD struct.
  - [#361](https://github.com/rabits/ha-ef-ble/pull/361) added defaults when the inverter heartbeat is missing.
  - The `R613` prefix typo was fixed after [#482](https://github.com/rabits/ha-ef-ble/issues/482). The maintainer replayed that user's 100 packets: "all 100 of them parse, producing 27 entities - battery level, AC input and output power, …".
- **Real-hardware reports.**
  - RIVER 2 Pro: [#43](https://github.com/rabits/ha-ef-ble/issues/43), with a GATT dump, and [#218](https://github.com/rabits/ha-ef-ble/issues/218). The #218 log says "Connecting to River 2 Pro" and "Auth completed, everything is fine", then decrypted packets. Its reporter calls the unit "River 2", but the SN decodes as Pro.
  - RIVER 2 Max: [#138](https://github.com/rabits/ha-ef-ble/issues/138), [#323](https://github.com/rabits/ha-ef-ble/issues/323) (works after a fix), [#482](https://github.com/rabits/ha-ef-ble/issues/482) and [#471](https://github.com/rabits/ha-ef-ble/issues/471).
  - **Base RIVER 2 (`R601/R603`): no public log found. UNVERIFIED**, though it shares the same class and struct.
- **Open problems** on the family:
  - [#169](https://github.com/rabits/ha-ef-ble/issues/169): RIVER 2 Pro, handshake fails with a short frame. Open since 2026-02.
  - [#380](https://github.com/rabits/ha-ef-ble/issues/380): RIVER 2 Max firmware 4.1.3.2.22 / 4.1.3.24, only the generic GAP characteristics visible. The cause was never established; the maintainer suspects the host side.
  - [#471](https://github.com/rabits/ha-ef-ble/issues/471): RIVER 2 Max auth stalls in `requesting_auth_status` every 3–6 days. Removing and re-adding the device fixes it.
- **Forks.**
  - GnoX/ha-ef-ble: same RIVER 2 code. Its unmerged branch `fix-auth-refresh-unverified` ([472a9d91](https://github.com/GnoX/ha-ef-ble/commit/472a9d91da9f4deb692b162a7c73857f0a2cdb3d)) sends `0x35/0x85` ("refresh"), a **write**, instead of the `0x86` check when the advert says the binding is not verified.
  - venturanima: nothing for RIVER 2.

### 1.2 lightheaded/bledash-esp32: yes, RIVER 2 Max, C++, hardware-verified

- Tier 1 (advert only):
  - "River 2-series units broadcast…", with a byte table ([docs/protocols/ecoflow.md#L14-L39](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/docs/protocols/ecoflow.md#L14-L39)).
  - SoC verified against Home Assistant on a RIVER 2 and a RIVER 2 Max.
- Tier 2 (authenticated GATT session), "**E4 VERIFIED on real hardware** … observed `auth OK` then `dsg in=0W out=97W soc=29.8 toEmpty=80min`" ([plan#L1-L12](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L1-L12)).
- It reads PD `watts_in_sum` / `watts_out_sum`, BMS SoC and EMS remaining times ([plan#L150-L160](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L150-L160)). It does **not** decode the inverter heartbeat or AC-in voltage.

### 1.3 xKhronoz/Ecoflow-BLE-NUTd: RIVER 2 family listed, read-only, Linux only

- "V2 families: DELTA 2, DELTA 2 Max / Max S, RIVER 2 / Max / Pro", "session modes `0`, `1`, and `7`" ([docs/supported-devices.md](https://github.com/xKhronoz/Ecoflow-BLE-NUTd/blob/d2b96420d6e727f9c37a60987092d90c900579fe/docs/supported-devices.md)).
- Its V2 decoder handles only PD, EMS and BMS. It derives `InputPresent` from `InputPower > 0`, or else from EMS `OpenUPSFlag` ([decode_v2.go#L148-L155](https://github.com/xKhronoz/Ecoflow-BLE-NUTd/blob/d2b96420d6e727f9c37a60987092d90c900579fe/internal/ecoflow/decode_v2.go#L148-L155)).
- That rule reports "no input" when the battery is full. Do not copy it.
- No hardware-verification note for RIVER 2 was found: **UNVERIFIED**.

### 1.4 arselzer/ecoflow-bluetooth: TypeScript + Web Bluetooth, not tested on RIVER 2

- It is a full TS implementation:
  - secp160r1 via the `elliptic` npm package ([src/protocol/crypto.ts](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/src/protocol/crypto.ts));
  - MD5 in JS, AES-CBC via WebCrypto;
  - `navigator.bluetooth.requestDevice` with `optionalServices: ['00000001-0000-1000-8000-00805f9b34fb', '6e400001-…']` ([src/protocol/connection.ts](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/src/protocol/connection.ts)).
- Only "River 3 Plus (…) -- tested" ([README#L20](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/README.md#L20)).
- **Its claim "Type 1 encryption (River 2 / Delta 2)" ([README#L11-L16](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/README.md#L11-L16), #L86) is contradicted by evidence** (sect. 2.3). It is a hard-coded name table, and the same table gives the DELTA 2 serial prefix as `DAEB`, while ha-ef-ble uses `R331/R335` ([delta2.py#L19](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/delta2.py#L19)).
- It is still the best TypeScript reference for the transport and crypto.
- It **auto-binds** with `0x35:85` ([README#L7](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/README.md#L7)). We must not do that (sect. 2.8).

### 1.5 Others

- **npike/ha-ecoflow-ble:** advertisement only, battery % only.
  - "I have only tested with a River 2." The sensor list per model is "Battery Level" only ([README](https://github.com/npike/ha-ecoflow-ble/blob/0726ed4b20abfdb1b5da38df06f79fe66d6dbfe3/README.md)).
  - It parses byte 17 of the manufacturer data as battery ([protocol.py#L8-L27](https://github.com/npike/ha-ecoflow-ble/blob/0726ed4b20abfdb1b5da38df06f79fe66d6dbfe3/custom_components/ecoflow-ble/ecoflow_ble/protocol.py#L8-L27)).
  - It connects to nothing useful: its UUID constants ([const.py#L9-L16](https://github.com/npike/ha-ecoflow-ble/blob/0726ed4b20abfdb1b5da38df06f79fe66d6dbfe3/custom_components/ecoflow-ble/ecoflow_ble/const.py#L9-L16)) are not EcoFlow's (see 2.2).
- **matguig/ecoflowbar:** macOS 14+, Apple Silicon, "100% locally over Bluetooth LE". It runs ha-ef-ble's `eflib` as a child Python daemon, and needs the "one-time EcoFlow sign-in (to obtain the account ID required by the protocol)" ([README#L8-L13, #L40-L43](https://github.com/matguig/ecoflowbar/blob/c1dd549ada1586607291685bf652bf418a4139f0/README.md#L8-L43)). Tested on River 3 Plus, but it vendors `river2.py`. Proof that eflib + bleak runs on macOS arm64.
- **rabits/ef-ble-reverse:** the protocol PoC.
  - It documents where userId comes from: "When you device is bond to your account - it's storing the user_id, which is on of the keys in auth procedure" ([connect.py#L28-L35](https://github.com/rabits/ef-ble-reverse/blob/9fdc35654c3c89f3382af6a2c81bf568734a678f/connect.py#L28-L35)).
  - Its device list is SHP2 and DPU only ([README#L6-L8](https://github.com/rabits/ef-ble-reverse/blob/9fdc35654c3c89f3382af6a2c81bf568734a678f/README.md#L6-L8)).
  - Its V2-packet handshake for DELTA 2 / Wave 2 came later, from ha-ef-ble [#80](https://github.com/rabits/ha-ef-ble/issues/80) (2025-10).
- **nielsole and avaver (DELTA 2, 2022–23):**
  - The station streamed **plaintext** `aa 02 …` frames over BLE with no auth: "sends out a beacon every 500ms" ([nielsole README#L45](https://github.com/nielsole/ecoflow-bt-reverse-engineering/blob/4fca10d6f4c29947259be07ca677435cc12c030d/README.md#L45)).
  - avaver subscribes to `00000003-…` and XOR-decodes the payload with `seq[0]` ([ByteExtensions.cs DecodePayload](https://github.com/avaver/ecoflow-ble/blob/2e82045331438a6fd7189541fe518b6881a66612/ByteExtensions.cs)). It reads `acInVoltage` at payload offset 23; its code indexes from frame byte 18, so the source says 21 ([Worker.cs ProcessInverter](https://github.com/avaver/ecoflow-ble/blob/2e82045331438a6fd7189541fe518b6881a66612/Worker.cs)).
  - This is an independent confirmation of the inverter layout. Current firmware no longer works this way (sect. 4.5).
- **anton-ptashnik/ecoflow-api-py:** "Delta 2 device is the only supported for now". The River 2 column is all "pending" ([README#L8-L21](https://github.com/anton-ptashnik/ecoflow-api-py/blob/f8aabe15b77bdfe9b59df95c599f0a9264c8d08d/README.md)).
- **lollokara/ESP32-Ecoflow-BLE:** supported hardware is Delta 3, Wave 2, Delta Pro 3 and Alternator Charger ([README](https://github.com/lollokara/ESP32-Ecoflow-BLE/blob/de3fc47711a35bf53cd8a9e4cb9be440b7ce2107/README.md)). No RIVER 2.
- **Home Assistant community.** Thread "EcoFlow BLE (Unofficial)" ([community.home-assistant.io/t/ecoflow-ble-unofficial/774794](https://community.home-assistant.io/t/ecoflow-ble-unofficial/774794)). Not read in depth; the primary evidence is in the GitHub issues above.

---

## 2. The RIVER 2 BLE protocol as known

### 2.1 Advertising

- **Manufacturer (company) ID `0xB5B5` (46517).** Sources: [devicebase.py#L69](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L69); the HA matchers `"manufacturer_id": 46517` with `manufacturer_data_start` `\x13R60`, `\x13R61`, `\x13R62` ([manifest.json#L150-L166](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/manifest.json#L150-L166)); bledash.
- **Manufacturer data payload** (index from the start of the payload, after the 2 company-ID bytes):

  | idx | value | meaning | source |
  |---|---|---|---|
  | 0 | `0x13` | `proto_version` (ha-ef-ble); "constant" (bledash) | [devicebase.py#L607-L617](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L607-L617), [bledash ecoflow.md#L20-L30](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/docs/protocols/ecoflow.md#L20-L30) |
  | 1–16 | ASCII | **full serial number**, e.g. `R601…` | same; [__init__.py#L19-L27](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/__init__.py#L19-L27) (`man_data[1:17]`) |
  | 17 | e.g. `0x64` | **SoC %** (bledash, verified against HA on two units; npike reads the same byte). ha-ef-ble calls it `status`, with bit 7 = `active_flag`. | bledash L32-L39; npike protocol.py; devicebase.py#L604 |
  | 18 | `0x00` | `product_type` (ha-ef-ble); unknown (bledash) | |
  | 19–21 | `01 00 00` | unknown, constant | bledash |
  | 22 | `0x3E` | **capability flags**: bit0 encrypt, bit1 support_verified, bit2 verified, bits 3–5 = `encrypt_type` | [devicebase.py#L597-L601](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L597-L601); bledash "`3E` constant so far" |
  | 23 | varies | probably a checksum (bledash) | UNVERIFIED |

  `0x3E` = `0b0011_1110` decodes to encrypt_type `(0x3E & 0x38) >> 3 = 7`, support_verified = 1, verified = 1. I checked the arithmetic in Python with ha-ef-ble's formula.
- **Local name is unreliable**, so match on the SN in the manufacturer data:
  - ha-ef-ble matchers use `EF-R2*`;
  - bledash saw `EF-R0xxxx` (River 2) and `EF-R1xxxx` (River 2 Max);
  - ha-ef-ble warns the name "is prone to change to 'Ecoflow-dev'" ([devicebase.py#L90-L91](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L90-L91));
  - the GAP Device Name read on a RIVER 2 Pro was `Ecoflow-dev` ([#43](https://github.com/rabits/ha-ef-ble/issues/43)).

### 2.2 GATT

The RIVER 2 Pro GATT dump in [#43](https://github.com/rabits/ha-ef-ble/issues/43) shows service `00000001-0000-1000-8000-00805f9b34fb`, which Wireshark/bleak label "SDP". It has two characteristics:
- write: `00000002-0000-1000-8000-00805f9b34fb`;
- notify: `00000003-0000-1000-8000-00805f9b34fb`.

ha-ef-ble calls this pair `"rfcomm"` and tries it before the Nordic-UART pair `6e400002/6e400003` ([connection.py#L65-L74](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L65-L74)). bledash confirms it for the RIVER 2 Max: "GATT (River 2 "rfcomm" variant) … Writes during session use write-with-response" ([plan#L109-L112](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L109-L112)).

None of these UUIDs is on the Web Bluetooth GATT blocklist ([gatt_blocklist.txt](https://github.com/WebBluetoothCG/registries/blob/master/gatt_blocklist.txt)).

### 2.3 Session and authentication (RIVER 2 = "encrypt type 7")

ha-ef-ble picks the session type from the advertisement: `encrypt_type=self.scan_record.encrypt_type` ([devicebase.py#L357](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L357)). The constructor default is 7 ([connection.py#L238](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L238)). `_run_auth` takes type 0 (no crypto), type 1 (static key) or anything else as the ECDH path ([connection.py#L736-L756](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L736-L756)).

**Why I conclude RIVER 2 uses type 7 (ECDH), not type 1:**
1. bledash's real RIVER 2 / RIVER 2 Max adverts carry flags `0x3E`, which decodes to encrypt_type 7 (sect. 2.1).
2. The plaintext connection-state history of the RIVER 2 Max (`R613`) in the [#482 diagnostics](https://github.com/user-attachments/files/31496197/config_entry-ef_ble-01M0ZVEJ23E21Z66THFAPEBHC2.json) runs `CONNECTED → PUBLIC_KEY_EXCHANGE (0.16 s) → PUBLIC_KEY_RECEIVED → REQUESTING_SESSION_KEY → SESSION_KEY_RECEIVED → REQUESTING_AUTH_STATUS → AUTH_STATUS_RECEIVED → AUTHENTICATING → AUTHENTICATED (0.64 s)`. `PUBLIC_KEY_EXCHANGE` exists only on the ECDH path.
3. bledash, on hardware: "Handshake (encrypt_type 7)" for the RIVER 2 Max ([plan#L125-L136](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L125-L136)).
4. RIVER 2 Pro and Max worked in ha-ef-ble in Feb 2026 (PR #155). Type-1 support was only added a month later, for PowerStream ([PR #185](https://github.com/rabits/ha-ef-ble/pull/185), merged 2026-03-09).

arselzer's "Type 1 (River 2, Delta 2)" is therefore contradicted. The implementation should still read the type from the advert at runtime and support types 7 and 1, as ha-ef-ble does. Some firmware could differ (UNVERIFIED).

**Type 7 handshake, step by step** (ha-ef-ble connection.py; bledash confirms every constant on a RIVER 2 Max):

1. Connect and subscribe to notify `…0003`.
2. Generate an ephemeral **secp160r1** key: `ecdsa.SigningKey.generate(curve=ecdsa.SECP160r1)` ([#L804](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L799-L836)). Send an **unencrypted** command frame with payload `01 00` followed by the raw 40-byte X‖Y public key.
3. The reply is type `0x01`. `data[2]` is the curve id (size table in [`_get_ecdh_type_size`](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L1620-L1631): the default is 40 bytes). The device public key is `data[3:3+size]`.
4. Compute the ECDH shared secret (20 bytes). `iv = MD5(shared)`, and the initial cipher is **AES-128-CBC**(key = `shared[:16]`, iv) ([#L830-L836](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L830-L836)).
5. Send command `02`. The reply (type 0x02) is encrypted. Decrypted, it holds `sRand` (16 B) and `seed` (2 B) ([#L838-L859](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L838-L859)).
6. Derive the session key from a **65,280-byte vendor key table** taken from the app ([keydata.py](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/keydata.py); identical to ef-ble-reverse `login_key.bin` per [bledash plan#L78-L85](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L78-L85)): `pos = seed[0]*0x10 + ((seed[1]-1)&0xFF)*0x100`, then `session_key = MD5(table[pos:pos+16] ‖ sRand[0:16])` ([`_gen_session_key` #L951-L981](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L951-L981)). The cipher becomes AES-128-CBC(session_key, same iv), with PKCS7 padding ([encryption.py#L29-L45](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/encryption.py#L29-L45)).
7. "Auth status": inner packet `src 0x21 → dst 0x35, cmdSet 0x35, cmdId 0x89`, empty payload ([#L917-L929](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L917-L929)).
8. **Auth**: inner packet `0x21 → 0x35, cmdSet 0x35, cmdId 0x86`. The payload is the 32 ASCII chars of the **uppercase hex of `MD5(userId + SN)`** ([#L877-L903](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L877-L903)):
   ```python
   md5_data = hashlib.md5((self._user_id + self._dev_sn).encode("ASCII")).digest()
   hex_format = "02x" if self._auth_token_lowercase else "02X"
   ```
   The reply `0x35/0x35/0x86`, payload `00`, means OK. Other codes are listed in [exceptions.py#L89-L98](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/exceptions.py#L89-L98): `01` NeedRefreshToken, `02` DeviceInternalError, `03` DeviceAlreadyBound, `04` NeedBindInstallFirst, `05` AppSendDataError, `06` WrongKey, `07` MaximumDevicesError. A first data packet also counts as success ([#L1219-L1224](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L1186-L1237)).

**What the app already has is enough.** Auth needs only:
- `userId`: the 19-digit decimal **string** from `/auth/login`, as in our `ecoflow-private-api-research.md` §1.4. ha-ef-ble's config flow obtains it the same way ([login.py](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/login.py));
- the SN, from the device list or from the advert.

The MQTT certificate credentials play no role over BLE. The userId is static, so after one online fetch, BLE works fully offline. bledash: "a static per-account decimal string … the device also stores the userId of the account it was bonded to and validates locally — so it must be the account that owns this specific River 2 Max" ([plan#L61-L76](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L61-L76)).

For reference only (not RIVER 2):
- Type 1 is a static AES-CBC session with key = MD5(SN) and iv = MD5(reversed SN) ([#L786-L791](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L786-L791)).
- Type 0 has no crypto ([PR #326](https://github.com/rabits/ha-ef-ble/pull/326)).

### 2.4 Framing

**Outer frame** (the bytes in the BLE write and notification), `EncPacket` ([encpacket.py#L23-L50](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/encpacket.py#L23-L50)):
```
5A 5A | frame_type<<4 | 01 | len_u16_LE (= payload + 2) | payload | CRC16_LE over everything before it
```
- frame_type `0x00` is a command frame (handshake, plaintext); `0x01`, which shows on the wire as `0x10`, is a protocol/data frame (AES-CBC).
- On the RIVER 2 Max, "the device sends exactly one complete EncPacket per notification. Handshake pubkey + key-info arrive as command frames (type 0x00); everything post-cipher … as data frames (type 0x10). Confirmed" ([bledash plan#L227-L229](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L218-L236)).
- ha-ef-ble still reassembles frames that span notifications ([frame_assembler.py](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/frame_assembler.py)).

**Inner packet**, version byte `0x02` for RIVER 2 ([packet.py#L38-L140](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/packet.py#L38-L140)):
```
off 0  AA
    1  02            version (V3 = 03 adds dsrc,ddst; 0x13 = "sentinel"/XOR variant; 04 = different format)
    2  len_u16_LE    payload length
    4  CRC8 of bytes 0..3   (poly 0x07, init 0, no reflection = CRC-8/CCITT)
    5  product byte  (we send 0x0D; the RIVER 2 Pro sends 0x2C on INV/EMS/BMS/MPPT frames, 0x0C on PD frames)
    6  seq u32 LE
   10  2 bytes       (zeros when we send; the device sends 01 01 on INV/EMS/BMS/MPPT, FF FF on PD)
   12  src
   13  dst
   14  cmdSet
   15  cmdId
   16  payload[len]
  end  CRC16_LE over bytes 0..end-2 (poly 0x8005 reflected, init 0 = CRC-16/ARC)
```
CRC definitions: [crc.py#L13-L14](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/crc.py#L13-L14).

Bytes 5 and 10–11 vary by module even within one session of the same unit. Example from the #218 log: a PD frame starts `aa 02 79 00 aa 0c 00000000 ff ff 02 21 20 02`. A parser must not validate them; ha-ef-ble ignores them ([packet.py#L76-L81](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/packet.py#L76-L81)).

**Worked example**, verified by me. This real RIVER 2 Pro inverter packet is from the [#218 log](https://github.com/user-attachments/files/25944422/ef_ble_log.txt), line 24:
```
aa 02 4600 90 2c 00000000 0101 04 21 20 02 | 70-byte payload | 32 4f
```
CRC8(`aa024600`) = `0x90` ✓. CRC16 = `0x4f32` ✓.

`seq[0]` is 0 in every packet in that log, and ha-ef-ble does not XOR-decode RIVER 2 payloads: `river2.py` has no `packet_parse` override, while DELTA 2 has `Packet.from_bytes(data, xor_payload=True)` ([delta2.py#L33-L34](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/delta2.py#L33-L34)). A defensive implementation should XOR the payload with `seq[0]` if it is ever non-zero (UNVERIFIED for RIVER 2).

### 2.5 "V1-style" vs "V2/V3": where RIVER 2 sits

The naming is confusing because the projects use "V2" for different things. RIVER 2 is a hybrid:
- **Payload and inner framing: the old style.** It uses the same `0xAA 0x02` header, CRC8/CRC16 and packed little-endian heartbeat structs as the gen-1 River/Delta local TCP protocol on port 8055:
  - hassio-ecoflow `PORT = 8055` ([__init__.py#L1](https://github.com/vwt12eh8/hassio-ecoflow/blob/c78701faf3cd0318ee7674fbe8eca2a86566979b/custom_components/ecoflow/ecoflow/__init__.py#L1));
  - framing check `x[:2] != b'\xaa\x02'` ([receive.py#L20-L45](https://github.com/vwt12eh8/hassio-ecoflow/blob/c78701faf3cd0318ee7674fbe8eca2a86566979b/custom_components/ecoflow/ecoflow/receive.py#L20-L45));
  - `parse_inverter_delta` has `ac_in_voltage` at the same position ([receive.py#L305-L331](https://github.com/vwt12eh8/hassio-ecoflow/blob/c78701faf3cd0318ee7674fbe8eca2a86566979b/custom_components/ecoflow/ecoflow/receive.py#L305-L331)).
  - It is **not protobuf**: "River 2 Max telemetry is NOT protobuf. It streams fixed-width little-endian binary "heartbeat pack" structs decoded by byte offset" ([bledash plan#L25-L29](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L25-L29)).
- **Transport: the newer style.** The `0xAA` packet travels inside the `0x5A5A` encrypted frame, after the secp160r1 ECDH handshake and the userId auth (sect. 2.3). ef-ble-reverse calls this whole BLE scheme "protocol V2".
- **Contrast:** River 3 / Delta 3 / Delta Pro 3 use the same transport, but with inner version `0x03`/`0x13` and protobuf payloads (`river3.py`, `pb/*.py` in ha-ef-ble). Older DELTA 2 firmware sent the `0xAA 0x02` frames over BLE in plaintext, with no transport at all (sect. 1.5, 4.5).
- Whether a RIVER 2 also answers on local TCP 8055: **UNVERIFIED** and not investigated. hassio-ecoflow is archived and covers gen-1 product IDs only ([__init__.py#L34-L80](https://github.com/vwt12eh8/hassio-ecoflow/blob/c78701faf3cd0318ee7674fbe8eca2a86566979b/custom_components/ecoflow/ecoflow/__init__.py#L34-L80)).

### 2.6 Messages and the AC-input fields

Heartbeats the RIVER 2 Pro streams unprompted after auth. This is my decode of the 107 decrypted payloads in the [#218 log](https://github.com/user-attachments/files/25944422/ef_ble_log.txt), using a throwaway script and ha-ef-ble's struct definitions. Every packet has version `0x02`, dst `0x21`, and no acks or time-sync replies were needed.

| src | cmdSet/cmdId | struct (ha-ef-ble) | payload len | count in ~23 s |
|---|---|---|---|---|
| 0x02 (PD) | 0x20/0x02 | `DirectPdHeartbeatPack` | 121 | 25 |
| 0x03 (EMS) | 0x20/0x02 | `DirectEmsDeltaHeartbeatPack` | 46 | 24 |
| 0x03 (BMS) | 0x20/0x32 | `DirectBmsMDeltaHeartbeatPack` | 69 | 24 |
| **0x04 (INV)** | **0x20/0x02** | **`DirectInvDeltaHeartbeatPack`** | **70** | **16 (about every 1.5 s)** |
| 0x05 (MPPT) | 0x20/0x02 | `Mr330MpptHeart` | 94 | 17 |

**Inverter heartbeat layout.** Little-endian, offsets from the payload start, from [direct_inv_heartbeat_pack.py#L6-L41](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/model/direct_inv_heartbeat_pack.py#L6-L41). I computed the offsets with `struct.calcsize`. The struct is 67 bytes; the real payload is 70, with 3 trailing zero bytes.

| off | type | field (cloud key) | unit |
|---|---|---|---|
| 0 | u32 | errCode | |
| 4 | u32 | sysVer | |
| 8 | u8 | chargerType (`inv.chargerType`) | enum |
| **9** | **u16** | **inputWatts (`inv.inputWatts`)** | W |
| 11 | u16 | outputWatts | W |
| 13 | u8 | invType | |
| 14 | u32 | invOutVol | mV |
| 18 | u32 | invOutAmp | mA |
| 22 | u8 | invOutFreq | Hz |
| **23** | **u32** | **acInVol (`inv.acInVol`)** | **mV** |
| 27 | u32 | acInAmp (`inv.acInAmp`) | mA |
| **31** | **u8** | **acInFreq (`inv.acInFreq`)** | **Hz** |
| 32 | u16 | outTemp | |
| 45 | u8 | cfgAcEnabled (AC output switch) | 0/1 |
| 64 | u16 | acChgRatedPower | W |

Decoded real values (RIVER 2 Pro, US grid, AC output on, `cfgAcEnabled = 1` in every sample):
```
10:52:50.268  inputWatts=497  outputWatts=96   acInVol=119189  acInAmp=3428  acInFreq=60
10:52:57.640  inputWatts=512  outputWatts=110  acInVol=119133  acInAmp=3442  acInFreq=60
10:52:59.281  inputWatts=0    outputWatts=0    acInVol=121254  acInAmp=3442  acInFreq=60   <- input stops, grid still present
10:53:12.590  inputWatts=0    outputWatts=109  acInVol=121344  acInAmp=3442  acInFreq=60
```
What these samples show:
- **`acInVol`/`acInFreq` at offsets 23/31 are confirmed on real RIVER 2-family BLE data.** The same offsets are exposed for DELTA 2 by ha-ef-ble and by avaver. For the base RIVER 2 (`R601/R603`) they are UNVERIFIED, but it uses the same parser class.
- In the second half, the reporter (who was enabling "backup reserve" to force discharge on AC) has `inputWatts = 0` while voltage and frequency show the grid. **Watts are not a grid signal; voltage and frequency are.** `acInAmp` stays frozen at 3442 after input stops, the same artefact our cloud research found in `inv.acInAmp`. The rule in `grid.ts` (voltage/frequency) carries over unchanged.
- Grid-absent values over BLE (`acInVol = 0`, `acInFreq = 0`) are not in any public RIVER 2 BLE capture: **UNVERIFIED**. The cloud data for the RIVER 2 Max shows 0/0 with the grid off (see `ecoflow-private-api-research.md` §5.2).

Possible fallback signals, all UNVERIFIED as grid indicators:
- PD `wattsInSum` u16 @17 ([direct_pd_heartbeat_pack.py#L6-L19](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/model/direct_pd_heartbeat_pack.py#L6-L19)). This is 0 when the battery is full;
- MPPT `chg_type` / `in_watts` ([mppt_heart.py#L6-L31](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/model/mppt_heart.py#L6-L31));
- EMS `chgState` / `openUpsFlag`.

### 2.7 The inverter heartbeat may be absent while AC output is off (main risk)

- For DELTA 2 the maintainer states: "The inverter heartbeat is the only message that carries `cfg_ac_enabled` … and **the firmware stops sending it entirely while AC output is off**" ([PR #356](https://github.com/rabits/ha-ef-ble/pull/356)). His earlier theory: "it stops sending inverter messages when AC is off because the inverter is also off" ([#334](https://github.com/rabits/ha-ef-ble/issues/334)).
- RIVER 2 Pro user: "After restart of integration AC out and **in** sensors of power are unavailable. After one time switch on and off the ac they become available" ([#351 comment](https://github.com/rabits/ha-ef-ble/issues/351#issuecomment-4583005082)). Follow-up [PR #361](https://github.com/rabits/ha-ef-ble/pull/361) made River 2 and Delta 2 inverter fields fall back to 0 after `MISSING_DEFAULT_GRACE = 10` seconds ([devicebase.py#L37-L40](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L37-L40)).
- **Do not copy that fallback.** It turns "no inverter data" into "AC input 0", which our widget would read as "grid off". A missing inverter heartbeat must map to **unknown**.
- What we do not know (**UNVERIFIED**): does the inverter heartbeat keep coming while the grid is plugged in and AC output is off? Two sub-cases: (a) while charging, and (b) with the battery full, which is the critical one. My inference, not sourced (UNVERIFIED): on a RIVER 2 the AC charger is probably the bidirectional inverter, which makes (a) plausible. (b) is a coin toss. This is the first thing to measure (sect. 5).

### 2.8 What a read-only client must never send

- `0x35/0x85` ("bind" in arselzer, "refresh" in GnoX's branch). It writes a binding to the station. arselzer warns that "a device bound this way may reject authentication from the official EcoFlow app until re-bound" ([README#L7](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/README.md#L7); [notes#L9-L47](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/docs/reverse-engineering-notes.md#L9-L47)). ha-ef-ble upstream only sends `0x89` and `0x86`.
- Replies to the device's time request `0x35/0x01/0x52`, which would set the station clock. bledash: "telemetry flows without us answering the RTC request" ([plan#L235-L236](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L218-L236)).
- Any `cmdSet 0x20` command to dst 0x02/0x03/0x05 (`0x42`, `0x45`, `0x47`, `0x51`, `0x52`, `0x5E`, `0x5F`, …). These are the RIVER 2 control writes ([river2.py#L145-L240](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devices/river2.py#L145-L240)).
- Echoing packets back ("reply_packet", [connection.py#L1239-L1257](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L1239-L1257)) is not needed for the RIVER 2 heartbeats: `river2.py` never calls it, and bledash found "Acking not required for the basic power heartbeats" ([plan#L230-L232](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L218-L236)).

---

## 3. Advertisements only (no connection)

**Not useful for grid detection.**
- The RIVER 2 advert carries the SN and SoC % (byte 17), nothing about AC input. bledash, on a RIVER 2 and a RIVER 2 Max: "Watts / input / output / remaining time are **not** in the advertisement (all the trailing bytes are constant or a checksum). They require the Tier 2 GATT session" ([ecoflow.md#L55-L58](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/docs/protocols/ecoflow.md#L50-L58)).
- npike's integration, tested on a River 2, gets only "Battery Level" from it.
- ha-ef-ble's parser knows no charging or input field either: it reads only proto version, SN, status/SoC, product type and capability flags ([devicebase.py#L580-L617](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/devicebase.py#L580-L617)).
- The only indirect signal is a rising SoC, which suggests charging. It is slow, it says nothing once the battery is full, and solar or car charging would fool it.
- Bit 7 of byte 17 (`active_flag` in ha-ef-ble) has unknown meaning on RIVER 2. Since byte 17 is SoC there, bit 7 is always 0 for SoC ≤ 100. Not a grid flag: **UNVERIFIED**.
- Adverts are also not continuous. They stop while a central is connected, and after about an hour idle (sect. 4).

Still useful: the advert gives the **SN for auth** and an offline **SoC** reading without taking the single connection slot.

---

## 4. Constraints

### 4.1 One BLE connection at a time

- ha-ef-ble README: "EcoFlow devices support only **one BLE connection at a time**. If you want to manage your device via the EcoFlow mobile app, you must temporarily disable this integration" ([README#L750](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/README.md#L746-L753)).
- bledash: "while bledash holds the EcoFlow GATT session, the EcoFlow phone app cannot connect, and vice-versa" ([plan#L92-L94](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/plans/done/2026-07-15-01-ecoflow-gatt-telemetry.md#L89-L105)). The same plan lists "reconnect/backoff when the phone app steals the slot" as not yet done (E6). So **whether the phone app actively kicks an existing session, or simply fails to connect, is UNVERIFIED.**
- The phone app normally talks to the station over the cloud when it has internet. That is why the maintainer had to ask a user to "disable wifi and data on your phone before connecting" to force a BLE session ([#380](https://github.com/rabits/ha-ef-ble/issues/380)). bledash: "with the default (passive advertisement scan) a running EcoFlow app doesn't conflict" ([README#L174-L178](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/README.md#L169-L178)).
- **Product consequence:** during a blackout with no internet, the phone app falls back to BLE, which is exactly when our widget holds the slot. Design options: a "release Bluetooth" control, or short polling sessions. Reconnect plus handshake took 0.64 s in #482 and about 1.6 s in #218, so connecting for a few seconds every N minutes is realistic. Caveat: in #471 the unit seemed to need a "quiet spell" before accepting a new session, so frequent reconnects might trigger the auth stall (UNVERIFIED). Measure this in the contention test.
- When the widget does hold the link, it may not notice the phone app wanting it (whether the app kicks us is the open question above), and with the adverts gone it cannot read the SoC from them either.

### 4.2 The station must be bound to an account

- ha-ef-ble prerequisite: "Your device must be **bound to your account** through the EcoFlow app before setup" ([README#L786-L787](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/README.md#L782-L788)). An unbound unit answers `04 NeedBindInstallFirst` ([exceptions.py#L94](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/exceptions.py#L89-L98); arselzer notes L77).
- The station checks `MD5(userId+SN)` against the account it is bound to (bledash plan L74-L76). So the userId must be the **owner's**.
- Our device list returns both `bound` and `share` groups (`ecoflow-private-api-research.md` §4). For a station that is only *shared* with the logged-in user, BLE auth will probably fail with `06 WrongKey`: **UNVERIFIED**.
- The user's RIVER 2 is already set up in their account, so this should hold. It must still be checked that the SN appears under `bound`.

### 4.3 Does BLE stay up when the station is idle?

- bledash, RIVER 2 Max: "stopped advertising over BLE (and stopped reporting to the EcoFlow cloud) after roughly an hour idle — both transports went quiet together … When it's actually working … it advertises fine" ([ecoflow.md#L41-L48](https://github.com/lightheaded/bledash-esp32/blob/39c0154005390ea91bc2f25785b2272bc550fdf4/docs/protocols/ecoflow.md#L41-L48)).
- So BLE silence means "unknown", never "grid off".
- Unknown (**UNVERIFIED**):
  - whether an idle station on grid with a full battery also goes quiet;
  - whether the app's standby/timeout settings (PD `standbyMin`, inverter `standbyMins`, MPPT `acStandbyMins`/`powerStandbyMins`, which exist in the structs) keep the radio up;
  - whether an established GATT session survives the idle timeout.

### 4.4 Stability reports

- [#471](https://github.com/rabits/ha-ef-ble/issues/471): RIVER 2 Max, auth stalls every 3–6 days. The maintainer suspects the unit needs a "quiet spell" before it will release a session. Open.
- [#169](https://github.com/rabits/ha-ef-ble/issues/169): RIVER 2 Pro, handshake fails on a malformed frame. Open.
- [#380](https://github.com/rabits/ha-ef-ble/issues/380): only the GAP characteristics visible. Unresolved; probably the host side.
- Expect occasional reconnect-and-backoff cycles.

### 4.5 Firmware changed the protocol before and can again

- DELTA 2 in 2022–23: plaintext `aa 02` frames on notify `0x0003`, no auth (nielsole, avaver; sect. 1.5).
- DELTA 2 and Wave 2 "running latest firmware" (2025-10) need the ECDH session and userId auth ([#80](https://github.com/rabits/ha-ef-ble/issues/80)): "If the Wave or Delta don't authenticate, they close the connection within a few seconds."
- Whether older RIVER 2 firmware was also plaintext: **UNVERIFIED**.
- ha-ef-ble warns: "**Future EcoFlow firmware updates may change these protocols and break compatibility**" ([README#L772-L777](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/README.md#L770-L778)).
- Example of fields changing after an update on a sibling model: River 3 firmware V6.30.49.80 ([#426](https://github.com/rabits/ha-ef-ble/issues/426)).
- RIVER 2 Max firmware seen in the wild: 4.1.3.2.22 and 4.1.3.24 ([#380](https://github.com/rabits/ha-ef-ble/issues/380)). Which firmware the #218/#482 units ran: not stated.

### 4.6 Platform notes for an Electron app (Windows 11 + macOS arm64)

- **Web Bluetooth in Electron:**
  - It is supported. The app must handle `select-bluetooth-device` on `webContents` to pick the device without the browser chooser ([Electron docs: Device access](https://www.electronjs.org/docs/latest/tutorial/devices)).
  - arselzer's code is a working Web Bluetooth precedent (Chrome, River 3 Plus).
  - It has no MTU control and, in practice, no manufacturer data in the chooser. arselzer notes "watchAdvertisements() not available … Serial must be entered manually" ([notes#L172](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/docs/reverse-engineering-notes.md#L168-L184)). That is fine for us: the SN comes from the account.
  - Electron on Windows/macOS with this device: **UNVERIFIED** (no precedent found).
- **Alternatives:**
  - a native Node BLE module such as `@abandonware/noble`: UNVERIFIED on Win11 and macOS arm64 for this project;
  - a Python sidecar running bleak + `eflib`. ecoflowbar does exactly this on macOS arm64; heavier to ship.
- **Crypto in TypeScript:**
  - secp160r1 is not in WebCrypto (arselzer's comment: "SECP160r1 Elliptic Curve (not in Web Crypto, use elliptic.js)", [crypto.ts#L13](https://github.com/arselzer/ecoflow-bluetooth/blob/0091725e0e2b573b02cde0e90715a0a941fcc21a/src/protocol/crypto.ts#L13)). Whether Electron's Node `crypto.createECDH('secp160r1')` works is **UNVERIFIED**. My understanding, not checked here, is that Electron builds Node against BoringSSL, which is not expected to include this curve.
  - Use pure-JS `elliptic`, as arselzer does.
  - MD5 and AES-128-CBC are in Node `crypto`.
- **Frame size:** a PD frame is 16 + 121 + 2 = 139 bytes inner, padded to 144, plus 8 bytes outer = 152 bytes, sent as one notification on a RIVER 2 Max (bledash). That needs an ATT MTU ≥ 155. Windows and macOS usually negotiate larger MTUs automatically, but this is **UNVERIFIED** for Web Bluetooth with this device. Keep ha-ef-ble-style reassembly anyway.
- **Licensing:**
  - ha-ef-ble and ef-ble-reverse are Apache-2.0, arselzer is MIT, NUTd is GPL-3.0 (do not copy its code).
  - The 65,280-byte key table is a vendor constant extracted from the EcoFlow app; legal status unknown.

---

## 5. Verdict

**(a) Doable now from public code.** Confidence:
- that we can authenticate to the user's RIVER 2 from the laptop and read `acInVol`/`acInFreq`: **about 85%**;
- that this becomes a reliable grid indicator in every station state: **about 70%**.

Why (a) and not (b):
- Every step is already implemented in public code and has worked on real RIVER 2-family hardware: advert parsing, the secp160r1/AES-CBC session, `MD5(userId+SN)` auth, and decoding the inverter heartbeat.
  - ha-ef-ble: RIVER 2 Pro and Max, including my decode of real RIVER 2 Pro packets with `acInVol` / `acInFreq`.
  - bledash: RIVER 2 Max session in C++.
  - NUTd: RIVER 2 family in Go.
- No undecoded message is needed. The remaining work is a TypeScript port (arselzer's TS transport is a precedent) plus a short validation on the user's unit. No new reverse-engineering.
- The app already has the userId and SN. The MQTT credentials are not needed for BLE.

**Main risks:**
1. **Inverter heartbeat absent with AC output off** (sect. 2.7). If it is also absent with grid on and AC output off, the widget must either ask the user to keep AC output on or fall back to weaker signals (PD `wattsInSum`, MPPT charge type). Those fail when the battery is full.
2. **Base RIVER 2 (`R601/R603`) has no public BLE log.** "regular one untested" (PR #155). The user's SN prefix decides: R601/R603 = base, R611/R613 = Max, R621/R623 = Pro.
3. **Single connection.** The widget blocks the phone app's BLE fallback, exactly when the internet is down. This needs a release or polling design.
4. **Idle sleep** after about an hour (River 2 Max): BLE silence must map to "unknown".
5. **Firmware updates** can change or break the protocol (DELTA 2 history).
6. **Platform:** Electron Web Bluetooth (or noble) with this device on Windows and macOS is unproven. MTU is not verified.
7. **Stability:** auth stalls every few days (#471). Reconnect logic is needed.

**What to capture with the user's help, and how.** An Android HCI snoop log of the EcoFlow app **cannot** decrypt anything here: the session uses an ephemeral ECDH key, so the AES session key cannot be recovered from a sniff. It would only show the plaintext handshake frames and which commands the app sends. If that ever matters, the procedure is nielsole's: enable the HCI snoop log in Android developer options, `adb bugreport`, open in Wireshark ([README#L58-L70](https://github.com/nielsole/ecoflow-bt-reverse-engineering/blob/4fca10d6f4c29947259be07ca677435cc12c030d/README.md#L56-L72)).

The useful capture is **from our own client**, which holds the keys:

0. Read from the app: the SN (prefix) and firmware version. Confirm the SN is under `bound` in `/iot-service/user/device`. Keep the userId from login.
1. **Smoke test, about 1 hour, laptop 10 cm from the station:**
   - Tool: a read-only script, either ha-ef-ble's `eflib` with bleak or our TS prototype. ecoflowbar shows eflib running on macOS arm64. On Windows it is **UNVERIFIED**: bleak supports WinRT, but eflib also calls the BlueZ-oriented helper `close_stale_connections_by_address` ([connection.py#L418-L421](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L418-L421)) and was built for Linux/HA.
   - Log the advert bytes, the state history, and every decrypted inner packet. eflib has the `on_packet_received` / `on_packet_parsed` listeners ([connection.py#L1311-L1314](https://github.com/rabits/ha-ef-ble/blob/1c1eb3310eb1ec1cee9cd4eab5f28a1f0f7aba83/custom_components/ef_ble/eflib/connection.py#L1278-L1335)).
   - Phone app closed, or its Bluetooth off.
   - The app must never send `0x85`, time sync or `0x20/xx` writes.
2. **State matrix.** For each state, record whether the inverter packet `04/20/02` arrives, its bytes 23–26 (`acInVol`), 31 (`acInFreq`) and 9–10 (`inputWatts`), plus PD bytes 17–18 (`wattsInSum`) and the MPPT/EMS charge-state bytes:

   | # | grid | AC output | battery |
   |---|---|---|---|
   | A | on | on | charging |
   | B | on | off | charging |
   | **C** | **on** | **off** | **full (100%)**, the critical case |
   | D | on | on | full |
   | E | unplugged | on, with load | |
   | F | unplugged | off | |

   Also time how quickly `acInVol` drops to 0 after unplugging.
3. **Idle test:** leave the station idle on grid, battery full, no load, for 2 hours with the session held, then with the session released. Repeat with "unit timeout: never" if the app offers it.
4. **Contention test:** with our session up, open the EcoFlow app with internet off, then with internet on. Who wins, does our session drop, and how fast can we reconnect?
5. **Platform test:** run the same handshake from Electron (Web Bluetooth) on Windows 11 and on macOS arm64.

If C shows the inverter packet with real voltage and frequency, the feature becomes a straightforward port. If it does not, decide between "ask the user to keep AC output on" and a degraded indicator.
