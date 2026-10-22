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

/**
 * The spec's rule: the exact label; else the only item accepted by (a) its name equals the whole label, or (b) the label is
 * «name (group)» with that item's name and group; a numeric « (2)» suffix never matches; else AddressNotFoundError.
 */
export function resolveByLabel<T>(
  items: readonly T[], labels: readonly string[], label: string,
  name: (t: T) => string, group: (t: T) => string | undefined, company: string,
): T {
  const exact = items.filter((_, i) => labels[i] === label);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw addressNotFound(company);
  const whole = nameKey(label);
  const m = /^(.*\S)\s+\(([^()]*)\)\s*$/.exec(label.trim());
  const bare = m && !/^\d+$/.test(m[2].trim()) ? { name: nameKey(m[1]), group: nameKey(m[2]) } : undefined;
  const accepted = items.filter(t => {
    const n = nameKey(name(t));
    if (n === whole) return true;
    const g = group(t)?.trim();
    return !!bare && !!g && n === bare.name && nameKey(g) === bare.group;
  });
  if (accepted.length === 1) return accepted[0];
  throw addressNotFound(company);
}

export const noGroup = (): undefined => undefined;

/** Labels in localeCompare 'uk' order, for a picker. */
export const sortedLabels = (labels: readonly string[]): string[] => [...labels].sort((a, b) => a.localeCompare(b, 'uk'));

/**
 * A list with its labels, index-aligned as `resolveByLabel` needs, in id order: the « (2)» of a repeated label then
 * follows the record, so a saved label never moves to a namesake when the API lists them in another order.
 */
export interface Labeled<T> { items: T[]; labels: string[] }

/** Items in id order (a « (2)» follows its record) with their uniqueLabels; `group` defaults to noGroup. */
export function labeled<T extends { id: number }>(
  items: readonly T[], name: (t: T) => string, group: (t: T) => string | undefined = noGroup,
): Labeled<T> {
  const byId = [...items].sort((a, b) => a.id - b.id);
  return { items: byId, labels: uniqueLabels(byId, name, group) };
}
