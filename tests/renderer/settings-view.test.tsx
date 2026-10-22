// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from '../../src/renderer/src/app/SettingsView';
import { DEFAULT_SETTINGS } from '../../src/main/store';
import type { RendererApi } from '../../src/shared/ipc';
import type { AppState, Location, LocationState, ScheduleSnapshot, Settings } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

function mockApi(over: Partial<Record<keyof RendererApi, unknown>> = {}) {
  return {
    setWidgetStyle: vi.fn(async () => {}), setAutostart: vi.fn(async () => {}), refreshNow: vi.fn(async () => {}),
    renameLocation: vi.fn(async () => {}), deleteLocation: vi.fn(async () => {}), setActualLocation: vi.fn(async () => {}),
    ...over,
  } as unknown as RendererApi;
}
const ADDRESS = fixtureSnapshot().address;
const place = (id: string, name: string, over: Partial<Location> = {}): Location =>
  ({ id, name, address: ADDRESS, widgetStyle: 'compact', widgetPosition: null, ...over });
const HOME = place('home', 'Дім');
const PARENTS = place('b', 'Батьки', { address: { ...ADDRESS, house: '12' } });
const locOf = (location: Location = HOME, snapshot: ScheduleSnapshot | null = fixtureSnapshot()): LocationState =>
  ({ location, snapshot, phase: 'ok', lineChanged: false });
function stateOf(locations: LocationState[] = [locOf()], settings: Partial<Settings> = {}): AppState {
  return {
    settings: { ...DEFAULT_SETTINGS, locations: locations.map(l => l.location), actualLocationId: 'home', ...settings },
    locations, actual: null, settingsLoaded: true,
  };
}
/** The address card alone: the EcoFlow card's picker lists the names too. */
const card = () => within(screen.getByRole('heading', { name: 'Адреса' }).closest('section')!);
const TWO = () => stateOf([locOf(HOME), locOf(PARENTS)]);
function view(state: AppState = stateOf(), opts: { loc?: LocationState; api?: RendererApi; onChangeAddress?: () => void; onAdd?: () => void } = {}) {
  const { loc = state.locations[0], api = mockApi(), onChangeAddress = () => {}, onAdd = () => {} } = opts;
  return render(<SettingsView state={state} loc={loc} api={api} onChangeAddress={onChangeAddress} onAdd={onAdd} />);
}

test('the address card: the name, the address, then source · line · queue; «Змінити адресу» opens the wizard', async () => {
  const onChangeAddress = vi.fn();
  view(stateOf(), { onChangeAddress });
  expect(screen.getByRole('heading', { name: 'Адреса' })).toBeInTheDocument();
  expect(card().getByText('Дім')).toBeInTheDocument();
  expect(screen.getByText('м. Біла Церква, бул. Грушевського Михайла, 40')).toBeInTheDocument();
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 1 · черга 1.2')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Змінити адресу' }));
  expect(onChangeAddress).toHaveBeenCalledTimes(1);
});

test('the address card shows the selected location\'s name and address', () => {
  const state = TWO();
  view(state, { loc: state.locations[1] });
  expect(card().getByText('Батьки')).toBeInTheDocument();
  expect(screen.getByText('м. Біла Церква, бул. Грушевського Михайла, 12')).toBeInTheDocument();
  expect(card().queryByText('Дім')).toBeNull();
  expect(screen.queryByText('м. Біла Церква, бул. Грушевського Михайла, 40')).toBeNull();
});

test('the queue label keeps its abbreviation: «не залучено до ГПВ»', () => {
  const snapshot = { ...fixtureSnapshot(), groupLabel: 'Не залучено до ГПВ' };
  view(stateOf([locOf(HOME, snapshot)]));
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 1 · не залучено до ГПВ')).toBeInTheDocument();
});

test('the queue is left out while the schedule is for another queue', () => {
  const location = place('home', 'Дім', { address: { ...ADDRESS, lineIndex: 2, groupId: 'GPV4.2' } });
  view(stateOf([locOf(location)]));
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 2')).toBeInTheDocument();
});

