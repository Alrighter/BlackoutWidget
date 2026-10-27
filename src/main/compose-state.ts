import type { ActualStatus, AppState, LocationState, Settings, UpdateStatus, WidgetState } from '../shared/types';

/**
 * The state the windows get. `actual` (the station's own status) goes on AppState for the EcoFlow card, and onto
 * the one LocationState whose id is `settings.actualLocationId` — no other location carries it. `update` only when
 * the updater runs.
 */
export function composeAppState(
  settings: Settings, locations: LocationState[], actual: ActualStatus | null | undefined, settingsLoaded: boolean,
  update?: UpdateStatus,
): AppState {
  return {
    settings,
    locations: locations.map(l => (l.location.id === settings.actualLocationId ? { ...l, actual } : l)),
    actual,
    settingsLoaded,
    ...(update ? { update } : {}),
  };
}

/** One widget's state: only its own location, never another's snapshot. Null for an id that is gone. */
export function widgetStateOf(state: AppState, id: string): WidgetState | null {
  const location = state.locations.find(l => l.location.id === id);
  return location ? { location, showName: state.locations.length > 1 } : null;
}
