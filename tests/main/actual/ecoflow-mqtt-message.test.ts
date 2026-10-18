import {
  isProtobufPayload, latestQuotasRequest, normalizeQuotaMessage, parseGetReply, parseStatusMessage,
} from '../../../src/main/actual/ecoflow/mqtt-message';

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

// The app broker (R§5.1): a string moduleType and params already dotted like quota/all; a 19-digit id is never used.
test('app property push: dotted params pass through unchanged, a 19-digit id is harmless', () => {
  const lines = [
    '{"id":1330299626203776316,"version":"1.0","timestamp":1669603259,"moduleType":"3","params":{"inv.acInVol":123113}}',
    '{"id":1330299635822756850,"version":"1.0","timestamp":1669603260,"moduleType":"3","params":{"inv.acInAmp":66,"inv.acInVol":123084}}',
    '{"id":1330299618754038533,"version":"1.0","timestamp":1669603258,"moduleType":"2","params":{"bms_bmsStatus.minCellTemp":26,"bms_bmsStatus.f32ShowSoc":89.7}}',
  ];
  expect(lines.map(l => normalizeQuotaMessage(JSON.parse(l)))).toEqual([
    { 'inv.acInVol': 123113 },
    { 'inv.acInAmp': 66, 'inv.acInVol': 123084 },
    { 'bms_bmsStatus.minCellTemp': 26, 'bms_bmsStatus.f32ShowSoc': 89.7 },
  ]);
});

test('get_reply: a River 2 Max latestQuotas snapshot (R§3.6)', () => {
  const reply = JSON.parse('{"code":"0","id":179531081,"moduleType":0,"operateType":"latestQuotas","version":"1.1",'
    + '"data":{"sn":"R601ABC","productType":71,"model":1,"online":1,"quotaMap":{"inv.acInVol":227718,"inv.acInFreq":50,"inv.acInAmp":1655,"inv.inputWatts":356}}}');
  expect(parseGetReply(reply)).toEqual({
    online: true, quota: { 'inv.acInVol': 227718, 'inv.acInFreq': 50, 'inv.acInAmp': 1655, 'inv.inputWatts': 356 },
  });
});

test('get_reply: an offline station has no usable quotaMap', () => {
  expect(parseGetReply({ code: '0', operateType: 'latestQuotas', data: { online: 0 } })).toEqual({ online: false, quota: null });
  // Even a cached map is not taken from an offline station.
  expect(parseGetReply({ code: '0', operateType: 'latestQuotas', data: { online: 0, quotaMap: { 'inv.acInVol': 227718 } } }))
    .toEqual({ online: false, quota: null });
  expect(parseGetReply({ code: '0', operateType: 'latestQuotas', data: { online: 1 } })).toEqual({ online: true, quota: null });
});

test('get_reply: anything but a successful latestQuotas answer → null', () => {
  const data = { online: 1, quotaMap: { 'inv.acInVol': 1 } };
  for (const m of [
    null, 'x', 42, {},
    { code: '1', operateType: 'latestQuotas', data },
    { code: '0', operateType: 'setRtcTime', data },
    { code: '0', data },
    { operateType: 'latestQuotas', data },
    { code: '0', operateType: 'latestQuotas' },
    { code: '0', operateType: 'latestQuotas', data: 'x' },
    { moduleType: '3', params: { 'inv.acInVol': 1 } },
  ]) expect(parseGetReply(m)).toBeNull();
});

test('isProtobufPayload: anything that is not JSON-object text', () => {
  expect(isProtobufPayload(Buffer.from('0a141020182070', 'hex'))).toBe(true);
  expect(isProtobufPayload(Buffer.from('0a141020182070bb8cc9d501ba0107416e64726f6964', 'hex'))).toBe(true);
  for (const text of ['not json', '[1,2]', '42', 'null', '"x"', '']) expect(isProtobufPayload(Buffer.from(text))).toBe(true);
  expect(isProtobufPayload(Buffer.from('{"moduleType":"3","params":{"inv.acInVol":227718}}'))).toBe(false);
  expect(isProtobufPayload(Buffer.from(' {"code":"0"}\n'))).toBe(false);
});

test('latestQuotasRequest: the exact request the Android app sends (R§3.6)', () => {
  expect(JSON.parse(latestQuotasRequest(1760780000123))).toEqual({
    from: 'Android', id: '1760780000123', moduleType: 0, operateType: 'latestQuotas', params: {}, version: '1.1',
  });
});
