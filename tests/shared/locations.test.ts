import { isAddress, nameProblem, normalizeName, sameAddress } from '../../src/shared/locations';
import { fixtureSnapshot } from '../helpers/snapshot';

test('name rules', () => {
  expect(nameProblem('   ', [])).toBe('Вкажіть назву');
  expect(nameProblem('я'.repeat(25), [])).toBe('Назва — до 24 символів');
  expect(nameProblem('я'.repeat(24), [])).toBeNull();
  expect(nameProblem('  дім ', ['Дім'])).toBe('Така назва вже є');
  expect(nameProblem('Батьки', ['Дім'])).toBeNull();
  expect(normalizeName('  Мамин   дім ')).toBe('Мамин дім');
});

test('isAddress', () => {
  expect(isAddress(fixtureSnapshot().address)).toBe(true);
  expect(isAddress({ ...fixtureSnapshot().address, lineIndex: '1' })).toBe(false);
  expect(isAddress(null)).toBe(false);
});

test('sameAddress compares the six fields and tolerates null', () => {
  const a = fixtureSnapshot().address;
  expect(sameAddress({ ...a }, a)).toBe(true);
  expect(sameAddress({ ...a, house: '41' }, a)).toBe(false);
  expect(sameAddress(null, a)).toBe(false);
  expect(sameAddress(undefined, a)).toBe(false);
});
