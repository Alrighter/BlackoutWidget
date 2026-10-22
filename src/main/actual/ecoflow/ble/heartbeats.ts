/**
 * The RIVER 2 family's heartbeat structs: packed little-endian, decoded by offset. Field lists from rabits/ha-ef-ble at
 * 1c1eb33, eflib/model/*.py (Apache License 2.0). A payload shorter than the struct yields the fields it covers.
 */

type Kind = 'u8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | `bytes${number}`;
type Layout = ReadonlyArray<readonly [name: string, kind: Kind]>;
export type Fields = Record<string, number | string>;

const SIZE: Record<string, number> = { u8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };

function decode(layout: Layout, payload: Uint8Array): Fields {
  const b = Buffer.from(payload);
  const out: Fields = {};
  let off = 0;
  for (const [name, kind] of layout) {
    const size = kind.startsWith('bytes') ? Number(kind.slice(5)) : SIZE[kind];
    if (off + size > b.length) break;
    switch (kind) {
      case 'u8': out[name] = b.readUInt8(off); break;
      case 'u16': out[name] = b.readUInt16LE(off); break;
      case 'i16': out[name] = b.readInt16LE(off); break;
      case 'u32': out[name] = b.readUInt32LE(off); break;
      case 'i32': out[name] = b.readInt32LE(off); break;
      case 'f32': out[name] = Math.round(b.readFloatLE(off) * 100) / 100; break;
      default: out[name] = b.subarray(off, off + size).toString('hex');
    }
    off += size;
  }
  return out;
}

/** DirectInvDeltaHeartbeatPack: src 0x04, cmd 0x20/0x02. acInVol is in mV, acInFreq in Hz. */
const INV: Layout = [
  ['errCode', 'u32'], ['sysVer', 'u32'], ['chargerType', 'u8'], ['inputWatts', 'u16'], ['outputWatts', 'u16'],
  ['invType', 'u8'], ['invOutVol', 'u32'], ['invOutAmp', 'u32'], ['invOutFreq', 'u8'],
  ['acInVol', 'u32'], ['acInAmp', 'u32'], ['acInFreq', 'u8'], ['outTemp', 'u16'], ['dcInVol', 'u32'], ['dcInAmp', 'u32'],
  ['dcInTemp', 'u16'], ['fanState', 'u8'], ['cfgAcEnabled', 'u8'], ['cfgAcXboost', 'u8'], ['cfgAcOutVoltage', 'u32'],
  ['cfgAcOutFreq', 'u8'], ['cfgAcWorkMode', 'u8'], ['cfgPauseFlag', 'u8'], ['acDipSwitch', 'u8'],
  ['cfgFastChgWatts', 'u16'], ['cfgSlowChgWatts', 'u16'], ['standbyMins', 'u16'], ['dischargeType', 'u8'],
  ['acPassbyAutoEn', 'u8'], ['prBalanceMode', 'u8'], ['acChgRatedPower', 'u16'], ['cfgGfciEnable', 'u8'],
];

/** DirectPdHeartbeatPack: src 0x02, cmd 0x20/0x02. */
const PD: Layout = [
  ['model', 'u8'], ['errCode', 'bytes4'], ['sysVer', 'bytes4'], ['wifiVer', 'bytes4'], ['wifiAutoRcvy', 'u8'], ['soc', 'u8'],
  ['wattsOutSum', 'u16'], ['wattsInSum', 'u16'], ['remainTime', 'i32'], ['beepMode', 'u8'], ['dcOutState', 'u8'],
  ['usb1Watts', 'u8'], ['usb2Watts', 'u8'], ['qcUsb1Watts', 'u8'], ['qcUsb2Watts', 'u8'], ['typec1Watts', 'u8'],
  ['typec2Watts', 'u8'], ['typec1Temp', 'u8'], ['typec2Temp', 'u8'], ['carState', 'u8'], ['carWatts', 'u8'],
  ['carTemp', 'u8'], ['standbyMin', 'u16'], ['lcdOffSec', 'u16'], ['lcdBrightness', 'u8'], ['chgPowerDC', 'u32'],
  ['chgSunPower', 'u32'], ['chgPowerAC', 'u32'], ['dsgPowerDC', 'u32'], ['dsgPowerAC', 'u32'], ['usbUsedTime', 'u32'],
  ['usbqcUsedTime', 'u32'], ['typecUsedTime', 'u32'], ['carUsedTime', 'u32'], ['invUsedTime', 'u32'],
  ['dcInUsedTime', 'u32'], ['mpptUsedTime', 'u32'], ['reserved', 'bytes2'], ['extRj45Port', 'u8'], ['ext3p8Port', 'u8'],
  ['ext4p8Port', 'u8'], ['sysChgDsgState', 'u8'], ['wifiRssi', 'u8'], ['wirelessWatts', 'u8'], ['screenState', 'bytes14'],
  ['acAutoConfig', 'u8'], ['minAcOutSoc', 'u8'], ['acOutPause', 'u8'], ['watthIsConfig', 'u8'], ['backupSoc', 'u8'],
  ['hysteresisAdd', 'u8'], ['relaySwitchCount', 'u32'],
];

