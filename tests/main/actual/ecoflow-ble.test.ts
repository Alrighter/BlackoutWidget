import { createCipheriv, createDecipheriv, createECDH, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseAdvert } from '../../../src/main/actual/ecoflow/ble/advert';
import { authToken, newEphemeralKey, sessionKey, sharedSecret, SessionCipher } from '../../../src/main/actual/ecoflow/ble/crypto';
import { decodeHeartbeat, heartbeatOf } from '../../../src/main/actual/ecoflow/ble/heartbeats';
import { KEY_TABLE_B64 } from '../../../src/main/actual/ecoflow/ble/keydata';
import {
  crc16, crc8, decodePacket, encodeFrame, encodePacket, FRAME_COMMAND, FRAME_PROTOCOL, FrameReader, PacketError,
} from '../../../src/main/actual/ecoflow/ble/protocol';
import { EcoflowBleSession, SessionError } from '../../../src/main/actual/ecoflow/ble/session';

// Decrypted RIVER 2 Pro packets from the ha-ef-ble #218 debug log (research §2.6), lines 24 and on.
const INV = Buffer.from('aa024600902c00000000010104212002000000004401010501f101600000f0d001006c0300003c95d10100640d00003c3300000000000000000000000001000000000002000000000000000000000000000000000000324f', 'hex');
const PD = Buffer.from('aa027900aa0c00000000ffff0221200200000000005b0501030000000000266700f80153000000000000000000000000000000001e002c016400000000000000003c0b0000260000007807000000000000000000009f050000fd1d0000968a0200000000000000000000000000000100000800880080000000000000000000010a0000000501000000f9fb', 'hex');
const MPPT = Buffer.from('aa025e006f2c0000000001010521200200100000780101045b0b0000140000000000b04d00002f4100000000000000000000000000000000000000000000000000000000000027000000000000401f0000000101780000003c9001000000000000002c010000000000000000000094a1', 'hex');

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
    expect(t.toString()).toBe(md5(Buffer.from('1234567890123456789R601ZEB4XXXX0000')).toString('hex').toUpperCase());
    expect(t).toHaveLength(32);
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

/** A station double: the device side of the handshake, written against OpenSSL rather than our crypto module. */
function fakeStation(opts: { userId: string; sn: string; authCode?: number; clockRequestFirst?: boolean }) {
  const ecdh = createECDH('secp160r1');
  ecdh.generateKeys();
  const sRand = Buffer.alloc(16, 0x42);
  const seed = Buffer.from([0x03, 0x05]);
  const table = Buffer.from(KEY_TABLE_B64, 'base64');
  const pos = seed[0] * 0x10 + (seed[1] - 1) * 0x100;
  const key = md5(Buffer.concat([table.subarray(pos, pos + 16), sRand]));
  let iv = Buffer.alloc(16);
  let initialKey = Buffer.alloc(16);
  const aes = (k: Buffer, data: Buffer, enc: boolean) => {
    const c = enc ? createCipheriv('aes-128-cbc', k, iv) : createDecipheriv('aes-128-cbc', k, iv);
    return Buffer.concat([c.update(data), c.final()]);
  };
  const sent: string[] = [];
  let session!: EcoflowBleSession;
  const reply = (frame: Buffer) => queueMicrotask(() => session.handle(frame));
  const send = (p: Parameters<typeof encodePacket>[0]) => reply(encodeFrame(FRAME_PROTOCOL, aes(key, encodePacket(p), true)));

  const write = async (frame: Buffer) => {
    const [f] = new FrameReader().push(frame);
    if (f.type === FRAME_COMMAND && f.payload[0] === 0x01) {
      const shared = ecdh.computeSecret(Buffer.concat([Buffer.from([4]), f.payload.subarray(2)]));
      initialKey = shared.subarray(0, 16);
      iv = md5(shared);
      reply(encodeFrame(FRAME_COMMAND, Buffer.concat([Buffer.from([0x01, 0x01, 0x00]), ecdh.getPublicKey().subarray(1)])));
      return;
    }
    if (f.type === FRAME_COMMAND && f.payload[0] === 0x02) {
      reply(encodeFrame(FRAME_COMMAND, Buffer.concat([Buffer.from([0x02]), aes(initialKey, Buffer.concat([sRand, seed]), true)])));
      return;
    }
    const p = decodePacket(aes(key, f.payload, false));
    sent.push(`${p.cmdSet.toString(16)}/${p.cmdId.toString(16)}`);
    if (p.cmdId === 0x89) send({ src: 0x35, dst: 0x21, cmdSet: 0x35, cmdId: 0x89, payload: Buffer.from([0x00]) });
    if (p.cmdId === 0x86) {
      // The station's clock request (src 0x35, cmd 0x01/0x52) can land between our auth and its reply.
      if (opts.clockRequestFirst) send({ src: 0x35, dst: 0x21, cmdSet: 0x01, cmdId: 0x52 });
      const ok = p.payload.equals(Buffer.from(md5(Buffer.from(opts.userId + opts.sn)).toString('hex').toUpperCase()));
      send({ src: 0x35, dst: 0x21, cmdSet: 0x35, cmdId: 0x86, payload: Buffer.from([ok ? 0 : (opts.authCode ?? 6)]) });
      if (ok) reply(encodeFrame(FRAME_PROTOCOL, aes(key, INV, true)));
    }
  };
  return { sent, attach: (s: EcoflowBleSession) => { session = s; }, write };
}

