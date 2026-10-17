import { useEffect, useState } from 'react';
import type { MainView, RendererApi } from '../../../shared/ipc';
import type { AppState } from '../../../shared/types';
import { ScheduleView } from './ScheduleView';
import { SettingsView } from './SettingsView';
import { SetupWizard } from './SetupWizard';

export function App({ api, view }: { api: RendererApi; view: MainView }) {
  const [state, setState] = useState<AppState | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [wizard, setWizard] = useState(view === 'setup');
  const [tab, setTab] = useState<'schedule' | 'settings'>(view === 'settings' ? 'settings' : 'schedule');

  useEffect(() => {
    let alive = true;
    void api.getState().then(s => { if (alive) setState(s); });
    const off = api.onState(setState);
    const offNav = api.onNavigate(v => {
      if (v === 'setup') setWizard(true);
      else { setWizard(false); setTab(v); }
    });
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => { alive = false; off(); offNav(); clearInterval(timer); };
  }, [api]);

  if (!state) return null;
  const hasAddress = !!state.settings.address;

  if (!hasAddress || wizard) {
    return (
      <main className="app">
        <SetupWizard api={api} onDone={() => { setWizard(false); setTab('schedule'); }} />
        {hasAddress && <button className="link" onClick={() => setWizard(false)}>Скасувати</button>}
      </main>
    );
  }

  return (
    <main className="app">
      <nav role="tablist" className="tabs main-tabs">
        <button role="tab" aria-selected={tab === 'schedule'} className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>Графік</button>
        <button role="tab" aria-selected={tab === 'settings'} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Налаштування</button>
      </nav>
      {tab === 'schedule'
        ? <ScheduleView state={state} now={now} api={api} />
        : <SettingsView state={state} api={api} onChangeAddress={() => setWizard(true)} />}
    </main>
  );
}
