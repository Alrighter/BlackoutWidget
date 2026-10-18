import { useEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from 'react';
import type { EcoflowDeviceView, EcoflowKeysInput, EcoflowPreviewResult, RendererApi } from '../../../shared/ipc';
import { formatHM } from '../../../shared/time';
import type { AppState, EcoflowRegion } from '../../../shared/types';

/** `initiallyOpen`: start with the connect / change form expanded (D10). */
type SettingsProps = { state: AppState; api: RendererApi; initiallyOpen?: boolean };
/** A panel draws the whole card: its heading changes with its step. `sourcePicker` goes into its connect form. */
type PanelProps = SettingsProps & { sourceName: string; sourcePicker: ReactNode };

const cap = (s?: string) => (s ? s[0].toLocaleUpperCase('uk') + s.slice(1) : '');
const SAVE_FAILED = 'Не вдалося зберегти налаштування. Спробуйте ще раз.';
const BOLT = 'M13.5 2 4.5 13.5H11l-1.5 8.5 9-11.5H12z';

/** Colour of the «Перевірка» box: the power read, a model we can't read, or nothing to tell. */
type Tone = 'on' | 'off' | 'warn' | 'neutral';

function previewView(r: EcoflowPreviewResult): { text: string; tone: Tone } {
  if (!r.ok) return { text: r.error, tone: 'neutral' };
  if (!r.online) return { text: 'Станція не в мережі', tone: 'neutral' };
  if (r.unsupported) return { text: 'Модель поки не підтримується', tone: 'warn' };
  if (r.power === 'on') return { text: r.detail ? `${cap(r.detail)} — світло є` : 'Світло є', tone: 'on' };
  if (r.power === 'off') return { text: r.detail ? `${cap(r.detail)} — світла немає` : 'Світла немає', tone: 'off' };
  return { text: cap(r.reason), tone: 'neutral' };
}

function currentText(actual: AppState['actual']): string | null {
  if (!actual) return null;
  const at = actual.observedAt ? ` (дані о ${formatHM(new Date(actual.observedAt))})` : '';
  if (actual.power === 'on') return `Зараз: світло є${at}`;
  if (actual.power === 'off') return `Зараз: світла немає${at}`;
  return `Зараз: невідомо${actual.reason ? ` — ${actual.reason}` : ''}`;
}

type Preview = { sn: string; text: string; tone: Tone } | { sn: string; pending: true };

/**
 * The card swaps its content under the button just pressed, so the new step's heading takes the focus: whenever `step`
 * changes, and also on mount with `onMount` (the form, opened by a button that is gone now).
 */
function useStepFocus(step: string, onMount = false) {
  const ref = useRef<HTMLHeadingElement>(null);
  const shown = useRef<string | null>(onMount ? null : step);
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    ref.current?.focus();
  }, [step]);
  return ref;
}

function Head({ title, chip, headRef }: { title: string; chip?: string; headRef: RefObject<HTMLHeadingElement | null> }) {
  return (
    <div className="st-head">
      <h2 className="st-title" ref={headRef} tabIndex={-1}>{title}</h2>
      {chip && (
        <span className="sv-chip st-chip">
          <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d={BOLT} /></svg>{chip}
        </span>
      )}
    </div>
  );
}

function Alert({ text }: { text: string }) {
  return (
    <div className="st-alert" role="alert">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5" /><path d="M12 16.4v.1" /></svg>
      <span>{text}</span>
    </div>
  );
}

function CheckResult({ preview }: { preview: Preview }) {
  const pending = 'pending' in preview;
  const tone = pending ? 'neutral' : preview.tone;
  return (
    <div className={`st-result ${tone}`} aria-live="polite" data-capture="check">
      <span className="st-result-label">Перевірка</span>
      <span className="st-result-value">
        {tone === 'warn'
          ? <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20.5h20z" /><path d="M12 10v4.5" /><path d="M12 17.6v.1" /></svg>
          : <i />}
        {pending ? 'Читаю показники…' : preview.text}
      </span>
    </div>
  );
}

/**
 * The keys live only in this component's state; the form is unmounted after save or cancel. Two steps: the keys, then
 * (after a successful check) the account's stations; «Назад» drops the check result and keeps the keys.
 */
