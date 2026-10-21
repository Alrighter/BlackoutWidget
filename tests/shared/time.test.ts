import { kyivDateKey, kyivMinutesOfDay, kyivWallTimeToInstant, addDays, formatHM, formatDM, parseDtekDateTime, kyivStamp, dtekStamp } from '../../src/shared/time';
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
test('kyivStamp is HH:MM DD.MM.YYYY in Kyiv time', () => {
  expect(kyivStamp(new Date('2026-10-20T10:09:00Z'))).toBe('13:09 20.10.2026');
});
test("dtekStamp is DD.MM.YYYY HH:MM in Kyiv time (DTEK's fact.update order)", () => {
  expect(dtekStamp(new Date('2026-10-21T17:45:03+00:00'))).toBe('21.10.2026 20:45');
  expect(dtekStamp(new Date('2026-10-25T21:05:00Z'))).toBe('25.10.2026 23:05'); // winter time, +02:00
  expect(parseDtekDateTime(dtekStamp(new Date('2026-10-20T10:09:00Z')))?.toISOString()).toBe('2026-10-20T10:09:00.000Z');
});
