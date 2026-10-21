import { describe, it, expect } from 'vitest';
import { houseKey, nameWords } from '../../src/main/providers/names';

describe('houseKey', () => {
  it.each([
    ['буд. 12-А', '12А'],
    ['12 а', '12А'],
    ['12.А', '12А'],
    ['12,А', '12А'],
    ['12 "Б"', '12Б'],
    ['50A', '50А'],
    ['108/56-а', '108/56А'],
  ])('maps %j to %j', (input, key) => {
    expect(houseKey(input)).toBe(key);
  });

  it('gives «16-А» and «16А» one key', () => {
    expect(houseKey('16-А')).toBe(houseKey('16А'));
  });

  it.each(['9/9', '9-9', '74/А', 'ТП-334', '001'])('keeps %j as it is', (s) => {
    expect(houseKey(s)).toBe(s);
  });
});

describe('nameWords', () => {
  it('keeps numbers and drops the ending after one', () => {
    expect(nameWords('1-й пров. Андріївський')).toEqual(['1', 'пров', 'андріївський']);
    expect(nameWords('вул. Шевченка')).toEqual(['вул', 'шевченка']);
  });
});
