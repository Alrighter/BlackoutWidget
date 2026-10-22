// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { App } from '../../src/renderer/src/app/App';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { MainNav, RendererApi } from '../../src/shared/ipc';
import type { AppState, Location, LocationState } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

afterEach(() => vi.useRealTimers());

// The fixture is for 2026-10-17 and the schedule tab is labelled with today's date: pin Date (only) to that day.
const pinDate = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-17T08:50:00Z')); };
const ADDRESS = fixtureSnapshot().address;
const place = (id: string, name: string, over: Partial<Location> = {}): Location =>
  ({ id, name, address: ADDRESS, widgetStyle: 'compact', widgetPosition: null, ...over });
const HOME = place('home', 'Дім');
const PARENTS = place('b', 'Батьки', { widgetStyle: 'ring' });
const locOf = (location: Location, over: Partial<LocationState> = {}): LocationState =>
  ({ location, snapshot: fixtureSnapshot(), phase: 'ok', lineChanged: false, ...over });
/** Батьки are in an emergency outage at the pinned time: «Світла немає», where Дім has «Світло є». */
const parentsDark = (over: Partial<LocationState> = {}) => locOf(PARENTS, {
  snapshot: fixtureSnapshot({ currentOutage: { kind: 'emergency', text: 'Аварія', start: '11:00 17.10.2026', end: '17:00 17.10.2026' } }), ...over,
});
/** EcoFlow belongs to the first location, as after the migration. */
function appState(locations: LocationState[] = [locOf(HOME)], over: Partial<AppState> = {}): AppState {
  return {
    settings: { ...DEFAULT_SETTINGS, locations: locations.map(l => l.location), actualLocationId: locations[0]?.location.id ?? null },
    locations, settingsLoaded: true, ...over,
  };
}
const twoState = (parents: LocationState = parentsDark()) => appState([locOf(HOME), parents]);

interface Fake { api: RendererApi; nav(n: MainNav): void; push(s: AppState): void }
function fake(state: AppState = appState(), extra: Partial<Record<keyof RendererApi, unknown>> = {}): Fake {
  let nav: (n: MainNav) => void = () => {};
  let push: (s: AppState) => void = () => {};
  const api = {
    getState: vi.fn(async () => state), onState: vi.fn((cb: (s: AppState) => void) => { push = cb; return () => {}; }),
    onNavigate: vi.fn((cb: (n: MainNav) => void) => { nav = cb; return () => {}; }),
    listProviders: vi.fn(async () => []), refreshNow: vi.fn(async () => {}),
    addLocation: vi.fn(async () => {}), editLocation: vi.fn(async () => {}),
    ...extra,
  } as unknown as RendererApi;
  return { api, nav: n => act(() => nav(n)), push: s => act(() => push(s)) };
}
/** The location picker in the app bar: a select named «Адреса», shown with 2+ locations. */
const picker = () => screen.getByRole('combobox', { name: 'Адреса' });
const pick = (name: string) => userEvent.selectOptions(picker(), name);
const status = (name: string) => screen.getByRole('heading', { level: 2, name });
const UNREADABLE = 'Не вдалося прочитати налаштування. Спробую ще раз за хвилину.';

