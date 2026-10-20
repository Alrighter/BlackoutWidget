import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng, type RgbImage } from '../../src/main/providers/voe/png';
import { GPV_GROUPS, readGpvGrid } from '../../src/main/providers/voe/gpv-image';
import { ProviderError } from '../../src/main/providers/types';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, '..', 'fixtures', 'voe', n)));
const MSG = 'Не вдалося прочитати графік Волиньобленерго';

const OFF: Record<string, [number, number]> = {
  '1.1': [20, 28], '1.2': [28, 35], '2.1': [35, 42], '2.2': [29, 36],
  '3.1': [22, 28], '3.2': [22, 28], '4.1': [28, 35], '4.2': [28, 35],
  '5.1': [35, 37], '5.2': [35, 38], '6.1': [36, 44], '6.2': [42, 44],
};

describe('decodePng', () => {
  it('decodes the 17.10 fixture as 1750x2250 RGB', () => {
    const img = decodePng(fx('gpv-2026-10-17.png'));
    expect(img.width).toBe(1750);
    expect(img.height).toBe(2250);
    expect(img.channels).toBe(3);
    expect(img.pixels.length).toBe(1750 * 2250 * 3);
  });

  it('throws on a truncated file', () => {
    const buf = fx('gpv-2026-10-17.png');
    const cut = buf.slice(0, Math.floor(buf.length / 2));
    expect(() => decodePng(cut)).toThrow(new ProviderError(MSG));
  });

  // Review Focus 1: a half-uploaded or damaged picture is unreadable, never an all-on day.
  const chunks = (b: Uint8Array) => {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: { type: string; start: number; data: number; end: number }[] = [];
    for (let p = 8; p + 8 <= b.length; p += 12 + view.getUint32(p)) {
      const len = view.getUint32(p);
      out.push({ type: String.fromCharCode(...b.subarray(p + 4, p + 8)), start: p, data: p + 8, end: p + 8 + len });
    }
    return out;
  };
  const causeOf = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).toBe(MSG);
      return (e as Error).cause as NodeJS.ErrnoException;
    }
    throw new Error('did not throw');
  };

  it('throws on a file cut just before IEND', () => {
    const buf = fx('gpv-2026-10-20.png');
    const iend = chunks(buf).find((c) => c.type === 'IEND')!;
    expect(causeOf(() => decodePng(buf.slice(0, iend.start))).message).toBe('incomplete PNG');
  });

  it('throws on a corrupted IDAT byte (zlib error)', () => {
    const buf = fx('gpv-2026-10-20.png').slice();
    const idats = chunks(buf).filter((c) => c.type === 'IDAT');
    // The last byte of the zlib stream is its Adler-32 checksum: CRCs are not checked, so inflate is what notices.
    buf[idats[idats.length - 1].end - 1] ^= 0xff;
    expect(causeOf(() => decodePng(buf)).code).toBe('Z_DATA_ERROR');
  });

  it('throws on a run of damaged bytes inside IDAT', () => {
    const buf = fx('gpv-2026-10-20.png').slice();
    const idat = chunks(buf).find((c) => c.type === 'IDAT')!;
    for (let i = idat.data + 2; i < idat.data + 52; i++) buf[i] ^= 0xff;
    expect(() => decodePng(buf)).toThrow(new ProviderError(MSG));
  });

  it('throws on a palette PNG (colour type 3)', () => {
    const buf = fx('gpv-2026-10-17.png').slice();
    buf[25] = 3; // IHDR colour type byte
    expect(() => decodePng(buf)).toThrow(new ProviderError(MSG));
  });

  it('throws on a bad signature', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4]))).toThrow(new ProviderError(MSG));
  });
});

describe('readGpvGrid', () => {
  it('reads the 17.10 outages exactly', () => {
    const grid = readGpvGrid(decodePng(fx('gpv-2026-10-17.png')));
    for (const g of GPV_GROUPS) {
      const [a, b] = OFF[g];
      expect(grid[g]).toHaveLength(48);
      grid[g].forEach((s, i) => expect(s, `${g}[${i}]`).toBe(i >= a && i < b ? 'off' : 'on'));
    }
  });

  it('reads 20.10 as all on', () => {
    const grid = readGpvGrid(decodePng(fx('gpv-2026-10-20.png')));
    const all = GPV_GROUPS.flatMap((g) => grid[g]);
    expect(all).toHaveLength(576);
    expect(all.every((s) => s === 'on')).toBe(true);
  });

  it('throws on a wrong width', () => {
    const img: RgbImage = { width: 1749, height: 2250, channels: 3, pixels: new Uint8Array(1749 * 2250 * 3) };
    expect(() => readGpvGrid(img)).toThrow(new ProviderError(MSG));
  });

  it('throws on a cell of an unknown colour', () => {
    const src = decodePng(fx('gpv-2026-10-17.png'));
    const pixels = src.pixels.slice();
    // row 1.1, column 0 centre
    const cx = Math.round(176 + (1726 - 176) / 24 / 2);
    const cy = Math.round(417 + (1131 - 417) / 12 / 2);
    for (let y = cy - 2; y <= cy + 2; y++)
      for (let x = cx - 2; x <= cx + 2; x++) {
        const o = (y * src.width + x) * 3;
        pixels[o] = 255; pixels[o + 1] = 0; pixels[o + 2] = 0;
      }
    expect(() => readGpvGrid({ ...src, pixels })).toThrow(new ProviderError(MSG));
  });
});
