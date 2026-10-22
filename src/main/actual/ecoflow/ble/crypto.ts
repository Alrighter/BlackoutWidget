import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { ecdh, weierstrass } from '@noble/curves/abstract/weierstrass.js';
import { KEY_TABLE_B64 } from './keydata';

/**
 * The EcoFlow BLE session for encrypt type 7, ported from rabits/ha-ef-ble at 1c1eb33 (connection.py, encryption.py;
 * Apache License 2.0): an ECDH exchange on secp160r1, AES-128-CBC keyed by the shared secret, then a session key
 * derived from the device's seed and sRand through the vendor key table (research §2.3).
 *
 * Electron's BoringSSL has no secp160r1 (crypto.getCurves() lacks it), hence @noble/curves.
 */

// SEC 2 v1.0 §2.4.2. The order is 161 bits, one more than p.
const secp160r1 = weierstrass({
  p: 0xffffffffffffffffffffffffffffffff7fffffffn,
  a: 0xffffffffffffffffffffffffffffffff7ffffffcn,
  b: 0x1c97befc54bd7a8b65acf89f81d4d4adc565fa45n,
  Gx: 0x4a96b5688ef573284664698968c38bb913cbfc82n,
  Gy: 0x23a628553168947d59dcc912042351377ac5fb32n,
  n: 0x0100000000000000000001f4c8f927aed3ca752257n,
  h: 1n,
});
const dh = ecdh(secp160r1);

const md5 = (data: Uint8Array): Buffer => createHash('md5').update(data).digest();

export interface EphemeralKey { secretKey: Uint8Array; /** X‖Y, 20 bytes each, as the device expects it. */ publicKey: Buffer }

export function newEphemeralKey(): EphemeralKey {
  const { secretKey, publicKey } = dh.keygen();
  // keygen returns the compressed point; the device takes the raw coordinates.
  return { secretKey, publicKey: Buffer.from(secp160r1.fromBytes(publicKey).toBytes(false).subarray(1)) };
}

/** The 20-byte X coordinate of the shared point; `devicePublicKey` is the device's raw X‖Y. */
export function sharedSecret(secretKey: Uint8Array, devicePublicKey: Uint8Array): Buffer {
  if (devicePublicKey.length !== 40) throw new Error(`device public key is ${devicePublicKey.length} bytes, need 40`);
  const shared = dh.getSharedSecret(secretKey, Buffer.concat([Buffer.from([0x04]), devicePublicKey]), false);
  return Buffer.from(shared.subarray(1, 21));
}

/** AES-128-CBC with a fixed IV per session: each message is encrypted on its own, PKCS#7-padded. */
export class SessionCipher {
  constructor(readonly key: Buffer, readonly iv: Buffer) {}

  /** The handshake's first cipher: key = the shared secret's first 16 bytes, iv = MD5 of the whole secret. */
  static fromShared(shared: Buffer): SessionCipher {
    return new SessionCipher(shared.subarray(0, 16), md5(shared));
  }

  encrypt(plain: Uint8Array): Buffer {
    const c = createCipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([c.update(plain), c.final()]);
  }

  /** Like the firmware: whole blocks only, and the padding is stripped only when it is valid PKCS#7. */
  decrypt(data: Uint8Array): Buffer {
    const aligned = data.length - (data.length % 16);
    if (aligned === 0) return Buffer.from(data);
    const d = createDecipheriv('aes-128-cbc', this.key, this.iv).setAutoPadding(false);
    const out = Buffer.concat([d.update(data.subarray(0, aligned)), d.final()]);
    const pad = out[out.length - 1];
    const valid = pad >= 1 && pad <= 16 && out.subarray(out.length - pad).every(v => v === pad);
    return valid ? out.subarray(0, out.length - pad) : out;
  }
}

let keyTable: Buffer | undefined;

/** MD5 of 16 table bytes picked by the seed, then the 16 bytes of sRand (connection.py `_gen_session_key`). */
export function sessionKey(seed: Uint8Array, sRand: Uint8Array): Buffer {
  keyTable ??= Buffer.from(KEY_TABLE_B64, 'base64');
  const pos = seed[0] * 0x10 + ((seed[1] - 1) & 0xff) * 0x100;
  if (seed.length < 2 || sRand.length < 16 || pos + 16 > keyTable.length) throw new Error('bad session key material');
  return md5(Buffer.concat([keyTable.subarray(pos, pos + 16), sRand.subarray(0, 16)]));
}
