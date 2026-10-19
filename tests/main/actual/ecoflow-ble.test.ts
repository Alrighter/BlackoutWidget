import { createECDH, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAdvert } from '../../../src/main/actual/ecoflow/ble/advert';
import { newEphemeralKey, sessionKey, sharedSecret, SessionCipher } from '../../../src/main/actual/ecoflow/ble/crypto';
import { decodeHeartbeat, heartbeatOf } from '../../../src/main/actual/ecoflow/ble/heartbeats';
import { KEY_TABLE_B64 } from '../../../src/main/actual/ecoflow/ble/keydata';
import {
  crc16, crc8, decodePacket, encodeFrame, encodePacket, FRAME_COMMAND, FRAME_PROTOCOL, FrameReader, PacketError,
} from '../../../src/main/actual/ecoflow/ble/protocol';
import { EcoflowBleSession } from '../../../src/main/actual/ecoflow/ble/session';
import { authToken } from '../../../src/main/actual/ecoflow/ble/token';
import { fakeStation, INV, MPPT, PD } from '../../helpers/ble-station';

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest();

describe('EcoFlow BLE wire format', () => {
  it('computes the CRCs of a real packet', () => {
    expect(crc8(Buffer.from('aa024600', 'hex'))).toBe(0x90);
    expect(crc16(INV.subarray(0, -2))).toBe(0x4f32);
  });

  it('decodes a real inverter heartbeat: AC-in voltage and frequency', () => {
    const p = decodePacket(INV);
    expect(p).toMatchObject({ version: 2, src: 0x04, dst: 0x21, cmdSet: 0x20, cmdId: 0x02 });
    expect(p.payload).toHaveLength(70);
    expect(heartbeatOf(p)).toBe('inv');
    expect(decodeHeartbeat('inv', p.payload)).toMatchObject({
      inputWatts: 497, outputWatts: 96, invOutVol: 119024, invOutFreq: 60, acInVol: 119189, acInAmp: 3428, acInFreq: 60,
    });
  });

  it('decodes the PD and MPPT heartbeats, whose header bytes differ', () => {
    const pd = decodePacket(PD);
    expect(heartbeatOf(pd)).toBe('pd');
    expect(decodeHeartbeat('pd', pd.payload)).toHaveProperty('wattsInSum');
    const mppt = decodePacket(MPPT);
    expect(heartbeatOf(mppt)).toBe('mppt');
    expect(decodeHeartbeat('mppt', mppt.payload)).toHaveProperty('cfgAcEnabled');
  });

  it('rejects broken packets and ignores cipher padding after the CRC', () => {
    expect(() => decodePacket(Buffer.from('bb02', 'hex'))).toThrow(PacketError);
    const bad = Buffer.from(INV);
    bad[30] ^= 0xff;
    expect(() => decodePacket(bad)).toThrow(/CRC16/);
    expect(decodePacket(Buffer.concat([INV, Buffer.alloc(6, 6)])).payload).toHaveLength(70);
  });

  it('encodes the auth-status request byte for byte', () => {
    const out = encodePacket({ src: 0x21, dst: 0x35, cmdSet: 0x35, cmdId: 0x89 });
    expect(out.subarray(0, 16).toString('hex')).toBe(`aa020000${crc8(Buffer.from('aa020000', 'hex')).toString(16).padStart(2, '0')}0d00000000000021353589`);
    expect(decodePacket(out)).toMatchObject({ src: 0x21, dst: 0x35, cmdSet: 0x35, cmdId: 0x89 });
    expect(decodePacket(encodePacket({ src: 1, dst: 2, cmdSet: 3, cmdId: 4, payload: Buffer.from('abc') })).payload.toString()).toBe('abc');
  });

  it('reassembles frames split across notifications, past noise, false prefixes and bad CRCs', () => {
    const a = encodeFrame(FRAME_COMMAND, Buffer.from([0x01, 0x02, 0x03]));
    const b = encodeFrame(FRAME_PROTOCOL, Buffer.from('5a5a0102', 'hex'));
    const broken = Buffer.from(a);
    broken[7] ^= 1;
    const stream = Buffer.concat([Buffer.from('00115a', 'hex'), broken, a, b]);
    const r = new FrameReader();
    const frames = [...r.push(stream.subarray(0, 9)), ...r.push(stream.subarray(9, 20)), ...r.push(stream.subarray(20))];
    expect(frames).toEqual([
      { type: FRAME_COMMAND, payload: Buffer.from([0x01, 0x02, 0x03]) },
      { type: FRAME_PROTOCOL, payload: Buffer.from('5a5a0102', 'hex') },
    ]);
  });
});

