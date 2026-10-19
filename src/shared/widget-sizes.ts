import type { WidgetStyle } from './types';

/** Widget window size per style, in DIP: main sizes the window by it, the settings show and draw it. */
export const WIDGET_SIZES: Record<WidgetStyle, { width: number; height: number }> = {
  compact: { width: 290, height: 150 }, ring: { width: 236, height: 260 }, timeline: { width: 400, height: 200 },
};

/**
 * Card corner radius per style, in DIP: tokens.css declares the same values (--bw-r-compact, --bw-r-dial, --bw-r-timeline;
 * a test keeps them in step) and main rounds the macOS widget window's native glass to them.
 */
export const WIDGET_RADII: Record<WidgetStyle, number> = { compact: 22, ring: 26, timeline: 24 };
