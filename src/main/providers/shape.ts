export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Base of every provider's «unknown shape» error (ToeShapeError, LoeShapeError, MkoeShapeError extend it). The message is a fixed reason of ours. */
export class ShapeError extends Error {}

/** An instant written with its zone: a bare wall time would be read in the machine's zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An instant written with its zone (`Z` or `±HH:MM`); a bare wall time or a bad date is undefined. */
export function instant(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !INSTANT.test(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
