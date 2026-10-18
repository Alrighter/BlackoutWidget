import type { WidgetStyle } from '../../../shared/types';

/** `size`: the widget window in px (= WIDGET_SIZES in src/main/widget/position.ts, which this bundle can't import). */
export const STYLES: { id: WidgetStyle; name: string; hint: string; size: [number, number] }[] = [
  { id: 'compact', name: 'Компакт', hint: 'Маленька картка зі смужкою на сьогодні', size: [290, 150] },
  { id: 'ring', name: 'Циферблат', hint: 'Кільце з добою та відліком', size: [236, 260] },
  { id: 'timeline', name: 'Таймлайн', hint: 'Сьогодні й завтра на одній шкалі', size: [400, 200] },
];