/** Mr330MpptHeart: src 0x05, cmd 0x20/0x02. */
const MPPT: Layout = [
  ['faultCode', 'u32'], ['swVer', 'bytes4'], ['inVol', 'u32'], ['inAmp', 'u32'], ['inWatts', 'u16'], ['outVal', 'u32'],
  ['outAmp', 'u32'], ['outWatts', 'u16'], ['mpptTemp', 'i16'], ['xt60ChgType', 'u8'], ['cfgChgType', 'u8'],
  ['chgType', 'u8'], ['chgState', 'u8'], ['dcdc12VVol', 'u32'], ['dcdc12VAmp', 'u32'], ['dcdc12VWatts', 'u16'],
  ['carOutVol', 'u32'], ['carOutAmp', 'u32'], ['carOutWatts', 'u16'], ['carTemp', 'i16'], ['carState', 'u8'],
  ['dc24vTemp', 'i16'], ['dc24vState', 'u8'], ['chgPauseFlag', 'u8'], ['cfgDcChgCurrent', 'u32'], ['beepState', 'u8'],
  ['cfgAcEnabled', 'u8'], ['cfgAcXboost', 'u8'], ['cfgAcOutVoltage', 'u32'], ['cfgAcOutFreq', 'u8'],
  ['cfgChgWatts', 'u16'], ['acStandbyMins', 'u16'], ['dischargeType', 'u8'], ['carStandbyMins', 'u16'],
  ['powerStandbyMins', 'u16'], ['screenStandbyMins', 'u16'], ['payFlag', 'u16'], ['res', 'bytes8'],
];

/** DirectEmsDeltaHeartbeatPack: src 0x03, cmd 0x20/0x02. */
const EMS: Layout = [
  ['chgState', 'u8'], ['chgCmd', 'u8'], ['dsgCmd', 'u8'], ['chgVol', 'u32'], ['chgAmp', 'u32'], ['fanLevel', 'u8'],
  ['maxChargeSoc', 'u8'], ['bmsModel', 'u8'], ['lcdShowSoc', 'u8'], ['openUpsFlag', 'u8'], ['bmsWarningState', 'u8'],
  ['chgRemainTime', 'u32'], ['dsgRemainTime', 'u32'], ['emsIsNormalFlag', 'u8'], ['f32LcdShowSoc', 'f32'],
  ['bmsIsConnt', 'bytes3'], ['maxAvailableNum', 'u8'], ['openBmsIdx', 'u8'], ['paraVolMin', 'u32'], ['paraVolMax', 'u32'],
  ['minDsgSoc', 'u8'], ['openOilEbSoc', 'u8'], ['closeOilEbSoc', 'u8'],
];

/** DirectBmsMDeltaHeartbeatPack: src 0x03, cmd 0x20/0x32. */
const BMS: Layout = [
  ['num', 'u8'], ['type', 'u8'], ['cellId', 'u8'], ['errCode', 'u32'], ['sysVer', 'u32'], ['soc', 'u8'], ['vol', 'u32'],
  ['amp', 'u32'], ['temp', 'u8'], ['openBmsIdx', 'u8'], ['designCap', 'u32'], ['remainCap', 'u32'], ['fullCap', 'u32'],
  ['cycles', 'u32'], ['soh', 'u8'], ['maxCellVol', 'u16'], ['minCellVol', 'u16'], ['maxCellTemp', 'u8'],
  ['minCellTemp', 'u8'], ['maxMosTemp', 'u8'], ['minMosTemp', 'u8'], ['bmsFault', 'u8'], ['bqSysStatReg', 'u8'],
  ['tagChgAmp', 'u32'], ['f32ShowSoc', 'f32'], ['inputWatts', 'u32'], ['outputWatts', 'u32'], ['remainTime', 'u32'],
];

export type Module = 'inv' | 'pd' | 'mppt' | 'ems' | 'bms';

/**
 * Which heartbeat a packet is (river2.py `data_parse`); null for anything else. Every one is under command set 0x20,
 * the inverter's included: its ids under another set would be read as a grid verdict.
 */
export function heartbeatOf(p: { src: number; cmdSet: number; cmdId: number }): Module | null {
  if (p.cmdSet !== 0x20) return null;
  if (p.src === 0x04 && p.cmdId === 0x02) return 'inv';
  if (p.src === 0x02 && p.cmdId === 0x02) return 'pd';
  if (p.src === 0x03 && p.cmdId === 0x02) return 'ems';
  if (p.src === 0x03 && p.cmdId === 0x32) return 'bms';
  if (p.src === 0x05 && p.cmdId === 0x02) return 'mppt';
  return null;
}

const LAYOUTS: Record<Module, Layout> = { inv: INV, pd: PD, mppt: MPPT, ems: EMS, bms: BMS };

export function decodeHeartbeat(module: Module, payload: Uint8Array): Fields {
  return decode(LAYOUTS[module], payload);
}
