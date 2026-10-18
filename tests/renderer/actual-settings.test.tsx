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
const APP_CONFIG = { id: 'ecoflow-app' as const, region: 'eu' as const, deviceSn: 'R331ZEB4ZEA01234', deviceName: 'Delta 2', accountHint: 'r…@dully.io' };
const keysMode = (user: ReturnType<typeof userEvent.setup>) => user.selectOptions(screen.getByLabelText('Джерело'), 'keys');
async function openAndCheck(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await keysMode(user);
  await user.type(screen.getByLabelText('Access Key'), 'AK-123');
  await user.type(screen.getByLabelText('Secret Key'), 'SK-456');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
}

test('not configured → connect button opens the form', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  expect(screen.getByRole('heading', { name: 'Фактичний стан світла' })).toBeInTheDocument();
  expect(screen.getByText('Зарядна станція EcoFlow може показувати, чи є світло насправді.')).toBeInTheDocument();
  expect(screen.getByText('EcoFlow')).toBeInTheDocument(); // the source chip
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.getByRole('heading', { name: 'Підключення EcoFlow' })).toBeInTheDocument();
  expect(screen.getByLabelText('Джерело')).toHaveValue('account');
  expect(screen.getByRole('radio', { name: 'Європа' })).toBeChecked();
  await keysMode(user);
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
  expect(api.ecoflowTest).toHaveBeenCalledWith({ mode: 'keys', region: 'eu', accessKey: 'AK-123', secretKey: 'SK-456' });
  expect(await screen.findByText('Станції в акаунті')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Delta 2 · …1234/ })).toBeChecked();
  expect(screen.getByText('в мережі')).toBeInTheDocument();
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledWith({ mode: 'keys', region: 'eu', accessKey: 'AK-123', secretKey: 'SK-456' }, 'R331ZEB4ZEA01234');
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

test('check error is shown and there is nothing to save', async () => {
  const user = userEvent.setup();
  const api = mockApi({ ecoflowTest: vi.fn(async () => ({ ok: false, error: 'Ключі не підійшли (8521)' })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Ключі не підійшли (8521)');
  // «Зберегти» lives in the stations step, which a failed check never reaches.
  expect(screen.queryByRole('button', { name: 'Зберегти' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити' })).toBeEnabled();
});

test('«Назад» from the stations goes back to the form with the keys kept', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(screen.queryByLabelText('Access Key')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Назад' }));
  expect(screen.queryByText('Станції в акаунті')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Підключення EcoFlow' })).toHaveFocus();
  expect(screen.getByLabelText('Access Key')).toHaveValue('AK-123');
  expect(screen.getByLabelText('Secret Key')).toHaveValue('SK-456');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(api.ecoflowTest).toHaveBeenCalledTimes(2);
  expect(await screen.findByText('Станції в акаунті')).toBeInTheDocument();
});

test('save sends keys once and clears the form', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  await user.click(await screen.findByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledTimes(1);
  expect(api.ecoflowSave).toHaveBeenCalledWith({ mode: 'keys', region: 'eu', accessKey: 'AK-123', secretKey: 'SK-456' }, { sn: 'R331ZEB4ZEA01234', label: 'Delta 2' });
  expect(await screen.findByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await keysMode(user);
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
  [{ ok: true, online: true, power: 'on', detail: 'на вході 229 В' }, 'На вході 229 В — світло є', 'on'],
  [{ ok: true, online: true, power: 'off', detail: 'на вході 0 В' }, 'На вході 0 В — світла немає', 'off'],
  [{ ok: true, online: false, power: 'unknown' }, 'Станція не в мережі', 'neutral'],
  [{ ok: true, online: true, power: 'unknown', unsupported: true }, 'Модель поки не підтримується', 'warn'],
  [{ ok: true, online: true, power: 'unknown', reason: 'немає даних про вхід' }, 'Немає даних про вхід', 'neutral'],
  [{ ok: false, error: 'Мережа недоступна' }, 'Мережа недоступна', 'neutral'],
])('preview %j → %s, tinted %s', async (result, text, tone) => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowPreview: vi.fn(async () => result) })} />);
  await openAndCheck(user);
  expect(await screen.findByText(text)).toBeInTheDocument();
  // The «Перевірка» box takes the tone as its class (on / off / warn / neutral).
  const box = screen.getByText(text).closest('.st-result');
  expect(box).toHaveClass(tone);
  expect([...box!.classList].filter(c => ['on', 'off', 'warn', 'neutral'].includes(c))).toEqual([tone]);
});

test('reading the station is a neutral box', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowPreview: vi.fn(() => new Promise(() => {})) })} />);
  await openAndCheck(user);
  expect((await screen.findByText('Читаю показники…')).closest('.st-result')).toHaveClass('neutral');
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

