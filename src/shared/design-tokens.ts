/**
 * Theme colours of the design (docs/superpowers/specs/assets/design-2026-10-18: tokens.html and THEMES in
 * widget-compact.html), for code that paints with JS/SVG. src/renderer/src/ui/tokens.css declares the same values as
 * `--bw-*` custom properties (key `offA` → `--bw-off-a`); a test keeps the two in step.
 */
export interface ThemeTokens {
  on: string; offA: string; offB: string; offDot: string; maybe: string; unknown: string; emergency: string; badge: string;
  ink: string; ink2: string; ink3: string;
  glass: string; glassEdge: string; shadow: string; hair: string;
  warnInk: string; warnBg: string;
  now: string; nowRing: string;
  tipBg: string; tipInk: string; tipEdge: string;
  /** Alpha of the state-colour tint over the glass. */
  tintA: number;
}

export const THEMES: Record<'light' | 'dark', ThemeTokens> = {
  light: {
    on: '#1fbf72', offA: '#f2a20c', offB: '#ef6a10', offDot: '#ee4b3c', maybe: '#e2a000', unknown: '#8a90a6',
    emergency: '#e3261e', badge: '#d12b25',
    ink: '#11131a', ink2: 'rgba(17, 19, 26, 0.74)', ink3: 'rgba(17, 19, 26, 0.62)',
    glass: 'rgba(248, 249, 252, 0.66)', glassEdge: 'rgba(255, 255, 255, 0.8)',
    shadow: '0 0 0 0.5px rgba(17, 19, 26, 0.12), 0 14px 34px rgba(18, 22, 36, 0.22), 0 2px 6px rgba(18, 22, 36, 0.10)',
    hair: 'rgba(17, 19, 26, 0.10)',
    warnInk: '#8a5800', warnBg: 'rgba(226, 160, 0, 0.2)',
    now: '#11131a', nowRing: 'rgba(255, 255, 255, 0.9)',
    tipBg: 'rgba(252, 252, 254, 0.97)', tipInk: '#11131a', tipEdge: 'rgba(17, 19, 26, 0.12)',
    tintA: 0.14,
  },
  dark: {
    on: '#5dffa8', offA: '#ffc23d', offB: '#ff7a1a', offDot: '#ff6b5b', maybe: '#ffc23d', unknown: '#9aa0b4',
    emergency: '#ff4d4d', badge: '#d12b25',
    ink: '#f5f7fc', ink2: 'rgba(245, 247, 252, 0.8)', ink3: 'rgba(245, 247, 252, 0.66)',
    glass: 'rgba(18, 20, 28, 0.62)', glassEdge: 'rgba(255, 255, 255, 0.16)',
    shadow: '0 0 0 0.5px rgba(0, 0, 0, 0.5), 0 16px 40px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.25)',
    hair: 'rgba(255, 255, 255, 0.12)',
    warnInk: '#ffd27a', warnBg: 'rgba(255, 194, 61, 0.18)',
    now: '#ffffff', nowRing: 'rgba(0, 0, 0, 0.55)',
    tipBg: 'rgba(30, 32, 40, 0.97)', tipInk: '#f5f7fc', tipEdge: 'rgba(255, 255, 255, 0.14)',
    tintA: 0.18,
  },
};

export function themeTokens(dark: boolean): ThemeTokens {
  return dark ? THEMES.dark : THEMES.light;
}
