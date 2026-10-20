import { nameKey } from './names';
import { ProviderError } from './types';

export class AddressNotFoundError extends ProviderError {}

export function addressNotFound(name: string): AddressNotFoundError {
  return new AddressNotFoundError(`Адресу не знайдено у ${name} — оберіть її в налаштуваннях заново`);
}

/** Labels in list order: the trimmed name; a name shared (nameKey) by several items gets ` (${group})`; a label still repeated gets ` (2)`, ` (3)`… in list order. */
export function uniqueLabels<T>(items: readonly T[], name: (t: T) => string, group: (t: T) => string | undefined): string[] {
  const keyCount = new Map<string, number>();
  for (const t of items) {
    const k = nameKey(name(t));
    keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const labels = items.map(t => {
    const base = name(t).trim();
    const g = group(t)?.trim();
    return keyCount.get(nameKey(base))! > 1 && g ? `${base} (${g})` : base;
  });
  const seen = new Map<string, number>();
  return labels.map(l => {
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return n > 1 ? `${l} (${n})` : l;
  });
}

/** The spec's rule: the exact label; else the only item whose name (nameKey) equals the label or the label minus a trailing « (…)»; else AddressNotFoundError. */
export function resolveByLabel<T>(
  items: readonly T[], labels: readonly string[], label: string, name: (t: T) => string, company: string,
): T {
  const exact = items.filter((_, i) => labels[i] === label);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw addressNotFound(company);
  const keys = new Set([nameKey(label), nameKey(label.replace(/\s*\([^()]*\)\s*$/, ''))]);
  const byName = items.filter(t => keys.has(nameKey(name(t))));
  if (byName.length === 1) return byName[0];
  throw addressNotFound(company);
}
