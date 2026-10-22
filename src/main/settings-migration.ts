import { HOME_ID, HOME_NAME, isAddress } from '../shared/locations';
import type { Location, Settings, WidgetPosition, WidgetStyle } from '../shared/types';
import { DEFAULT_SETTINGS } from './store';

const STYLES: WidgetStyle[] = ['compact', 'ring', 'timeline'];
const LEGACY_KEYS = ['address', 'widgetStyle', 'widgetPosition'] as const;

function isPosition(v: unknown): v is WidgetPosition {
  const p = v as Record<string, unknown> | null;
  return !!p && typeof p === 'object' && ['x', 'y', 'displayId'].every(k => typeof p[k] === 'number');
}

/**
 * The one-address settings file becomes one location with a fixed id, so a migration that could not be written yet
 * gives the same location on every read. `migrated` is true when the file had old keys that must be rewritten
 * (an empty or unreadable file has nothing to migrate and is left alone).
 */
export function migrateSettings(raw: Record<string, unknown>): { settings: Settings; migrated: boolean } {
  if (Array.isArray(raw.locations)) return { settings: { ...DEFAULT_SETTINGS, ...raw } as Settings, migrated: false };
  const { address, widgetStyle, widgetPosition, locations: _ignored, ...rest } = raw;
  const home: Location | null = isAddress(address) ? {
    id: HOME_ID, name: HOME_NAME, address,
    widgetStyle: STYLES.includes(widgetStyle as WidgetStyle) ? widgetStyle as WidgetStyle : 'compact',
    widgetPosition: isPosition(widgetPosition) ? widgetPosition : null,
  } : null;
  const settings = { ...DEFAULT_SETTINGS, ...rest, locations: home ? [home] : [], actualLocationId: home ? HOME_ID : null } as Settings;
  return { settings, migrated: LEGACY_KEYS.some(k => k in raw) };
}
