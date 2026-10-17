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
    solveCaptcha: vi.fn(async () => {}), saveAddress: vi.fn(async () => {}), setWidgetStyle: vi.fn(async () => {}) } as unknown as RendererApi;
}
const two = [{ house: '40', outageActive: false, lines: [{ index: 1, groupId: 'GPV1.2', label: 'Черга 1.2' }, { index: 2, groupId: 'GPV4.2', label: 'Черга 4.2' }] }];
const OUTAGE_NOTE = 'Зараз для цього будинку діє відключення — список ліній може бути неповним. Якщо вашої лінії немає, спробуйте пізніше.';
async function pickAddress(user: UserEvent) {
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  await user.type(await screen.findByRole('combobox', { name: 'Населений пункт' }), 'Біла');
  expect(screen.queryByText('с-ще Козин')).toBeNull();
  await user.click(screen.getByText('м. Біла Церква')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('бул. Грушевського Михайла')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(await screen.findByText('40'));
}
test('two lines: shows both previews and saves chosen line', async () => {
  const api = mockApi(two); const onDone = vi.fn(); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={onDone} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 1 · Черга 1.2')).toBeInTheDocument(); expect(screen.getByText('Лінія 2 · Черга 4.2')).toBeInTheDocument();
  await user.click(screen.getByText('Лінія 1 · Черга 1.2')); await user.click(screen.getByRole('button', { name: 'Далі' }));
  await user.click(screen.getByText('Таймлайн')); await user.click(screen.getByRole('button', { name: 'Готово' }));
  expect(api.saveAddress).toHaveBeenCalledWith({ providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex: 1, groupId: 'GPV1.2' });
  expect(api.setWidgetStyle).toHaveBeenCalledWith('timeline'); expect(onDone).toHaveBeenCalled();
});
test('one line: skips line step', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [two[0].lines[0]] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={() => {}} />); await pickAddress(user);
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Компакт')).toBeInTheDocument(); expect(api.previewLines).not.toHaveBeenCalled();
});
test('no lines: explains and blocks', async () => {
  const api = mockApi([{ house: '40', outageActive: false, lines: [] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeInTheDocument();
  expect(screen.queryByText(OUTAGE_NOTE)).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('active outage: the house and line steps warn that the line list may be incomplete', async () => {
  const api = mockApi([{ ...two[0], outageActive: true }]); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Лінія 2 · Черга 4.2')).toBeInTheDocument();
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
});
test('active outage and no lines: only the outage note, still blocked', async () => {
  const api = mockApi([{ house: '40', outageActive: true, lines: [] }]); const user = userEvent.setup();
  render(<SetupWizard api={api} onDone={() => {}} />); await pickAddress(user);
  expect(screen.getByText(OUTAGE_NOTE)).toBeInTheDocument();
  expect(screen.queryByText('Для цього будинку ДТЕК не публікує графік відключень')).toBeNull();
  expect(screen.getByRole('button', { name: 'Далі' })).toBeDisabled();
});
test('captcha: shows prompt, solves, then retries the load', async () => {
  const api = mockApi(two); const user = userEvent.setup();
  (api.listCities as ReturnType<typeof vi.fn>)
    .mockRejectedValueOnce(new Error("Error invoking remote method 'addr:cities': Error: CAPTCHA_REQUIRED"))
    .mockResolvedValue(['м. Біла Церква']);
  render(<SetupWizard api={api} onDone={() => {}} />);
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
  render(<SetupWizard api={api} onDone={() => {}} />);
  await user.click(await screen.findByRole('button', { name: 'Далі' }));
  expect(await screen.findByText('Сайт ДТЕК недоступний')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }));
  expect(await screen.findByText('м. Біла Церква')).toBeInTheDocument();
});
