import { describe, it, expect } from 'vitest';
import { cvoeSettlements, CVOE_DISTRICTS } from '../../src/main/providers/cvoe/settlements';
import { nameKey } from '../../src/main/providers/names';

describe('cvoeSettlements', () => {
  const list = cvoeSettlements();

  it('holds roughly 440 settlements', () => {
    expect(list.length).toBeGreaterThanOrEqual(400);
    expect(list.length).toBeLessThanOrEqual(650);
  });
  it('has unique labels without outer or double spaces', () => {
    expect(new Set(list.map(s => s.label)).size).toBe(list.length);
    for (const s of list) {
      expect(s.label).toBe(s.label.trim());
      expect(s.label).not.toMatch(/\s{2,}/);
    }
  });
  it('is sorted by label', () => {
    const labels = list.map(s => s.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'uk')));
  });
  it('names the 12 districts', () => {
    expect(Object.keys(CVOE_DISTRICTS)).toHaveLength(12);
    expect(CVOE_DISTRICTS[1]).toBe('ЧЕРНІВЦІ');
    expect(CVOE_DISTRICTS[8]).toBe('Новоселицька');
  });
  it('has the city once, in district 1', () => {
    const city = list.filter(s => s.label === 'м. Чернівці');
    expect(city).toHaveLength(1);
    expect(city[0].district).toBe(1);
    expect(list.filter(s => s.district === 1)).toHaveLength(1);
  });
  it('tells the two Остриця apart by their district', () => {
    const hits = list.filter(s => nameKey(s.name) === nameKey('с. Остриця'));
    expect(hits.map(s => s.district).sort((a, b) => a - b)).toEqual([3, 8]);
    expect(hits.map(s => s.label).sort()).toEqual([
      'с. Остриця (Герцаївська дільниця)',
      'с. Остриця (Новоселицька дільниця)',
    ].sort());
  });
  it('has no two entries of one district with the same nameKey', () => {
    const seen = new Set<string>();
    for (const s of list) {
      const k = `${s.district}|${nameKey(s.name)}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});
