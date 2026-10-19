/**
 * Theme colours of the design (docs/superpowers/specs/assets/design-2026-10-18: tokens.html, THEMES in
 * widget-compact.html, main-schedule.html and main-settings.html), for code that paints with JS/SVG. src/renderer/src/ui/tokens.css declares the same values as
 * `--bw-*` custom properties (key `offA` → `--bw-off-a`); a test keeps the two in step.
 */
export interface ThemeTokens {
  on: string; offA: string; offB: string; offDot: string; maybe: string; unknown: string; emergency: string; badge: string;
  ink: string; ink2: string; ink3: string;
  glass: string; glassEdge: string; shadow: string; hair: string;
  /** Pill behind a label laid over a hatch («ще не опубліковано»). */
  pill: string;
  warnInk: string; warnBg: string;
  now: string; nowRing: string;
  tipBg: string; tipInk: string; tipEdge: string;
  /** Alpha of the state-colour tint over the glass. */
  tintA: number;
  /**
   * Main window (THEMES in main-schedule.html), over Mica: its own text and hairline shades, the «now» pill's ring
   * and ink, cards, segmented controls (ctl, the selected segment ctlOn), buttons, the accent and the primary button.
   */
  appInk: string; appInk2: string; appInk3: string; appHair: string; appNowRing: string; nowInk: string;
  card: string; cardEdge: string;
  ctl: string; ctlOn: string; ctlOnShadow: string;
  btn: string; btnEdge: string;
  accent: string; primary: string; primaryInk: string;
  /**
   * Settings (TH in main-settings.html, ecoflow-panel.html): ink on the accent, a selected option's background, the
   * primary button while it works, form fields, the «в мережі» / warning / error inks, and the style thumbnails'
   * wallpaper and shadow (a CSS filter: the widget's shadow at about thumbnail scale). The EcoFlow panel mockup is
   * light only, so its dark shades are derived.
   */
  accentInk: string; optOn: string; primaryBusy: string;
  field: string; fieldEdge: string;
  onInk: string; warnText: string; dangerInk: string; dangerIcon: string;
  thumbShadow: string; thumbWp: string;
  /**
   * Setup wizard (setup-wizard.html, light only, so the dark shades are derived): the step rail's background, the
   * suggestion list's shadow, a disabled button's ink and the «Готово» check's ink.
   */
  rail: string; popShadow: string; disabledInk: string; doneInk: string;
  /** An open dropdown's list (derived): opaque, since it floats over the content below it. */
  menu: string;
}

