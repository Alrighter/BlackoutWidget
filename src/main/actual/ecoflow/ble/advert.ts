/**
 * An EcoFlow BLE advertisement's manufacturer data (company id 0xB5B5), per rabits/ha-ef-ble devicebase.py at 1c1eb33
 * and the bledash-esp32 notes (research §2.1): after the company id, a protocol byte, the 16-char SN, the SoC % on the
 * RIVER 2 family, the product type, then a capability byte whose bits 3–5 are the encrypt type.
 */
export const ECOFLOW_COMPANY_ID = 0xb5b5;

export interface EcoflowAdvert { sn: string; soc: number; encryptType: number; flags: number }

/** `data`: the manufacturer data with its 2-byte company id first, as Bluetooth stacks report it. */
export function parseAdvert(data: Uint8Array | undefined): EcoflowAdvert | null {
  if (!data || data.length < 25) return null;
  const b = Buffer.from(data);
  if (b.readUInt16LE(0) !== ECOFLOW_COMPANY_ID) return null;
  const sn = b.subarray(3, 19).toString('ascii').replace(/\0+$/, '');
  if (!/^[A-Za-z0-9]{1,16}$/.test(sn)) return null;
  const flags = b[24];
  return { sn, soc: b[19], encryptType: (flags >> 3) & 0x07, flags };
}
