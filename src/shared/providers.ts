/** Display names of the schedule sources, shared by the main-process providers and the UI captions. */
export const PROVIDER_NAMES: Record<string, string> = {
  'dtek-krem': 'ДТЕК Київські регіональні електромережі',
};

/** The provider's display name; an unknown id is shown as is. */
export function providerDisplayName(id: string): string {
  return Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id] : id;
}
