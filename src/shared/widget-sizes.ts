import type { WidgetStyle } from './types';

/** Widget window size per style, in DIP: main sizes the window by it, the settings show and draw it. */
export const WIDGET_SIZES: Record<WidgetStyle, { width: number; height: number }> = {
  compact: { width: 290, height: 150 }, ring: { width: 236, height: 260 }, timeline: { width: 400, height: 200 },
};
