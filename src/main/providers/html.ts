const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

/** One pass, so «&amp;lt;» stays «&lt;». A numeric entity beyond Unicode is left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|nbsp));/gi, (m, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED[name.toLowerCase()];
    const cp = dec ? Number(dec) : parseInt(hex!, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** A fragment as text: <br> → space, tags dropped, entities decoded, whitespace collapsed, trimmed. */
export function htmlText(fragment: string): string {
  return decodeEntities(fragment.replace(/<!--[\s\S]*?-->/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}
