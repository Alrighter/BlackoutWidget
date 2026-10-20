import { inflateSync } from 'node:zlib';
import { ProviderError } from '../types';

export interface RgbImage {
  width: number;
  height: number;
  channels: 3 | 4;
  pixels: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function fail(cause?: unknown): never {
  throw new ProviderError('Не вдалося прочитати графік Волиньобленерго', cause === undefined ? undefined : { cause });
}

/** Minimal PNG decoder: 8-bit RGB / RGBA, no interlace. CRCs are not checked. */
export function decodePng(buf: Uint8Array): RgbImage {
  try {
    return decode(buf);
  } catch (e) {
    return fail(e);
  }
}

function decode(buf: Uint8Array): RgbImage {
  if (buf.length < 8 || SIGNATURE.some((b, i) => buf[i] !== b)) throw new Error('bad signature');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let channels: 3 | 4 | 0 = 0;
  const idat: Uint8Array[] = [];
  let sawEnd = false;
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const start = pos + 8;
    if (start + len + 4 > buf.length) throw new Error('truncated chunk');
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = buf[start + 8];
      const colour = buf[start + 9];
      const interlace = buf[start + 12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) throw new Error('unsupported PNG');
      channels = colour === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(start, start + len));
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }
    pos = start + len + 4;
  }
  if (!sawEnd || !channels || !width || !height) throw new Error('incomplete PNG');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('bad data length');
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[row + i - channels] : 0;
      const b = y > 0 ? out[row - stride + i] : 0;
      const c = y > 0 && i >= channels ? out[row - stride + i - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter');
      }
      out[row + i] = v & 255;
    }
  }
  return { width, height, channels, pixels: out };
}
