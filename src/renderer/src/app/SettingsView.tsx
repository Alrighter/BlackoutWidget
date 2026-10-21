import { useEffect, useId, useRef, useState } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import { LIMIT_TEXT, MAX_LOCATIONS, NAME_MAX, nameProblem, normalizeName } from '../../../shared/locations';
import { providerDisplayName } from '../../../shared/providers';
import { formatHM } from '../../../shared/time';
import type { AppState, LocationState, WidgetStyle } from '../../../shared/types';
import { WIDGET_SIZES } from '../../../shared/widget-sizes';
import { lowerFirst } from '../../../shared/widget-state';
import { ActualSettings, Alert } from './ActualSettings';
import { unwrapIpcError } from './ipc-error';
import { StyleThumb } from './StyleThumb';
import { STYLES } from './widget-styles';

/** The thumbnails' scale in the style cards (main-settings.html). */
const THUMB_SCALE: Record<WidgetStyle, number> = { compact: 0.4, ring: 0.32, timeline: 0.3 };

/** «<source> · Лінія N · черга X»; the queue only while the schedule on hand is the address's own. */
function addressSub(loc: LocationState): string {
  const { address } = loc.location;
  const { snapshot } = loc;
  const queue = snapshot && snapshot.groupId === address.groupId ? ` · ${lowerFirst(snapshot.groupLabel)}` : '';
  return `${providerDisplayName(address.providerId)} · Лінія ${address.lineIndex}${queue}`;
}

function updatedText(snapshot: LocationState['snapshot']): string {
  if (!snapshot) return 'Дані ще не отримано';
  const at = new Date(snapshot.fetchedAt);
  return `Оновлено о ${Number.isNaN(at.getTime()) ? '--:--' : formatHM(at)}`;
}

type Edit = 'none' | 'rename' | 'delete';

/**
 * The selected location's card: its name with an inline rename, the address, «Змінити адресу» and, among several,
 * «Видалити» behind an inline question. Keyed by the location, so an edit left open never follows the switcher.
 */
