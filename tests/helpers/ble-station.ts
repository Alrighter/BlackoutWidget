import { createCipheriv, createDecipheriv, createECDH, createHash } from 'node:crypto';
import { KEY_TABLE_B64 } from '../../src/main/actual/ecoflow/ble/keydata';
import {
  decodePacket, encodeFrame, encodePacket, FRAME_COMMAND, FRAME_PROTOCOL, FrameReader, type OutPacket,
} from '../../src/main/actual/ecoflow/ble/protocol';

// Decrypted RIVER 2 Pro packets from the ha-ef-ble #218 debug log (research §2.6), lines 24 and on.
export const INV = Buffer.from('aa024600902c00000000010104212002000000004401010501f101600000f0d001006c0300003c95d10100640d00003c3300000000000000000000000001000000000002000000000000000000000000000000000000324f', 'hex');
export const PD = Buffer.from('aa027900aa0c00000000ffff0221200200000000005b0501030000000000266700f80153000000000000000000000000000000001e002c016400000000000000003c0b0000260000007807000000000000000000009f050000fd1d0000968a0200000000000000000000000000000100000800880080000000000000000000010a0000000501000000f9fb', 'hex');
export const MPPT = Buffer.from('aa025e006f2c0000000001010521200200100000780101045b0b0000140000000000b04d00002f4100000000000000000000000000000000000000000000000000000000000027000000000000401f0000000101780000003c9001000000000000002c010000000000000000000094a1', 'hex');

const md5 = (b: Uint8Array) => createHash('md5').update(b).digest();

export interface StationOptions {
  sn: string;
  /** The owner: the station accepts the auth payload MD5(userId + SN), unless `token` says otherwise. */
  userId?: string;
  /** The auth payload the station accepts. */
  token?: string;
  /** The refusal code for any other payload (default 6, WrongKey). */
  authCode?: number;
  clockRequestFirst?: boolean;
  /** Answer nothing from this request on: the handshake works, then the station goes quiet (a stall). */
  silentFrom?: 'auth-status' | 'auth';
  /** Send an inverter heartbeat right after accepting the auth (default true). */
  heartbeatOnAuth?: boolean;
}

export type FakeStation = ReturnType<typeof fakeStation>;

/**
 * A station double: the device side of the handshake, written against OpenSSL rather than our crypto module. Its
 * options can change between connections; each connection's handshake starts over.
 */
export function fakeStation(opts: StationOptions) {
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
  /** The app's packets as the station decoded them: '35/89'. */
  const sent: string[] = [];
  /** Every write, classified: 'hs/01', 'hs/02', 'packet 35 35/89' (dst, cmdSet/cmdId), or 'unknown …'. */
  const writes: string[] = [];
  let target: { handle(chunk: Buffer): void } | null = null;
  const reply = (frame: Buffer) => queueMicrotask(() => target?.handle(frame));
  const send = (p: OutPacket) => reply(encodeFrame(FRAME_PROTOCOL, aes(key, encodePacket(p), true)));
  const hex = (n: number) => n.toString(16).padStart(2, '0');

  const write = async (frame: Buffer) => {
    const [f] = new FrameReader().push(frame);
    if (f?.type === FRAME_COMMAND && f.payload[0] === 0x01) {
      writes.push('hs/01');
      const shared = ecdh.computeSecret(Buffer.concat([Buffer.from([4]), f.payload.subarray(2)]));
      initialKey = shared.subarray(0, 16);
      iv = md5(shared);
      reply(encodeFrame(FRAME_COMMAND, Buffer.concat([Buffer.from([0x01, 0x01, 0x00]), ecdh.getPublicKey().subarray(1)])));
      return;
    }
    if (f?.type === FRAME_COMMAND && f.payload[0] === 0x02) {
      writes.push('hs/02');
      reply(encodeFrame(FRAME_COMMAND, Buffer.concat([Buffer.from([0x02]), aes(initialKey, Buffer.concat([sRand, seed]), true)])));
      return;
    }
    let p: ReturnType<typeof decodePacket>;
    try {
      if (f?.type !== FRAME_PROTOCOL) throw new Error('not a protocol frame');
      p = decodePacket(aes(key, f.payload, false));
    } catch {
      writes.push(`unknown ${frame.toString('hex')}`);
      return;
    }
    sent.push(`${p.cmdSet.toString(16)}/${p.cmdId.toString(16)}`);
    writes.push(`packet ${hex(p.dst)} ${hex(p.cmdSet)}/${hex(p.cmdId)}`);
    if (p.cmdId === 0x89 && opts.silentFrom !== 'auth-status') {
      send({ src: 0x35, dst: 0x21, cmdSet: 0x35, cmdId: 0x89, payload: Buffer.from([0x00]) });
    }
    if (p.cmdId === 0x86 && !opts.silentFrom) {
      // The station's clock request (src 0x35, cmd 0x01/0x52) can land between our auth and its reply.
      if (opts.clockRequestFirst) send({ src: 0x35, dst: 0x21, cmdSet: 0x01, cmdId: 0x52 });
      const expected = opts.token ?? md5(Buffer.from(opts.userId + opts.sn)).toString('hex').toUpperCase();
      const ok = p.payload.equals(Buffer.from(expected));
      send({ src: 0x35, dst: 0x21, cmdSet: 0x35, cmdId: 0x86, payload: Buffer.from([ok ? 0 : (opts.authCode ?? 6)]) });
      if (ok && opts.heartbeatOnAuth !== false) reply(encodeFrame(FRAME_PROTOCOL, aes(key, INV, true)));
    }
  };

  return {
    opts, sent, writes, write,
    /** Where the station's notifications go: a session, or anything with `handle`. */
    attach: (t: { handle(chunk: Buffer): void }) => { target = t; },
    /** Sends an encoded packet (such as INV) to the app, encrypted with the session key. */
    emit: (packet: Buffer) => reply(encodeFrame(FRAME_PROTOCOL, aes(key, packet, true))),
    /** Sends a packet built from its fields. */
    send,
    /** A protocol frame that arrives intact but does not decode, as when the key no longer matches. */
    garbage: () => reply(encodeFrame(FRAME_PROTOCOL, aes(key, Buffer.from('not an EcoFlow packet'), true))),
  };
}
