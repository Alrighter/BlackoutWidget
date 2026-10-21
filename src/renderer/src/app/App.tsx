import { useEffect, useState } from 'react';
import type { MainView, RendererApi } from '../../../shared/ipc';
import type { AppState, WidgetStyle } from '../../../shared/types';
import { Banner, ScheduleView } from './ScheduleView';
import { SettingsView } from './SettingsView';
import { SetupWizard, type WizardMode } from './SetupWizard';

type Tab = 'schedule' | 'settings';
/**
 * The wizard on show. `first` stays until it is done, even once its own new location is in the state. `add` is
 * frozen when it opens: the ids and names then, and locations[0]'s style, so the location it has just saved, landing
 * in the state before the call returns, is never «taken». `edit` without an id edits the selected location (main's
 * «setup»); with one, that location only.
 */
type Wizard =
  | { kind: 'first' }
  | { kind: 'add'; before: string[]; taken: string[]; style: WidgetStyle }
  | { kind: 'edit'; id?: string }
  | null;

const UNREADABLE = 'Не вдалося прочитати налаштування. Спробую ще раз за хвилину.';

export function App({ api, view, locationId }: { api: RendererApi; view: MainView; locationId?: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [now, setNow] = useState(() => new Date());
  // Not persisted: a new window starts on the location it was opened for, else on the first one.
  const [selected, setSelected] = useState(locationId);
  const [wizard, setWizard] = useState<Wizard>(view === 'setup' ? { kind: 'edit' } : null);
  const [tab, setTab] = useState<Tab>(view === 'settings' ? 'settings' : 'schedule');
  // D10: the settings open once with the EcoFlow form expanded; any other way there shows them as usual.
  const [ecoflowForm, setEcoflowForm] = useState(false);
  // A finished add: the ids before it. The id that then appears in the state is selected, once.
  const [addedFrom, setAddedFrom] = useState<string[] | null>(null);
  const select = (id: string) => { setAddedFrom(null); setSelected(id); };
  const show = (next: Tab, openEcoflowForm = false) => { setTab(next); setEcoflowForm(openEcoflowForm); };
  const openWizard = (next: Wizard) => { setWizard(next); setEcoflowForm(false); };

  useEffect(() => {
    let alive = true;
    void api.getState().then(s => { if (alive) setState(s); });
    const off = api.onState(setState);
    const offNav = api.onNavigate(nav => {
      setEcoflowForm(false);
      // An explicit location wins over a pending add's.
      if (nav.locationId !== undefined) { setAddedFrom(null); setSelected(nav.locationId); }
      // The first setup is not left by a navigate: the window cannot be used without it.
      setWizard(w => (w?.kind === 'first' ? w : nav.view === 'setup' ? { kind: 'edit', id: nav.locationId } : null));
      if (nav.view !== 'setup') setTab(nav.view);
    });
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => { alive = false; off(); offNav(); clearInterval(timer); };
  }, [api]);

  // A read with no locations: the first setup, kept on until it is done.
  const firstSetup = !!state && state.settingsLoaded && state.locations.length === 0;
  useEffect(() => { if (firstSetup) setWizard({ kind: 'first' }); }, [firstSetup]);
  const added = addedFrom && state ? state.locations.find(l => !addedFrom.includes(l.location.id)) : undefined;
  const addedId = added?.location.id;
  useEffect(() => { if (addedId) select(addedId); }, [addedId]);

  if (!state) return null;

  // An unreadable settings file is not a new install: never the first setup then, only the note.
  if (!state.settingsLoaded) {
    return (
      <div className="app">
        <main className="app-body app-unread"><Banner tone="warn" title={UNREADABLE} /></main>
      </div>
    );
  }

  const { locations } = state;
  const names = locations.map(l => l.location.name);
  // The selection falls back to the first location when its id is unknown or gone. A just-added location is shown
  // at once, in the render before the effect above records it.
  const loc = added ?? locations.find(l => l.location.id === selected) ?? locations[0];

  let mode: WizardMode | null = null;
  if (firstSetup || wizard?.kind === 'first') mode = { kind: 'first' };
  else if (wizard?.kind === 'add') mode = { kind: 'add', taken: wizard.taken, style: wizard.style };
  else if (wizard?.kind === 'edit') {
    // The location to edit; one deleted meanwhile closes the wizard rather than edit another.
    const target = wizard.id === undefined ? loc : locations.find(l => l.location.id === wizard.id);
    if (target) mode = { kind: 'edit', location: target.location, taken: names.filter(n => n !== target.location.name) };
  }

  if (mode) {
    // D3: the wizard fills the window, without the tab row. A new mode or location is a fresh wizard.
    return (
      <div className="app">
        <SetupWizard key={mode.kind === 'edit' ? `edit:${mode.location.id}` : mode.kind} api={api} autostart={state.settings.autostart}
          mode={mode} onDone={() => { if (wizard?.kind === 'add') setAddedFrom(wizard.before); setWizard(null); show('schedule'); }}
          onCancel={mode.kind === 'first' ? undefined : () => setWizard(null)} />
      </div>
    );
  }
  // No locations is the first setup above.
  if (!loc) return null;

  const { id } = loc.location;
  return (
    <div className="app">
      <header className="app-bar">
        <div className="app-nav">
          <nav role="tablist" aria-label="Розділи" className="app-tabs">
            <button role="tab" aria-selected={tab === 'schedule'} className="app-tab" onClick={() => show('schedule')}>Графік</button>
            <button role="tab" aria-selected={tab === 'settings'} className="app-tab" onClick={() => show('settings')}>Налаштування</button>
          </nav>
          {locations.length > 1 && (
            <div role="tablist" aria-label="Адреси" className="app-locs" data-capture="switcher">
              {locations.map(l => (
                <button key={l.location.id} role="tab" aria-selected={l.location.id === id} className="app-loc" title={l.location.name}
                  onClick={() => select(l.location.id)}>
                  <span>{l.location.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {tab === 'schedule' && (
          <button className="app-refresh" aria-label="Оновити зараз" title="Оновити зараз" onClick={() => void api.refreshNow(id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66" /><path d="M20 4v5h-5" /></svg>
          </button>
        )}
      </header>
      <main className="app-body" data-capture="body">
        {tab === 'schedule'
          ? <ScheduleView loc={loc} settings={state.settings} now={now} api={api}
              onConnectEcoflow={() => show('settings', true)} onChangeAddress={() => openWizard({ kind: 'edit', id })} />
          : <SettingsView state={state} loc={loc} api={api} ecoflowFormOpen={ecoflowForm}
              onChangeAddress={() => openWizard({ kind: 'edit', id })} onAdd={() => openWizard({ kind: 'add', before: locations.map(l => l.location.id), taken: names, style: locations[0].location.widgetStyle })} />}
      </main>
    </div>
  );
}
