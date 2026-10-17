import { useRef, useState, type ComponentType } from 'react';
import type { EcoflowDeviceView, EcoflowKeysInput, EcoflowPreviewResult, RendererApi } from '../../../shared/ipc';
import { formatHM } from '../../../shared/time';
import type { AppState, EcoflowRegion } from '../../../shared/types';

type PanelProps = { state: AppState; api: RendererApi };

const cap = (s?: string) => (s ? s[0].toLocaleUpperCase('uk') + s.slice(1) : '');
const SAVE_FAILED = 'Не вдалося зберегти налаштування. Спробуйте ще раз.';

function previewText(r: EcoflowPreviewResult): string {
  if (!r.ok) return r.error;
  if (!r.online) return 'Станція не в мережі';
  if (r.unsupported) return 'Модель поки не підтримується';
  if (r.power === 'on') return r.detail ? `${cap(r.detail)} — світло є` : 'Світло є';
  if (r.power === 'off') return r.detail ? `${cap(r.detail)} — світла немає` : 'Світла немає';
  return cap(r.reason);
}

function currentText(actual: AppState['actual']): string | null {
  if (!actual) return null;
  const at = actual.observedAt ? ` (дані о ${formatHM(new Date(actual.observedAt))})` : '';
  if (actual.power === 'on') return `Зараз: світло є${at}`;
  if (actual.power === 'off') return `Зараз: світла немає${at}`;
  return `Зараз: невідомо${actual.reason ? ` — ${actual.reason}` : ''}`;
}

type Preview = { sn: string; text: string } | { sn: string; pending: true };

/** The keys live only in this component's state; the form is unmounted after save or cancel. */
function EcoflowForm({ api, onClose }: { api: RendererApi; onClose(): void }) {
  const [region, setRegion] = useState<EcoflowRegion>('eu');
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

  const keys = (): EcoflowKeysInput => ({ region, accessKey: accessKey.trim(), secretKey: secretKey.trim() });
  const resetResult = () => { seq.current++; setChecking(false); setDevices(null); setTestError(null); setSn(null); setPreview(null); setSaveError(null); };

  async function choose(next: string, k: EcoflowKeysInput) {
    const mine = ++seq.current;
    setSn(next); setPreview({ sn: next, pending: true }); setSaveError(null);
    let text: string;
    try { text = previewText(await api.ecoflowPreview(k, next)); } catch { text = 'Не вдалося прочитати показники'; }
    if (mine === seq.current) setPreview({ sn: next, text });
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

  const canCheck = !checking && accessKey.trim() !== '' && secretKey.trim() !== '';
  return (
    <div className="actual-form">
      <label className="field"><span>Регіон</span>
        <select value={region} onChange={e => { setRegion(e.target.value as EcoflowRegion); resetResult(); }}>
          <option value="eu">Європа</option>
          <option value="us">Інший регіон (api.ecoflow.com)</option>
        </select>
      </label>
      <label className="field"><span>Access Key</span>
        <input type="password" autoComplete="off" value={accessKey} onChange={e => { setAccessKey(e.target.value); resetResult(); }} />
      </label>
      <label className="field"><span>Secret Key</span>
        <input type="password" autoComplete="off" value={secretKey} onChange={e => { setSecretKey(e.target.value); resetResult(); }} />
      </label>
      <p className="muted">Ключі видає EcoFlow після схвалення заявки розробника на developer-eu.ecoflow.com (зазвичай кілька днів).</p>
      <button className="link" onClick={() => api.openEcoflowHelp()}>Як отримати ключі</button>
      <div className="row">
        <button className="secondary" disabled={!canCheck} onClick={() => void check()}>{checking ? 'Перевіряю…' : 'Перевірити'}</button>
        <button className="link" onClick={() => { setAccessKey(''); setSecretKey(''); onClose(); }}>Скасувати</button>
      </div>
      {testError && <p className="error" role="alert">{testError}</p>}
      {devices && (
        <div className="stations">
          <h3>Станції в акаунті</h3>
          {devices.length === 0 && <p className="muted">У цьому акаунті немає станцій</p>}
          {devices.map(d => (
            <label key={d.sn} className="station">
              <input type="radio" name="ecoflow-station" checked={sn === d.sn} onChange={() => void choose(d.sn, keys())} />
              <span>{`${d.label} · …${d.sn.slice(-4)}`}</span>
              <span className="muted">{d.online ? 'в мережі' : 'не в мережі'}</span>
            </label>
          ))}
          {preview && <p className="preview" aria-live="polite">{'pending' in preview ? 'Читаю показники…' : preview.text}</p>}
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={!devices || !sn || saving} onClick={() => void save()}>Зберегти</button>
      </div>
      {saveError && <p className="error" role="alert">{saveError}</p>}
    </div>
  );
}

function EcoflowPanel({ state, api }: PanelProps) {
  const source = state.settings.actualSource;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (editing) return <EcoflowForm api={api} onClose={() => setEditing(false)} />;
  if (!source) {
    return (
      <>
        <p>Зарядна станція EcoFlow може показувати, чи є світло насправді.</p>
        <button className="primary" onClick={() => setEditing(true)}>Підключити EcoFlow</button>
      </>
    );
  }
  const now = currentText(state.actual);
  return (
    <>
      <p>{`EcoFlow · ${source.deviceName} · ключ ${source.accessKeyHint}`}</p>
      {now && <p className="muted">{now}</p>}
      <div className="row">
        <button className="secondary" onClick={() => { setError(null); setEditing(true); }}>Змінити</button>
        <button className="secondary" onClick={() => { setError(null); api.actualDisconnect().catch(() => setError(SAVE_FAILED)); }}>Вимкнути</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

const PANELS: Record<string, { name: string; Panel: ComponentType<PanelProps> }> = {
  ecoflow: { name: 'EcoFlow', Panel: EcoflowPanel },
};

export function ActualSettings({ state, api }: PanelProps) {
  const [sourceId, setSourceId] = useState('ecoflow');
  const { Panel } = PANELS[sourceId];
  return (
    <section className="actual-settings">
      <h2>Фактичний стан світла</h2>
      <label className="field"><span className="muted">Джерело</span>
        <select aria-label="Джерело" value={sourceId} onChange={e => setSourceId(e.target.value)}>
          {Object.entries(PANELS).map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
        </select>
      </label>
      <Panel state={state} api={api} />
    </section>
  );
}