export const THEMES: Record<'light' | 'dark', ThemeTokens> = {
  light: {
    on: '#1fbf72', offA: '#f2a20c', offB: '#ef6a10', offDot: '#ee4b3c', maybe: '#e2a000', unknown: '#8a90a6',
    emergency: '#e3261e', badge: '#d12b25',
    ink: '#11131a', ink2: 'rgba(17, 19, 26, 0.74)', ink3: 'rgba(17, 19, 26, 0.62)',
    glass: 'rgba(248, 249, 252, 0.66)', glassEdge: 'rgba(255, 255, 255, 0.8)',
    shadow: '0 0 0 0.5px rgba(17, 19, 26, 0.12), 0 14px 34px rgba(18, 22, 36, 0.22), 0 2px 6px rgba(18, 22, 36, 0.10)',
    hair: 'rgba(17, 19, 26, 0.10)', pill: 'rgba(248, 249, 252, 0.92)',
    warnInk: '#8a5800', warnBg: 'rgba(226, 160, 0, 0.2)',
    now: '#11131a', nowRing: 'rgba(255, 255, 255, 0.9)',
    tipBg: 'rgba(252, 252, 254, 0.97)', tipInk: '#11131a', tipEdge: 'rgba(17, 19, 26, 0.12)',
    tintA: 0.14,
    appInk: '#11131a', appInk2: '#474c59', appInk3: '#686d7c', appHair: 'rgba(17, 19, 26, 0.09)',
    appNowRing: 'rgba(255, 255, 255, 0.95)', nowInk: '#ffffff',
    card: 'rgba(255, 255, 255, 0.82)', cardEdge: 'rgba(17, 19, 26, 0.07)',
    ctl: 'rgba(17, 19, 26, 0.06)', ctlOn: '#ffffff', ctlOnShadow: '0 1px 2px rgba(17, 19, 26, 0.14), 0 0 0 0.5px rgba(17, 19, 26, 0.08)',
    btn: 'rgba(255, 255, 255, 0.9)', btnEdge: 'rgba(17, 19, 26, 0.13)',
    accent: '#2a5bd7', primary: '#1b1e27', primaryInk: '#ffffff',
    accentInk: '#ffffff', optOn: 'rgba(42, 91, 215, 0.06)', primaryBusy: '#3a3e4a',
    field: '#ffffff', fieldEdge: 'rgba(17, 19, 26, 0.18)',
    onInk: '#0f6b3d', warnText: '#6b4500', dangerInk: '#7a1712', dangerIcon: '#c4241d',
    thumbShadow: 'drop-shadow(0 5px 12px rgba(18, 22, 36, 0.22))',
    thumbWp: 'radial-gradient(55% 70% at 12% 18%, #ffd6bd 0%, rgba(255, 214, 189, 0) 70%), radial-gradient(50% 65% at 88% 22%, #c4defc 0%, rgba(196, 222, 252, 0) 70%), radial-gradient(70% 60% at 55% 105%, #e2d6ff 0%, rgba(226, 214, 255, 0) 70%), linear-gradient(170deg, #f7f3ee 0%, #eef1f7 100%)',
    rail: 'rgba(255, 255, 255, 0.35)', popShadow: '0 12px 28px rgba(20, 24, 40, 0.14)', disabledInk: '#9ca2b3', doneInk: '#0f7a45',
    menu: '#fbfbfd',
  },
  dark: {
    on: '#5dffa8', offA: '#ffc23d', offB: '#ff7a1a', offDot: '#ff6b5b', maybe: '#ffc23d', unknown: '#9aa0b4',
    emergency: '#ff4d4d', badge: '#d12b25',
    ink: '#f5f7fc', ink2: 'rgba(245, 247, 252, 0.8)', ink3: 'rgba(245, 247, 252, 0.66)',
    glass: 'rgba(18, 20, 28, 0.62)', glassEdge: 'rgba(255, 255, 255, 0.16)',
    shadow: '0 0 0 0.5px rgba(0, 0, 0, 0.5), 0 16px 40px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.25)',
    hair: 'rgba(255, 255, 255, 0.12)', pill: 'rgba(22, 24, 32, 0.9)',
    warnInk: '#ffd27a', warnBg: 'rgba(255, 194, 61, 0.18)',
    now: '#ffffff', nowRing: 'rgba(0, 0, 0, 0.55)',
    tipBg: 'rgba(30, 32, 40, 0.97)', tipInk: '#f5f7fc', tipEdge: 'rgba(255, 255, 255, 0.14)',
    tintA: 0.18,
    appInk: '#f2f4f9', appInk2: '#c4c8d3', appInk3: '#9ca2b3', appHair: 'rgba(255, 255, 255, 0.10)',
    appNowRing: 'rgba(0, 0, 0, 0.6)', nowInk: '#11131a',
    card: 'rgba(255, 255, 255, 0.05)', cardEdge: 'rgba(255, 255, 255, 0.08)',
    ctl: 'rgba(255, 255, 255, 0.07)', ctlOn: 'rgba(255, 255, 255, 0.15)', ctlOnShadow: '0 1px 2px rgba(0, 0, 0, 0.3)',
    btn: 'rgba(255, 255, 255, 0.08)', btnEdge: 'rgba(255, 255, 255, 0.14)',
    accent: '#8fb4ff', primary: '#f2f4f9', primaryInk: '#15171d',
    accentInk: '#10131c', optOn: 'rgba(143, 180, 255, 0.08)', primaryBusy: '#d3d5da',
    field: 'rgba(255, 255, 255, 0.06)', fieldEdge: 'rgba(255, 255, 255, 0.18)',
    onInk: '#5dffa8', warnText: '#ffd27a', dangerInk: '#ffb4ae', dangerIcon: '#ff4d4d',
    thumbShadow: 'drop-shadow(0 6px 14px rgba(0, 0, 0, 0.45))',
    thumbWp: 'radial-gradient(1.2px 1.2px at 18px 22px, rgba(255, 255, 255, 0.75) 0%, rgba(255, 255, 255, 0) 100%) 0 0 / 74px 62px, radial-gradient(45% 60% at 82% 12%, rgba(92, 112, 255, 0.55) 0%, rgba(92, 112, 255, 0) 70%), radial-gradient(55% 60% at 8% 92%, rgba(255, 92, 160, 0.32) 0%, rgba(255, 92, 160, 0) 70%), linear-gradient(180deg, #0b0e18 0%, #10131f 100%)',
    rail: 'rgba(255, 255, 255, 0.03)', popShadow: '0 12px 28px rgba(0, 0, 0, 0.4)', disabledInk: '#757b8b', doneInk: '#5dffa8',
    menu: '#2b2d35',
  },
};

export function themeTokens(dark: boolean): ThemeTokens {
  return dark ? THEMES.dark : THEMES.light;
}
