// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActualSettings } from '../../src/renderer/src/app/ActualSettings';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { ActualStatus, AppState, Location } from '../../src/shared/types';

const CONFIG = { id: 'ecoflow' as const, region: 'eu' as const, deviceSn: 'R331ZEB4ZEA01234', deviceName: 'Delta 2', accessKeyHint: 'AbCd…' };
const stations = [{ sn: 'R331ZEB4ZEA01234', label: 'Delta 2', online: true }, { sn: 'R33100000000WXYZ', label: 'River', online: false }];

function mockApi(over: Partial<Record<keyof RendererApi, unknown>> = {}) {
  return {
    ecoflowTest: vi.fn(async () => ({ ok: true, devices: [stations[0]] })),
    ecoflowScan: vi.fn(async () => ({ nearby: [] })),
    ecoflowPreview: vi.fn(async () => ({ ok: true, online: true, power: 'on', detail: 'на вході 229 В' })),
    ecoflowSave: vi.fn(async () => ({ ok: true })),
    actualDisconnect: vi.fn(async () => {}),
    openEcoflowHelp: vi.fn(),
    ...over,
  } as unknown as RendererApi;
}
const ADDRESS = { providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' };
const place = (id: string, name: string): Location => ({ id, name, address: ADDRESS, widgetStyle: 'compact', widgetPosition: null });
const HOME = place('home', 'Дім'), PARENTS = place('b', 'Батьки');
/** One location, «Дім», where the station stands, unless `places` and `at` say otherwise. */
function stateOf(actualSource: AppState['settings']['actualSource'] = null, actual: ActualStatus | null = null,
  places: Location[] = [HOME], at: string | null = places[0]?.id ?? null): AppState {
  return {
    settings: { ...DEFAULT_SETTINGS, actualSource, locations: places, actualLocationId: at },
    locations: places.map(location => ({ location, snapshot: null, phase: 'ok', lineChanged: false, ...(location.id === at ? { actual } : {}) })),
    actual, settingsLoaded: true,
  };
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
  // Keys mode has no Bluetooth: no scan, no «Підключення» switch.
  expect(api.ecoflowScan).not.toHaveBeenCalled();
  expect(screen.queryByRole('radiogroup', { name: 'Підключення' })).toBeNull();
  expect(screen.queryByText('Шукаю станції поруч через Bluetooth…')).toBeNull();
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

// --- Bluetooth, chosen per station after the account check ---
const BLE_CONFIG = { id: 'ecoflow-ble' as const, region: 'eu' as const, deviceSn: 'R601ZEB4ZEA01234', deviceName: 'River 2', accountHint: 'r…@dully.io' };
const RIVER = { sn: 'R601ZEB4ZEA01234', label: 'River 2', online: false };
const DELTA = { sn: 'R331ZEB4ZEA05678', label: 'Delta 2', online: true };
const MAX = { sn: 'R611ZEB4ZEA09999', label: 'River 2 Max', online: true };
const ACCOUNT_INPUT = { mode: 'account', region: 'eu', email: 'roman@dully.io', password: PASSWORD };
const SCANNING = 'Шукаю станції поруч через Bluetooth…';
const AFTER_SAVE = 'Станція поруч — стан світла з’явиться після збереження';
const BLE_HINT = 'Поки віджет підключений, телефон зможе керувати станцією лише через інтернет. Пароль не зберігається — лише ключ для цієї станції.';
const NOT_NEARBY = 'Станцію не знайдено поруч — увімкніть її і тримайте поряд з комп’ютером';
const UNSUPPORTED = 'Модель поки не підтримується';

/** The stations come back at once; each scan waits for `scan(n, result)` (an Error rejects it). */
function scanApi(devices: unknown[] = [RIVER, DELTA, MAX], over: Partial<Record<keyof RendererApi, unknown>> = {}) {
  const pending: { resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  const api = mockApi({
    ecoflowTest: vi.fn(async () => ({ ok: true, devices })),
    ecoflowScan: vi.fn(() => new Promise((resolve, reject) => { pending.push({ resolve, reject }); })),
    ...over,
  });
  const scan = (n: number, r: unknown) => act(async () => { if (r instanceof Error) pending[n].reject(r); else pending[n].resolve(r); });
  return { api, scan };
}
async function checkAccount(user: ReturnType<typeof userEvent.setup>, open = true) {
  if (open) await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Email'), 'roman@dully.io');
  await user.type(screen.getByLabelText('Пароль'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  await screen.findByText('Станції в акаунті');
}
const station = (name: RegExp) => screen.getByRole('radio', { name });
const rowState = (name: RegExp) => station(name).closest('label')!.querySelector('.st-station-state')!;
const bt = () => screen.getByRole('radio', { name: 'Bluetooth' });
const net = () => screen.getByRole('radio', { name: 'Інтернет' });
const linkGroup = () => screen.getByRole('radiogroup', { name: 'Підключення' });

test('«Джерело» offers the account and the developer keys only, with no Bluetooth hint', async () => {
  const user = userEvent.setup();
  render(<ActualSettings state={stateOf()} api={mockApi()} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['EcoFlow — вхід через акаунт', 'EcoFlow — ключі розробника']);
  expect(screen.queryByText(/Далі інтернет не потрібен/)).toBeNull();
});

test('check: the stations come at once with the cloud state; with a RIVER 2 among them the scan starts, then «поруч» from it', async () => {
  const user = userEvent.setup(); let signedIn!: (v: unknown) => void;
  const { api, scan } = scanApi([RIVER, DELTA, MAX], { ecoflowTest: vi.fn(() => new Promise(r => { signedIn = r; })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
  await user.type(screen.getByLabelText('Email'), 'roman@dully.io');
  await user.type(screen.getByLabelText('Пароль'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  expect(api.ecoflowTest).toHaveBeenCalledWith(ACCOUNT_INPUT);
  expect(screen.getByRole('button', { name: 'Перевіряю…' })).toBeDisabled();
  expect(api.ecoflowScan).not.toHaveBeenCalled(); // not before the list says there is a station to look for
  await act(async () => signedIn({ ok: true, devices: [RIVER, DELTA, MAX] }));
  expect(api.ecoflowScan).toHaveBeenCalledTimes(1);
  expect(api.ecoflowScan).toHaveBeenCalledWith();
  expect(screen.getByRole('heading', { name: 'Станції в акаунті' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(SCANNING);
  expect(rowState(/River 2 · …1234/)).toHaveTextContent(/^не в мережі$/);
  expect(rowState(/Delta 2 · …5678/)).toHaveTextContent(/^в мережі$/);
  await scan(0, { nearby: [RIVER.sn, DELTA.sn, 'R601ZEB4ZEA00000'] });
  expect(screen.queryByText(SCANNING)).toBeNull();
  for (const name of [/River 2 · …1234/, /Delta 2 · …5678/]) {
    expect(rowState(name)).toHaveTextContent(/^поруч$/);
    expect(rowState(name)).toHaveClass('online');
  }
  expect(rowState(/River 2 Max · …9999/)).toHaveTextContent(/^в мережі$/);
  expect(api.ecoflowTest).toHaveBeenCalledTimes(1);
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
});

test('a scan problem is an alert under the list, which stays; a failed scan call too', async () => {
  const user = userEvent.setup();
  const first = scanApi();
  const { unmount } = render(<ActualSettings state={stateOf()} api={first.api} />);
  await checkAccount(user);
  await first.scan(0, { nearby: [], bluetooth: 'Bluetooth на цьому комп’ютері вимкнено' });
  expect(screen.getByRole('alert')).toHaveTextContent('Bluetooth на цьому комп’ютері вимкнено');
  expect(screen.getAllByRole('radio', { name: /·/ })).toHaveLength(3);
  expect(screen.getByRole('group', { name: 'Станція' }).compareDocumentPosition(screen.getByRole('alert')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  unmount();

  const second = scanApi();
  render(<ActualSettings state={stateOf()} api={second.api} />);
  await checkAccount(user);
  await second.scan(0, new Error('ipc'));
  expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося пошукати станцію через Bluetooth');
  expect(screen.queryByText(SCANNING)).toBeNull();
});

test('an account with no stations is not scanned', async () => {
  const user = userEvent.setup(); const { api } = scanApi([]);
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  expect(screen.getByText('У цьому акаунті немає станцій')).toBeInTheDocument();
  expect(api.ecoflowScan).not.toHaveBeenCalled();
  expect(screen.queryByText(SCANNING)).toBeNull();
});

test('an account with only a Delta: no scan, no scanning line, no switch; preselected at once with exactly one preview', async () => {
  const user = userEvent.setup(); const { api } = scanApi([DELTA]);
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  expect(station(/Delta 2 · …5678/)).toBeChecked();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, DELTA.sn);
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(api.ecoflowScan).not.toHaveBeenCalled();
  expect(screen.queryByText(SCANNING)).toBeNull();
  expect(screen.queryByRole('radiogroup', { name: 'Підключення' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledWith(ACCOUNT_INPUT, { sn: DELTA.sn, label: 'Delta 2' });
});

test('«Підключення» defaults to Bluetooth for a nearby RIVER 2, with no preview; another model has no switch; a RIVER 2 not nearby gets Інтернет and the reason', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await scan(0, { nearby: [RIVER.sn, DELTA.sn] });
  expect(screen.queryByRole('radiogroup', { name: 'Підключення' })).toBeNull(); // only under the chosen station

  await user.click(station(/River 2 · …1234/));
  expect(bt()).toBeChecked();
  expect(bt()).toBeEnabled();
  expect(net()).not.toBeChecked();
  expect(screen.getByText(AFTER_SAVE).closest('.st-result')).toHaveClass('neutral');
  expect(screen.getByText(BLE_HINT)).toHaveClass('st-hint');
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled();

  await user.click(station(/Delta 2 · …5678/)); // nearby, but another model: the account's cloud, as before
  expect(screen.queryByRole('radiogroup', { name: 'Підключення' })).toBeNull();
  expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  expect(api.ecoflowPreview).toHaveBeenLastCalledWith(ACCOUNT_INPUT, DELTA.sn);
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(screen.queryByText(BLE_HINT)).toBeNull();

  await user.click(station(/River 2 Max · …9999/)); // RIVER 2 family, not nearby
  expect(bt()).toBeDisabled();
  expect(net()).toBeChecked();
  expect(linkGroup()).toHaveAccessibleDescription(NOT_NEARBY); // the reason only, not the link's text
  expect(screen.getByRole('button', { name: 'Шукати ще раз' })).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenLastCalledWith(ACCOUNT_INPUT, MAX.sn);
  expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled();
});

test('while the scan runs Bluetooth waits with no «Шукати ще раз»; the link re-runs only the scan, and the default follows it', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi([MAX]);
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  // The only station waits for the scan; picked by hand meanwhile, it is read over the internet at once.
  expect(station(/River 2 Max · …9999/)).not.toBeChecked();
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await user.click(station(/River 2 Max · …9999/));
  expect(net()).toBeChecked();
  expect(bt()).toBeDisabled();
  // No scan has said anything yet: Bluetooth waits with no reason, so nothing contradicts «Шукаю станції поруч…».
  expect(linkGroup()).not.toHaveAttribute('aria-describedby');
  expect(screen.queryByText(NOT_NEARBY)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Шукати ще раз' })).toBeNull();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);

  await scan(0, { nearby: [] });
  expect(linkGroup()).toHaveAccessibleDescription(NOT_NEARBY);
  await user.click(screen.getByRole('button', { name: 'Шукати ще раз' }));
  expect(api.ecoflowScan).toHaveBeenCalledTimes(2);
  expect(api.ecoflowTest).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status')).toHaveTextContent(SCANNING);
  expect(screen.queryByRole('button', { name: 'Шукати ще раз' })).toBeNull();
  expect(linkGroup()).toHaveAccessibleDescription(NOT_NEARBY); // the last real result stays during a new search
  expect(net()).toHaveFocus(); // the link is gone, the focus stays in the switch

  await scan(1, { nearby: [MAX.sn] });
  expect(bt()).toBeChecked();
  expect(screen.getByText(AFTER_SAVE)).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
});

test('a station picked while the scan runs is read over the internet at once; a nearby scan then switches it to Bluetooth and the late preview stays hidden', async () => {
  const user = userEvent.setup(); let previewDone!: (v: unknown) => void;
  const { api, scan } = scanApi(undefined, { ecoflowPreview: vi.fn(() => new Promise(r => { previewDone = r; })) });
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await user.click(station(/River 2 · …1234/));
  expect(net()).toBeChecked();
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, RIVER.sn);
  expect(screen.getByText('Читаю показники…')).toBeInTheDocument();

  await scan(0, { nearby: [RIVER.sn] });
  expect(rowState(/River 2 · …1234/)).toHaveTextContent(/^поруч$/);
  expect(bt()).toBeChecked();
  expect(screen.getByText(AFTER_SAVE)).toBeInTheDocument();
  await act(async () => previewDone({ ok: true, online: false, power: 'unknown' }));
  expect(screen.getByText(AFTER_SAVE)).toBeInTheDocument();
  expect(screen.queryByText('Станція не в мережі')).toBeNull();

  await user.click(net()); // back to Інтернет: the preview already read is reused
  expect(screen.getByText('Станція не в мережі')).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
});

test('a single station waits for the scan before its default: no preview while it runs; nearby → Bluetooth, still no preview', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi([RIVER]);
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  expect(screen.queryByText('Читаю показники…')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent(SCANNING);
  await scan(0, { nearby: [RIVER.sn] });
  expect(station(/River 2 · …1234/)).toBeChecked();
  expect(bt()).toBeChecked();
  expect(screen.getByText(AFTER_SAVE)).toBeInTheDocument();
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
});

test.each([
  ['did not find it', { nearby: [] }],
  ['failed', new Error('ipc')],
])('a single station whose scan %s: Інтернет and exactly one preview', async (_, result) => {
  const user = userEvent.setup(); const { api, scan } = scanApi([RIVER]);
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await scan(0, result);
  expect(station(/River 2 · …1234/)).toBeChecked();
  expect(net()).toBeChecked();
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, RIVER.sn);
});

test('a switch the user touched is kept when the scan result arrives', async () => {
  const user = userEvent.setup(); const { scan, api } = scanApi([RIVER]);
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await user.click(station(/River 2 · …1234/));
  await user.click(net());
  await scan(0, { nearby: [RIVER.sn] });
  expect(bt()).toBeEnabled();
  expect(net()).toBeChecked();
  expect(screen.queryByText(AFTER_SAVE)).toBeNull();
});

test('Bluetooth chosen: «Зберегти» sends the account sign-in with mode ble, and no preview ran', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await scan(0, { nearby: [RIVER.sn] });
  await user.click(station(/River 2 · …1234/));
  await user.click(screen.getByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledTimes(1);
  expect(api.ecoflowSave).toHaveBeenCalledWith({ ...ACCOUNT_INPUT, mode: 'ble' }, { sn: RIVER.sn, label: 'River 2' });
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  expect(await screen.findByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
});

test('Інтернет chosen for a Bluetooth-ready station: the cloud preview, reused on the way back, and a save with mode account', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await scan(0, { nearby: [RIVER.sn] });
  await user.click(station(/River 2 · …1234/));
  expect(bt()).toBeChecked();
  await user.click(net());
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, RIVER.sn);
  expect(await screen.findByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(screen.queryByText(BLE_HINT)).toBeNull();
  await user.click(bt());
  expect(screen.getByText(AFTER_SAVE)).toBeInTheDocument();
  await user.click(net());
  expect(screen.getByText('На вході 229 В — світло є')).toBeInTheDocument();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledWith(ACCOUNT_INPUT, { sn: RIVER.sn, label: 'River 2' });
});

test('the switch is one Tab stop; the arrows move and pick, and skip a disabled Bluetooth', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await scan(0, { nearby: [RIVER.sn] });
  await user.click(station(/River 2 · …1234/));
  expect(bt()).toHaveAttribute('tabindex', '0');
  expect(net()).toHaveAttribute('tabindex', '-1');
  act(() => bt().focus());
  await user.keyboard('{ArrowRight}');
  expect(net()).toBeChecked();
  expect(net()).toHaveFocus();
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, RIVER.sn);
  await user.keyboard('{ArrowLeft}');
  expect(bt()).toBeChecked();
  expect(bt()).toHaveFocus();

  await user.click(station(/River 2 Max · …9999/)); // not nearby: Bluetooth is disabled
  act(() => net().focus());
  await user.keyboard('{ArrowLeft}');
  expect(net()).toBeChecked();
  expect(net()).toHaveFocus();
});

test('a scan from an earlier check is ignored', async () => {
  const user = userEvent.setup(); const { api, scan } = scanApi();
  render(<ActualSettings state={stateOf()} api={api} />);
  await checkAccount(user);
  await user.click(screen.getByRole('button', { name: 'Назад' }));
  await user.click(screen.getByRole('button', { name: 'Перевірити' }));
  await screen.findByText('Станції в акаунті');
  expect(api.ecoflowScan).toHaveBeenCalledTimes(2);
  await scan(0, { nearby: [RIVER.sn], bluetooth: 'Bluetooth на цьому комп’ютері вимкнено' });
  expect(screen.queryByText('поруч')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent(SCANNING);
  await scan(1, { nearby: [MAX.sn] });
  expect(screen.getAllByText('поруч')).toHaveLength(1);
  expect(rowState(/River 2 Max · …9999/)).toHaveTextContent(/^поруч$/);
});

test.each([
  ['the only station', false],
  ['the saved Bluetooth station', true],
])('«Назад» or a new check while %s waits for the scan: the old scan picks and reads nothing', async (_, saved) => {
  const user = userEvent.setup();
  const { api, scan } = scanApi(saved ? [DELTA, RIVER] : [RIVER], { getActualLive: vi.fn(async () => null), onActualLive: vi.fn(() => () => {}) });
  render(<ActualSettings state={stateOf(saved ? BLE_CONFIG : null)} api={api} />);
  if (saved) await user.click(screen.getByRole('button', { name: 'Змінити' }));
  await checkAccount(user, !saved);
  const back = async () => user.click(screen.getByRole('button', { name: 'Назад' }));
  const recheck = async () => { await user.click(screen.getByRole('button', { name: 'Перевірити' })); await screen.findByText('Станції в акаунті'); };
  const picked = () => screen.queryAllByRole('radio', { name: /·/ }).filter(r => (r as HTMLInputElement).checked);

  await back(); await recheck(); await back();
  await scan(1, { nearby: [] }); // after «Назад»
  expect(screen.getByRole('heading', { name: 'Підключення EcoFlow' })).toBeInTheDocument();
  await recheck();
  await scan(0, { nearby: [] }); // a stale scan during the next check
  expect(picked()).toEqual([]);
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await scan(2, { nearby: [RIVER.sn] }); // the current check's own scan
  expect(picked()).toEqual([station(/River 2 · …1234/)]);
  expect(bt()).toBeChecked();
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
});

test('«Змінити» on an ecoflow-ble source: a pick by hand while its station waits for the scan wins', async () => {
  const user = userEvent.setup();
  const { api, scan } = scanApi([DELTA, RIVER], { getActualLive: vi.fn(async () => null), onActualLive: vi.fn(() => () => {}) });
  render(<ActualSettings state={stateOf(BLE_CONFIG)} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Змінити' }));
  await checkAccount(user, false);
  await user.click(station(/Delta 2 · …5678/));
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, DELTA.sn);
  await scan(0, { nearby: [RIVER.sn] });
  expect(station(/Delta 2 · …5678/)).toBeChecked();
  expect(station(/River 2 · …1234/)).not.toBeChecked();
  expect(api.ecoflowPreview).toHaveBeenCalledTimes(1);
});

describe('where the station stands', () => {
  const PICKER = 'Станція стоїть у:';
  const UNASSIGNED = 'Оберіть, де стоїть станція';
  const actualNow = { sourceLabel: 'EcoFlow', power: 'on', observedAt: '2026-10-17T08:50:00Z', history: [] } as ActualStatus;
  const picker = () => screen.getByLabelText(PICKER) as HTMLSelectElement;
  const names = () => [...picker().options].filter(o => !o.disabled).map(o => o.textContent);

  test.each([
    ['connected', CONFIG, actualNow],
    ['not connected yet', null, null],
  ] as const)('two locations, %s: «Станція стоїть у:» picks the location', async (_, source, actual) => {
    const user = userEvent.setup(); const api = mockApi({ setActualLocation: vi.fn(async () => {}) });
    render(<ActualSettings state={stateOf(source, actual, [HOME, PARENTS], 'home')} api={api} />);
    expect(picker()).toHaveValue('home');
    expect(names()).toEqual(['Дім', 'Батьки']);
    expect(screen.queryByText(UNASSIGNED)).toBeNull();
    await user.selectOptions(picker(), 'Батьки');
    expect(api.setActualLocation).toHaveBeenCalledTimes(1);
    expect(api.setActualLocation).toHaveBeenCalledWith('b');
  });

  test('the card\'s device line still reads the station\'s own status', () => {
    render(<ActualSettings state={stateOf(CONFIG, actualNow, [HOME, PARENTS], 'b')} api={mockApi()} />);
    expect(picker()).toHaveValue('b');
    expect(screen.getByText('Зараз: світло є (дані о 11:50)')).toBeInTheDocument();
  });

  test('one location: no picker', () => {
    const { unmount } = render(<ActualSettings state={stateOf(CONFIG, actualNow)} api={mockApi()} />);
    expect(screen.queryByLabelText(PICKER)).toBeNull();
    expect(screen.queryByText(UNASSIGNED)).toBeNull();
    unmount();
    render(<ActualSettings state={stateOf()} api={mockApi()} />);
    expect(screen.queryByLabelText(PICKER)).toBeNull();
  });

  test('actualLocationId null: «Оберіть, де стоїть станція» and the picker, even with one location', async () => {
    const user = userEvent.setup(); const api = mockApi({ setActualLocation: vi.fn(async () => {}) });
    render(<ActualSettings state={stateOf(CONFIG, actualNow, [HOME], null)} api={api} />);
    expect(screen.getByText(UNASSIGNED)).toBeInTheDocument();
    expect(picker()).toHaveAccessibleDescription(UNASSIGNED);
    // Nothing picked: the one name is not shown as chosen, so picking it is a change.
    expect(picker()).toHaveValue('');
    expect(names()).toEqual(['Дім']);
    await user.selectOptions(picker(), 'Дім');
    expect(api.setActualLocation).toHaveBeenCalledWith('home');
  });

  test('no locations at all: no picker', () => {
    render(<ActualSettings state={stateOf(CONFIG, actualNow, [], null)} api={mockApi()} />);
    expect(screen.queryByLabelText(PICKER)).toBeNull();
    expect(screen.queryByText(UNASSIGNED)).toBeNull();
  });

  test('the form has no picker; a refused pick shows the reason', async () => {
    const user = userEvent.setup();
    const api = mockApi({ setActualLocation: vi.fn(async () => { throw new Error("Error invoking remote method 'loc:actual': Error: Цієї адреси вже немає"); }) });
    render(<ActualSettings state={stateOf(null, null, [HOME, PARENTS], 'home')} api={api} />);
    await user.selectOptions(picker(), 'Батьки');
    expect(await screen.findByRole('alert')).toHaveTextContent('Цієї адреси вже немає');
    await user.click(screen.getByRole('button', { name: 'Підключити EcoFlow' }));
    expect(screen.queryByLabelText(PICKER)).toBeNull();
  });
});

function liveApi(seed: unknown = null) {
  let push: (l: unknown) => void = () => {}; const off = vi.fn();
  const api = mockApi({
    getActualLive: vi.fn(async () => seed),
    onActualLive: vi.fn((cb: (l: unknown) => void) => { push = cb; return off; }),
  });
  return { api, off, push: (l: unknown) => act(() => push(l)) };
}
const bleActual = { sourceLabel: 'EcoFlow', power: 'on', observedAt: '2026-10-17T08:50:00Z', history: [] } as ActualStatus;

test('connected ecoflow-ble panel shows the Bluetooth name and the live line, updating on push', async () => {
  const { api, off, push } = liveApi({ link: 'connected', acInVolts: 227, acInHz: 50, inputWatts: 0, acOut: true, soc: 87 });
  const { unmount } = render(<ActualSettings state={stateOf(BLE_CONFIG, bleActual)} api={api} />);
  expect(screen.getByText('EcoFlow · River 2 · Bluetooth · акаунт r…@dully.io')).toBeInTheDocument();
  expect(await screen.findByText('На вході 227 В · 50 Гц · 0 Вт · вихід AC увімк · заряд 87%')).toBeInTheDocument();
  push({ link: 'connected', invSilent: true, acOut: false, soc: 100 });
  expect(screen.getByText('Станція не повідомляє про вхід · вихід AC вимк · заряд 100%')).toBeInTheDocument();
  push({ link: 'connected', invSilent: true, acOut: false, soc: 97, wattsIn: 0, wattsOut: 12 });
  expect(screen.getByText('Від батареї · споживання 12 Вт · вихід AC вимк · заряд 97%')).toBeInTheDocument();
  push({ link: 'connected', invSilent: true, acOut: false, soc: 97, wattsIn: 0, wattsOut: 0 });
  expect(screen.getByText('Вхід 0 Вт · споживання 0 Вт · вихід AC вимк · заряд 97%')).toBeInTheDocument();
  push({ link: 'connected', invSilent: true, soc: 97, wattsIn: 40 });
  expect(screen.getByText('Вхід 40 Вт · заряд 97%')).toBeInTheDocument();
  push({ link: 'searching' });
  expect(screen.getByText('Шукаю станцію поруч…')).toBeInTheDocument();
  push({ link: 'bt-off' });
  expect(screen.getByText('Bluetooth на цьому комп’ютері вимкнено')).toBeInTheDocument();
  unmount();
  expect(off).toHaveBeenCalled();
});

test('live line leaves out values not received yet', async () => {
  const { api } = liveApi({ link: 'connected', acInVolts: 227, soc: 87 });
  render(<ActualSettings state={stateOf(BLE_CONFIG, bleActual)} api={api} />);
  expect(await screen.findByText('На вході 227 В · заряд 87%')).toBeInTheDocument();
});

test('a late seed does not overwrite a push', async () => {
  let seed!: (v: unknown) => void; let push: (l: unknown) => void = () => {};
  const api = mockApi({
    getActualLive: vi.fn(() => new Promise(r => { seed = r; })),
    onActualLive: vi.fn((cb: (l: unknown) => void) => { push = cb; return () => {}; }),
  });
  render(<ActualSettings state={stateOf(BLE_CONFIG, bleActual)} api={api} />);
  act(() => push({ link: 'connecting' }));
  await act(async () => seed({ link: 'searching' }));
  expect(screen.getByText('Підключаюся…')).toBeInTheDocument();
});

test('the live line is only for the Bluetooth source', () => {
  const api = mockApi({ getActualLive: vi.fn(async () => null), onActualLive: vi.fn(() => () => {}) });
  render(<ActualSettings state={stateOf(APP_CONFIG, bleActual)} api={api} />);
  expect(api.onActualLive).not.toHaveBeenCalled();
});

test('«Змінити» on an ecoflow-ble source: the account form; after the check and the scan its station is preselected with Bluetooth', async () => {
  const user = userEvent.setup();
  const { api, scan } = scanApi([DELTA, RIVER], { getActualLive: vi.fn(async () => null), onActualLive: vi.fn(() => () => {}) });
  render(<ActualSettings state={stateOf(BLE_CONFIG)} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Змінити' }));
  expect(screen.getByLabelText('Джерело')).toHaveValue('account');
  expect(screen.getByLabelText('Email')).toHaveValue('');
  expect(screen.getByLabelText('Пароль')).toHaveValue('');
  await checkAccount(user, false);
  // Nothing is picked (or read) until the scan has said whether the station is still nearby.
  expect(screen.getAllByRole('radio', { name: /·/ }).filter(r => (r as HTMLInputElement).checked)).toEqual([]);
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await scan(0, { nearby: [RIVER.sn] });
  expect(station(/River 2 · …1234/)).toBeChecked();
  expect(bt()).toBeChecked();
  expect(screen.getByText(AFTER_SAVE)).toBeInTheDocument();
  expect(api.ecoflowPreview).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Зберегти' }));
  expect(api.ecoflowSave).toHaveBeenCalledWith({ ...ACCOUNT_INPUT, mode: 'ble' }, { sn: RIVER.sn, label: 'River 2' });
});

test('«Змінити» on an ecoflow-ble source: a station no longer nearby is preselected on Інтернет', async () => {
  const user = userEvent.setup();
  const { api, scan } = scanApi([RIVER], { getActualLive: vi.fn(async () => null), onActualLive: vi.fn(() => () => {}) });
  render(<ActualSettings state={stateOf(BLE_CONFIG)} api={api} />);
  await user.click(screen.getByRole('button', { name: 'Змінити' }));
  await checkAccount(user, false);
  expect(station(/River 2 · …1234/)).not.toBeChecked(); // the only station waits for the scan too
  await scan(0, { nearby: [] });
  expect(station(/River 2 · …1234/)).toBeChecked();
  expect(net()).toBeChecked();
  expect(api.ecoflowPreview).toHaveBeenCalledWith(ACCOUNT_INPUT, RIVER.sn);
});
