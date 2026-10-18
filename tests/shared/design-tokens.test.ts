import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, themeTokens, type ThemeTokens } from '../../src/shared/design-tokens';
import { PROVIDER_NAMES, providerDisplayName } from '../../src/shared/providers';

const css = readFileSync(join(__dirname, '../../src/renderer/src/ui/tokens.css'), 'utf8');

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
});

describe('provider names', () => {
  it('names a known provider', () => {
    expect(providerDisplayName('dtek-krem')).toBe('ДТЕК Київські регіональні електромережі');
    expect(PROVIDER_NAMES['dtek-krem']).toBe('ДТЕК Київські регіональні електромережі');
  });

  it('falls back to the id itself', () => {
    expect(providerDisplayName('some-new-provider')).toBe('some-new-provider');
    expect(providerDisplayName('toString')).toBe('toString');
  });
});
