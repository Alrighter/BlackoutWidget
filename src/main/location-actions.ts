import { NAME_EMPTY, UNKNOWN_LOCATION, isAddress, normalizeName, sameAddress } from '../shared/locations';
import type { Address, Location, WidgetPosition, WidgetStyle } from '../shared/types';
import type { RefreshService } from './refresh';
import { LocationError } from './store';
import type { AppStore } from './store';

const STYLES: WidgetStyle[] = ['compact', 'ring', 'timeline'];

export interface LocationActions {
  add(input: unknown): Location;
  edit(id: unknown, input: unknown): Promise<void>;
  rename(id: unknown, name: unknown): void;
  remove(id: unknown): void;
  setStyle(id: unknown, style: unknown): void;
  setActualLocation(id: unknown): void;
}

export interface LocationActionDeps {
  store: AppStore;
  service: Pick<RefreshService, 'addressChanged' | 'forget'>;
  isProvider(id: string): boolean;
  placeNew(style: WidgetStyle): WidgetPosition;
  /** Called after every change, so main can rebuild its schedulers, widgets and menus and tell the window. */
  changed(): void;
}

/** Validates what the main window sends, then applies it. Invalid input throws LocationError; store errors pass through. */
export function createLocationActions(deps: LocationActionDeps): LocationActions {
  const { store, service } = deps;

  const idOf = (id: unknown): string => {
    if (typeof id !== 'string') throw new LocationError(UNKNOWN_LOCATION);
    return id;
  };
  const nameOf = (name: unknown): string => {
    if (typeof name !== 'string') throw new LocationError(NAME_EMPTY);
    return name;
  };
  const styleOf = (style: unknown): WidgetStyle => {
    if (!STYLES.includes(style as WidgetStyle)) throw new LocationError(`Невідомий стиль: ${String(style)}`);
    return style as WidgetStyle;
  };
  const inputOf = (input: unknown): { name: string; address: Address; widgetStyle: WidgetStyle } => {
    if (!input || typeof input !== 'object') throw new LocationError('Некоректні дані адреси');
    const i = input as Record<string, unknown>;
    if (!isAddress(i.address) || !deps.isProvider(i.address.providerId)) throw new LocationError('Некоректна адреса');
    const { providerId, city, street, house, lineIndex, groupId } = i.address;
    return { name: nameOf(i.name), address: { providerId, city, street, house, lineIndex, groupId }, widgetStyle: styleOf(i.widgetStyle) };
  };

  return {
    add(input) {
      const v = inputOf(input);
      const location = store.addLocation({ name: normalizeName(v.name), address: v.address, widgetStyle: v.widgetStyle, widgetPosition: deps.placeNew(v.widgetStyle) });
      deps.changed();
      return location;
    },

    async edit(id, input) {
      const locationId = idOf(id);
      const v = inputOf(input);
      let addressChanged = false;
      store.updateLocation(locationId, l => {
        addressChanged = !sameAddress(l.address, v.address);
        return { ...l, name: v.name, address: v.address, widgetStyle: v.widgetStyle };
      });
      deps.changed();
      // The wizard waits for the first fetch of the new address.
      if (addressChanged) await service.addressChanged(locationId);
    },

    rename(id, name) {
      const locationId = idOf(id);
      const n = nameOf(name);
      store.updateLocation(locationId, l => ({ ...l, name: n }));
      deps.changed();
    },

    remove(id) {
      const locationId = idOf(id);
      store.removeLocation(locationId);
      service.forget(locationId);
      deps.changed();
    },

    setStyle(id, style) {
      const locationId = idOf(id);
      const s = styleOf(style);
      store.updateLocation(locationId, l => ({ ...l, widgetStyle: s }));
      deps.changed();
    },

    setActualLocation(id) {
      const locationId = idOf(id);
      if (!store.getLocation(locationId)) throw new LocationError(UNKNOWN_LOCATION);
      store.updateSettings({ actualLocationId: locationId });
      deps.changed();
    },
  };
}
