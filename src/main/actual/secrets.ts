import { JsonStore } from '../store';

/** Log-safe form of an Access Key: first 4 characters + ellipsis. */
export function maskKey(key: string): string {
  return key.length < 5 ? '…' : `${key.slice(0, 4)}…`;
}

export interface Encryptor { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }

export class SecretsUnavailableError extends Error {
  constructor() {
    super('Не вдалося безпечно зберегти ключі на цьому комп’ютері');
    this.name = 'SecretsUnavailableError';
  }
}

/** `{ [sourceId]: base64(encrypt(JSON(secrets))) }` on disk; plaintext never touches it. */
export class SecretStore {
  private readonly file: JsonStore<Record<string, string>>;

  constructor(filePath: string, private readonly enc: Encryptor) {
    this.file = new JsonStore<Record<string, string>>(filePath, {});
  }

  save(sourceId: string, secrets: Record<string, string>): void {
    if (!this.enc.isEncryptionAvailable()) throw new SecretsUnavailableError();
    const blob = this.enc.encryptString(JSON.stringify(secrets)).toString('base64');
    this.file.write({ ...this.file.read(), [sourceId]: blob });
  }

  load(sourceId: string): Record<string, string> | null {
    try {
      if (!this.enc.isEncryptionAvailable()) return null;
      const blob = this.file.read()[sourceId];
      if (typeof blob !== 'string') return null;
      const parsed: unknown = JSON.parse(this.enc.decryptString(Buffer.from(blob, 'base64')));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : null;
    } catch {
      return null;
    }
  }

  remove(sourceId: string): void {
    const all = this.file.read();
    if (!(sourceId in all)) return;
    delete all[sourceId];
    this.file.write(all);
  }
}
