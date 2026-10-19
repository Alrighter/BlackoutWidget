/**
 * EcoFlow BLE wire format for the RIVER 2 family (encrypt type 7), ported from rabits/ha-ef-ble at 1c1eb33 (Apache
 * License 2.0): the outer 0x5A5A frame (encpacket.py, frame_assembler.py), the inner 0xAA packet (packet.py) and their
 * CRCs (crc.py). Layout notes: docs/superpowers/specs/assets/ecoflow-ble-research.md §2.4.
 */

function table(step: (c: number) => number): Uint16Array {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = step(c);
    t[i] = c;
  }
  return t;
}

// CRC-8/CCITT: poly 0x07, init 0, no reflection. CRC-16/ARC: poly 0x8005 reflected (0xA001), init 0.
const CRC8 = table(c => (c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff));
const CRC16 = table(c => (c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1));

export function crc8(data: Uint8Array): number {
  let c = 0;
  for (const b of data) c = CRC8[c ^ b];
  return c;
}

export function crc16(data: Uint8Array): number {
  let c = 0;
  for (const b of data) c = CRC16[(c ^ b) & 0xff] ^ (c >>> 8);
  return c;
}

const FRAME_PREFIX = Buffer.from([0x5a, 0x5a]);
/** Handshake frames travel in plain text; everything after the session key is a protocol frame (AES-CBC). */
export const FRAME_COMMAND = 0x0;
export const FRAME_PROTOCOL = 0x1;
const MAX_FRAME_LEN = 10_000;

/** Outer frame: 5A 5A | type<<4 | 01 | u16 LE length (payload + CRC) | payload | CRC16 LE of everything before it. */
export function encodeFrame(type: number, payload: Uint8Array): Buffer {
  const head = Buffer.from([0x5a, 0x5a, type << 4, 0x01, 0, 0]);
  head.writeUInt16LE(payload.length + 2, 4);
  const body = Buffer.concat([head, payload]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(body));
  return Buffer.concat([body, crc]);
}

export interface Frame { type: number; payload: Buffer }

/**
 * Cuts outer frames out of the notification stream. A frame may span notifications, a false prefix may sit inside a
 * payload, and a corrupt frame fails its CRC: the reader resyncs on the next prefix and keeps an incomplete tail.
 */
export class FrameReader {
  private tail = Buffer.alloc(0);

  push(chunk: Uint8Array): Frame[] {
    let data = this.tail.length ? Buffer.concat([this.tail, chunk]) : Buffer.from(chunk);
    const frames: Frame[] = [];
    for (;;) {
      const start = data.indexOf(FRAME_PREFIX);
      if (start < 0) {
        // A lone 0x5A at the end may be the first half of the next prefix.
        data = data.length && data[data.length - 1] === 0x5a ? data.subarray(data.length - 1) : Buffer.alloc(0);
        break;
      }
      data = data.subarray(start);
      if (data.length < 8) break;
      const len = data.readUInt16LE(4);
      if (len < 2 || len > MAX_FRAME_LEN) { data = data.subarray(2); continue; }
      const end = 6 + len;
      if (end > data.length) {
        // Incomplete, or a false prefix whose bogus length runs past the buffer: a later prefix decides which.
        const next = data.indexOf(FRAME_PREFIX, 2);
        if (next >= 0) { data = data.subarray(next); continue; }
        break;
      }
      if (crc16(data.subarray(0, end - 2)) !== data.readUInt16LE(end - 2)) { data = data.subarray(2); continue; }
      frames.push({ type: data[2] >> 4, payload: Buffer.from(data.subarray(6, end - 2)) });
      data = data.subarray(end);
    }
    this.tail = Buffer.from(data);
    return frames;
  }
}

export interface Packet { version: number; src: number; dst: number; cmdSet: number; cmdId: number; seq: Buffer; payload: Buffer }
export type OutPacket = Pick<Packet, 'src' | 'dst' | 'cmdSet' | 'cmdId'> & { payload?: Uint8Array; version?: 2 | 3 };

/**
 * Inner packet: AA | version | u16 LE payload length | CRC8 of those 4 bytes | product byte | u32 seq | 00 00 | src |
 * dst | (V3: dsrc ddst) | cmdSet | cmdId | payload | CRC16 LE of everything before it.
 */
export function encodePacket(p: OutPacket): Buffer {
  const version = p.version ?? 2;
  const payload = Buffer.from(p.payload ?? []);
  const head = Buffer.from([0xaa, version, 0, 0]);
  head.writeUInt16LE(payload.length, 2);
  const route = version >= 3 ? [p.src, p.dst, 0x01, 0x01, p.cmdSet, p.cmdId] : [p.src, p.dst, p.cmdSet, p.cmdId];
  // 0x0D is the product byte the app sends; the seq and the two bytes after it are zeros on our side.
  const body = Buffer.concat([head, Buffer.from([crc8(head), 0x0d, 0, 0, 0, 0, 0, 0, ...route]), payload]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16(body));
  return Buffer.concat([body, crc]);
}

export class PacketError extends Error {}

/** Parses one inner packet; bytes past its CRC (cipher padding) are ignored. Bytes 5 and 10–11 vary by module. */
export function decodePacket(data: Uint8Array): Packet {
  const b = Buffer.from(data);
  if (b.length < 5 || b[0] !== 0xaa) throw new PacketError('no 0xAA prefix');
  if (crc8(b.subarray(0, 4)) !== b[4]) throw new PacketError('header CRC8 mismatch');
  const version = b[1];
  if (version !== 2 && version !== 3) throw new PacketError(`unsupported packet version ${version}`);
  const start = version === 2 ? 16 : 18;
  const len = b.readUInt16LE(2);
  const end = start + len;
  if (b.length < end + 2) throw new PacketError('packet shorter than its length');
  if (crc16(b.subarray(0, end)) !== b.readUInt16LE(end)) throw new PacketError('CRC16 mismatch');
  const [cmdSet, cmdId] = version === 2 ? [b[14], b[15]] : [b[16], b[17]];
  return {
    version, src: b[12], dst: b[13], cmdSet, cmdId, seq: Buffer.from(b.subarray(6, 10)), payload: Buffer.from(b.subarray(start, end)),
  };
}
