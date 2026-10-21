// The operator mixes Latin look-alike letters into Cyrillic names (the district «Володимирcький» with a Latin c, houses
// «2a» and «12-A») and writes the apostrophe both as U+0027 and U+2019. Every Volyn name comparison goes through here.

const LOOK_ALIKES: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};
const LATIN = /[aceiopxyABCEHIKMOPTXY]/g;
const APOSTROPHES = /['ʼ’]/g;

const cyrillic = (s: string): string => s.trim().replace(LATIN, (ch) => LOOK_ALIKES[ch]);

/** The form two names are compared in: Cyrillic letters, one apostrophe, single spaces, lower case. Never shown. */
export function nameKey(s: string): string {
  return cyrillic(s).replace(/\s+/g, ' ').replace(APOSTROPHES, '’').toLowerCase();
}

export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

/** A house number in its one shown form, Cyrillic upper case without the hyphen: «12-A», «12-а» and «12А» are «12А». */
export function normHouse(s: string): string {
  return cyrillic(s).toUpperCase().replace(/(\d)-(?=\p{L})/gu, '$1');
}

const QUOTES = /["'«»“”„’ʼ]/g;

/**
 * The key two spellings of one house share: «буд.»/«сад.» dropped, Cyrillic upper case, no quotes, no separator between a
 * digit and a letter («16-А», «16 а», «16.А» are «16А»), no spaces. «/» and the other hyphens stay: «9/9», «9-9», «ТП-334».
 * Never shown.
 */
export function houseKey(s: string): string {
  const bare = s.replace(/^\s*(?:буд|сад)(?:\.|\s+|(?=\d)|$)/iu, '');
  return cyrillic(bare).toUpperCase()
    .replace(QUOTES, '')
    .replace(/(\d)[\s\-._,]+(?=\p{L})/gu, '$1')
    .replace(/\s+/g, '');
}
