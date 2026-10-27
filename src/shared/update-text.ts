import type { UpdateStatus } from './types';

const offer = (version: string): string => `Оновити застосунок до ${version}`;

/** The header button's tooltip and accessible name; null when there is nothing to show. */
export function updateTooltip(s: UpdateStatus | undefined): string | null {
  switch (s?.phase) {
    case 'available': return offer(s.version);
    case 'downloading': return `Завантаження оновлення… ${s.percent} %`;
    case 'installing': return 'Встановлення…';
    case 'error': return 'Не вдалося оновити. Натисніть, щоб спробувати ще раз';
    default: return null;
  }
}

/** The tray's item: the offer when a click can start the update (again), the progress while it runs. */
export function trayUpdateItem(s: UpdateStatus | undefined): { label: string; enabled: boolean } | null {
  switch (s?.phase) {
    case 'available': case 'error': return { label: offer(s.version), enabled: true };
    case 'downloading': case 'installing': return { label: updateTooltip(s) as string, enabled: false };
    default: return null;
  }
}
