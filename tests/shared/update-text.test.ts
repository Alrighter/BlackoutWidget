import { trayUpdateItem, updateTooltip } from '../../src/shared/update-text';

test('tooltips', () => {
  expect(updateTooltip(undefined)).toBeNull();
  expect(updateTooltip({ phase: 'idle' })).toBeNull();
  expect(updateTooltip({ phase: 'available', version: '1.0.2' })).toBe('Оновити застосунок до 1.0.2');
  expect(updateTooltip({ phase: 'downloading', version: '1.0.2', percent: 42 })).toBe('Завантаження оновлення… 42 %');
  expect(updateTooltip({ phase: 'installing', version: '1.0.2' })).toBe('Встановлення…');
  expect(updateTooltip({ phase: 'error', version: '1.0.2' })).toBe('Не вдалося оновити. Натисніть, щоб спробувати ще раз');
});

test('tray item: clickable when available or after an error, disabled while working', () => {
  expect(trayUpdateItem(undefined)).toBeNull();
  expect(trayUpdateItem({ phase: 'idle' })).toBeNull();
  expect(trayUpdateItem({ phase: 'available', version: '1.0.2' })).toEqual({ label: 'Оновити застосунок до 1.0.2', enabled: true });
  expect(trayUpdateItem({ phase: 'error', version: '1.0.2' })).toEqual({ label: 'Оновити застосунок до 1.0.2', enabled: true });
  expect(trayUpdateItem({ phase: 'downloading', version: '1.0.2', percent: 7 })).toEqual({ label: 'Завантаження оновлення… 7 %', enabled: false });
  expect(trayUpdateItem({ phase: 'installing', version: '1.0.2' })).toEqual({ label: 'Встановлення…', enabled: false });
});