describe('EcoFlow BLE crypto', () => {
  it('agrees with OpenSSL on the secp160r1 shared secret', () => {
    const ours = newEphemeralKey();
    expect(ours.publicKey).toHaveLength(40);
    const theirs = createECDH('secp160r1');
    theirs.generateKeys();
    const theirPub = theirs.getPublicKey().subarray(1);
    const expected = theirs.computeSecret(Buffer.concat([Buffer.from([4]), ours.publicKey]));
    expect(sharedSecret(ours.secretKey, theirPub)).toEqual(expected);
    expect(() => sharedSecret(ours.secretKey, theirPub.subarray(1))).toThrow(/40/);
  });

  it('derives the first cipher from the shared secret and round-trips messages', () => {
    const shared = Buffer.from('00112233445566778899aabbccddeeff01234567', 'hex');
    const c = SessionCipher.fromShared(shared);
    expect(c.key).toEqual(shared.subarray(0, 16));
    expect(c.iv).toEqual(md5(shared));
    const msg = Buffer.from('a heartbeat that spans a few blocks');
    const enc = c.encrypt(msg);
    expect(enc.length % 16).toBe(0);
    expect(c.decrypt(enc)).toEqual(msg);
    expect(c.decrypt(Buffer.concat([enc, Buffer.from([1, 2, 3])]))).toEqual(msg);
  });

  it('picks the session key from the table by the seed', () => {
    const table = Buffer.from(KEY_TABLE_B64, 'base64');
    expect(table).toHaveLength(65280);
    const sRand = Buffer.alloc(16, 7);
    // seed 01 02: 0x01 * 0x10 + (0x02 - 1) * 0x100 = 0x110
    expect(sessionKey(Buffer.from([0x01, 0x02]), sRand)).toEqual(md5(Buffer.concat([table.subarray(0x110, 0x120), sRand])));
    expect(() => sessionKey(Buffer.from([0x00, 0x00]), sRand)).toThrow();
  });

  it('builds the auth token as uppercase hex of MD5(userId + SN)', () => {
    const t = authToken('1234567890123456789', 'R601ZEB4XXXX0000');
    expect(t).toBe(md5(Buffer.from('1234567890123456789R601ZEB4XXXX0000')).toString('hex').toUpperCase());
    expect(t).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe('EcoFlow BLE advertisement', () => {
  it('reads the SN, SoC and encrypt type', () => {
    const md = Buffer.concat([Buffer.from('b5b513', 'hex'), Buffer.from('R601ZEB4XXXX0000'), Buffer.from('5700010000' + '3e' + '9c', 'hex')]);
    expect(parseAdvert(md)).toEqual({ sn: 'R601ZEB4XXXX0000', soc: 0x57, encryptType: 7, flags: 0x3e });
    expect(parseAdvert(Buffer.concat([Buffer.from('4c00', 'hex'), md.subarray(2)]))).toBeNull();
    expect(parseAdvert(md.subarray(0, 10))).toBeNull();
  });
});

describe('EcoFlow BLE session', () => {
  it('runs the handshake against a station double and then streams heartbeats', async () => {
    const station = fakeStation({ userId: '1234567890123456789', sn: 'R601ZEB4XXXX0000' });
    const packets: string[] = [];
    const stages: string[] = [];
    const s = new EcoflowBleSession({
      token: authToken('1234567890123456789', 'R601ZEB4XXXX0000'), write: station.write,
      onPacket: p => packets.push(`${p.src}:${p.cmdSet.toString(16)}/${p.cmdId.toString(16)}`), onStage: st => stages.push(st),
    });
    station.attach(s);
    await s.start();
    await new Promise(r => setTimeout(r, 0));
    expect(stages).toEqual(['public-key', 'session-key', 'auth-status', 'auth', 'streaming']);
    expect(station.sent).toEqual(['35/89', '35/86']);
    expect(packets).toContain('4:20/2');
  });

  it('fails with the station\'s reason when the account does not own it', async () => {
    const station = fakeStation({ userId: 'owner', sn: 'R601ZEB4XXXX0000' });
    const s = new EcoflowBleSession({ token: authToken('someone-else', 'R601ZEB4XXXX0000'), write: station.write });
    station.attach(s);
    await expect(s.start()).rejects.toThrow(/6 WrongKey/);
    expect(s.currentStage).toBe('failed');
  });

  it('classifies a refusal, a silent stage and a stop after auth-status', async () => {
    const station = fakeStation({ userId: 'owner', sn: 'R601ZEB4XXXX0000' });
    const refused = new EcoflowBleSession({ token: authToken('other', 'R601ZEB4XXXX0000'), write: station.write });
    station.attach(refused);
    await expect(refused.start()).rejects.toMatchObject({ kind: 'refused', code: 6 });

    // Silent from the auth-status request on: the handshake works, the station never answers 0x89.
    const mute = fakeStation({ userId: 'owner', sn: 'R601ZEB4XXXX0000' });
    const quiet = new EcoflowBleSession({
      token: authToken('owner', 'R601ZEB4XXXX0000'), stageTimeoutMs: 50,
      write: async f => { const [fr] = new FrameReader().push(f); if (fr.type === FRAME_COMMAND) return mute.write(f); },
    });
    mute.attach(quiet);
    await expect(quiet.start()).rejects.toMatchObject({ kind: 'timeout', stage: 'auth-status' });

    const probe = fakeStation({ userId: 'owner', sn: 'R601ZEB4XXXX0000' });
    const noToken = new EcoflowBleSession({ write: probe.write, stopAfterAuthStatus: true });
    probe.attach(noToken);
    await expect(noToken.start()).resolves.toBeUndefined();
  });

  it('does not take the station\'s clock request for an accepted login', async () => {
    const station = fakeStation({ userId: 'owner', sn: 'R601ZEB4XXXX0000', clockRequestFirst: true });
    const s = new EcoflowBleSession({ token: authToken('someone-else', 'R601ZEB4XXXX0000'), write: station.write });
    station.attach(s);
    await expect(s.start()).rejects.toThrow(/6 WrongKey/);
  });

  it('times out a silent station at the first stage', async () => {
    const s = new EcoflowBleSession({ token: authToken('u', 'R601'), write: async () => {}, stageTimeoutMs: 20 });
    await expect(s.start()).rejects.toMatchObject({ stage: 'public-key' });
    await expect(new EcoflowBleSession({ token: authToken('u', 'R601'), write: async () => { throw new Error('gatt'); } }).start())
      .rejects.toMatchObject({ kind: 'failed' });
  });

  it('refuses to send anything but the handshake and the auth requests', async () => {
    const station = fakeStation({ userId: 'u', sn: 'R601ZEB4XXXX0000' });
    const s = new EcoflowBleSession({ token: authToken('u', 'R601ZEB4XXXX0000'), write: station.write });
    station.attach(s);
    await s.start();
    const frame = (s as any).packetFrame({ src: 0x21, dst: 0x02, cmdSet: 0x20, cmdId: 0x42, payload: Buffer.from([1]) });
    await expect((s as any).send(frame)).rejects.toThrow(/refusing/);
    const bind = (s as any).packetFrame({ src: 0x21, dst: 0x35, cmdSet: 0x35, cmdId: 0x85 });
    await expect((s as any).send(bind)).rejects.toThrow(/refusing/);
    await expect((s as any).send(encodeFrame(FRAME_COMMAND, Buffer.from([0x05])))).rejects.toThrow(/refusing/);
  });
});
