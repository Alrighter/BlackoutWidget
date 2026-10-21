import { uniqueLabels } from '../resolve';
import data from './settlements.data.json';

/** The search pages' district ids: 1 is the city (no settlement column), 2–12 the operator's дільниці. */
export const CVOE_DISTRICTS: Record<number, string> = {
  1: 'ЧЕРНІВЦІ', 2: 'Вижницька', 3: 'Герцаївська', 4: 'Глибоцька', 5: 'Заставнівська', 6: 'Кіцманська',
  7: 'Кельменецька', 8: 'Новоселицька', 9: 'Путильська', 10: 'Сокирянська', 11: 'Сторожинецька', 12: 'Хотинська',
};

interface Row { district: number; name: string }

export interface CvoeSettlement { label: string; district: number; name: string }

function build(): CvoeSettlement[] {
  const rows = data as Row[];
  const labels = uniqueLabels(rows, r => r.name, r => r.district === 1 ? undefined : `${CVOE_DISTRICTS[r.district]} дільниця`);
  return rows
    .map((r, i): CvoeSettlement => ({ label: labels[i], district: r.district, name: r.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk'));
}

let cache: CvoeSettlement[] | undefined;

export function cvoeSettlements(): CvoeSettlement[] {
  return (cache ??= build());
}