describe('Перейменувати edits inline', () => {
  test('«Зберегти» calls renameLocation(id, name) and closes the field', async () => {
    const api = mockApi(); const user = userEvent.setup(); const state = TWO();
    view(state, { loc: state.locations[1], api });
    await user.click(screen.getByRole('button', { name: 'Перейменувати' }));
    const field = screen.getByRole('textbox', { name: 'Назва' });
    expect(field).toHaveValue('Батьки');
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('maxlength', '24');
    await user.clear(field); await user.type(field, 'Хата');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(api.renameLocation).toHaveBeenCalledTimes(1);
    expect(api.renameLocation).toHaveBeenCalledWith('b', 'Хата');
    expect(screen.queryByRole('textbox', { name: 'Назва' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Перейменувати' })).toHaveFocus();
  });

  test('«Скасувати» calls nothing and keeps the name', async () => {
    const api = mockApi(); const user = userEvent.setup(); const state = TWO();
    view(state, { loc: state.locations[1], api });
    await user.click(screen.getByRole('button', { name: 'Перейменувати' }));
    await user.type(screen.getByRole('textbox', { name: 'Назва' }), ' нова');
    await user.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(api.renameLocation).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Назва' })).toBeNull();
    expect(card().getByText('Батьки')).toBeInTheDocument();
  });

  test('a taken name shows «Така назва вже є» and cannot be saved; an empty one «Вкажіть назву»', async () => {
    const api = mockApi(); const user = userEvent.setup(); const state = TWO();
    view(state, { loc: state.locations[1], api });
    await user.click(screen.getByRole('button', { name: 'Перейменувати' }));
    const field = screen.getByRole('textbox', { name: 'Назва' });
    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(field);
    expect(screen.getByRole('alert')).toHaveTextContent('Вкажіть назву');
    await user.type(field, ' дім ');
    expect(screen.getByRole('alert')).toHaveTextContent('Така назва вже є');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Така назва вже є');
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
    // Its own name, in another case, is not «taken».
    await user.clear(field); await user.type(field, 'БАТЬКИ');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled();
  });

  test('a refused rename shows main\'s reason and keeps the field open', async () => {
    const api = mockApi({ renameLocation: vi.fn(async () => { throw new Error("Error invoking remote method 'loc:rename': Error: Цієї адреси вже немає"); }) });
    const user = userEvent.setup(); const state = TWO();
    view(state, { loc: state.locations[1], api });
    await user.click(screen.getByRole('button', { name: 'Перейменувати' }));
    const field = screen.getByRole('textbox', { name: 'Назва' });
    await user.clear(field); await user.type(field, 'Хата');
    await user.click(screen.getByRole('button', { name: 'Зберегти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Цієї адреси вже немає');
    expect(screen.getByRole('textbox', { name: 'Назва' })).toHaveValue('Хата');
  });
});

describe('Видалити asks first', () => {
  const QUESTION = 'Видалити локацію «Батьки»? Її віджет зникне з робочого столу.';

  test('the question, then «Скасувати» deletes nothing; confirming calls deleteLocation(id)', async () => {
    const api = mockApi(); const user = userEvent.setup(); const state = TWO();
    view(state, { loc: state.locations[1], api });
    expect(screen.queryByText(QUESTION)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Видалити' }));
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    // While asking, the card's own buttons step aside: one «Видалити», the confirming one.
    expect(screen.getAllByRole('button', { name: 'Видалити' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Перейменувати' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Скасувати' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Скасувати' }));
    expect(api.deleteLocation).not.toHaveBeenCalled();
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(screen.getByRole('button', { name: 'Видалити' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Видалити' }));
    await user.click(screen.getByRole('button', { name: 'Видалити' }));
    expect(api.deleteLocation).toHaveBeenCalledTimes(1);
    expect(api.deleteLocation).toHaveBeenCalledWith('b');
  });

  test('a refused delete shows main\'s reason', async () => {
    const api = mockApi({ deleteLocation: vi.fn(async () => { throw new Error("Error invoking remote method 'loc:delete': Error: Останню адресу видалити не можна"); }) });
    const user = userEvent.setup(); const state = TWO();
    view(state, { loc: state.locations[1], api });
    await user.click(screen.getByRole('button', { name: 'Видалити' }));
    await user.click(screen.getByRole('button', { name: 'Видалити' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Останню адресу видалити не можна');
  });

  test('«Перейменувати» is one of the card\'s buttons, beside «Змінити адресу» and styled like it', () => {
    view(TWO());
    const rename = screen.getByRole('button', { name: 'Перейменувати' });
    const change = screen.getByRole('button', { name: 'Змінити адресу' });
    expect(rename.parentElement).toBe(change.parentElement);
    expect(rename.className).toBe(change.className);
    expect(card().getByText('Дім').parentElement).not.toContainElement(rename);
  });

  test('there is no «Видалити» with one location', () => {
    view(stateOf());
    expect(screen.queryByRole('button', { name: 'Видалити' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Перейменувати' })).toBeInTheDocument();
  });
});

describe('Додати адресу', () => {
  test('starts the add wizard', async () => {
    const onAdd = vi.fn();
    view(TWO(), { onAdd });
    await userEvent.click(screen.getByRole('button', { name: 'Додати адресу' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Можна додати до 5 адрес')).toBeNull();
  });

  test('disabled at 5 with «Можна додати до 5 адрес»', async () => {
    const onAdd = vi.fn();
    const five = ['Дім', 'Батьки', 'Дача', 'Офіс', 'Бабуся'].map((name, i) => locOf(place(i ? `l${i}` : 'home', name)));
    view(stateOf(five), { onAdd });
    const add = screen.getByRole('button', { name: 'Додати адресу' });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription('Можна додати до 5 адрес');
    expect(screen.getByText('Можна додати до 5 адрес')).toBeInTheDocument();
    await userEvent.click(add);
    expect(onAdd).not.toHaveBeenCalled();
  });
});

test('style cards: three radios with sizes, the saved one checked; a click saves the style', async () => {
  const api = mockApi();
  view(stateOf([locOf(place('home', 'Дім', { widgetStyle: 'ring' }))]), { api });
  const group = screen.getByRole('radiogroup', { name: 'Стиль віджета' });
  const radios = within(group).getAllByRole('radio');
  const names = ['Компакт', 'Циферблат', 'Таймлайн'], sizes = ['290×150', '236×260', '400×200'];
  radios.forEach((r, i) => {
    expect(r).toHaveAccessibleName(names[i]);
    expect(r).toHaveAccessibleDescription(sizes[i]); // the size is announced too
  });
  expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
  for (const size of sizes) expect(within(group).getByText(size)).toBeInTheDocument();
  await userEvent.click(within(group).getByRole('radio', { name: 'Таймлайн' }));
  expect(api.setWidgetStyle).toHaveBeenCalledWith('home', 'timeline');
});

test('the style card sets the selected location\'s style', async () => {
  const api = mockApi(); const state = TWO();
  view(state, { loc: state.locations[1], api });
  const group = screen.getByRole('radiogroup', { name: 'Стиль віджета' });
  expect(within(group).getByRole('radio', { name: 'Компакт' })).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(within(group).getByRole('radio', { name: 'Циферблат' }));
  expect(api.setWidgetStyle).toHaveBeenCalledTimes(1);
  expect(api.setWidgetStyle).toHaveBeenCalledWith('b', 'ring');
});

test('each style card shows its thumbnail: a hidden drawing at the widget\'s proportions', () => {
  view();
  const radios = within(screen.getByRole('radiogroup', { name: 'Стиль віджета' })).getAllByRole('radio');
  expect(radios.map(r => {
    const svg = r.querySelector('svg.st-thumb-art');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg!.querySelector('rect')).not.toBeNull();
    return svg!.getAttribute('viewBox');
  })).toEqual(['0 0 290 150', '0 0 236 260', '0 0 400 200']);
});

test('the autostart switch is named by its label, shows the setting and flips it', async () => {
  const api = mockApi();
  const loc = locOf();
  const { rerender } = render(<SettingsView state={stateOf([loc], { autostart: true })} loc={loc} api={api} onChangeAddress={() => {}} onAdd={() => {}} />);
  const sw = screen.getByRole('switch', { name: 'Запускати разом із системою' });
  expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(sw).toHaveAccessibleDescription('Віджет з’явиться після входу');
  await userEvent.click(sw);
  expect(api.setAutostart).toHaveBeenLastCalledWith(false);
  rerender(<SettingsView state={stateOf([loc], { autostart: false })} loc={loc} api={api} onChangeAddress={() => {}} onAdd={() => {}} />);
  expect(sw).toHaveAttribute('aria-checked', 'false');
  // The label is a click target too.
  await userEvent.click(screen.getByText('Запускати разом із системою'));
  expect(api.setAutostart).toHaveBeenLastCalledWith(true);
});

test('the schedule row: «Оновлено о HH:MM» of the selected location\'s fetch; «Оновити зараз» refreshes it alone', async () => {
  const api = mockApi();
  const state = stateOf([locOf(HOME), locOf(PARENTS, fixtureSnapshot({ fetchedAt: '2026-10-17T11:50:00.000Z' }))]);
  view(state, { loc: state.locations[1], api });
  expect(screen.getByText('Графік відключень')).toBeInTheDocument();
  expect(screen.getByText('Оновлено о 14:50')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Оновити зараз' }));
  expect(api.refreshNow).toHaveBeenCalledTimes(1);
  expect(api.refreshNow).toHaveBeenCalledWith('b');
});

test('«Оновити зараз» for a location main no longer has leaves no unhandled rejection', async () => {
  const gone = new Error("Error invoking remote method 'refresh:now': Error: Цієї адреси вже немає");
  // A plain function, not vi.fn: a mock's own bookkeeping handles the promise it returns.
  const asked: (string | undefined)[] = [];
  const api = mockApi({ refreshNow: (id?: string) => { asked.push(id); return Promise.reject(gone); } });
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    view(stateOf(), { api });
    await userEvent.click(screen.getByRole('button', { name: 'Оновити зараз' }));
    expect(asked).toEqual(['home']);
    await new Promise(r => setTimeout(r, 0));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});

test('no schedule yet: the row says so', () => {
  view(stateOf([locOf(HOME, null)]));
  expect(screen.getByText('Дані ще не отримано')).toBeInTheDocument();
  expect(screen.getByText('ДТЕК Київські регіональні електромережі · Лінія 1')).toBeInTheDocument();
});

test('the EcoFlow section sits in the settings with its source chip', () => {
  view();
  expect(screen.getByRole('heading', { name: 'Фактичний стан світла' })).toBeInTheDocument();
  expect(screen.getByText('EcoFlow')).toBeInTheDocument();
});

test('switching the location closes a rename or a delete question left open', async () => {
  const user = userEvent.setup(); const state = TWO(); const api = mockApi();
  const props = { state, api, onChangeAddress: () => {}, onAdd: () => {} };
  const { rerender } = render(<SettingsView {...props} loc={state.locations[1]} />);
  await user.click(screen.getByRole('button', { name: 'Перейменувати' }));
  rerender(<SettingsView {...props} loc={state.locations[0]} />);
  expect(screen.queryByRole('textbox', { name: 'Назва' })).toBeNull();
  expect(card().getByText('Дім')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Видалити' }));
  rerender(<SettingsView {...props} loc={state.locations[1]} />);
  expect(screen.queryByText(/^Видалити локацію/)).toBeNull();
});
