import type { RendererApi } from '../../../shared/ipc';
import { providerDisplayName } from '../../../shared/providers';
import { formatHM } from '../../../shared/time';
import type { AppState, WidgetStyle } from '../../../shared/types';
import { WIDGET_SIZES } from '../../../shared/widget-sizes';
import { ActualSettings } from './ActualSettings';
import { StyleThumb } from './StyleThumb';
import { STYLES } from './widget-styles';

/** The thumbnails' scale in the style cards (main-settings.html). */
const THUMB_SCALE: Record<WidgetStyle, number> = { compact: 0.4, ring: 0.32, timeline: 0.3 };

/** «<source> · Лінія N · черга X»; the queue only while the schedule on hand is the address's own. */
function addressSub(state: AppState): string {
  const { address } = state.settings;
  if (!address) return '';
  const { snapshot } = state;
  const queue = snapshot && snapshot.groupId === address.groupId ? ` · ${snapshot.groupLabel.toLowerCase()}` : '';
  return `${providerDisplayName(address.providerId)} · Лінія ${address.lineIndex}${queue}`;
}

function updatedText(snapshot: AppState['snapshot']): string {
  if (!snapshot) return 'Дані ще не отримано';
  const at = new Date(snapshot.fetchedAt);
  return `Оновлено о ${Number.isNaN(at.getTime()) ? '--:--' : formatHM(at)}`;
}

export function SettingsView({ state, api, ecoflowFormOpen = false, onChangeAddress }: {
  state: AppState; api: RendererApi;
  /** Open with the EcoFlow form already expanded (D10). */
  ecoflowFormOpen?: boolean;
  onChangeAddress(): void;
}) {
  const { address, widgetStyle, autostart } = state.settings;
  const place = address ? `${address.city}, ${address.street}, ${address.house}` : 'Адресу не вибрано';
  const sub = addressSub(state);
  return (
    <div className="st">
      <div className="st-col">
        <section className="sv-card st-card">
          <h2 className="st-title">Адреса</h2>
          <div className="st-addr">
            <span className="st-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
            </span>
            <div className="st-addr-text">
              <span className="st-addr-main" title={place} data-capture="address">{place}</span>
              {sub && <span className="st-addr-sub" title={sub} data-capture="address-sub">{sub}</span>}
            </div>
          </div>
          <div className="st-actions"><button className="sv-btn" onClick={onChangeAddress}>Змінити адресу</button></div>
        </section>

        <section className="sv-card st-card">
          <h2 className="st-title">Стиль віджета</h2>
          <div className="st-styles" role="radiogroup" aria-label="Стиль віджета">
            {STYLES.map(s => {
              const on = widgetStyle === s.id;
              const { width, height } = WIDGET_SIZES[s.id];
              return (
                <button key={s.id} role="radio" aria-checked={on} aria-labelledby={`st-style-${s.id}`} aria-describedby={`st-style-${s.id}-size`}
                  className="st-style" onClick={() => void api.setWidgetStyle(s.id)}>
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
              <span className="st-row-sub" data-capture="updated">{updatedText(state.snapshot)}</span>
            </div>
            <button className="sv-btn st-refresh" onClick={() => void api.refreshNow()}>
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
