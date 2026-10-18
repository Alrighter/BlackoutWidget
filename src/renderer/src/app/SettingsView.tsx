import type { RendererApi } from '../../../shared/ipc';
import type { AppState } from '../../../shared/types';
import { ActualSettings } from './ActualSettings';
import { STYLES } from './widget-styles';

export function SettingsView({ state, api, ecoflowFormOpen = false, onChangeAddress }: {
  state: AppState; api: RendererApi;
  /** Open with the EcoFlow form already expanded (D10). */
  ecoflowFormOpen?: boolean;
  onChangeAddress(): void;
}) {
  const { address, widgetStyle, autostart } = state.settings;
  return (
    <div className="settings panel">
      <section>
        <h2>Адреса</h2>
        <p>{address ? `${address.city}, ${address.street}, ${address.house} · Лінія ${address.lineIndex}` : 'Адресу не вибрано'}</p>
        <button className="secondary" onClick={onChangeAddress}>Змінити адресу</button>
      </section>
      <section>
        <h2>Стиль віджета</h2>
        <div className="cards" role="radiogroup" aria-label="Стиль віджета">
          {STYLES.map(s => (
            <button key={s.id} role="radio" aria-checked={widgetStyle === s.id} className={`card${widgetStyle === s.id ? ' selected' : ''}`}
              onClick={() => void api.setWidgetStyle(s.id)}>
              <strong>{s.name}</strong><span className="muted">{s.hint}</span>
            </button>
          ))}
        </div>
      </section>
      <ActualSettings state={state} api={api} initiallyOpen={ecoflowFormOpen} />
      <section>
        <label className="switch">
          <input type="checkbox" role="switch" checked={autostart} onChange={e => void api.setAutostart(e.target.checked)} />
          <span>Запускати разом із системою</span>
        </label>
      </section>
      <section>
        <button className="primary" onClick={() => void api.refreshNow()}>Оновити зараз</button>
      </section>
    </div>
  );
}
