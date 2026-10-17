import type { WidgetStyle } from '../../../shared/types';

export const STYLES: { id: WidgetStyle; name: string; hint: string }[] = [
  { id: 'compact', name: 'Компакт', hint: 'Маленька картка зі смужкою на сьогодні' },
  { id: 'ring', name: 'Циферблат', hint: 'Кільце з добою та відліком' },
  { id: 'timeline', name: 'Таймлайн', hint: 'Сьогодні й завтра на одній шкалі' },
];
