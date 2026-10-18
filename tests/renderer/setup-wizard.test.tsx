// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { SetupWizard } from '../../src/renderer/src/app/SetupWizard';
import type { RendererApi } from '../../src/shared/ipc';
import { outageRanges } from '../../src/shared/outage-ranges';
import type { HouseInfo } from '../../src/shared/types';
import { fixtureSnapshot } from '../helpers/snapshot';

function mockApi(houses: HouseInfo[]) {
  return { listProviders: vi.fn(async () => [{ id: 'dtek-krem', displayName: 'ДТЕК Київські регіональні електромережі' }]),
    listCities: vi.fn(async () => ['м. Біла Церква', 'с-ще Козин']), listStreets: vi.fn(async () => ['бул. Грушевського Михайла']),
    listHouses: vi.fn(async () => houses),
    previewLines: vi.fn(async () => houses[0].lines.map(line => ({ line, today: fixtureSnapshot().days[0] }))),
    solveCaptcha: vi.fn(async () => {}), saveAddress: vi.fn(async () => {}), setWidgetStyle: vi.fn(async () => {}),
    setAutostart: vi.fn(async () => {}), openDtekSite: vi.fn() } as unknown as RendererApi;
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
  render(<SetupWizard api={api} autostart onDone={onDone} />); await pickAddress(user);
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
  render(<SetupWizard api={api} autostart onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Компакт')).toBeInTheDocument(); expect(api.previewLines).not.toHaveBeenCalled();
  // The rail keeps all seven steps: the skipped «Лінія» still counts, and screen readers hear the done ones as done.
  expect(screen.getByText('Крок 6 з 7')).toBeInTheDocument();
  expect(within(screen.getByRole('navigation', { name: 'Кроки' })).getAllByText(/пройдено/)).toHaveLength(5);
});
test('up to 24 houses: just the grid, no filter', async () => {
  const user = userEvent.setup();
  render(<SetupWizard api={mockApi(street(24))} autostart onDone={() => {}} />); await toHouseStep(user);
  expect(await screen.findAllByRole('radio')).toHaveLength(24);
  expect(screen.queryByRole('textbox', { name: 'Номер будинку' })).toBeNull();
});
test('more than 24 houses: a filter field narrows the grid, matching as the old house search', async () => {
  const api = mockApi(street(30)); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={() => {}} />); await toHouseStep(user);
  const filter = await screen.findByRole('textbox', { name: 'Номер будинку' });
  expect(filter).toHaveFocus();
  expect(screen.getAllByRole('radio')).toHaveLength(30);
  await user.type(filter, ' 2');
  expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['2', '12', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29']);
  await user.type(filter, '5');
  await user.click(screen.getByRole('radio', { name: '25' }));
  expect(screen.getByRole('button', { name: 'Далі' })).toBeEnabled();
  await user.type(filter, '9');
  expect(screen.queryAllByRole('radio')).toHaveLength(0);
  expect(screen.getByText('Нічого не знайдено')).toBeInTheDocument();
});
test('the house grid is one Tab stop: arrows move the focus, a row is 6, Space picks', async () => {
  const user = userEvent.setup();
  render(<SetupWizard api={mockApi(street(8))} autostart onDone={() => {}} />); await toHouseStep(user);
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
  render(<SetupWizard api={mockApi(two)} autostart onDone={() => {}} />);
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
  const { rerender } = render(<SetupWizard api={api} autostart onDone={() => {}} />);
  await screen.findByRole('radio', { name: /Київська область/, checked: true });
  expect(screen.queryByRole('button', { name: 'Скасувати' })).toBeNull();
  rerender(<SetupWizard api={api} autostart onDone={() => {}} onCancel={onCancel} />);
  await user.click(screen.getByRole('button', { name: 'Скасувати' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(api.saveAddress).not.toHaveBeenCalled(); expect(api.setWidgetStyle).not.toHaveBeenCalled();
});
test('no lines: explains and blocks', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeInTheDocument();
  expect(screen.queryByText(OUTAGE_NOTE)).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('active outage: the house and line steps warn that the line list may be incomplete', async () => {
  const api = mockApi([{ ...two[0], outageActive: true }]); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 2 · черга 4.2')).toBeInTheDocument();
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
});
test('active outage and one line: the line step is shown, needs an explicit choice, nothing is saved before it', async () => {
  const api = mockApi([{ house: '40', outageActive: true, lines: [two[0].lines[0]] }]); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={onDone} />); await pickAddress(user);
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
  render(<SetupWizard api={api} autostart onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  expect(screen.queryByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('the line step opens the schedule on the DTEK site (D11)', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByRole('button', { name: 'Відкрити графік на сайті ДТЕК' }));
  expect(api.openDtekSite).toHaveBeenCalledTimes(1);
  expect(api.openDtekSite).toHaveBeenCalledWith();
});
test('«Готово» sums up the choice and switches autostart; nothing is saved before «Завершити»', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [two[0].lines[0]] }]); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={onDone} />); await pickAddress(user);
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
test('captcha: shows prompt, solves, then retries the load', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  (api.listCities as ReturnType<typeof vi.fn>)
    .mockRejectedValueOnce(new Error("Error invoking remote method 'addr:cities': Error: CAPTCHA_REQUIRED"))
    .mockResolvedValue(['м. Біла Церква']);
  render(<SetupWizard api={api} autostart onDone={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Сайт ДТЕК просить пройти перевірку')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Пройти перевірку' }));
  expect(api.solveCaptcha).toHaveBeenCalled();
  expect(await screen.findByText('м. Біла Церква')).toBeInTheDocument();
  expect(api.listCities).toHaveBeenCalledTimes(2);
});
test('other errors show the Ukrainian message and allow retry', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  (api.listCities as ReturnType<typeof vi.fn>)
    .mockRejectedValueOnce(new Error("Error invoking remote method 'addr:cities': Error: Сайт ДТЕК недоступний"))
    .mockResolvedValue(['м. Біла Церква']);
  render(<SetupWizard api={api} autostart onDone={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Сайт ДТЕК недоступний')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
  expect(await screen.findByText('м. Біла Церква')).toBeInTheDocument();
});
