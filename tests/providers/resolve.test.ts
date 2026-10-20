import { AddressNotFoundError, addressNotFound, resolveByLabel, uniqueLabels } from '../../src/main/providers/resolve';
import { ProviderError } from '../../src/main/providers/types';

interface It { id: number; name: string; g: string }
const LIST: It[] = [
  { id: 1, name: 'Ланівці', g: 'Лановецька' },
  { id: 2, name: 'Ланівці', g: 'Борщівська' },
  { id: 3, name: 'Збараж', g: 'Збаразька' },
];
const name = (t: It) => t.name;
const group = (t: It) => `${t.g} громада`;
const NOT_FOUND = 'Адресу не знайдено у Тернопільобленерго — оберіть її в налаштуваннях заново';

test('a shared name gets its group, a unique name stays bare', () => {
  expect(uniqueLabels(LIST, name, group)).toEqual([
    'Ланівці (Лановецька громада)', 'Ланівці (Борщівська громада)', 'Збараж',
  ]);
});
test('a label still repeated is numbered in list order', () => {
  const items = [{ n: ' Вишневе ' }, { n: 'Вишневе' }, { n: 'Вишневе' }];
  expect(uniqueLabels(items, t => t.n, () => undefined)).toEqual(['Вишневе', 'Вишневе (2)', 'Вишневе (3)']);
});
test('same group twice: group suffix, then numbers', () => {
  const items = [{ n: 'А', g: 'Х' }, { n: 'А', g: 'Х' }];
  expect(uniqueLabels(items, t => t.n, t => t.g)).toEqual(['А (Х)', 'А (Х) (2)']);
});
test('labels are index-aligned and a look-alike counts as the same name', () => {
  const items = [{ n: 'Cелo' }, { n: 'Село' }];
  expect(uniqueLabels(items, t => t.n, () => 'Р')).toEqual(['Cелo (Р)', 'Село (Р)']);
});

const labels = uniqueLabels(LIST, name, group);
const resolve = (label: string, list = LIST, ls = labels) => resolveByLabel(list, ls, label, name, group, 'Тернопільобленерго');

test('the exact label picks the item', () => {
  expect(resolve('Ланівці (Борщівська громада)').id).toBe(2);
  expect(resolve('Збараж').id).toBe(3);
});
test('a bare namesake that is now ambiguous is not found', () => {
  expect(() => resolve('Ланівці')).toThrow(AddressNotFoundError);
  expect(() => resolve('Ланівці')).toThrow(NOT_FOUND);
});
test('a label saved with a group still resolves when the name is now unique', () => {
  expect(resolve('Збараж (Збаразька громада)').id).toBe(3);
});
test('an apostrophe or look-alike difference still resolves', () => {
  const items = [{ id: 7, name: 'Мар’янівка' }, { id: 8, name: 'Інше' }];
  const ls = ['Мар’янівка', 'Інше'];
  const r = (l: string) => resolveByLabel(items, ls, l, t => t.name, () => undefined, 'Х').id;
  expect(r("Мар'янівка")).toBe(7);
  expect(r('Iнше')).toBe(8); // Latin I
  expect(resolve('Збаpаж').id).toBe(3); // Latin p
});
test('unknown or two exact matches is not found', () => {
  expect(() => resolve('Тернопіль')).toThrow(AddressNotFoundError);
  expect(() => resolveByLabel(LIST, ['x', 'x', 'y'], 'x', name, group, 'Х')).toThrow(AddressNotFoundError);
});
test('addressNotFound is a ProviderError with the copy', () => {
  const e = addressNotFound('Тернопільобленерго');
  expect(e).toBeInstanceOf(ProviderError);
  expect(e.message).toBe(NOT_FOUND);
});
test('a saved group that no longer exists does not resolve to the namesake', () => {
  const only = [LIST[1]];
  expect(() => resolve('Ланівці (Лановецька громада)', only, uniqueLabels(only, name, group))).toThrow(AddressNotFoundError);
});
test('a saved group that matches the only item resolves', () => {
  const only = [LIST[2]];
  expect(resolve('Збараж (Збаразька громада)', only, uniqueLabels(only, name, group)).id).toBe(3);
});
test('a numeric suffix never matches in rule 2', () => {
  const items = [{ n: 'вул. Шевченка' }];
  expect(() => resolveByLabel(items, ['вул. Шевченка'], 'вул. Шевченка (2)', t => t.n, () => undefined, 'Х')).toThrow(AddressNotFoundError);
});
