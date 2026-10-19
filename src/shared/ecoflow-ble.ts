/** Vocabulary shared by the renderer and main for the EcoFlow Bluetooth source. */

/** RIVER 2 family SN prefixes: the models whose encrypt type 7 session this app speaks. */
export const BLE_PREFIXES = ['R601', 'R603', 'R611', 'R613', 'R621', 'R623'] as const;

export const isRiver2Family = (sn: string): boolean => BLE_PREFIXES.some(p => sn.startsWith(p));

export type BleProblem = 'bt-off' | 'bt-denied' | 'bt-missing' | 'bt-unavailable' | 'host-failed' | 'scan-failed';

/** Setup alert and live line. */
export const BLE_PROBLEM_TEXT: Record<BleProblem, string> = {
  'bt-off': 'Bluetooth на цьому комп’ютері вимкнено',
  'bt-denied': 'Немає дозволу на Bluetooth — дозвольте його в Системних параметрах → Конфіденційність і безпека → Bluetooth',
  'bt-missing': 'На цьому комп’ютері немає Bluetooth',
  'bt-unavailable': 'Bluetooth ще не готовий — якщо система питає дозвіл, дозвольте і спробуйте ще раз',
  'host-failed': 'Не вдалося запустити Bluetooth у застосунку',
  'scan-failed': 'Не вдалося пошукати станцію через Bluetooth',
};

/** Live-line texts for link states that are not a problem with the adapter. */
export const BLE_LINK_TEXT = {
  searching: 'Шукаю станцію поруч…',
  connecting: 'Підключаюся…',
  refused: 'Станція не прийняла вхід — натисніть «Змінити» і увійдіть знову',
  stalled: 'Станція не відповідає — спробую ще раз за кілька хвилин',
  unsupported: 'Модель поки не підтримується',
} as const;

/** What the source reports as the reason when it cannot tell whether the power is on. */
export const BLE_REASON = {
  lost: 'станція поза зв’язком Bluetooth',
  invSilent: 'станція не повідомляє про вхід',
  acOffHint: ' (вимкнено вихід AC?)',
  refused: 'станція не прийняла вхід — увійдіть знову в налаштуваннях',
  stalled: 'станція не відповідає по Bluetooth',
  unsupported: 'модель поки не підтримується',
  'bt-off': 'Bluetooth на цьому комп’ютері вимкнено',
  'bt-denied': 'немає дозволу на Bluetooth',
  'bt-missing': 'на цьому комп’ютері немає Bluetooth',
  'bt-unavailable': 'Bluetooth недоступний',
  'host-failed': 'не вдалося запустити Bluetooth у застосунку',
} as const;