describe('EcoFlow BLE session', () => {
  it('runs the handshake against a station double and then streams heartbeats', async () => {
    const station = fakeStation({ userId: '1234567890123456789', sn: 'R601ZEB4XXXX0000' });
    const packets: string[] = [];
    const stages: string[] = [];
    const s = new EcoflowBleSession({
      userId: '1234567890123456789', sn: 'R601ZEB4XXXX0000', write: station.write,
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
    const s = new EcoflowBleSession({ userId: 'someone-else', sn: 'R601ZEB4XXXX0000', write: station.write });
    station.attach(s);
    await expect(s.start()).rejects.toThrow(/6 WrongKey/);
    expect(s.currentStage).toBe('failed');
  });

  it('does not take the station\'s clock request for an accepted login', async () => {
    const station = fakeStation({ userId: 'owner', sn: 'R601ZEB4XXXX0000', clockRequestFirst: true });
    const s = new EcoflowBleSession({ userId: 'someone-else', sn: 'R601ZEB4XXXX0000', write: station.write });
    station.attach(s);
    await expect(s.start()).rejects.toThrow(/6 WrongKey/);
  });

  it('times out a silent station at the first stage', async () => {
    const s = new EcoflowBleSession({ userId: 'u', sn: 'R601', write: async () => {}, stageTimeoutMs: 20 });
    await expect(s.start()).rejects.toMatchObject({ stage: 'public-key' });
    await expect(new EcoflowBleSession({ userId: 'u', sn: 'R601', write: async () => { throw new Error('gatt'); } }).start())
      .rejects.toBeInstanceOf(SessionError);
  });

  it('refuses to send anything but the handshake and the auth requests', async () => {
    const station = fakeStation({ userId: 'u', sn: 'R601ZEB4XXXX0000' });
    const s = new EcoflowBleSession({ userId: 'u', sn: 'R601ZEB4XXXX0000', write: station.write });
    station.attach(s);
    await s.start();
    const frame = (s as any).packetFrame({ src: 0x21, dst: 0x02, cmdSet: 0x20, cmdId: 0x42, payload: Buffer.from([1]) });
    await expect((s as any).send(frame)).rejects.toThrow(/refusing/);
    const bind = (s as any).packetFrame({ src: 0x21, dst: 0x35, cmdSet: 0x35, cmdId: 0x85 });
    await expect((s as any).send(bind)).rejects.toThrow(/refusing/);
    await expect((s as any).send(encodeFrame(FRAME_COMMAND, Buffer.from([0x05])))).rejects.toThrow(/refusing/);
  });
});
