/** Display names of the schedule sources, shared by the main-process providers and the UI captions. */
export const PROVIDER_NAMES: Record<string, string> = {
  'dtek-krem': 'ДТЕК Київські регіональні електромережі',
};

/** The region each source serves, for the setup wizard's «Регіон / компанія» cards (D4). */
const PROVIDER_REGIONS: Record<string, string> = {
  'dtek-krem': 'Київська область',
};

/** The provider's display name; an unknown id is shown as is. */
export function providerDisplayName(id: string): string {
  return Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id] : id;
}

/** The region the provider serves, if known. */
export function providerRegion(id: string): string | undefined {
  return Object.hasOwn(PROVIDER_REGIONS, id) ? PROVIDER_REGIONS[id] : undefined;
}
