// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActualSettings } from '../../src/renderer/src/app/ActualSettings';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { ActualStatus, AppState } from '../../src/shared/types';

const CONFIG = { id: 'ecoflow' as const, region: 'eu' as const, deviceSn: 'R331ZEB4ZEA01234', deviceName: 'Delta 2', accessKeyHint: 'AbCd…' };
const stations = [{ sn: 'R331ZEB4ZEA01234', label: 'Delta 2', online: true }, { sn: 'R33100000000WXYZ', label: 'River', online: false }];

function mockApi(over: Partial<Record<keyof RendererApi, unknown>> = {}) {
  return {
    ecoflowTest: vi.fn(async () => ({ ok: true, devices: [stations[0]] })),
    ecoflowPreview: vi.fn(async () => ({ ok: true, online: true, power: 'on', detail: 'на вході 229 В' })),
    ecoflowSave: vi.fn(async () => ({ ok: true })),
    actualDisconnect: vi.fn(async () => {}),
    openEcoflowHelp: vi.fn(),
    ...over,
  } as unknown as RendererApi;
}
function stateOf(actualSource: AppState['settings']['actualSource'] = null, actual: ActualStatus | null = null): AppState {
  return { settings: { ...DEFAULT_SETTINGS, actualSource }, snapshot: null, phase: 'ok', lineChanged: false, actual };
}
async function openAndCheck(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Access Key'), 'AK-123');
  await user.type(screen.getByLabelText('Secret Key'), 'SK-456');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
}

test('not configured → connect button opens the form', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  expect(screen.getByRole('heading', { name: 'Фактичний стан світла' })).toBeInTheDocument();
  expect(screen.getByText('Зарядна станція EcoFlow може показувати, чи є світло насправді.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.getByLabelText('Регіон')).toHaveValue('eu');
  expect(screen.getByLabelText('Access Key')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Secret Key')).toHaveAttribute('type', 'password');
  expect(screen.getByText('Ключі видає EcoFlow після схвалення заявки розробника на developer-eu.ecoflow.com (зазвичай кілька днів).')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(screen.getByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
});

test('check lists stations; single station preselected; preview text', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  expect(api.ecoflowTest).toHaveBeenCalledWith({ region: 'eu', accessKey: 'AK-123', secretKey: 'SK-456' });
  expect(await screen.findByText('Станції в акаунті')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Delta 2 · …1234/ })).toBeChecked();
  expect(screen.getByText('в мережі')).toBeInTheDocument();
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledWith({ region: 'eu', accessKey: 'AK-123', secretKey: 'SK-456' }, 'R331ZEB4ZEA01234');
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled();
});

test('several stations: none preselected, save disabled until one is picked; empty list message', async () => {
  const user = userEvent.setup();
  const api = mockApi({ ecoflowTest: vi.fn(async () => ({ ok: true, devices: stations })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  expect(await screen.findByText('не в мережі')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await user.click(screen.getByRole('radio', { name: /River · …WXYZ/ }));
  expect(await screen.findByText('Зберегти', { selector: 'button' })).toBeEnabled();
});

test('no stations in the account', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowTest: vi.fn(async () => ({ ok: true, devices: [] })) })} />);
  await openAndCheck(user);
  expect(await screen.findByText('У цьому акаунті немає станцій')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
});

test('check error is shown and save stays disabled', async () => {
  const user = userEvent.setup();
  const api = mockApi({ ecoflowTest: vi.fn(async () => ({ ok: false, error: 'Ключі не підійшли (8521)' })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  expect(await screen.findByText('Ключі не підійшли (8521)')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
});

test('save sends keys once and clears the form', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  await user.click(await screen.findByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledTimes(1);
  expect(api.ecoflowSave).toHaveBeenCalledWith({ region: 'eu', accessKey: 'AK-123', secretKey: 'SK-456' }, { sn: 'R331ZEB4ZEA01234', label: 'Delta 2' });
  expect(await screen.findByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.getByLabelText('Access Key')).toHaveValue('');
  expect(screen.getByLabelText('Secret Key')).toHaveValue('');
});

test('save error is shown under the button', async () => {
  const user = userEvent.setup();
  const api = mockApi({ ecoflowSave: vi.fn(async () => ({ ok: false, error: 'Шифування недоступне' })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  await user.click(await screen.findByRole('button', { name: 'Зберегти' }));
  expect(await screen.findByText('Шифування недоступне')).toBeInTheDocument();
});

test.each([
  [{ ok: true, online: true, power: 'off', detail: 'на вході 0 В' }, 'На вході 0 В — світла немає'],
  [{ ok: true, online: false, power: 'unknown' }, 'Станція не в мережі'],
  [{ ok: true, online: true, power: 'unknown', unsupported: true }, 'Модель поки не підтримується'],
  [{ ok: true, online: true, power: 'unknown', reason: 'немає даних про вхід' }, 'Немає даних про вхід'],
  [{ ok: false, error: 'Мережа недоступна' }, 'Мережа недоступна'],
])('preview %j → %s', async (result, text) => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowPreview: vi.fn(async () => result) })} />);
  await openAndCheck(user);
  expect(await screen.findByText(text)).toBeInTheDocument();
});

test('preview offline still allows save', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowPreview: vi.fn(async () => ({ ok: true, online: false, power: 'unknown' })) })} />);
  await openAndCheck(user);
  expect(await screen.findByText('Станція не в мережі')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled();
});

test('configured view shows hint and current state; disconnect calls api', async () => {
  const user = userEvent.setup(); const api = mockApi();
  const actual = { sourceLabel: 'EcoFlow', power: 'on', observedAt: '2026-10-17T08:50:00Z', history: [] } as ActualStatus;
  render(<ActualSettings state={stateOf(CONFIG, actual)} api={api} />);
  expect(screen.getByText('EcoFlow · Delta 2 · ключ AbCd…')).toBeInTheDocument();
  expect(screen.getByText('Зараз: світло є (дані о 11:50)')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Вимкнути' }));
  expect(api.actualDisconnect).toHaveBeenCalled();
});

test('configured view: off, unknown, and disconnect failure', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<ActualSettings state={stateOf(CONFIG, { sourceLabel: 'EcoFlow', power: 'off', observedAt: '2026-10-17T08:50:00Z', history: [] })} api={mockApi()} />);
  expect(screen.getByText('Зараз: світла немає (дані о 11:50)')).toBeInTheDocument();
  rerender(<ActualSettings state={stateOf(CONFIG, { sourceLabel: 'EcoFlow', power: 'unknown', reason: 'станція не в мережі', history: [] })}
    api={mockApi({ actualDisconnect: vi.fn(async () => { throw new Error('x'); }) })} />);
  expect(screen.getByText('Зараз: невідомо — станція не в мережі')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Вимкнути' }));
  expect(await screen.findByText('Не вдалося зберегти налаштування. Спробуйте ще раз.')).toBeInTheDocument();
});

test('«Змінити» opens an empty form', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf(CONFIG)} api={mockApi()} />);
  await user.click(screen.getByRole('button', { name: 'Змінити' }));
  expect(screen.getByLabelText('Access Key')).toHaveValue('');
  expect(screen.getByLabelText('Secret Key')).toHaveValue('');
});

test('help link calls openEcoflowHelp', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.click(screen.getByRole('button', { name: 'Як отримати ключі' }));
  expect(api.openEcoflowHelp).toHaveBeenCalled();
});