function AddressCard({ state, loc, api, onChangeAddress }: { state: AppState; loc: LocationState; api: RendererApi; onChangeAddress(): void }) {
  const { id, name, address } = loc.location;
  const others = state.locations.filter(l => l.location.id !== id).map(l => l.location.name);
  const [edit, setEdit] = useState<Edit>('none');
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const renameBtn = useRef<HTMLButtonElement>(null);
  const deleteBtn = useRef<HTMLButtonElement>(null);
  // The pressed button is gone while the field or the question is open; back from them, the focus returns to it.
  const shown = useRef<Edit>(edit);
  useEffect(() => {
    const was = shown.current;
    shown.current = edit;
    if (edit === 'none' && was !== 'none') (was === 'rename' ? renameBtn : deleteBtn).current?.focus();
  }, [edit]);

  const open = (next: Edit) => { setEdit(next); setDraft(name); setError(null); setBusy(false); };
  const problem = edit === 'rename' ? nameProblem(draft, others) : null;
  const shownProblem = problem ?? error;

  async function rename() {
    const next = normalizeName(draft);
    if (next === name) { open('none'); return; }
    setBusy(true); setError(null);
    try { await api.renameLocation(id, next); open('none'); } catch (e) { setError(unwrapIpcError(e).message); setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(null);
    // Done, the location leaves the state and the window falls back to the first one.
    try { await api.deleteLocation(id); } catch (e) { setError(unwrapIpcError(e).message); setBusy(false); }
  }

  const place = `${address.city}, ${address.street}, ${address.house}`;
  const sub = addressSub(loc);
  return (
    <section className="sv-card st-card" data-capture="address-card">
      <h2 className="st-title">Адреса</h2>
      {edit === 'rename' ? (
        <div className="st-rename">
          <label className="st-label" htmlFor={`${uid}-name`}>Назва</label>
          <input id={`${uid}-name`} className="st-input" value={draft} maxLength={NAME_MAX} autoFocus
            aria-invalid={shownProblem ? true : undefined} aria-describedby={shownProblem ? `${uid}-name-err` : undefined}
            onChange={e => { setDraft(e.target.value); setError(null); }}
            onKeyDown={e => { if (e.key === 'Enter' && !problem && !busy) void rename(); else if (e.key === 'Escape') open('none'); }} />
          {shownProblem && <p className="st-name-err" id={`${uid}-name-err`} role="alert">{shownProblem}</p>}
          <div className="st-actions">
            <button className="sv-primary" disabled={!!problem || busy} onClick={() => void rename()}>Зберегти</button>
            <button className="sv-btn st-ghost st-tall" onClick={() => open('none')}>Скасувати</button>
          </div>
        </div>
      ) : (
        <div className="st-loc-name">
          <span className="st-loc-name-text" title={name} data-capture="location-name">{name}</span>
          {edit === 'none' && <button className="st-link" ref={renameBtn} onClick={() => open('rename')}>Перейменувати</button>}
        </div>
      )}
      <div className="st-addr">
        <span className="st-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
        </span>
        <div className="st-addr-text">
          <span className="st-addr-main" title={place} data-capture="address">{place}</span>
          <span className="st-addr-sub" title={sub} data-capture="address-sub">{sub}</span>
        </div>
      </div>
      {edit === 'delete' ? (
        <div className="st-confirm" role="group" aria-labelledby={`${uid}-ask`}>
          <p className="st-text" id={`${uid}-ask`}>{`Видалити локацію «${name}»? Її віджет зникне з робочого столу.`}</p>
          <div className="st-actions">
            <button className="sv-primary st-danger" disabled={busy} onClick={() => void remove()}>Видалити</button>
            <button className="sv-btn st-ghost st-tall" autoFocus disabled={busy} onClick={() => open('none')}>Скасувати</button>
          </div>
          {error && <Alert text={error} />}
        </div>
      ) : edit === 'none' && (
        <div className="st-actions">
          <button className="sv-btn" onClick={onChangeAddress}>Змінити адресу</button>
          {state.locations.length > 1 && <button className="sv-btn st-ghost" ref={deleteBtn} onClick={() => open('delete')}>Видалити</button>}
        </div>
      )}
    </section>
  );
}

/** «Налаштування»: the selected location's address and widget style, its schedule row; autostart and EcoFlow for the app. */
export function SettingsView({ state, loc, api, ecoflowFormOpen = false, onChangeAddress, onAdd }: {
  state: AppState; loc: LocationState; api: RendererApi;
  /** Open with the EcoFlow form already expanded (D10). */
  ecoflowFormOpen?: boolean;
  onChangeAddress(): void;
  /** «Додати адресу»: the wizard for a new location. */
  onAdd(): void;
}) {
  const { autostart } = state.settings;
  const { id, widgetStyle } = loc.location;
  const full = state.locations.length >= MAX_LOCATIONS;
  const limitId = useId();
  return (
    <div className="st">
      <div className="st-col">
        <AddressCard key={id} state={state} loc={loc} api={api} onChangeAddress={onChangeAddress} />
        <div className="st-add">
          <button className="sv-btn st-add-btn" disabled={full} aria-describedby={full ? limitId : undefined} onClick={onAdd}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
            Додати адресу
          </button>
          {full && <span className="st-hint" id={limitId}>{LIMIT_TEXT}</span>}
        </div>

        <section className="sv-card st-card">
          <h2 className="st-title">Стиль віджета</h2>
          <div className="st-styles" role="radiogroup" aria-label="Стиль віджета">
            {STYLES.map(s => {
              const on = widgetStyle === s.id;
              const { width, height } = WIDGET_SIZES[s.id];
              return (
                <button key={s.id} role="radio" aria-checked={on} aria-labelledby={`st-style-${s.id}`} aria-describedby={`st-style-${s.id}-size`}
                  className="st-style" onClick={() => void api.setWidgetStyle(id, s.id)}>
                  <span className="st-thumb" data-capture={`thumb-box-${s.id}`}><StyleThumb style={s.id} scale={THUMB_SCALE[s.id]} /></span>
                  <span className="st-style-foot">
                    <span className="st-style-text">
                      <span className="st-style-name" id={`st-style-${s.id}`}>{s.name}</span>
                      <span className="st-style-size" id={`st-style-${s.id}-size`}>{`${width}×${height}`}</span>
                    </span>
                    {on && (
                      <span className="st-check">
                        <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <div className="st-col">
        <section className="sv-card st-card st-rows">
          <div className="st-row">
            <label className="st-row-text" htmlFor="st-autostart">
              <span className="st-row-title" id="st-autostart-name">Запускати разом із системою</span>
              <span className="st-row-sub" id="st-autostart-note">Віджет з’явиться після входу</span>
            </label>
            <button id="st-autostart" role="switch" aria-checked={autostart} aria-labelledby="st-autostart-name" aria-describedby="st-autostart-note"
              className="st-switch" onClick={() => void api.setAutostart(!autostart)} />
          </div>
          <div className="st-hair" />
          <div className="st-row">
            <div className="st-row-text">
              <span className="st-row-title">Графік відключень</span>
              <span className="st-row-sub" data-capture="updated">{updatedText(loc.snapshot)}</span>
            </div>
            <button className="sv-btn st-refresh" onClick={() => void api.refreshNow(id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
              Оновити зараз
            </button>
          </div>
        </section>
        <ActualSettings state={state} api={api} initiallyOpen={ecoflowFormOpen} />
      </div>
    </div>
  );
}
