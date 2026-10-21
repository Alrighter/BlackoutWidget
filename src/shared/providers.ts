export interface ProviderInfo {
  /** Display name of the schedule source, for the UI captions. */
  name: string;
  /** The short form used inside sentences («ДТЕК», «Волиньобленерго»). */
  shortName: string;
  /** The region the source serves, for the setup wizard's «Регіон / компанія» cards (D4). */
  region: string;
  /** The page with the company's own schedule, opened from the wizard. */
  siteUrl: string;
  /** Set when the source serves one city only, so the wizard can skip the city step. */
  singleCity?: string;
}

/** Metadata of the schedule sources, shared by the main-process providers and the UI texts. */
export const PROVIDERS: Record<string, ProviderInfo> = {
  'dtek-kem': {
    name: 'ДТЕК Київські електромережі', shortName: 'ДТЕК', region: 'м. Київ',
    siteUrl: 'https://www.dtek-kem.com.ua/ua/shutdowns', singleCity: 'м. Київ',
  },
  'voe': {
    name: 'Волиньобленерго', shortName: 'Волиньобленерго', region: 'Волинська область',
    siteUrl: 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/',
  },
  'dtek-dnem': {
    name: 'ДТЕК Дніпровські електромережі', shortName: 'ДТЕК', region: 'Дніпропетровська область',
    siteUrl: 'https://www.dtek-dnem.com.ua/ua/shutdowns',
  },
  'ztoe': {
    name: 'Житомиробленерго', shortName: 'Житомиробленерго', region: 'Житомирська область',
    siteUrl: 'https://www.ztoe.com.ua/unhooking-search.php',
  },
  'dtek-krem': {
    name: 'ДТЕК Київські регіональні електромережі', shortName: 'ДТЕК', region: 'Київська область',
    siteUrl: 'https://www.dtek-krem.com.ua/ua/shutdowns',
  },
  'loe': {
    name: 'Львівобленерго', shortName: 'Львівобленерго', region: 'Львівська область',
    siteUrl: 'https://poweron.loe.lviv.ua/',
  },
  'mkoe': {
    name: 'Миколаївобленерго', shortName: 'Миколаївобленерго', region: 'Миколаївська область',
    siteUrl: 'https://off.energy.mk.ua/',
  },
  'dtek-oem': {
    name: 'ДТЕК Одеські електромережі', shortName: 'ДТЕК', region: 'Одеська область',
    siteUrl: 'https://www.dtek-oem.com.ua/ua/shutdowns',
  },
  'toe': {
    name: 'Тернопільобленерго', shortName: 'Тернопільобленерго', region: 'Тернопільська область',
    siteUrl: 'https://poweron.toe.com.ua/',
  },
};

const info = (id: string): ProviderInfo | undefined => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : undefined);

/** The provider's display name; an unknown id is shown as is. */
export function providerDisplayName(id: string): string {
  return info(id)?.name ?? id;
}

/** The provider's short name for sentences; an unknown id is shown as is. */
export function providerShortName(id: string): string {
  return info(id)?.shortName ?? id;
}

/** The region the provider serves, if known. */
export function providerRegion(id: string): string | undefined {
  return info(id)?.region;
}

/** The company's own schedule page, if the provider is known. */
export function providerSiteUrl(id: string): string | undefined {
  return info(id)?.siteUrl;
}

/** The only city the provider serves, if it serves just one. */
export function providerSingleCity(id: string): string | undefined {
  return info(id)?.singleCity;
}
