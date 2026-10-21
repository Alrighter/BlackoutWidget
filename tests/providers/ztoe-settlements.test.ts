import { describe, it, expect } from 'vitest';
import { ztoeSettlements } from '../../src/main/providers/ztoe/settlements';

describe('ztoeSettlements', () => {
  const list = ztoeSettlements();
  const byLabel = new Map(list.map(s => [s.label, s]));

  it('holds roughly 1,750 settlements', () => {
    expect(list.length).toBeGreaterThanOrEqual(1700);
    expect(list.length).toBeLessThanOrEqual(1800);
  });
  it('has unique labels, without entities or outer spaces', () => {
    expect(new Set(list.map(s => s.label)).size).toBe(list.length);
    for (const s of list) {
      expect(s.label).not.toContain('&#');
      expect(s.label).toBe(s.label.trim());
    }
  });
  it('is sorted by label', () => {
    const labels = list.map(s => s.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'uk')));
  });
  it('has the city of Zhytomyr', () => {
    expect(byLabel.get('місто Житомир')).toMatchObject({ id: 16657, remId: 7 });
  });
  it('tells the two Андрушівка apart by their РЕМ', () => {
    const a = byLabel.get('місто Андрушівка (Андрушівський РЕМ)');
    const b = byLabel.get('місто Андрушівка (Попільнянський РЕМ)');
    expect(a?.remId).toBe(1);
    expect(b?.remId).toBe(19);
    expect(a?.id).not.toBe(b?.id);
  });
});
