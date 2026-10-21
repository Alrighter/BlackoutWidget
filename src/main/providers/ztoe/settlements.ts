import { labeled } from '../resolve';
import data from './settlements.data.json';

interface Row { id: number; name: string; remId: number; rem: string }

export interface ZtoeSettlement { label: string; id: number; name: string; remId: number; rem: string }

function build(): ZtoeSettlement[] {
  // 140 names repeat across РЕМ («місто Андрушівка»): the РЕМ is the label's group, so a label follows its record.
  const { items, labels } = labeled(data as Row[], r => r.name, r => `${r.rem} РЕМ`);
  return items
    .map((r, i): ZtoeSettlement => ({ label: labels[i], id: r.id, name: r.name, remId: r.remId, rem: r.rem }))
    .sort((a, b) => a.label.localeCompare(b.label, 'uk'));
}

let cache: ZtoeSettlement[] | undefined;

export function ztoeSettlements(): ZtoeSettlement[] {
  return (cache ??= build());
}
