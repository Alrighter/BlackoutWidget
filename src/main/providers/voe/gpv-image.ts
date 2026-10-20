import type { Slot } from '../../../shared/types';
import { ProviderError } from '../types';
import type { RgbImage } from './png';

export const GPV_GROUPS = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'] as const;

const WIDTH = 1750;
const HEIGHT = 2250;
const X0 = 176;
const X1 = 1726;
const COLS = 24; // per half-day
const HALVES: Array<[number, number]> = [[417, 1131], [1304, 2019]];
const LIGHT = [184, 200, 216];
const DARK = [68, 111, 155];
const TOLERANCE = 60;

const dist = (c: number[], r: number[]) => Math.hypot(c[0] - r[0], c[1] - r[1], c[2] - r[2]);

function fail(): never {
  throw new ProviderError('Не вдалося прочитати графік Волиньобленерго');
}

function sample(img: RgbImage, cx: number, cy: number): number[] {
  const sum = [0, 0, 0];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const o = ((cy + dy) * img.width + cx + dx) * img.channels;
      for (let k = 0; k < 3; k++) sum[k] += img.pixels[o + k];
    }
  return sum.map((s) => s / 9);
}

/** Turns the oblast-wide hourly PNG into 48 half-hour slots per queue. Unknown colours throw. */
export function readGpvGrid(img: RgbImage): Record<string, Slot[]> {
  if (img.width !== WIDTH || img.height !== HEIGHT) return fail();
  const grid: Record<string, Slot[]> = {};
  GPV_GROUPS.forEach((g) => (grid[g] = []));
  const colW = (X1 - X0) / COLS;
  for (const [y0, y1] of HALVES) {
    const rowH = (y1 - y0) / GPV_GROUPS.length;
    GPV_GROUPS.forEach((g, r) => {
      const cy = Math.round(y0 + (r + 0.5) * rowH);
      for (let c = 0; c < COLS; c++) {
        const rgb = sample(img, Math.round(X0 + (c + 0.5) * colW), cy);
        if (dist(rgb, LIGHT) <= TOLERANCE) grid[g].push('on');
        else if (dist(rgb, DARK) <= TOLERANCE) grid[g].push('off');
        else fail();
      }
    });
  }
  return grid;
}
