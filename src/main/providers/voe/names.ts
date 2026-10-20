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
