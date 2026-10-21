import { findFreeSpot, placeNewWidget, placeWidget } from '../../src/main/widget/position';
import { WIDGET_SIZES } from '../../src/shared/widget-sizes';

const primary = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const second = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1000 } };
const size = WIDGET_SIZES.compact;
test('default: top-right of primary with 24px margin', () =>
  expect(placeWidget(null, size, [primary, second], 1)).toEqual({ x: 1920 - 290 - 24, y: 24, displayId: 1 }));
test('unknown display → default', () =>
  expect(placeWidget({ x: 5000, y: 10, displayId: 9 }, size, [primary], 1)).toEqual({ x: 1606, y: 24, displayId: 1 }));
test('clamped into its display work area', () =>
  expect(placeWidget({ x: 3100, y: 950, displayId: 2 }, size, [primary, second], 1)).toEqual({ x: 1920 + 1280 - 290, y: 1000 - 150, displayId: 2 }));

const inCorner = { x: 1606, y: 24, ...size };

test('findFreeSpot: the corner when free', () =>
  expect(findFreeSpot(primary.workArea, size, [])).toEqual({ x: 1920 - 290 - 24, y: 24 }));

test('findFreeSpot: below a widget in the corner, 16 apart', () =>
  expect(findFreeSpot(primary.workArea, size, [inCorner])).toEqual({ x: 1606, y: 24 + 150 + 16 }));

test('findFreeSpot: next column when the column is full', () => {
  // Six widgets 16 apart fill the corner column: the last free y would be 1040 - 150 - 24 = 866, under 854 + 150 + 16.
  const column = [24, 190, 356, 522, 688, 854].map(y => ({ x: 1606, y, ...size }));
  const spot = findFreeSpot(primary.workArea, size, column);
  expect(spot).not.toBeNull();
  expect(spot!.x + 290 + 16).toBeLessThanOrEqual(1606);
  expect(spot).toEqual({ x: 1606 - 16 - 290, y: 24 }); // the column right next to it, 16 apart, from the top
});

test('findFreeSpot: null when full', () => {
  expect(findFreeSpot(primary.workArea, size, [{ ...primary.workArea }])).toBeNull();
  // A work area too small for the widget and its margins has no spot either.
  expect(findFreeSpot({ x: 0, y: 0, width: 300, height: 160 }, size, [])).toBeNull();
});

test('findFreeSpot: a widget exactly 16 away does not count as overlapping', () => {
  const left = { x: 1606 - 16 - 290, y: 24, ...size };
  expect(findFreeSpot(primary.workArea, size, [left])).toEqual({ x: 1606, y: 24 });
  expect(findFreeSpot(primary.workArea, size, [{ ...left, x: left.x + 1 }])).toEqual({ x: 1606, y: 24 + 150 + 16 });
});

test('placeWidget: a gone display takes a free spot', () => {
  expect(placeWidget({ x: 5000, y: 10, displayId: 9 }, size, [primary], 1, [inCorner]))
    .toEqual({ x: 1606, y: 24 + 150 + 16, displayId: 1 });
  // A saved position on a live display stays where it was saved, neighbours or not.
  expect(placeWidget({ x: 1606, y: 24, displayId: 1 }, size, [primary], 1, [inCorner])).toEqual({ x: 1606, y: 24, displayId: 1 });
  // A primary display with no room left: today's corner.
  expect(placeWidget(null, size, [primary], 1, [{ ...primary.workArea }])).toEqual({ x: 1606, y: 24, displayId: 1 });
});

test('placeWidget: a widget never dragged (no saved position) keeps the corner, neighbours or not', () => {
  // A sibling right below the corner, and one parked snug left of it: neither moves the corner widget.
  const below = { x: 1606, y: 190, ...size };
  const snugLeft = { x: 1310, y: 24, ...size };
  expect(placeWidget(null, size, [primary], 1, [below])).toEqual({ x: 1606, y: 24, displayId: 1 });
  expect(placeWidget(null, size, [primary], 1, [snugLeft])).toEqual({ x: 1606, y: 24, displayId: 1 });
  expect(placeWidget(null, size, [primary], 1, [inCorner])).toEqual({ x: 1606, y: 24, displayId: 1 });
  // A style change: the bigger size takes the timeline's corner, even if it now overlaps the sibling below.
  expect(placeWidget(null, WIDGET_SIZES.timeline, [primary], 1, [below])).toEqual({ x: 1920 - 400 - 24, y: 24, displayId: 1 });
});

test('placeNewWidget: anchor display, else primary', () => {
  const corner2 = { x: 1920 + 1280 - 290 - 24, y: 24, displayId: 2 };
  expect(placeNewWidget(size, [primary, second], 1, 2, [])).toEqual(corner2);
  expect(placeNewWidget(size, [primary, second], 1, 2, [{ ...corner2, ...size }])).toEqual({ ...corner2, y: 24 + 150 + 16 });
  expect(placeNewWidget(size, [primary, second], 1, undefined, [])).toEqual({ x: 1606, y: 24, displayId: 1 });
  expect(placeNewWidget(size, [primary, second], 1, 9, [inCorner])).toEqual({ x: 1606, y: 24 + 150 + 16, displayId: 1 });
});

test('placeNewWidget: a full work area falls back to the corner', () =>
  expect(placeNewWidget(size, [primary], 1, 1, [{ ...primary.workArea }])).toEqual({ x: 1606, y: 24, displayId: 1 }));