function EcoflowForm({ api, initialRegion, sourcePicker, onClose }: {
  api: RendererApi; initialRegion: EcoflowRegion; sourcePicker: ReactNode; onClose(): void;
}) {
  const [region, setRegion] = useState<EcoflowRegion>(initialRegion);
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [devices, setDevices] = useState<EcoflowDeviceView[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [sn, setSn] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seq = useRef(0);
  const headRef = useStepFocus(devices ? 'stations' : 'keys', true);

  const keys = (): EcoflowKeysInput => ({ region, accessKey: accessKey.trim(), secretKey: secretKey.trim() });
  const resetResult = () => { seq.current++; setChecking(false); setDevices(null); setTestError(null); setSn(null); setPreview(null); setSaveError(null); };

  async function choose(next: string, k: EcoflowKeysInput) {
    const mine = ++seq.current;
    setSn(next); setPreview({ sn: next, pending: true }); setSaveError(null);
    let view: { text: string; tone: Tone };
    try { view = previewView(await api.ecoflowPreview(k, next)); } catch { view = { text: 'Не вдалося прочитати показники', tone: 'neutral' }; }
    if (mine === seq.current) setPreview({ sn: next, ...view });
  }
  async function check() {
    const k = keys(); resetResult(); setChecking(true);
    const mine = seq.current;
    let res;
    try { res = await api.ecoflowTest(k); } catch { res = { ok: false as const, error: 'Не вдалося перевірити ключі' }; }
    if (mine !== seq.current) return;
    setChecking(false);
    if (!res.ok) { setTestError(res.error); return; }
    setDevices(res.devices);
    if (res.devices.length === 1) void choose(res.devices[0].sn, k);
  }
  async function save() {
    const device = devices?.find(d => d.sn === sn);
    if (!device) return;
    setSaving(true); setSaveError(null);
    let res;
    try { res = await api.ecoflowSave(keys(), { sn: device.sn, label: device.label }); } catch { res = { ok: false as const, error: SAVE_FAILED }; }
    setSaving(false);
    if (res.ok) { setAccessKey(''); setSecretKey(''); onClose(); } else setSaveError(res.error);
  }

  if (devices) {
    return (
      <div className="st-panel">
        <h2 className="st-title" ref={headRef} tabIndex={-1}>Станції в акаунті</h2>
        {devices.length === 0 ? <p className="st-text">У цьому акаунті немає станцій</p> : (
          <fieldset className="st-stations">
            <legend className="st-sr">Станція</legend>
            {devices.map(d => (
              <label key={d.sn} className="st-station">
                <input type="radio" name="ecoflow-station" checked={sn === d.sn} onChange={() => void choose(d.sn, keys())} />
                <span className="st-station-name">{d.label} <span>{`· …${d.sn.slice(-4)}`}</span></span>
                <span className={`st-station-state${d.online ? ' online' : ''}`}><i />{d.online ? 'в мережі' : 'не в мережі'}</span>
              </label>
            ))}
          </fieldset>
        )}
        {preview && <CheckResult preview={preview} />}
        <div className="st-actions">
          <button className="sv-primary" disabled={!sn || saving} onClick={() => void save()}>Зберегти</button>
          <button className="sv-btn st-ghost st-tall" disabled={saving} onClick={resetResult}>Назад</button>
        </div>
        {saveError && <Alert text={saveError} />}
      </div>
    );
  }

  const canCheck = !checking && accessKey.trim() !== '' && secretKey.trim() !== '';
  const pickRegion = (next: EcoflowRegion) => { setRegion(next); resetResult(); };
  return (
    <div className="st-panel st-form">
      <h2 className="st-title" ref={headRef} tabIndex={-1}>Підключення EcoFlow</h2>
      {sourcePicker}
      <fieldset className="st-radios">
        <legend>Регіон</legend>
        <label className="st-radio">
          <input type="radio" name="ecoflow-region" checked={region === 'eu'} onChange={() => pickRegion('eu')} />Європа
        </label>
        <label className="st-radio">
          <input type="radio" name="ecoflow-region" checked={region === 'us'} onChange={() => pickRegion('us')} />Інший регіон <span>(api.ecoflow.com)</span>
        </label>
      </fieldset>
      <label className="st-field"><span className="st-label">Access Key</span>
        <input className="st-input st-mono" type="password" autoComplete="off" value={accessKey} onChange={e => { setAccessKey(e.target.value); resetResult(); }} />
      </label>
      <label className="st-field"><span className="st-label">Secret Key</span>
        <input className="st-input" type="password" autoComplete="off" placeholder="Вставте Secret Key" value={secretKey}
          onChange={e => { setSecretKey(e.target.value); resetResult(); }} />
      </label>
      <p className="st-hint">
        Ключі видає EcoFlow після схвалення заявки розробника на developer-eu.ecoflow.com (зазвичай кілька днів).{' '}
        <button className="st-link" onClick={() => api.openEcoflowHelp()}>Як отримати ключі</button>
      </p>
      {testError && <Alert text={testError} />}
      <div className="st-actions">
        <button className={`sv-primary${checking ? ' st-busy' : ''}`} disabled={!canCheck} onClick={() => void check()}>
          {checking && <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>}
          {checking ? 'Перевіряю…' : 'Перевірити'}
        </button>
        <button className="sv-btn st-ghost st-tall" onClick={() => { setAccessKey(''); setSecretKey(''); onClose(); }}>Скасувати</button>
      </div>
    </div>
  );
}

function EcoflowPanel({ state, api, initiallyOpen = false, sourceName, sourcePicker }: PanelProps) {
  const source = state.settings.actualSource;
  const [editing, setEditing] = useState(initiallyOpen);
  const [error, setError] = useState<string | null>(null);
  const headRef = useStepFocus(editing ? 'form' : source ? 'connected' : 'idle');

  if (editing) {
    return <EcoflowForm api={api} initialRegion={source?.region ?? 'eu'} sourcePicker={sourcePicker} onClose={() => setEditing(false)} />;
  }
  if (!source) {
    return (
      <div className="st-panel">
        <Head title="Фактичний стан світла" chip={sourceName} headRef={headRef} />
        <p className="st-text">Зарядна станція EcoFlow може показувати, чи є світло насправді.</p>
        <div className="st-actions"><button className="sv-primary" onClick={() => setEditing(true)}>Підключити EcoFlow</button></div>
      </div>
    );
  }
  const name = `EcoFlow · ${source.deviceName} · ключ ${source.accessKeyHint}`;
  const now = currentText(state.actual);
  return (
    <div className="st-panel">
      <Head title="Фактичний стан світла" chip={sourceName} headRef={headRef} />
      <div className="st-device">
        <span className="st-icon st-icon-lg">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M8 6V4h8v2" /><path d="m12.5 9-3 4.5h4l-1 3.5" /></svg>
        </span>
        <div className="st-device-text">
          <span className="st-device-name" title={name} data-capture="device">{name}</span>
          {now && <span className="st-device-now"><i className={`sv-tone-${state.actual!.power}`} />{now}</span>}
        </div>
      </div>
      <div className="st-actions">
        <button className="sv-btn" onClick={() => { setError(null); setEditing(true); }}>Змінити</button>
        <button className="sv-btn st-ghost" onClick={() => { setError(null); api.actualDisconnect().catch(() => setError(SAVE_FAILED)); }}>Вимкнути</button>
      </div>
      {error && <Alert text={error} />}
    </div>
  );
}

const PANELS: Record<string, { name: string; Panel: ComponentType<PanelProps> }> = {
  ecoflow: { name: 'EcoFlow', Panel: EcoflowPanel },
};

export function ActualSettings({ state, api, initiallyOpen = false }: SettingsProps) {
  const [sourceId, setSourceId] = useState('ecoflow');
  const { name, Panel } = PANELS[sourceId];
  const ref = useRef<HTMLElement>(null);
  // Opened for the form: bring it into view (jsdom has no scrollIntoView).
  useEffect(() => { if (initiallyOpen) ref.current?.scrollIntoView?.({ block: 'start' }); }, [initiallyOpen]);
  const picker = (
    <label className="st-field"><span className="st-label">Джерело</span>
      <span className="st-select">
        <select value={sourceId} onChange={e => setSourceId(e.target.value)}>
          {Object.entries(PANELS).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
        </select>
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </span>
    </label>
  );
  return (
    <section className="sv-card st-card" ref={ref} data-capture="ecoflow">
      <Panel state={state} api={api} initiallyOpen={initiallyOpen} sourceName={name} sourcePicker={picker} />
    </section>
  );
}
