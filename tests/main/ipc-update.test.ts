import { ipcMain, type WebContents } from 'electron';
import { registerIpc, type IpcDeps, type WidgetCalls } from '../../src/main/ipc';
import { IPC } from '../../src/shared/ipc';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

const SENDER_WIDGET = { id: 1 } as unknown as WebContents;
const SENDER_MAIN = { id: 2 } as unknown as WebContents;

function setup() {
  const deps = {
    providers: [],
    installUpdate: vi.fn(async () => {}),
    widgets: { find: vi.fn((sender: WebContents) => (sender === SENDER_WIDGET ? ({ locationId: 'a' } as WidgetCalls) : undefined)) },
  } satisfies Partial<IpcDeps>;
  vi.mocked(ipcMain.handle).mockClear();
  registerIpc(deps as unknown as IpcDeps);
  const call = (sender: WebContents): unknown => {
    const found = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === IPC.installUpdate);
    if (!found) throw new Error(`no handler for ${IPC.installUpdate}`);
    return (found[1] as (e: unknown) => unknown)({ sender });
  };
  return { deps, call };
}

test('update:install calls deps.installUpdate', async () => {
  expect(IPC.installUpdate).toBe('update:install');
  const { deps, call } = setup();
  await call(SENDER_MAIN);
  expect(deps.installUpdate).toHaveBeenCalledTimes(1);
});

test('a widget can\'t start an update', async () => {
  const { deps, call } = setup();
  await call(SENDER_WIDGET);
  expect(deps.installUpdate).not.toHaveBeenCalled();
});