test('«Змінити» opens a form with empty keys and the configured region', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf({ ...CONFIG, region: 'us' })} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Змінити' }));
  expect(screen.getByLabelText('Джерело')).toHaveValue('keys');
  expect(screen.getByRole('radio', { name: 'Інший регіон (api.ecoflow.com)' })).toBeChecked();
  expect(screen.getByLabelText('Access Key')).toHaveValue('');
  expect(screen.getByLabelText('Secret Key')).toHaveValue('');
  await user.type(screen.getByLabelText('Access Key'), 'AK-123');
  await user.type(screen.getByLabelText('Secret Key'), 'SK-456');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(api.ecoflowTest).toHaveBeenCalledWith({ mode: 'keys', region: 'us', accessKey: 'AK-123', secretKey: 'SK-456' });
});

test('the region radios pick the API region', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await keysMode(user);
  await user.click(screen.getByRole('radio', { name: 'Інший регіон (api.ecoflow.com)' }));
  expect(screen.getByRole('radio', { name: 'Європа' })).not.toBeChecked();
  await user.type(screen.getByLabelText('Access Key'), 'AK-123');
  await user.type(screen.getByLabelText('Secret Key'), 'SK-456');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(api.ecoflowTest).toHaveBeenCalledWith({ mode: 'keys', region: 'us', accessKey: 'AK-123', secretKey: 'SK-456' });
});

test('focus follows the card when its step changes (the pressed button is gone)', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  expect(document.body).toHaveFocus(); // nothing is focused on first show
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.getByRole('heading', { name: 'Підключення EcoFlow' })).toHaveFocus();
  await keysMode(user);
  await user.type(screen.getByLabelText('Access Key'), 'AK-123');
  await user.type(screen.getByLabelText('Secret Key'), 'SK-456');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(await screen.findByRole('heading', { name: 'Станції в акаунті' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Назад' }));
  await user.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(screen.getByRole('heading', { name: 'Фактичний стан світла' })).toHaveFocus();
});

test('the form opened up front (D10) takes the focus', () => {
  render(<ActualSettings state={stateOf()} api={mockApi()} initiallyOpen />);
  expect(screen.getByRole('heading', { name: 'Підключення EcoFlow' })).toHaveFocus();
});

test('help link calls openEcoflowHelp', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.queryByRole('button', { name: 'Як отримати ключі' })).toBeNull();
  await keysMode(user);
  await user.click(screen.getByRole('button', { name: 'Як отримати ключі' }));
  expect(api.openEcoflowHelp).toHaveBeenCalled();
});

test('editing a key while the check is pending does not leave the button stuck', async () => {
  const user = userEvent.setup(); let resolve!: (v: unknown) => void;
  const api = mockApi({ ecoflowTest: vi.fn(() => new Promise(r => { resolve = r; })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheck(user);
  expect(screen.getByRole('button', { name: 'Перевіряю…' })).toBeDisabled();
  await user.type(screen.getByLabelText('Access Key'), 'x');
  resolve({ ok: true, devices: [stations[0]] });
  expect(await screen.findByRole('button', { name: 'Перевірити' })).toBeEnabled();
  expect(screen.queryByText('Станції в акаунті')).toBeNull();
});

// --- account mode ---
const PASSWORD = 'Sup3r-Secret-pw!';
async function openAndCheckAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Email'), ' roman@dully.io ');
  await user.type(screen.getByLabelText('Пароль'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
}

test('account is the default mode: email, password and the unofficial-way hint; keys fields are hidden', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.getByRole('option', { name: 'EcoFlow — вхід через акаунт' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'EcoFlow — ключі розробника' })).toBeInTheDocument();
  expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
  expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'off');
  expect(screen.getByLabelText('Пароль')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Пароль')).toHaveAttribute('autocomplete', 'off');
  expect(screen.getByText("Неофіційний спосіб — той самий вхід, що й у застосунку EcoFlow. Може перестати працювати, якщо EcoFlow щось змінить. Пароль зберігається зашифрованим лише на цьому комп'ютері.")).toHaveClass('st-hint');
  expect(screen.queryByLabelText('Access Key')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Як отримати ключі' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Перевірити' })).toBeDisabled();
});

test('switching to keys shows the key fields and the help link; back to account keeps what was typed', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Email'), 'a@b.co');
  await keysMode(user);
  expect(screen.getByLabelText('Access Key')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Як отримати ключі' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Email')).toBeNull();
  await user.type(screen.getByLabelText('Access Key'), 'AK-1');
  await user.selectOptions(screen.getByLabelText('Джерело'), 'account');
  expect(screen.getByLabelText('Email')).toHaveValue('a@b.co');
  await keysMode(user);
  expect(screen.getByLabelText('Access Key')).toHaveValue('AK-1');
});