describe('settings not loaded: a note, never the wizard', () => {
  test('settingsLoaded false shows the note and no wizard, even when main asks for setup', async () => {
    const f = fake(appState([], { settings: DEFAULT_SETTINGS, settingsLoaded: false }));
    render(<App api={f.api} view="setup" />);
    expect(await screen.findByText(UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Кроки' })).toBeNull();
    expect(screen.queryByText('Перше налаштування')).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Розділи' })).toBeNull();
    f.nav({ view: 'setup' });
    expect(screen.queryByRole('navigation', { name: 'Кроки' })).toBeNull();
  });

  test('settingsLoaded true with no locations shows the wizard, with no «Скасувати»', async () => {
    render(<App api={fake(appState([])).api} view="schedule" />);
    expect(await screen.findByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
    expect(screen.getByText('Перше налаштування')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Скасувати' })).toBeNull();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });

  test('once the file reads, the note gives way to the schedule', async () => {
    pinDate();
    const f = fake(appState([], { settings: DEFAULT_SETTINGS, settingsLoaded: false }));
    render(<App api={f.api} view="schedule" />);
    expect(await screen.findByText(UNREADABLE)).toBeInTheDocument();
    f.push(appState());
    expect(screen.queryByText(UNREADABLE)).toBeNull();
    expect(status('Світло є')).toBeInTheDocument();
  });
});

test('navigate events switch the in-app view each time', async () => {
  pinDate();
  const f = fake();
  render(<App api={f.api} view="schedule" />);
  expect(await screen.findByRole('tab', { name: 'Налаштування' })).toBeInTheDocument();
  f.nav({ view: 'settings' });
  expect(screen.getByRole('button', { name: 'Оновити зараз' })).toBeInTheDocument();
  f.nav({ view: 'setup' });
  expect(screen.getByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
  expect(screen.getByText('Зміна адреси')).toBeInTheDocument();
  f.nav({ view: 'schedule' });
  expect(await screen.findByRole('tab', { name: 'Сьогодні 17.10' })).toBeInTheDocument();
  f.nav({ view: 'setup' });
  expect(screen.getByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
});

test('the tab row: «Графік» selected first, ⟳ beside the tabs refreshes the location now', async () => {
  pinDate();
  const f = fake();
  render(<App api={f.api} view="schedule" />);
  expect(await screen.findByRole('tab', { name: 'Графік' })).toHaveAttribute('aria-selected', 'true');
  expect(within(screen.getByRole('tablist', { name: 'Розділи' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['Графік', 'Налаштування']);
  await userEvent.click(screen.getByRole('button', { name: 'Оновити зараз' }));
  expect(f.api.refreshNow).toHaveBeenCalledTimes(1);
  expect(f.api.refreshNow).toHaveBeenCalledWith('home');
});

test('⟳ for a location main no longer has leaves no unhandled rejection', async () => {
  pinDate();
  const gone = new Error("Error invoking remote method 'refresh:now': Error: Цієї адреси вже немає");
  // A plain function, not vi.fn: a mock's own bookkeeping handles the promise it returns.
  const asked: (string | undefined)[] = [];
  const f = fake(appState(), { refreshNow: (id?: string) => { asked.push(id); return Promise.reject(gone); } });
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    render(<App api={f.api} view="schedule" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Оновити зараз' }));
    expect(asked).toEqual(['home']);
    await new Promise(r => setTimeout(r, 0));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('one location: no switcher', async () => {
  pinDate();
  render(<App api={fake().api} view="schedule" />);
  expect(await screen.findByRole('tab', { name: 'Графік' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Адреса' })).toBeNull();
});

test('two locations: the picker picks the schedule', async () => {
  pinDate();
  const f = fake(twoState());
  render(<App api={f.api} view="schedule" />);
  expect(await screen.findByRole('combobox', { name: 'Адреса' })).toBeInTheDocument();
  expect(within(picker()).getAllByRole('option').map(o => o.textContent)).toEqual(['Дім', 'Батьки']);
  expect(picker()).toHaveDisplayValue('Дім');
  // Where: on the right, beside the refresh button, away from the section tabs (what).
  expect(screen.getByRole('button', { name: 'Оновити зараз' }).parentElement).toContainElement(picker());
  expect(status('Світло є')).toBeInTheDocument();
  // The section tabs are their own tablist, unchanged.
  expect(within(screen.getByRole('tablist', { name: 'Розділи' })).getAllByRole('tab').map(t => t.textContent)).toEqual(['Графік', 'Налаштування']);

  await pick('Батьки');
  expect(picker()).toHaveDisplayValue('Батьки');
  expect(status('Світла немає')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 2, name: 'Світло є' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Оновити зараз' }));
  expect(f.api.refreshNow).toHaveBeenCalledTimes(1);
  expect(f.api.refreshNow).toHaveBeenCalledWith('b');

  // The settings follow the selection too, and the picker stays.
  await userEvent.click(screen.getByRole('tab', { name: 'Налаштування' }));
  expect(within(screen.getByRole('heading', { name: 'Адреса' }).closest('section')!).getByText('Батьки')).toBeInTheDocument();
  expect(picker()).toHaveDisplayValue('Батьки');
});

describe('a navigate with a locationId selects it', () => {
  test('from a navigate', async () => {
    pinDate();
    const f = fake(twoState());
    render(<App api={f.api} view="schedule" />);
    expect(await screen.findByRole('combobox', { name: 'Адреса' })).toBeInTheDocument();
    f.nav({ view: 'settings', locationId: 'b' });
    expect(picker()).toHaveDisplayValue('Батьки');
    expect(screen.getByRole('tab', { name: 'Налаштування' })).toHaveAttribute('aria-selected', 'true');
    // A navigate without an id keeps the selection.
    f.nav({ view: 'schedule' });
    expect(picker()).toHaveDisplayValue('Батьки');
    expect(status('Світла немає')).toBeInTheDocument();
    f.nav({ view: 'schedule', locationId: 'home' });
    expect(picker()).toHaveDisplayValue('Дім');
    expect(status('Світло є')).toBeInTheDocument();
  });

  test('from the window\'s query', async () => {
    pinDate();
    render(<App api={fake(twoState()).api} view="schedule" locationId="b" />);
    expect(await screen.findByRole('combobox', { name: 'Адреса' })).toBeInTheDocument();
    expect(picker()).toHaveDisplayValue('Батьки');
    expect(status('Світла немає')).toBeInTheDocument();
  });

  test('an unknown id, or a selected one that is gone, falls back to the first location', async () => {
    pinDate();
    const f = fake(twoState());
    render(<App api={f.api} view="schedule" locationId="gone" />);
    expect(await screen.findByRole('combobox', { name: 'Адреса' })).toBeInTheDocument();
    expect(picker()).toHaveDisplayValue('Дім');
    await pick('Батьки');
    // Батьки deleted: back on Дім, and with one location left no switcher.
    f.push(appState([locOf(HOME)]));
    expect(screen.queryByRole('combobox', { name: 'Адреса' })).toBeNull();
    expect(status('Світло є')).toBeInTheDocument();
  });
});

test('Додати адресу opens the add wizard; Скасувати returns without saving', async () => {
  pinDate();
  const f = fake(twoState());
  render(<App api={f.api} view="settings" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Додати адресу' }));
  expect(screen.getByText('Нова адреса')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Адреса' })).toBeNull(); // the wizard fills the window
  await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(screen.getByRole('tab', { name: 'Налаштування' })).toHaveAttribute('aria-selected', 'true');
  expect(f.api.addLocation).not.toHaveBeenCalled();
  expect(f.api.editLocation).not.toHaveBeenCalled();
});

/** The one provider, city, street and one-line house the wizard walks through. */
const wizardApi = {
  listProviders: vi.fn(async () => [{ id: 'dtek-krem', displayName: 'ДТЕК Київські регіональні електромережі' }]),
  listCities: vi.fn(async () => ['м. Біла Церква']), listStreets: vi.fn(async () => ['бул. Грушевського Михайла']),
  listHouses: vi.fn(async () => [{ house: '40', outageActive: false, lines: [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }] }]),
  setAutostart: vi.fn(async () => {}),
};
async function walkWizard(user: UserEvent) {
  const next = () => screen.getByRole('button', { name: 'Далі' });
  expect(await screen.findByRole('radio', { name: /Київська область/, checked: true })).toBeInTheDocument();
  await user.click(next());
  await user.type(await screen.findByRole('combobox', { name: 'Місто або село' }), 'Біла');
  await user.click(screen.getByRole('option', { name: 'м. Біла Церква' })); await user.click(next());
  await user.click(await screen.findByText('бул. Грушевського Михайла')); await user.click(next());
  await user.click(await screen.findByText('40')); await user.click(next());
  await user.click(next());
  expect(await screen.findByText('Крок 7 з 7')).toBeInTheDocument();
}

test('the line-changed banner\'s «Змінити адресу» edits the selected location, never another', async () => {
  pinDate();
  const user = userEvent.setup();
  const f = fake(twoState(parentsDark({ lineChanged: true })), wizardApi);
  render(<App api={f.api} view="schedule" locationId="b" />);
  await user.click(await screen.findByRole('button', { name: 'Змінити адресу' }));
  expect(screen.getByText('Зміна адреси')).toBeInTheDocument();
  await walkWizard(user);
  expect(screen.getByRole('textbox', { name: 'Назва' })).toHaveValue('Батьки');
  await user.click(screen.getByRole('button', { name: 'Завершити' }));
  expect(f.api.editLocation).toHaveBeenCalledTimes(1);
  expect(f.api.editLocation).toHaveBeenCalledWith('b', { name: 'Батьки', address: ADDRESS, widgetStyle: 'ring' });
  expect(f.api.addLocation).not.toHaveBeenCalled();
  // Done: back on the schedule, Батьки still selected.
  expect(await screen.findByRole('tab', { name: 'Графік' })).toHaveAttribute('aria-selected', 'true');
  expect(picker()).toHaveDisplayValue('Батьки');
});

test('the first setup stays the first setup when its own location arrives before it is done', async () => {
  pinDate();
  const user = userEvent.setup();
  const f = fake(appState([]), wizardApi);
  let returned!: () => void;
  (f.api.addLocation as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(r => { returned = r; }));
  // Opened by main for the first setup: «setup» with no locations.
  render(<App api={f.api} view="setup" />);
  await walkWizard(user);
  expect(screen.getByText('Перше налаштування')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Назва' })).toHaveValue('Дім');
  await user.click(screen.getByRole('button', { name: 'Завершити' }));
  expect(f.api.addLocation).toHaveBeenCalledTimes(1);
  // Main pushes the new state before the add call returns: the same wizard stays, not an edit of the new location.
  f.push(appState());
  expect(screen.getByText('Перше налаштування')).toBeInTheDocument();
  expect(screen.queryByText('Зміна адреси')).toBeNull();
  expect(screen.getByText('Крок 7 з 7')).toBeInTheDocument();
  await act(async () => returned());
  expect(f.api.editLocation).not.toHaveBeenCalled();
  expect(await screen.findByRole('tab', { name: 'Графік' })).toHaveAttribute('aria-selected', 'true');
  expect(status('Світло є')).toBeInTheDocument();
});

describe('after «Додати адресу»', () => {
  const COTTAGE = place('c', 'Дача');
  /** The state main pushes once «Дача» is added: no schedule fetched for it yet. */
  const added = () => appState([locOf(HOME), parentsDark(), locOf(COTTAGE, { snapshot: null })]);
  async function addCottage(user: UserEvent, f: Fake) {
    await user.click(await screen.findByRole('button', { name: 'Додати адресу' }));
    await walkWizard(user);
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), 'Дача');
    await user.click(screen.getByRole('button', { name: 'Завершити' }));
    expect(f.api.addLocation).toHaveBeenCalledWith({ name: 'Дача', address: ADDRESS, widgetStyle: 'compact' });
  }
  const expectCottageShown = () => {
    expect(picker()).toHaveDisplayValue('Дача');
    expect(screen.getByRole('tab', { name: 'Графік' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Дані ще не отримано')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Світло є' })).toBeNull();
  };

  test('the state lands before the add call returns: the saved name is never «taken», then the new location is selected', async () => {
    pinDate();
    const user = userEvent.setup();
    const f = fake(twoState(), wizardApi);
    let returned!: () => void;
    (f.api.addLocation as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(r => { returned = r; }));
    render(<App api={f.api} view="settings" />);
    await addCottage(user, f);
    f.push(added());
    // Still the same add wizard: its own new name is not flagged as one already there.
    expect(screen.getByText('Нова адреса')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Така назва вже є')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Назва' })).not.toHaveAttribute('aria-invalid');
    await act(async () => returned());
    expectCottageShown();
  });

  test('the add call returns before the state lands: the new location is selected once it does', async () => {
    pinDate();
    const user = userEvent.setup();
    const f = fake(twoState(), wizardApi);
    render(<App api={f.api} view="settings" locationId="b" />);
    await addCottage(user, f);
    // Back on the schedule; the new location is not in the state yet.
    expect(await screen.findByRole('tab', { name: 'Графік' })).toHaveAttribute('aria-selected', 'true');
    expect(picker()).toHaveDisplayValue('Батьки');
    f.push(added());
    expectCottageShown();
    // Only once: a later push does not pull the selection back.
    await user.selectOptions(picker(), 'Дім');
    f.push(added());
    expect(picker()).toHaveDisplayValue('Дім');
  });

  test('a cancelled add selects nothing new', async () => {
    pinDate();
    const user = userEvent.setup();
    const f = fake(twoState(), wizardApi);
    render(<App api={f.api} view="settings" />);
    await user.click(await screen.findByRole('button', { name: 'Додати адресу' }));
    await user.click(screen.getByRole('button', { name: 'Скасувати' }));
    // A location that appears some other way (another window, a settings re-read) does not take the selection.
    f.push(added());
    expect(picker()).toHaveDisplayValue('Дім');
  });
});

test.each(['Підключити EcoFlow', 'Підключити'])('«%s» opens the settings with the EcoFlow form open, once', async name => {
  pinDate();
  render(<App api={fake().api} view="schedule" />);
  await userEvent.click(await screen.findByRole('button', { name }));
  expect(screen.getByRole('tab', { name: 'Налаштування' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByLabelText('Email')).toBeInTheDocument();
  // Going back and forth by the tabs shows the settings as usual, the form closed.
  await userEvent.click(screen.getByRole('tab', { name: 'Графік' }));
  await userEvent.click(screen.getByRole('tab', { name: 'Налаштування' }));
  expect(screen.queryByLabelText('Email')).toBeNull();
  expect(screen.getByRole('button', { name: 'Підключити EcoFlow' })).toBeInTheDocument();
});

test('back from the wizard the settings show the EcoFlow form closed', async () => {
  pinDate();
  render(<App api={fake().api} view="schedule" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Підключити EcoFlow' }));
  await userEvent.click(screen.getByRole('button', { name: 'Змінити адресу' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Скасувати' }));
  expect(screen.getByRole('tab', { name: 'Налаштування' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.queryByLabelText('Email')).toBeNull();
});
