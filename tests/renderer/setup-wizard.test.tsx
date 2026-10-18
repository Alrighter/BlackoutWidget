// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { SetupWizard } from '../../src/renderer/src/app/SetupWizard';
import type { RendererApi } from '../../src/shared/ipc';
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
async function pickAddress(user: UserEvent) {
  // D4: the only supported source, as a region card, picked already.
  expect(await screen.findByRole('radio', { name: /Київська область/, checked: true })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.type(await screen.findByRole('combobox', { name: 'Місто або село' }), 'Біла');
  expect(screen.queryByText('с-ще Козин')).toBeNull();
  await user.click(screen.getByRole('option', { name: 'м. Біла Церква' })); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('бул. Грушевського Михайла')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('40'));
}
test('two lines: shows both previews and saves chosen line', async () => {
  const api = mockApi(two); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} autostart onDone={onDone} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · черга 1.2')).toBeInTheDocument(); expect(screen.getByText('Лінія 2 · черга 4.2')).toBeInTheDocument();
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
  // The rail keeps all seven steps: the skipped «Лінія» still counts.
  expect(screen.getByText('Крок 6 з 7')).toBeInTheDocument();
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
