import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WidgetStyle } from '../../src/shared/types';
import { WIDGET_RADII, WIDGET_SIZES } from '../../src/shared/widget-sizes';

test('one widget size table for the window and the settings: 290×150, 236×260, 400×200', () => {
  expect(WIDGET_SIZES).toEqual({
    compact: { width: 290, height: 150 }, ring: { width: 236, height: 260 }, timeline: { width: 400, height: 200 },
  });
});

test('one card radius table: compact 22, ring 26, timeline 24', () => {
  expect(WIDGET_RADII).toEqual({ compact: 22, ring: 26, timeline: 24 });
});

test('the CSS card radii are the same table: tokens.css declares them, widget.css rounds each card by its own', () => {
  const tokens = readFileSync(join(__dirname, '../../src/renderer/src/ui/tokens.css'), 'utf8');
  const widget = readFileSync(join(__dirname, '../../src/renderer/src/widget/widget.css'), 'utf8');
  const token: Record<WidgetStyle, string> = { compact: '--bw-r-compact', ring: '--bw-r-dial', timeline: '--bw-r-timeline' };
  for (const style of Object.keys(token) as WidgetStyle[]) {
    expect([style, tokens.match(new RegExp(`${token[style]}:\\s*(\\d+)px;`))?.[1]]).toEqual([style, String(WIDGET_RADII[style])]);
  }
  expect(widget).toMatch(/\.w-card \{[^}]*border-radius: var\(--bw-r-compact\);/);
  expect(widget).toMatch(/\.w-card\.w-ring \{ border-radius: var\(--bw-r-dial\); \}/);
  expect(widget).toMatch(/\.w-card\.w-timeline \{ border-radius: var\(--bw-r-timeline\); \}/);
});
