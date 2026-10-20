import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, themeTokens, type ThemeTokens } from '../../src/shared/design-tokens';
import { PROVIDERS, providerDisplayName, providerRegion } from '../../src/shared/providers';

const css = readFileSync(join(__dirname, '../../src/renderer/src/ui/tokens.css'), 'utf8');
const appCss = readFileSync(join(__dirname, '../../src/renderer/src/app/app.css'), 'utf8');
const styleThumb = readFileSync(join(__dirname, '../../src/renderer/src/app/StyleThumb.tsx'), 'utf8');

/** `--bw-*` custom properties declared directly inside `block`. */
function vars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--bw-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim().replace(/\s+/g, ' ');
  return out;
}

/** Body of the first `{ ... }` that follows `start`, braces balanced. */
function blockAfter(text: string, start: number): string {
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

const cssName = (key: string) => `--bw-${key.replace(/[A-Z0-9]/g, c => `-${c.toLowerCase()}`)}`;

describe('design tokens', () => {
  it('carries the mockup values', () => {
    expect(THEMES.dark.on).toBe('#5dffa8');
    expect(THEMES.light.on).toBe('#1fbf72');
    expect([THEMES.dark.offA, THEMES.dark.offB]).toEqual(['#ffc23d', '#ff7a1a']);
    expect([THEMES.light.offA, THEMES.light.offB]).toEqual(['#f2a20c', '#ef6a10']);
    expect(THEMES.dark.badge).toBe('#d12b25');
    expect(THEMES.light.badge).toBe('#d12b25');
    expect(THEMES.dark.glass).toBe('rgba(18, 20, 28, 0.62)');
    expect(THEMES.light.glass).toBe('rgba(248, 249, 252, 0.66)');
    expect(THEMES.dark.pill).toBe('rgba(22, 24, 32, 0.9)');
    expect(THEMES.light.pill).toBe('rgba(248, 249, 252, 0.92)');
    expect(THEMES.light.tintA).toBe(0.14);
    expect(THEMES.dark.tintA).toBe(0.18);
    // Main window (main-schedule.html): its text shades differ from the widget's.
    expect([THEMES.light.appInk2, THEMES.light.appInk3]).toEqual(['#474c59', '#686d7c']);
    expect([THEMES.dark.appInk, THEMES.dark.appInk2, THEMES.dark.appInk3]).toEqual(['#f2f4f9', '#c4c8d3', '#9ca2b3']);
    expect([THEMES.light.card, THEMES.dark.card]).toEqual(['rgba(255, 255, 255, 0.82)', 'rgba(255, 255, 255, 0.05)']);
    expect([THEMES.light.accent, THEMES.dark.accent]).toEqual(['#2a5bd7', '#8fb4ff']);
    // Settings (TH in main-settings.html; ecoflow-panel.html).
    expect([THEMES.light.accentInk, THEMES.dark.accentInk]).toEqual(['#ffffff', '#10131c']);
    expect([THEMES.light.optOn, THEMES.dark.optOn]).toEqual(['rgba(42, 91, 215, 0.06)', 'rgba(143, 180, 255, 0.08)']);
    expect([THEMES.light.field, THEMES.light.fieldEdge, THEMES.light.primaryBusy]).toEqual(['#ffffff', 'rgba(17, 19, 26, 0.18)', '#3a3e4a']);
    expect([THEMES.light.onInk, THEMES.light.warnText, THEMES.light.dangerInk, THEMES.light.dangerIcon]).toEqual(['#0f6b3d', '#6b4500', '#7a1712', '#c4241d']);
    expect(THEMES.light.thumbWp).toMatch(/^radial-gradient\(55% 70% at 12% 18%, #ffd6bd 0%/);
    expect(THEMES.dark.thumbWp).toMatch(/0 0 \/ 74px 62px, .*linear-gradient\(180deg, #0b0e18 0%, #10131f 100%\)$/);
    // Setup wizard (setup-wizard.html, light only).
    expect([THEMES.light.rail, THEMES.light.popShadow]).toEqual(['rgba(255, 255, 255, 0.35)', '0 12px 28px rgba(20, 24, 40, 0.14)']);
    expect([THEMES.light.disabledInk, THEMES.light.doneInk]).toEqual(['#9ca2b3', '#0f7a45']);
  });

  it('picks the theme by the dark flag', () => {
    expect(themeTokens(true)).toBe(THEMES.dark);
    expect(themeTokens(false)).toBe(THEMES.light);
  });

  it('tokens.css declares the same values: light by default, dark under prefers-color-scheme: dark', () => {
    const light = vars(blockAfter(css, css.indexOf(':root')));
    const media = css.indexOf('@media (prefers-color-scheme: dark)');
    expect(media).toBeGreaterThan(-1);
    const dark = vars(blockAfter(blockAfter(css, media), 0));
    for (const theme of ['light', 'dark'] as const) {
      const declared = theme === 'light' ? light : dark;
      for (const [key, value] of Object.entries(THEMES[theme]) as [keyof ThemeTokens, string | number][]) {
        expect([theme, cssName(key), declared[cssName(key)]]).toEqual([theme, cssName(key), String(value)]);
      }
    }
  });

  it('.bw-dark-thumb redeclares, with the dark values, every token the style thumbnails paint with', () => {
    const at = css.indexOf('.bw-dark-thumb');
    expect(at).toBeGreaterThan(-1);
    const forced = vars(blockAfter(css, at));
    const dark = Object.fromEntries(Object.entries(THEMES.dark).map(([key, value]) => [cssName(key), String(value)]));
    for (const [name, value] of Object.entries(forced)) expect([name, value]).toEqual([name, dark[name]]);
    const thumbRules = [...appCss.matchAll(/\.st-thumb-[\w-]+\s*\{([^}]*)\}/g)].map(m => m[1]).join(' ');
    const used = new Set([...`${styleThumb} ${thumbRules}`.matchAll(/var\((--bw-[\w-]+)\)/g)].map(m => m[1]));
    used.delete('--bw-font'); used.delete('--bw-font-display');
    expect(used.size).toBeGreaterThan(10);
    for (const name of used) expect([name, forced[name]]).toEqual([name, dark[name]]);
  });
});

describe('provider names', () => {
  it('names a known provider', () => {
    expect(providerDisplayName('dtek-krem')).toBe('ДТЕК Київські регіональні електромережі');
    expect(PROVIDERS['dtek-krem'].name).toBe('ДТЕК Київські регіональні електромережі');
  });

  it('names the region a provider serves (D4), none for an unknown one', () => {
    expect(providerRegion('dtek-krem')).toBe('Київська область');
    expect(providerRegion('some-new-provider')).toBeUndefined();
    expect(providerRegion('toString')).toBeUndefined();
  });

  it('falls back to the id itself', () => {
    expect(providerDisplayName('some-new-provider')).toBe('some-new-provider');
    expect(providerDisplayName('toString')).toBe('toString');
  });
});
