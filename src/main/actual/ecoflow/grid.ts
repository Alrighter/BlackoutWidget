export const GRID_MIN_VOLTS = 50, MAX_SANE_VOLTS = 300, GRID_MIN_HZ = 40;

export type GridVerdict =
  | { power: 'on' | 'off'; detail: string }
  | { power: 'unknown'; reason: string; unsupported: boolean };

type Quota = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// First field of the list that holds a usable value; a missing field is never 0.
function pick<T>(quota: Quota, keys: string[], read: (v: unknown, key: string) => T | null): T | null {
  for (const k of keys) {
    const r = read(quota[k], k);
    if (r !== null) return r;
  }
  return null;
}

const volts = (v: unknown, key: string): number | null => {
  const n = num(v);
  if (n === null) return null;
  const x = key === 'inv.acInVol' ? n / 1000 : n;
  return x >= 0 && x <= MAX_SANE_VOLTS ? x : null;
};
const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};
// 0 < Hz < 40 is neither a grid nor a clean zero: skip the field.
const freq = (v: unknown): number | null => {
  const n = nonNegative(v);
  return n !== null && (n === 0 || n >= GRID_MIN_HZ) ? n : null;
};
const flag = (v: unknown): boolean | null => {
  if (typeof v === 'boolean') return v;
  return v === 1 ? true : v === 0 ? false : null;
};

export function detectGrid(quota: Quota): GridVerdict {
  const v = pick(quota, ['inv.acInVol', 'plugInInfoAcInVol', 'hs_yj751_pd_backend_addr.inAcC20Vol'], volts);
  const hz = pick(quota, ['inv.acInFreq', 'plugInInfoAcInFeq'], freq);
  if (v !== null) {
    if (v >= GRID_MIN_VOLTS) return { power: 'on', detail: `на вході ${Math.round(v)} В` };
    // Ruling R13: a grid frequency next to "no voltage" is a conflict, never off (the mV unit of inv.acInVol is
    // unconfirmed on some firmware: volts read as mV would be 0.23 V forever).
    if (hz !== null && hz >= GRID_MIN_HZ) return { power: 'unknown', reason: 'покази суперечать одне одному', unsupported: false };
    return { power: 'off', detail: `на вході ${Math.round(v)} В` };
  }

  if (hz !== null) return { power: hz >= GRID_MIN_HZ ? 'on' : 'off', detail: `на вході ${Math.round(hz)} Гц` };

  const f = pick(quota, ['plugInInfoAcInFlag'], flag);
  if (f !== null) return { power: f ? 'on' : 'off', detail: f ? 'вхід AC підключено' : 'вхід AC не підключено' };

  const w = pick(quota, ['inv.inputWatts', 'powGetAcIn', 'hs_yj751_pd_appshow_addr.inAcC20Pwr'], nonNegative);
  if (w !== null) {
    return w > 0
      ? { power: 'on', detail: `на вході ${Math.round(w)} Вт` }
      : { power: 'unknown', reason: 'не вдається визначити', unsupported: false };
  }
  return { power: 'unknown', reason: 'модель поки не підтримується', unsupported: true };
}
