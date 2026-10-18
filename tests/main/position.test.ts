import { placeWidget } from '../../src/main/widget/position';
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
