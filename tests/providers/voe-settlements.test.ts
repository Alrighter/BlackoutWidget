import { describe, expect, it } from 'vitest';
import { bareName, findSettlement, operatorCity, voeSettlements } from '../../src/main/providers/voe/settlements';

describe('voeSettlements', () => {
  const all = voeSettlements();
  const labels = all.map((s) => s.label);

  it('includes the big towns with the м. prefix', () => {
    for (const l of ['м. Ковель', 'м. Луцьк', 'м. Володимир', 'м. Нововолинськ']) expect(labels).toContain(l);
  });

  it('has roughly the Volyn settlement count', () => {
    expect(all.length).toBeGreaterThan(1000);
    expect(all.length).toBeLessThan(1200);
  });

  it('has unique labels, sorted for Ukrainian', () => {
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'uk')));
  });

  it('adds the district to a label that occurs in several districts', () => {
    expect(labels).toContain('с. Заріччя (Ковельський р-н)');
    expect(labels).toContain('с. Заріччя (Луцький р-н)');
    expect(labels).toContain('с. Заріччя (Володимирський р-н)');
    expect(labels).not.toContain('с. Заріччя');
  });

  it('collapses the same label in the same district into one entry', () => {
    expect(labels.filter((l) => l.startsWith('с. Бубнів'))).toHaveLength(1);
  });

  it('uses с-ще for settlements of category Т and Х', () => {
    expect(labels.some((l) => l.startsWith('с-ще '))).toBe(true);
  });

  it('keeps the post-2020 district without the word район', () => {
    expect(findSettlement('м. Нововолинськ')?.raion).toBe('Володимирський');
    expect(findSettlement('м. Ковель')?.raion).toBe('Ковельський');
  });
});

describe('findSettlement / operatorCity', () => {
  it('finds by label', () => {
    expect(findSettlement('м. Луцьк')?.name).toBe('Луцьк');
    expect(findSettlement('м. Немає такого')).toBeUndefined();
  });

  it('sends the operator name when it differs, else the name', () => {
    expect(operatorCity({ label: 'м. Луцьк', name: 'Луцьк', raion: 'Луцький' })).toBe('Луцьк');
    expect(operatorCity({ label: 'с. Х', name: 'Х', raion: 'Луцький', operatorName: 'Y' })).toBe('Y');
  });
});

describe('bareName', () => {
  it('strips the prefix and the district suffix', () => {
    expect(bareName('с. Липне (Луцький р-н)')).toBe('Липне');
    expect(bareName('м. Ковель')).toBe('Ковель');
    expect(bareName('с-ще Люблинець')).toBe('Люблинець');
  });

  it('leaves a bare name alone', () => {
    expect(bareName('Ковель')).toBe('Ковель');
  });
});
