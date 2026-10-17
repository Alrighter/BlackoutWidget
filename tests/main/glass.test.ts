import { computeCrop, type Rect } from '../../src/main/widget/glass';

const mon = { x: 0, y: 0, width: 2560, height: 1440 };
const expectRect = (a: Rect | null, e: Rect) => { expect(a).not.toBeNull(); for (const k of ['x', 'y', 'width', 'height'] as const) expect(a![k]).toBeCloseTo(e[k], 6); };
test('fill, same aspect', () =>
  expectRect(computeCrop({ width: 1920, height: 1080 }, 'fill', mon, mon, { x: 100, y: 100, width: 290, height: 150 }), { x: 75, y: 75, width: 217.5, height: 112.5 }));
test('fill, square image on 16:9 crops vertically', () => {
  const m = { x: 0, y: 0, width: 1920, height: 1080 };
  expectRect(computeCrop({ width: 1000, height: 1000 }, 'fill', m, m, { x: 0, y: 0, width: 192, height: 108 }), { x: 0, y: 218.75, width: 100, height: 56.25 });
});
test('stretch', () =>
  expectRect(computeCrop({ width: 1280, height: 720 }, 'stretch', mon, mon, { x: 0, y: 0, width: 256, height: 144 }), { x: 0, y: 0, width: 128, height: 72 }));
test('center', () => {
  const m = { x: 0, y: 0, width: 1920, height: 1080 };
  expectRect(computeCrop({ width: 1000, height: 500 }, 'center', m, m, { x: 460, y: 290, width: 100, height: 50 }), { x: 0, y: 0, width: 100, height: 50 });
});
test('fit: widget in letterbox → null', () => {
  const m = { x: 0, y: 0, width: 1920, height: 1080 };
  expect(computeCrop({ width: 1000, height: 1000 }, 'fit', m, m, { x: 0, y: 0, width: 200, height: 100 })).toBeNull();
});
test('second monitor offsets are relative to that monitor', () => {
  const m2 = { x: 2560, y: 0, width: 2560, height: 1440 };
  expectRect(computeCrop({ width: 1920, height: 1080 }, 'fill', m2, { x: 0, y: 0, width: 5120, height: 1440 }, { x: 2660, y: 100, width: 290, height: 150 }),
    { x: 75, y: 75, width: 217.5, height: 112.5 });
});
test('span uses the virtual screen', () => {
  const virt = { x: 0, y: 0, width: 5120, height: 1440 };
  expectRect(computeCrop({ width: 5120, height: 1440 }, 'span', { x: 2560, y: 0, width: 2560, height: 1440 }, virt, { x: 2660, y: 100, width: 290, height: 150 }),
    { x: 2660, y: 100, width: 290, height: 150 });
});
