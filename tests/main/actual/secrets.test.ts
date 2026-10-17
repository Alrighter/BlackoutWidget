import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubKeys, SecretStore, SecretsUnavailableError, type Encryptor } from '../../../src/main/actual/secrets';

const reverse = (s: string) => [...s].reverse().join('');
const fakeEnc: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from('enc:' + reverse(s)),
  decryptString: b => reverse(b.toString().slice(4)),
};
const newFile = () => join(mkdtempSync(join(tmpdir(), 'bw-sec-')), 'secrets.json');

test('round trip; file never contains plaintext', () => {
  const file = newFile();
  const st = new SecretStore(file, fakeEnc);
  st.save('ecoflow', { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' });
  expect(st.load('ecoflow')).toEqual({ accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' });
  const raw = readFileSync(file, 'utf8');
  expect(raw).not.toContain('AKEY1234567');
  expect(raw).not.toContain('SECRET-xyz');
});

test('encryption unavailable → throws, writes nothing', () => {
  const file = newFile();
  const st = new SecretStore(file, { ...fakeEnc, isEncryptionAvailable: () => false });
  expect(() => st.save('ecoflow', { a: 'b' })).toThrow(SecretsUnavailableError);
  expect(() => st.save('ecoflow', { a: 'b' })).toThrow('Не вдалося безпечно зберегти ключі на цьому комп’ютері');
  expect(existsSync(file)).toBe(false);
  expect(st.load('ecoflow')).toBeNull();
});

test('undecryptable or missing → null; remove deletes only that source', () => {
  const file = newFile();
  const st = new SecretStore(file, fakeEnc);
  expect(st.load('ecoflow')).toBeNull();
  st.save('ecoflow', { a: '1' });
  st.save('other', { b: '2' });
  const broken = new SecretStore(file, { ...fakeEnc, decryptString: () => { throw new Error('bad'); } });
  expect(broken.load('ecoflow')).toBeNull();
  st.remove('ecoflow');
  expect(st.load('ecoflow')).toBeNull();
  expect(st.load('other')).toEqual({ b: '2' });
  expect(() => st.remove('missing')).not.toThrow();
});

test('encryption unavailable at load time → null', () => {
  const file = newFile();
  new SecretStore(file, fakeEnc).save('ecoflow', { a: '1' });
  expect(new SecretStore(file, { ...fakeEnc, isEncryptionAvailable: () => false }).load('ecoflow')).toBeNull();
});

test('scrubKeys: Secret Key → …, Access Key → its mask; an empty key changes nothing', () => {
  const keys = { accessKey: 'AKEY1234567', secretKey: 'SECRET-xyz' };
  expect(scrubKeys('a=AKEY1234567 s=SECRET-xyz, again AKEY1234567', keys)).toBe('a=AKEY… s=…, again AKEY…');
  expect(scrubKeys('Помилка EcoFlow 9999: nothing here', keys)).toBe('Помилка EcoFlow 9999: nothing here');
  expect(scrubKeys('Помилка EcoFlow', { accessKey: '', secretKey: '' })).toBe('Помилка EcoFlow');
});
