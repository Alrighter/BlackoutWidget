import { PROVIDERS, providerShortName, providerSingleCity, providerSiteUrl } from '../../src/shared/providers';

test('the ten providers carry exactly the agreed metadata', () => {
  expect(PROVIDERS).toEqual({
    'dtek-kem': { name: 'ДТЕК Київські електромережі', shortName: 'ДТЕК', region: 'м. Київ', siteUrl: 'https://www.dtek-kem.com.ua/ua/shutdowns', singleCity: 'м. Київ' },
    'voe': { name: 'Волиньобленерго', shortName: 'Волиньобленерго', region: 'Волинська область', siteUrl: 'https://energy.volyn.ua/spozhyvacham/perervy-u-elektropostachanni/hrafik-vidkliuchen/' },
    'dtek-dnem': { name: 'ДТЕК Дніпровські електромережі', shortName: 'ДТЕК', region: 'Дніпропетровська область', siteUrl: 'https://www.dtek-dnem.com.ua/ua/shutdowns' },
    'ztoe': { name: 'Житомиробленерго', shortName: 'Житомиробленерго', region: 'Житомирська область', siteUrl: 'https://www.ztoe.com.ua/unhooking-search.php' },
    'dtek-krem': { name: 'ДТЕК Київські регіональні електромережі', shortName: 'ДТЕК', region: 'Київська область', siteUrl: 'https://www.dtek-krem.com.ua/ua/shutdowns' },
    'loe': { name: 'Львівобленерго', shortName: 'Львівобленерго', region: 'Львівська область', siteUrl: 'https://poweron.loe.lviv.ua/' },
    'mkoe': { name: 'Миколаївобленерго', shortName: 'Миколаївобленерго', region: 'Миколаївська область', siteUrl: 'https://off.energy.mk.ua/' },
    'dtek-oem': { name: 'ДТЕК Одеські електромережі', shortName: 'ДТЕК', region: 'Одеська область', siteUrl: 'https://www.dtek-oem.com.ua/ua/shutdowns' },
    'toe': { name: 'Тернопільобленерго', shortName: 'Тернопільобленерго', region: 'Тернопільська область', siteUrl: 'https://poweron.toe.com.ua/' },
    'cvoe': { name: 'Чернівціобленерго', shortName: 'Чернівціобленерго', region: 'Чернівецька область', siteUrl: 'https://oblenergo.cv.ua/shutdowns/' },
  });
});

test('short name falls back to the id; site url and single city are undefined for an unknown id', () => {
  expect(providerShortName('x')).toBe('x');
  expect(providerShortName('toString')).toBe('toString');
  expect(providerSiteUrl('x')).toBeUndefined();
  expect(providerSiteUrl('toString')).toBeUndefined();
  expect(providerSingleCity('x')).toBeUndefined();
  expect(providerSingleCity('dtek-kem')).toBe('м. Київ');
  expect(providerSingleCity('voe')).toBeUndefined();
});
