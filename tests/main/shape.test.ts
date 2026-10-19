import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { roundedShape } from '../../src/main/widget/shape';
import { WIDGET_RADII, WIDGET_SIZES } from '../../src/shared/widget-sizes';

/** Covered pixels per row, from the strips; throws on a row covered twice. */
function rows(strips: ReturnType<typeof roundedShape>, height: number): ([number, number] | null)[] {
  const out: ([number, number] | null)[] = Array(height).fill(null);
  for (const s of strips) {
    for (let y = s.y; y < s.y + s.height; y++) {
      if (out[y]) throw new Error(`row ${y} covered twice`);
      out[y] = [s.x, s.x + s.width];
    }
  }
  return out;
}

/**
 * Whether pixel (x, y) overlaps the rounded rectangle, i.e. the inner rectangle [r, w-r]×[r, h-r] grown by r: the
 * pixel's nearest point to that rectangle is closer than r.
 */
function touchesCard(x: number, y: number, w: number, h: number, r: number): boolean {
  const dx = Math.max(0, r - (x + 1), x - (w - r));
  const dy = Math.max(0, r - (y + 1), y - (h - r));
  return dx * dx + dy * dy < r * r;
}

describe('roundedShape', () => {
  it.each(Object.keys(WIDGET_SIZES) as (keyof typeof WIDGET_SIZES)[])('covers every pixel of the %s card and none of its corners', style => {
    const { width, height } = WIDGET_SIZES[style];
    const r = WIDGET_RADII[style];
    const covered = rows(roundedShape(width, height, r), height);
    for (let y = 0; y < height; y++) {
      const span = covered[y];
      expect(span, `row ${y}`).not.toBeNull();
      for (let x = 0; x < width; x++) {
        const inShape = x >= span![0] && x < span![1];
        if (touchesCard(x, y, width, height, r)) expect(inShape, `pixel ${x},${y}`).toBe(true);
      }
    }
    // The corner pixels are the desktop's.
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [3, 3], [width - 4, height - 4]]) {
      expect(covered[y]![0] <= x && x < covered[y]![1], `corner ${x},${y}`).toBe(false);
    }
  });

  it('keeps few strips and is symmetric', () => {
    const strips = roundedShape(290, 150, 22);
    expect(strips.length).toBeLessThanOrEqual(45);
    expect(strips[0]).toEqual({ x: 15, y: 0, width: 260, height: 1 });
    expect(strips[strips.length - 1]).toEqual({ x: 15, y: 149, width: 260, height: 1 });
  });

  it('caps the radius at half the shorter side', () => {
    const covered = rows(roundedShape(40, 20, 50), 20);
    expect(covered.every(Boolean)).toBe(true);
    expect(covered[10]).toEqual([0, 40]);
  });

  it('matches the card radii in tokens.css', () => {
    const tokens = readFileSync(join(__dirname, '../../src/renderer/src/ui/tokens.css'), 'utf8');
    const px = (name: string) => Number(new RegExp(`--bw-r-${name}:\\s*(\\d+)px;`).exec(tokens)?.[1]);
    expect(WIDGET_RADII).toEqual({ compact: px('compact'), ring: px('dial'), timeline: px('timeline') });
  });
});
