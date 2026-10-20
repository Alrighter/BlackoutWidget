import { nameKey } from '../names';
import data from './settlements.json';

type Kind = 'м' | 'с-ще' | 'с';

interface Entry { name: string; kind: Kind; raion: string; operatorName?: string }

export interface VoeSettlement { label: string; name: string; raion: string; operatorName?: string }

const PREFIX: Record<Kind, string> = { 'м': 'м.', 'с-ще': 'с-ще', 'с': 'с.' };

const baseLabel = (e: Entry): string => `${PREFIX[e.kind]} ${e.name}`;

function build(): VoeSettlement[] {
  const unique = new Map<string, Entry>();
  for (const e of data as Entry[]) unique.set(`${baseLabel(e)}|${e.raion}`, e);
  const entries = [...unique.values()];
  const count = new Map<string, number>();
  for (const e of entries) count.set(baseLabel(e), (count.get(baseLabel(e)) ?? 0) + 1);
  return entries
    .map((e): VoeSettlement => {
      const base = baseLabel(e);
      const s: VoeSettlement = {
        label: (count.get(base) ?? 0) > 1 ? `${base} (${e.raion} р-н)` : base,
        name: e.name,
        raion: e.raion,
      };
      if (e.operatorName) s.operatorName = e.operatorName;
      return s;
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'uk'));
}

let cache: VoeSettlement[] | undefined;

export function voeSettlements(): VoeSettlement[] {
  return (cache ??= build());
}

export function findSettlement(label: string): VoeSettlement | undefined {
  return voeSettlements().find((s) => s.label === label);
}

let districtsByName: Map<string, Set<string>> | undefined;

/**
 * Whether the operator knows this settlement's name in another district too. The forms take the name alone, so only
 * the district tells such places apart — also when the labels differ by kind alone («с. Луків» and «с-ще Луків»).
 */
export function hasNamesake(s: VoeSettlement): boolean {
  if (!districtsByName) {
    districtsByName = new Map();
    for (const o of voeSettlements()) {
      const key = nameKey(operatorCity(o));
      districtsByName.set(key, (districtsByName.get(key) ?? new Set()).add(nameKey(o.raion)));
    }
  }
  return (districtsByName.get(nameKey(operatorCity(s)))?.size ?? 0) > 1;
}

const RAION_SUFFIX = /\s*\([^()]*р-н\)\s*$/;

/** The settlement name without the «м.» / «с.» / «с-ще» prefix and the « (… р-н)» suffix. */
export function bareName(label: string): string {
  return label.replace(RAION_SUFFIX, '').replace(/^(?:м\.|с-ще|с\.)\s+/, '').trim();
}

export function operatorCity(s: VoeSettlement): string {
  return s.operatorName ?? s.name;
}
