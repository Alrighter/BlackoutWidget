import { houseLinesOf, previewLines } from '../../src/main/ipc';
import type { ScheduleProvider } from '../../src/main/providers/types';
import type { HouseInfo, LineInfo } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const L1: LineInfo = { index: 1, groupId: 'GPV1.1', label: 'Черга 1.1' };
const L2: LineInfo = { index: 2, groupId: 'GPV2.1', label: 'Черга 2.1' };

function provider(houses: HouseInfo[], houseLines?: (...a: string[]) => Promise<LineInfo[]>) {
  return {
    id: 'dtek-krem', displayName: 'ДТЕК',
    listHouses: vi.fn(async () => houses),
    fetchSnapshot: vi.fn(async () => fixtureSnapshot()),
    ...(houseLines ? { houseLines: vi.fn(houseLines) } : {}),
  } as unknown as ScheduleProvider & { listHouses: ReturnType<typeof vi.fn>; fetchSnapshot: ReturnType<typeof vi.fn>; houseLines?: ReturnType<typeof vi.fn> };
}

test('houseLinesOf without houseLines asks listHouses once and returns the house lines', async () => {
  const p = provider([{ house: '7', outageActive: false, lines: [L1] }, { house: '8', outageActive: false, lines: [L2] }]);
  expect(await houseLinesOf(p, 'c', 's', '8')).toEqual([L2]);
  expect(p.listHouses).toHaveBeenCalledTimes(1);
  expect(await houseLinesOf(p, 'c', 's', '9')).toEqual([]);
});

test('houseLinesOf with houseLines returns its answer and never calls listHouses', async () => {
  const p = provider([], async () => [L1, L2]);
  expect(await houseLinesOf(p, 'c', 's', '7')).toEqual([L1, L2]);
  expect(p.houseLines).toHaveBeenCalledWith('c', 's', '7');
  expect(p.listHouses).not.toHaveBeenCalled();
});

test('previewLines on a provider with houseLines fetches one snapshot per returned line', async () => {
  const p = provider([], async () => [L1, L2]);
  const out = await previewLines(p, 'c', 's', '7');
  expect(out.map(o => o.line)).toEqual([L1, L2]);
  expect(p.fetchSnapshot).toHaveBeenCalledTimes(2);
  expect(p.fetchSnapshot).toHaveBeenCalledWith({ providerId: 'dtek-krem', city: 'c', street: 's', house: '7', lineIndex: 2, groupId: 'GPV2.1' });
  expect(p.listHouses).not.toHaveBeenCalled();
});
