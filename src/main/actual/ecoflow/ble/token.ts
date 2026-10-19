import { createHash } from 'node:crypto';

/**
 * The BLE auth payload: the uppercase hex of MD5(userId + SN), 32 ASCII characters (ha-ef-ble connection.py, Apache
 * License 2.0). Kept apart from crypto.ts so main can import it without pulling in the ESM-only @noble/curves.
 */
export function authToken(userId: string, sn: string): string {
  return createHash('md5').update(Buffer.from(userId + sn, 'ascii')).digest('hex').toUpperCase();
}
