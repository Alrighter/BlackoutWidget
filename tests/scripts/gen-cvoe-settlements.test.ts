// The Chernivtsi generator groups each district's rows by its own copy of settlementKey (R11). The copy must agree with
// src/main/providers/cvoe/parse.ts, and a settlement is shown as its spelling with the most rows. Importing the script
// neither fetches nor writes.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { settlementKey } from '../../src/main/providers/cvoe/parse';
import { cvoeSettlements } from '../../src/main/providers/cvoe/settlements';

interface Gen {
  settlementKey(name: string): string;
  districtSettlements(names: string[]): string[];
}

const SCRIPT = pathToFileURL(join(__dirname, '..', '..', 'scripts', 'gen-cvoe-settlements.mjs')).href;
const load = async (): Promise<Gen> => (await import(/* @vite-ignore */ SCRIPT)) as Gen;

describe('gen-cvoe-settlements (R11)', () => {
  it('its copy of settlementKey agrees with parse.ts on every bundled name and on the ruling\'s cases', async () => {
    const gen = await load();
    const names = [
      ...cvoeSettlements().map((s) => s.name),
      'с.Мариничі', 'с. Мариничі', 'с. Мaриничі', 'с.Бісків', 'с. село Бісків', 'с. РІпень', 'с. с. Заболоття',
      'м. Герца', 'місто Герца', 'смт Герца', 'селище Герца', 'с-ще Герца', 'с. смт Герца', 'м. с. Герца', 'Герца',
      'с. Драниця (Негринці)', 'с. Негринці (Драниця)', 'с. Нове Село', 'с. Кам\'яна', 'с. Кам’яна', 'с. Селище', 'ст. Іванівці',
      '1-й Провулок', '',
    ];
    for (const name of names) expect(gen.settlementKey(name), name).toBe(settlementKey(name));
  });

  it('one entry per settlement, shown as the spelling with the most rows; ties go to the first seen', async () => {
    const gen = await load();
    expect(gen.districtSettlements(['с.Мариничі', 'с. Мариничі', 'с. Мариничі'])).toEqual(['с. Мариничі']);
    expect(gen.districtSettlements(['с.Бісків', 'с. село Бісків'])).toEqual(['с.Бісків']);
    expect(gen.districtSettlements(['с. Негринці (Драниця)', 'с. Драниця (Негринці)', 'с. Негринці (Драниця)']))
      .toEqual(['с. Негринці (Драниця)', 'с. Драниця (Негринці)']);
    expect(gen.districtSettlements(['с. Герца', 'м. Герца', 'м.Герца'])).toEqual(['с. Герца', 'м. Герца']);
  });
});