test('account test → stations → save sends exactly the account input', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheckAccount(user);
  const input = { mode: 'account', region: 'eu', email: 'roman@dully.io', password: PASSWORD };
  expect(api.ecoflowTest).toHaveBeenCalledWith(input);
  expect(await screen.findByText('Станції в акаунті')).toBeInTheDocument();
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
  expect(api.ecoflowPreview).toHaveBeenCalledWith(input, 'R331ZEB4ZEA01234');
  await user.click(screen.getByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledTimes(1);
  expect(api.ecoflowSave).toHaveBeenCalledWith(input, { sn: 'R331ZEB4ZEA01234', label: 'Delta 2' });
});

test('the preview runs only on a station pick, never on region change, typing or mode change', async () => {
  const user = userEvent.setup();
  const api = mockApi({ ecoflowTest: vi.fn(async () => ({ ok: true, devices: stations })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheckAccount(user);
  await screen.findByText('Станції в акаунті');
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Назад' }));
  await user.click(screen.getByRole('radio', { name: 'Інший регіон (api.ecoflow.com)' }));
  await user.type(screen.getByLabelText('Email'), 'x');
  await keysMode(user);
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
});

test('changing the source drops the check result', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowTest: vi.fn(async () => ({ ok: false, error: 'Невірний пароль' })) })} />);
  await openAndCheckAccount(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Невірний пароль');
  await keysMode(user);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('«Змінити» on an account connection opens on account with empty fields', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf(APP_CONFIG)} api={mockApi()} />);
  await user.click(screen.getByRole('button', { name: 'Змінити' }));
  expect(screen.getByLabelText('Джерело')).toHaveValue('account');
  expect(screen.getByLabelText('Email')).toHaveValue('');
  expect(screen.getByLabelText('Пароль')).toHaveValue('');
});

test('the connected card shows the account hint', () => {
  const actual = { sourceLabel: 'EcoFlow', power: 'on', observedAt: '2026-10-17T08:50:00Z', history: [] } as ActualStatus;
  render(<ActualSettings state={stateOf(APP_CONFIG, actual)} api={mockApi()} />);
  expect(screen.getByText('EcoFlow · Delta 2 · акаунт r…@dully.io')).toBeInTheDocument();
});

/** Every text node and attribute that holds `secret` (or its base64): the field's value property is not in the DOM. */
const leaks = (secret: string) => [...document.body.querySelectorAll('*')].flatMap(el => {
  const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('');
  return [own, ...[...el.attributes].map(a => a.value)].filter(v => v.includes(secret) || v.includes(btoa(secret)));
});

test('the password is never in the DOM, attributes included, and is gone after save', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Email'), 'roman@dully.io');
  const field = screen.getByLabelText('Пароль');
  await user.type(field, PASSWORD);
  const b64 = btoa(PASSWORD);
  expect(field).toHaveValue(PASSWORD);
  expect(leaks(PASSWORD)).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  await screen.findByText('Станції в акаунті');
  expect(document.body.innerHTML).not.toContain(PASSWORD);
  await user.click(await screen.findByRole('button', { name: 'Зберегти' }));
  await screen.findByRole('button', { name: 'Підключити EcoFlow' });
  expect(document.body.innerHTML).not.toContain(PASSWORD);
  expect(document.body.innerHTML).not.toContain(b64);
});

test('«Назад» brings the password back into its field, still out of the DOM', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await openAndCheckAccount(user);
  await user.click(await screen.findByRole('button', { name: 'Назад' }));
  expect(screen.getByLabelText('Пароль')).toHaveValue(PASSWORD);
  expect(leaks(PASSWORD)).toEqual([]);
  await keysMode(user); // a mode switch unmounts the field as well
  await user.selectOptions(screen.getByLabelText('Джерело'), 'account');
  expect(screen.getByLabelText('Пароль')).toHaveValue(PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(api.ecoflowTest).toHaveBeenLastCalledWith({ mode: 'account', region: 'eu', email: 'roman@dully.io', password: PASSWORD });
});

test('the Secret Key is never in the DOM either, attributes included', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  await openAndCheck(user);
  await user.click(await screen.findByRole('button', { name: 'Назад' }));
  expect(screen.getByLabelText('Secret Key')).toHaveValue('SK-456');
  expect(leaks('SK-456')).toEqual([]);
});

test('the password goes out exactly as typed, spaces included', async () => {
  const user = userEvent.setup(); const api = mockApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Email'), 'roman@dully.io');
  await user.type(screen.getByLabelText('Пароль'), ' pw ');
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(api.ecoflowTest).toHaveBeenCalledWith({ mode: 'account', region: 'eu', email: 'roman@dully.io', password: ' pw ' });
});

test('a failed account check shows its error and keeps «Перевірити» usable', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi({ ecoflowTest: vi.fn(async () => { throw new Error('x'); }) })} />);
  await openAndCheckAccount(user);
  expect(await screen.findByRole('alert')).toHaveTextContent('Не вдалося перевірити вхід');
  expect(screen.getByRole('button', { name: 'Перевірити' })).toBeEnabled();
});
