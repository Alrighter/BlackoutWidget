// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { SetupWizard } from '../../src/renderer/src/app/SetupWizard';
import type { RendererApi } from '../../src/shared/ipc';
import { outageRanges } from '../../src/shared/outage-ranges';
import type { HouseInfo, LineInfo } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

function mockApi(houses: HouseInfo[], houseLines?: RendererApi['houseLines']) {
  return { listProviders: vi.fn(async () => [{ id: 'dtek-krem', displayName: 'ДТЕК Київські регіональні електромережі' }]),
    listCities: vi.fn(async () => ['м. Біла Церква', 'с-ще Козин']), listStreets: vi.fn(async () => ['бул. Грушевського Михайла']),
    listHouses: vi.fn(async () => houses),
    previewLines: vi.fn(async () => houses[0].lines.map(line => ({ line, today: fixtureSnapshot().days[0] }))),
    solveCaptcha: vi.fn(async () => {}), saveAddress: vi.fn(async () => {}), setWidgetStyle: vi.fn(async () => {}),
    setAutostart: vi.fn(async () => {}), openProviderSite: vi.fn(), ...(houseLines ? { houseLines } : {}) } as unknown as RendererApi;
}
const two = [{ house: '40', outageActive: false, lines: [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }, { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' }] }];
const OUTAGE_NOTE = 'Зараз для цього будинку діє відключення — список ліній може бути неповним. Якщо вашої лінії немає, спробуйте пізніше.';
/** A street of houses 1..n, each on one line. */
const street = (n: number): HouseInfo[] => Array.from({ length: n }, (_, i) => ({ house: String(i + 1), outageActive: false, lines: [two[0].lines[0]] }));
const tabbable = () => screen.getAllByRole('radio').filter(r => r.tabIndex === 0).map(r => r.textContent);
async function toHouseStep(user: UserEvent) {
  // D4: the only supported source, as a region card, picked already.
  expect(await screen.findByRole('radio', { name: /Київська область/, checked: true })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.type(await screen.findByRole('combobox', { name: 'Місто або село' }), 'Біла');
  expect(screen.queryByText('с-ще Козин')).toBeNull();
  await user.click(screen.getByRole('option', { name: 'м. Біла Церква' })); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('бул. Грушевського Михайла')); await user.click(screen.getByRole('button', { name: 'Далі' }));
}
async function pickAddress(user: UserEvent) {
  await toHouseStep(user);
  await user.click(await screen.findByText('40'));
}
test('two lines: shows both previews and saves chosen line', async () => {
  const api = mockApi(two); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={onDone} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · черга 1.2')).toBeInTheDocument(); expect(screen.getByText('Лінія 2 · черга 4.2')).toBeInTheDocument();
  // Each line's radio is described by today's outage times shown beside it.
  const times = outageRanges(fixtureSnapshot().days[0].slots).join(', ');
  expect(times).not.toBe('');
  expect(screen.getByRole('radio', { name: 'Лінія 1 · черга 1.2' })).toHaveAccessibleDescription(times);
  await user.click(screen.getByText('Лінія 1 · черга 1.2')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(screen.getByText('Таймлайн')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(screen.getByRole('button', { name: 'Завершити' }));
  expect(api.saveAddress).toHaveBeenCalledWith({ providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' });
  expect(api.setWidgetStyle).toHaveBeenCalledWith('timeline'); expect(onDone).toHaveBeenCalled();
});
test('one line: skips line step', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [two[0].lines[0]] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Компакт')).toBeInTheDocument(); expect(api.previewLines).not.toHaveBeenCalled();
  // The rail keeps all seven steps: the skipped «Лінія» still counts, and screen readers hear the done ones as done.
  expect(screen.getByText('Крок 6 з 7')).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Кроки' })).getAllByText(/пройдено/)).toHaveLength(5);
});
test('up to 24 houses: just the grid, no filter', async () => {
  const user = userEvent.setup();
  render(<SetupWizard api={mockApi(street(24))} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  expect(await screen.findAllByRole('radio')).toHaveLength(24);
  expect(screen.queryByRole('textbox', { name: 'Номер будинку' })).toBeNull();
});
test('more than 24 houses: a filter field narrows the grid, matching as the old house search', async () => {
  const api = mockApi(street(30)); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  const filter = await screen.findByRole('textbox', { name: 'Номер будинку' });
  expect(filter).toHaveFocus();
  expect(screen.getAllByRole('radio')).toHaveLength(30);
  await user.type(filter, ' 2');
  expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['2', '12', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29']);
  await user.type(filter, '5');
  await user.click(screen.getByRole('radio', { name: '25' }));
  expect(screen.getByRole('button', { name: 'Далі' })).toBeEnabled();
  await user.type(filter, '9');
  // Nothing matches «259»: the note says so, and the picked house stays (see the next test).
  expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['25']);
  expect(screen.getByText('Нічого не знайдено')).toBeInTheDocument();
});
test('the filter never hides the picked house: it keeps its place in the grid', async () => {
  const user = userEvent.setup();
  render(<SetupWizard api={mockApi(street(30))} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  await user.click(await screen.findByRole('radio', { name: '7' }));
  await user.type(screen.getByRole('textbox', { name: 'Номер будинку' }), '2');
  expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['2', '7', '12', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29']);
  expect(screen.getByRole('radio', { name: '7' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.queryByText('Нічого не знайдено')).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeEnabled();
});
test('the house grid is one Tab stop: arrows move the focus, a row is 6, Space picks', async () => {
  const user = userEvent.setup();
  render(<SetupWizard api={mockApi(street(8))} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  const house = (n: string) => screen.getByRole('radio', { name: n });
  await screen.findByRole('radio', { name: '1' });
  expect(tabbable()).toEqual(['1']);
  await user.tab(); expect(house('1')).toHaveFocus();
  await user.keyboard('{ArrowRight}'); expect(house('2')).toHaveFocus();
  await user.keyboard('{ArrowDown}'); expect(house('8')).toHaveFocus();
  await user.keyboard('{ArrowDown}'); expect(house('8')).toHaveFocus();
  await user.keyboard('{ArrowUp}'); expect(house('2')).toHaveFocus();
  await user.keyboard('{ArrowLeft}'); expect(house('1')).toHaveFocus();
  await user.keyboard('{ArrowLeft}'); expect(house('1')).toHaveFocus();
  await user.keyboard('{ArrowRight}{ArrowRight}[Space]');
  expect(house('3')).toHaveAttribute('aria-checked', 'true');
  expect(tabbable()).toEqual(['3']);
  await user.tab(); expect(screen.getByRole('button', { name: 'Назад' })).toHaveFocus();
});
test('each new step\'s title takes the focus, unless the step\'s own field does; nothing on first show', async () => {
  const user = userEvent.setup();
  render(<SetupWizard api={mockApi(two)} autostart widgetStyle="compact" onDone={() => {}} />);
  await screen.findByRole('radio', { name: /Київська область/, checked: true });
  expect(document.body).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByRole('combobox', { name: 'Місто або село' })).toHaveFocus();
  await user.click(await screen.findByText('м. Біла Церква')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByRole('combobox', { name: 'Вулиця' })).toHaveFocus();
  await user.click(await screen.findByText('бул. Грушевського Михайла')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(screen.getByRole('heading', { name: 'Будинок' })).toHaveFocus();
  await user.click(await screen.findByText('40')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(screen.getByRole('heading', { name: 'Лінія' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Назад' }));
  expect(screen.getByRole('heading', { name: 'Будинок' })).toHaveFocus();
});
test('«Скасувати» shows only when an address is set, and leaves without saving', async () => {
  const api = mockApi(two); const onCancel = vi.fn(); const user = userEvent.setup();
  const { rerender } = render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />);
  await screen.findByRole('radio', { name: /Київська область/, checked: true });
  expect(screen.queryByRole('button', { name: 'Скасувати' })).toBeNull();
  rerender(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} onCancel={onCancel} />);
  await user.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(api.saveAddress).not.toHaveBeenCalled(); expect(api.setWidgetStyle).not.toHaveBeenCalled();
});
test('no lines: explains and blocks', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeInTheDocument();
  expect(screen.queryByText(OUTAGE_NOTE)).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('active outage: the house and line steps warn that the line list may be incomplete', async () => {
  const api = mockApi([{ ...two[0], outageActive: true }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 2 · черга 4.2')).toBeInTheDocument();
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
});
test('active outage and one line: the line step is shown, needs an explicit choice, nothing is saved before it', async () => {
  const api = mockApi([{ house: '40', outageActive: true, lines: [two[0].lines[0]] }]); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={onDone} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · черга 1.2')).toBeInTheDocument();
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  expect(api.previewLines).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
  expect(api.saveAddress).not.toHaveBeenCalled();
  await user.click(screen.getByText('Лінія 1 · черга 1.2')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(screen.getByRole('button', { name: 'Далі' })); await user.click(screen.getByRole('button', { name: 'Завершити' }));
  expect(api.saveAddress).toHaveBeenCalledWith({ providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' });
  expect(onDone).toHaveBeenCalled();
});
test('active outage and no lines: only the outage note, still blocked', async () => {
  const api = mockApi([{ house: '40', outageActive: true, lines: [] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  expect(screen.queryByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('the line step opens the schedule on the DTEK site (D11)', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByRole('button', { name: 'Відкрити графік на сайті ДТЕК' }));
  expect(api.openProviderSite).toHaveBeenCalledTimes(1);
  expect(api.openProviderSite).toHaveBeenCalledWith('dtek-krem');
});
test('the line step subline names the provider', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText(/з сайтом ДТЕК і оберіть свою\.$/)).toBeInTheDocument();
});
test('«Готово» sums up the choice and switches autostart; nothing is saved before «Завершити»', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [two[0].lines[0]] }]); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={onDone} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' })); await user.click(await screen.findByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Крок 7 з 7')).toBeInTheDocument();
  expect(screen.getByText('м. Біла Церква, бул. Грушевського Михайла, 40')).toBeInTheDocument();
  expect(screen.getByText('Лінія 1 · черга 1.2 · стиль «Компакт»')).toBeInTheDocument();
  const autostart = screen.getByRole('switch', { name: 'Запускати разом із системою' });
  expect(autostart).toHaveAttribute('aria-checked', 'true');
  await user.click(autostart);
  expect(api.setAutostart).toHaveBeenCalledWith(false);
  expect(api.saveAddress).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Завершити' }));
  // The single line was picked without the «Лінія» step.
  expect(api.saveAddress).toHaveBeenCalledWith({ providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' });
  expect(api.setWidgetStyle).toHaveBeenCalledWith('compact'); expect(onDone).toHaveBeenCalled();
});
test('a line label is lower-cased at its first letter only: «не залучено до ГПВ» keeps the abbreviation', async () => {
  const lines = [{ index: 1, groupId: '4.2', label: 'Черга 4.2' }, { index: 2, groupId: 'none', label: 'Не залучено до ГПВ' }];
  const api = mockApi([{ house: '40', outageActive: false, lines }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('Лінія 2 · не залучено до ГПВ')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(screen.getByText('Лінія 2 · не залучено до ГПВ · стиль «Компакт»')).toBeInTheDocument();
});
test('changing the address keeps the widget style: the style step starts from the saved one', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [two[0].lines[0]] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="ring" onDone={() => {}} onCancel={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByRole('radio', { name: 'Циферблат' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('radio', { name: 'Компакт' })).toHaveAttribute('aria-checked', 'false');
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(screen.getByText('Лінія 1 · черга 1.2 · стиль «Циферблат»')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Завершити' }));
  expect(api.setWidgetStyle).toHaveBeenCalledWith('ring');
});
test('captcha: shows prompt, solves, then retries the load', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  (api.listCities as ReturnType<typeof vi.fn>)
    .mockRejectedValueOnce(new Error("Error invoking remote method 'addr:cities': Error: CAPTCHA_REQUIRED"))
    .mockResolvedValue(['м. Біла Церква']);
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Сайт ДТЕК просить пройти перевірку')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Пройти перевірку' }));
  expect(api.solveCaptcha).toHaveBeenCalledWith('dtek-krem');
  expect(await screen.findByText('м. Біла Церква')).toBeInTheDocument();
  expect(api.listCities).toHaveBeenCalledTimes(2);
});
test('other errors show the Ukrainian message and allow retry', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  (api.listCities as ReturnType<typeof vi.fn>)
    .mockRejectedValueOnce(new Error("Error invoking remote method 'addr:cities': Error: Сайт ДТЕК недоступний"))
    .mockResolvedValue(['м. Біла Церква']);
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Сайт ДТЕК недоступний')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
  expect(await screen.findByText('м. Біла Церква')).toBeInTheDocument();
});

const FIVE = [
  { id: 'dtek-kem', displayName: 'ДТЕК Київські електромережі' }, { id: 'voe', displayName: 'Волиньобленерго' },
  { id: 'dtek-dnem', displayName: 'ДТЕК Дніпровські електромережі' }, { id: 'dtek-krem', displayName: 'ДТЕК Київські регіональні електромережі' },
  { id: 'dtek-oem', displayName: 'ДТЕК Одеські електромережі' },
];
function fiveApi() {
  const api = mockApi(two) as unknown as { listProviders: ReturnType<typeof vi.fn> };
  api.listProviders = vi.fn(async () => FIVE);
  return api as unknown as RendererApi;
}
const next = () => screen.getByRole('button', { name: 'Далі' });

describe('choosing among providers', () => {
  test('with several providers none is preselected, Далі waits for a pick, and the order is the list order', async () => {
    const user = userEvent.setup();
    render(<SetupWizard api={fiveApi()} autostart widgetStyle="compact" onDone={() => {}} />);
    const radios = await screen.findAllByRole('radio');
    expect(radios.map(r => (r as HTMLInputElement).checked)).toEqual([false, false, false, false, false]);
    expect(radios.map(r => within(r.closest('label') as HTMLElement).getByText(/./, { selector: '.wz-opt-name' }).textContent))
      .toEqual(['м. Київ', 'Волинська область', 'Дніпропетровська область', 'Київська область', 'Одеська область']);
    expect(next()).toBeDisabled();
    await user.click(radios[1]);
    expect(next()).toBeEnabled();
  });

  test('Kyiv skips the city step: the chip reads м. Київ, streets are loaded for it, Назад returns to the provider', async () => {
    const api = fiveApi(); const user = userEvent.setup();
    render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />);
    await user.click(await screen.findByRole('radio', { name: /м\. Київ/ }));
    await user.click(next());
    expect(await screen.findByRole('combobox', { name: 'Вулиця' })).toBeInTheDocument();
    expect(screen.getByText('м. Київ', { selector: '.wz-chip' })).toBeInTheDocument();
    expect(api.listCities).not.toHaveBeenCalled();
    expect(api.listStreets).toHaveBeenCalledWith('dtek-kem', 'м. Київ');
    const rail = within(screen.getByRole('navigation', { name: 'Кроки' }));
    expect(rail.getByText('Місто').closest('li')).toHaveTextContent('пройдено');
    await user.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByRole('heading', { name: 'Регіон і компанія' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /м\. Київ/ })).toBeChecked();
  });

  test('switching the provider clears the city: it is never sent to another provider', async () => {
    const api = fiveApi(); const user = userEvent.setup();
    render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />);
    await user.click(await screen.findByRole('radio', { name: /Київська область/ })); await user.click(next());
    await user.type(await screen.findByRole('combobox', { name: 'Місто або село' }), 'Біла');
    await user.click(screen.getByRole('option', { name: 'м. Біла Церква' })); await user.click(next());
    await screen.findByRole('combobox', { name: 'Вулиця' });
    await user.click(screen.getByRole('button', { name: 'Назад' })); await user.click(screen.getByRole('button', { name: 'Назад' }));
    await user.click(screen.getByRole('radio', { name: /Волинська область/ })); await user.click(next());
    expect(await screen.findByRole('combobox', { name: 'Місто або село' })).toHaveValue('');
    expect(api.listCities).toHaveBeenLastCalledWith('voe');
    expect(api.listStreets).not.toHaveBeenCalledWith('voe', expect.anything());
    expect(next()).toBeDisabled();
  });

  test('picking the same provider again keeps the city', async () => {
    const user = userEvent.setup();
    render(<SetupWizard api={fiveApi()} autostart widgetStyle="compact" onDone={() => {}} />);
    await user.click(await screen.findByRole('radio', { name: /Київська область/ })); await user.click(next());
    await user.type(await screen.findByRole('combobox', { name: 'Місто або село' }), 'Біла');
    await user.click(screen.getByRole('option', { name: 'м. Біла Церква' }));
    await user.click(screen.getByRole('button', { name: 'Назад' }));
    await user.click(screen.getByRole('radio', { name: /Київська область/ })); await user.click(next());
    expect(await screen.findByRole('combobox', { name: 'Місто або село' })).toHaveValue('м. Біла Церква');
  });

  test('an empty street list says the provider has no addresses there', async () => {
    const api = fiveApi() as unknown as { listStreets: ReturnType<typeof vi.fn> };
    api.listStreets = vi.fn(async () => []);
    const user = userEvent.setup();
    render(<SetupWizard api={api as unknown as RendererApi} autostart widgetStyle="compact" onDone={() => {}} />);
    await user.click(await screen.findByRole('radio', { name: /Волинська область/ })); await user.click(next());
    await user.type(await screen.findByRole('combobox', { name: 'Місто або село' }), 'Біла');
    await user.click(screen.getByRole('option', { name: 'м. Біла Церква' })); await user.click(next());
    expect(await screen.findByText('Для цього населеного пункту немає адрес у Волиньобленерго')).toBeInTheDocument();
  });
});

const pending: HouseInfo[] = [{ house: '7', outageActive: false, lines: [], linesPending: true }];
const NO_SCHEDULE = 'Для цього будинку ДТЕК не публікує графік відключень';
test('a pending house: the lines load after the pick, then the line step lists both', async () => {
  let resolve!: (l: LineInfo[]) => void;
  const houseLines = vi.fn(() => new Promise<LineInfo[]>(r => { resolve = r; }));
  const api = mockApi(pending, houseLines); const user = userEvent.setup();
  // The mock's preview follows the listed (empty) lines; the real one follows houseLines.
  api.previewLines = vi.fn(async () => two[0].lines.map(line => ({ line, today: fixtureSnapshot().days[0] })));
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  await user.click(await screen.findByRole('radio', { name: '7' }));
  expect(screen.getByText('Завантаження ліній…')).toBeInTheDocument();
  expect(screen.queryByText(NO_SCHEDULE)).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
  expect(houseLines).toHaveBeenCalledWith('dtek-krem', 'м. Біла Церква', 'бул. Грушевського Михайла', '7');
  await act(async () => { resolve(two[0].lines); });
  expect(screen.queryByText('Завантаження ліній…')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · черга 1.2')).toBeInTheDocument();
  expect(screen.getByText('Лінія 2 · черга 4.2')).toBeInTheDocument();
});
test('the lines loading line is a polite status, so a screen reader hears it', async () => {
  const api = mockApi(pending, vi.fn(() => new Promise<LineInfo[]>(() => {}))); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  await user.click(await screen.findByRole('radio', { name: '7' }));
  const loading = screen.getByText('Завантаження ліній…');
  expect(loading).toHaveAttribute('role', 'status');
  expect(loading).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('status')).toBe(loading);
});
test('a pending house whose answer is empty: the no-schedule note, blocked', async () => {
  const api = mockApi(pending, vi.fn(async () => [])); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  await user.click(await screen.findByRole('radio', { name: '7' }));
  expect(await screen.findByText(NO_SCHEDULE)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('a pending house whose answer fails: the message and a retry that asks again', async () => {
  const houseLines = vi.fn().mockRejectedValueOnce(new Error('Сервер недоступний')).mockResolvedValueOnce(two[0].lines);
  const api = mockApi(pending, houseLines as unknown as RendererApi['houseLines']); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  await user.click(await screen.findByRole('radio', { name: '7' }));
  expect(await screen.findByText('Сервер недоступний')).toBeInTheDocument();
  expect(screen.queryByText(NO_SCHEDULE)).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
  expect(houseLines).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Далі' })).toBeEnabled());
  expect(screen.queryByText('Сервер недоступний')).toBeNull();
});
test('a stale lines answer for a house no longer picked is dropped', async () => {
  const resolvers: Record<string, (l: LineInfo[]) => void> = {};
  const houseLines = vi.fn((_p: string, _c: string, _s: string, h: string) => new Promise<LineInfo[]>(r => { resolvers[h] = r; }));
  const api = mockApi([{ house: '7', outageActive: false, lines: [], linesPending: true }, { house: '8', outageActive: false, lines: [], linesPending: true }], houseLines);
  const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await toHouseStep(user);
  await user.click(await screen.findByRole('radio', { name: '7' })); await user.click(screen.getByRole('radio', { name: '8' }));
  await act(async () => { resolvers['8']([two[0].lines[0]]); });
  await act(async () => { resolvers['7'](two[0].lines); });
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  // House 8 has one line, so the line step is skipped; had 7's answer won, the line step would show.
  expect(await screen.findByText('Компакт')).toBeInTheDocument();
});
test('a house without linesPending never calls houseLines', async () => {
  const houseLines = vi.fn(async () => []);
  const api = mockApi(two, houseLines); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart widgetStyle="compact" onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · черга 1.2')).toBeInTheDocument();
  expect(houseLines).not.toHaveBeenCalled();
});
