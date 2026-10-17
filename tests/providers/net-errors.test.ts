import { isConnectivityError } from '../../src/main/providers/net-errors';

test.each([-106, -105, -137, -102, -109, -118, -21, -130])('connectivity code %i is a network error even when online', code => {
  expect(isConnectivityError(code, true)).toBe(true);
});
test.each([-324, -101, -379, -7, -20, -200, 0])('code %i means the site was contacted (or we blocked it): not a network error while online', code => {
  expect(isConnectivityError(code, true)).toBe(false);
});
test('any code is a network error while offline', () => {
  expect(isConnectivityError(-324, false)).toBe(true);
  expect(isConnectivityError(-20, false)).toBe(true);
});
