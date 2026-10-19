'use strict';
// Spike: passive 15 s scan for EcoFlow adverts (company id 0xB5B5). Prints the SN prefix only.
const { withBindings } = require('@stoprocent/noble');
const noble = withBindings('default');
const seen = new Map();
(async () => {
  await noble.waitForPoweredOnAsync();
  noble.on('discover', p => {
    const md = p.advertisement.manufacturerData;
    if (!md || md.length < 25 || md.readUInt16LE(0) !== 0xb5b5) return;
    const d = md.subarray(2);
    const sn = d.subarray(1, 17).toString('ascii');
    const key = p.id;
    const info = {
      id: p.id, address: p.address, rssi: p.rssi, name: p.advertisement.localName,
      proto: d[0], snPrefix: sn.slice(0, 4), snLen: sn.replace(/\0+$/, '').length, soc: d[17], productType: d[18],
      flags: '0x' + d[22].toString(16), encryptType: (d[22] & 0x38) >> 3, connectable: p.connectable,
      services: p.advertisement.serviceUuids,
    };
    if (!seen.has(key)) console.log(JSON.stringify(info));
    seen.set(key, info);
  });
  await noble.startScanningAsync([], true);
  setTimeout(async () => { await noble.stopScanningAsync(); console.log(`done: ${seen.size} EcoFlow device(s)`); noble.stop(); process.exit(0); }, 15000);
})().catch(e => { console.error(e); process.exit(1); });
