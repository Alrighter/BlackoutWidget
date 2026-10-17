import { kyivDateKey, kyivMinutesOfDay, kyivWallTimeToInstant, addDays, formatHM, formatDM, parseDtekDateTime } from '../../src/shared/time';
test('kyivDateKey: DTEK day key 1792184400 is 2026-10-17', () => {
  expect(kyivDateKey(new Date(1792184400 * 1000))).toBe('2026-10-17');
});
test('kyivMinutesOfDay', () => expect(kyivMinutesOfDay(new Date('2026-10-17T08:50:00Z'))).toBe(710));
test('kyivWallTimeToInstant summer time', () =>
  expect(kyivWallTimeToInstant('2026-10-17', 900).toISOString()).toBe('2026-10-17T12:00:00.000Z'));
test('kyivWallTimeToInstant across DST end', () =>
  expect(kyivWallTimeToInstant('2026-10-25', 900).toISOString()).toBe('2026-10-25T13:00:00.000Z'));
test('kyivWallTimeToInstant 24:00 is next midnight', () =>
  expect(kyivWallTimeToInstant('2026-10-18', 1440).toISOString()).toBe('2026-10-18T21:00:00.000Z'));
test('addDays crosses month', () => expect(addDays('2026-10-31', 1)).toBe('2026-11-01'));
test('formatHM / formatDM', () => {
  expect(formatHM(new Date('2026-10-17T08:48:00Z'))).toBe('11:48');
  expect(formatDM('2026-10-18')).toBe('18.10');
});
test('parseDtekDateTime both orders, garbage → undefined', () => {
  expect(parseDtekDateTime('11:55 17.10.2026')?.toISOString()).toBe('2026-10-17T08:55:00.000Z');
  expect(parseDtekDateTime('17.10.2026 11:55')?.toISOString()).toBe('2026-10-17T08:55:00.000Z');
  expect(parseDtekDateTime('')).toBeUndefined();
  expect(parseDtekDateTime('завтра')).toBeUndefined();
});
