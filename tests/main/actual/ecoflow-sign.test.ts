import { flattenParams, hmacHex, signString } from '../../../src/main/actual/ecoflow/sign';

test('documented golden vector', () => {
  const s = signString({ sn: '123456789', params: { cmdSet: 11, id: 24, eps: 0 } }, 'Fp4SvIprYSDPXtYJidEtUAd1o', '345164', '1671171709428');
  expect(s).toBe('params.cmdSet=11&params.eps=0&params.id=24&sn=123456789&accessKey=Fp4SvIprYSDPXtYJidEtUAd1o&nonce=345164&timestamp=1671171709428');
  expect(hmacHex(s, 'WIbFEKre0s6sLnh4ei7SPUeYnptHG6V')).toBe('07c13b65e037faf3b153d51613638fa80003c4c38d2407379a7f52851af1473e');
});
test('flattens arrays and objects in arrays, sorted', () => {
  expect(flattenParams({ name: 'demo1', ids: [1, 2, 3], deviceInfo: { id: 1 }, deviceList: [{ id: 1 }, { id: 2 }] }))
    .toBe('deviceInfo.id=1&deviceList[0].id=1&deviceList[1].id=2&ids[0]=1&ids[1]=2&ids[2]=3&name=demo1');
});
test('booleans lowercase; no params → only the key part', () => {
  expect(flattenParams({ b: true, a: false })).toBe('a=false&b=true');
  expect(signString(undefined, 'AK', '000001', '5')).toBe('accessKey=AK&nonce=000001&timestamp=5');
});
