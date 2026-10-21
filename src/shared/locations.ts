import type { Address, WidgetStyle } from './types';

export const MAX_LOCATIONS = 5, NAME_MAX = 24, HOME_ID = 'home', HOME_NAME = 'Дім';
export const NAME_EMPTY = 'Вкажіть назву', NAME_LONG = 'Назва — до 24 символів', NAME_TAKEN = 'Така назва вже є';
export const LIMIT_TEXT = 'Можна додати до 5 адрес', LAST_LOCATION = 'Останню адресу видалити не можна', UNKNOWN_LOCATION = 'Цієї адреси вже немає';

export interface LocationInput { name: string; address: Address; widgetStyle: WidgetStyle }

export function normalizeName(name: string): string { return name.trim().replace(/\s+/g, ' '); }

const key = (name: string): string => normalizeName(name).toLowerCase();

/** Why this name cannot be used, or null. `taken` is the other locations' names (compared normalized, ignoring case). */
export function nameProblem(name: string, taken: string[]): string | null {
  const n = normalizeName(name);
  if (!n) return NAME_EMPTY;
  if ([...n].length > NAME_MAX) return NAME_LONG;
  return taken.some(t => key(t) === key(n)) ? NAME_TAKEN : null;
}

export function sameAddress(a: Address | null | undefined, b: Address): boolean {
  return !!a && a.providerId === b.providerId && a.city === b.city && a.street === b.street
    && a.house === b.house && a.lineIndex === b.lineIndex && a.groupId === b.groupId;
}

export function isAddress(v: unknown): v is Address {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return ['providerId', 'city', 'street', 'house', 'groupId'].every(k => typeof a[k] === 'string') && Number.isInteger(a.lineIndex);
}
