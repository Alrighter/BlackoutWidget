import { WIDGET_SIZES } from '../../src/shared/widget-sizes';

test('one widget size table for the window and the settings: 290×150, 236×260, 400×200', () => {
  expect(WIDGET_SIZES).toEqual({
    compact: { width: 290, height: 150 }, ring: { width: 236, height: 260 }, timeline: { width: 400, height: 200 },
  });
});
