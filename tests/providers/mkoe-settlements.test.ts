import { describe, it, expect } from 'vitest';
import { mkoeSettlements } from '../../src/main/providers/mkoe/settlements';

describe('mkoeSettlements', () => {
  const list = mkoeSettlements();
  const byLabel = new Map(list.map(s => [s.label, s]));

  it('holds roughly nine hundred settlements', () => {
    expect(list.length).toBeGreaterThanOrEqual(850);
    expect(list.length).toBeLessThanOrEqual(950);
  });
  it('has unique labels without stray spaces', () => {
    expect(new Set(list.map(s => s.label)).size).toBe(list.length);
    for (const s of list) expect(s.label).toBe(s.label.trim());
  });
  it('keeps the three Mykolaiv places apart', () => {
    expect(byLabel.get('м. Миколаїв')?.id).toBe(171);
    expect(byLabel.get('м. Миколаїв (Варварівка)')?.id).toBe(764);
    expect(byLabel.get('м. Миколаїв (Корабельний)')?.id).toBe(696);
  });
  it('adds the дільниця to every Костянтинівка', () => {
    const k = list.filter(s => s.name.trim() === 'Костянтинівка');
    expect(k.length).toBeGreaterThan(1);
    for (const s of k) expect(s.label).toBe(`Костянтинівка (${s.filii})`);
    expect(byLabel.has('Костянтинівка (Арбузинська дільниця)')).toBe(true);
  });
});
