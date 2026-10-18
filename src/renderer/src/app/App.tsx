import { useEffect, useState } from 'react';
import type { MainView, RendererApi } from '../../../shared/ipc';
import type { AppState } from '../../../shared/types';
import { ScheduleView } from './ScheduleView';
import { SettingsView } from './SettingsView';
import { SetupWizard } from './SetupWizard';

type Tab = 'schedule' | 'settings';

export function App({ api, view }: { api: RendererApi; view: MainView }) {
  const [state, setState] = useState<AppState | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [wizard, setWizard] = useState(view === 'setup');
  const [tab, setTab] = useState<Tab>(view === 'settings' ? 'settings' : 'schedule');
  // D10: the settings open once with the EcoFlow form expanded; any other way there shows them as usual.
  const [ecoflowForm, setEcoflowForm] = useState(false);
  const show = (next: Tab, openEcoflowForm = false) => { setTab(next); setEcoflowForm(openEcoflowForm); };
  const openWizard = () => { setWizard(true); setEcoflowForm(false); };

  useEffect(() => {
    let alive = true;
    void api.getState().then(s => { if (alive) setState(s); });
    const off = api.onState(setState);
    const offNav = api.onNavigate(v => {
      setEcoflowForm(false);
      if (v === 'setup') setWizard(true);
      else { setWizard(false); setTab(v); }
    });
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => { alive = false; off(); offNav(); clearInterval(timer); };
  }, [api]);

  if (!state) return null;
  const hasAddress = !!state.settings.address;

  if (!hasAddress || wizard) {
    // D3: the wizard fills the window, without the tab row.
    return (
      <div className="app">
        <SetupWizard api={api} autostart={state.settings.autostart}
          onDone={() => { setWizard(false); show('schedule'); }}
          onCancel={hasAddress ? () => setWizard(false) : undefined} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-bar">
        <nav role="tablist" className="app-tabs">
          <button role="tab" aria-selected={tab === 'schedule'} className="app-tab" onClick={() => show('schedule')}>Графік</button>
          <button role="tab" aria-selected={tab === 'settings'} className="app-tab" onClick={() => show('settings')}>Налаштування</button>
        </nav>
        {tab === 'schedule' && (
          <button className="app-refresh" aria-label="Оновити зараз" title="Оновити зараз" onClick={() => void api.refreshNow()}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
          </button>
        )}
      </header>
      <main className="app-body" data-capture="body">
        {tab === 'schedule'
          ? <ScheduleView state={state} now={now} api={api} onConnectEcoflow={() => show('settings', true)} />
          : <SettingsView state={state} api={api} ecoflowFormOpen={ecoflowForm} onChangeAddress={openWizard} />}
      </main>
    </div>
  );
}
