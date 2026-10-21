export const KYIV_TZ = 'Europe/Kyiv';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: KYIV_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Parts { y: number; mo: number; d: number; h: number; mi: number; s: number }

function kyivParts(d: Date): Parts {
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Kyiv UTC offset (ms) at the given instant. */
function kyivOffsetMs(d: Date): number {
  const p = kyivParts(d);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

export function kyivDateKey(d: Date): string {
  const p = kyivParts(d);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

export function kyivMinutesOfDay(d: Date): number {
  const p = kyivParts(d);
  return p.h * 60 + p.mi;
}

/** minutes 0..1440; 1440 = next midnight. */
export function kyivWallTimeToInstant(dateKey: string, minutes: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, 0, minutes);
  let result = wallAsUtc - kyivOffsetMs(new Date(wallAsUtc));
  const offset2 = kyivOffsetMs(new Date(result));
  const corrected = wallAsUtc - offset2;
  if (corrected !== result) result = corrected;
  return new Date(result);
}

export function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function formatHM(d: Date): string {
  const p = kyivParts(d);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

export function formatDM(dateKey: string): string {
  const [, m, d] = dateKey.split('-');
  return `${d}.${m}`;
}

/** Parses 'HH:MM DD.MM.YYYY' or 'DD.MM.YYYY HH:MM' as Kyiv wall time. */
export function parseDtekDateTime(s: string): Date | undefined {
  const text = s.trim();
  let m = /^(\d{1,2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  let h: number, mi: number, dd: number, mo: number, yy: number;
  if (m) {
    [h, mi, dd, mo, yy] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  } else {
    m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(text);
    if (!m) return undefined;
    [dd, mo, yy, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  }
  if (h > 23 || mi > 59 || mo < 1 || mo > 12 || dd < 1 || dd > 31) return undefined;
  const key = `${yy}-${pad(mo)}-${pad(dd)}`;
  const date = kyivWallTimeToInstant(key, h * 60 + mi);
  return kyivDateKey(date) === key ? date : undefined;
}

/** 'HH:MM DD.MM.YYYY' of an instant, in Kyiv time. */
export function kyivStamp(d: Date): string {
  const [y, m, day] = kyivDateKey(d).split('-');
  return `${formatHM(d)} ${day}.${m}.${y}`;
}
