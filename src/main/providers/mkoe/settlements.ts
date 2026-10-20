import { uniqueLabels } from '../resolve';
import data from './settlements.data.json';

interface Row { id: number; name: string; filiiId: number; filii: string }

export interface MkoeSettlement { label: string; id: number; name: string; filii: string }

function build(): MkoeSettlement[] {
  // By numeric id first, so the « (2)» numbering never depends on the order the operator lists them in.
  const rows = [...(data as Row[])].sort((a, b) => a.id - b.id);
  const labels = uniqueLabels(rows, r => r.name, r => r.filii);
  return rows
    .map((r, i): MkoeSettlement => ({ label: labels[i], id: r.id, name: r.name, filii: r.filii }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk'));
}

let cache: MkoeSettlement[] | undefined;

export function mkoeSettlements(): MkoeSettlement[] {
  return (cache ??= build());
}
