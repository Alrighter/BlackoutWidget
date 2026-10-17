import { normalizeQuotaMessage, parseStatusMessage } from '../../../src/main/actual/ecoflow/mqtt-message';

test('typeCode envelope', () => expect(normalizeQuotaMessage({ typeCode: 'invStatus', params: { acInVol: 228652, inputWatts: 0 } }))
  .toEqual({ 'inv.acInVol': 228652, 'inv.inputWatts': 0 }));
test('pd/mppt prefixes and unknown typeCode', () => {
  expect(normalizeQuotaMessage({ typeCode: 'pdStatus', params: { soc: 5 } })).toEqual({ 'pd.soc': 5 });
  expect(normalizeQuotaMessage({ typeCode: 'mpptStatus', params: { a: 1 } })).toEqual({ 'mppt.a': 1 });
  expect(normalizeQuotaMessage({ typeCode: 'fooStatus', params: { a: 1 } })).toEqual({ 'foo.a': 1 });
});
test('bms/ems prefixes', () => {
  expect(normalizeQuotaMessage({ typeCode: 'bmsStatus', params: { soc: 80 } })).toEqual({ 'bms_bmsStatus.soc': 80 });
  expect(normalizeQuotaMessage({ typeCode: 'emsStatus', params: { chgState: 1 } })).toEqual({ 'bms_emsStatus.chgState': 1 });
});
test('cmdFunc/cmdId, addr and flat envelopes', () => {
  expect(normalizeQuotaMessage({ cmdId: 1, cmdFunc: 20, param: { x: 1 } })).toEqual({ '20_1.x': 1 });
  expect(normalizeQuotaMessage({ addr: 'hs_yj751_pd_appshow_addr', param: { inAcC20Pwr: 5 } })).toEqual({ 'hs_yj751_pd_appshow_addr.inAcC20Pwr': 5 });
  expect(normalizeQuotaMessage({ params: { plugInInfoAcInVol: 230 } })).toEqual({ plugInInfoAcInVol: 230 });
});
test('garbage → null', () => { for (const m of [null, 'x', 42, {}, { typeCode: 'invStatus' }, { params: 5 }]) expect(normalizeQuotaMessage(m)).toBeNull(); });
test('status topic', () => {
  expect(parseStatusMessage({ id: '1', params: { status: 1 } })).toBe(true);
  expect(parseStatusMessage({ params: { status: 0 } })).toBe(false);
  expect(parseStatusMessage({ params: {} })).toBeNull();
  expect(parseStatusMessage(null)).toBeNull();
});
