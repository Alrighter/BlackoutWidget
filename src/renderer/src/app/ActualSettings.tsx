import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { BLE_LINK_TEXT, BLE_PROBLEM_TEXT, isRiver2Family } from '../../../shared/ecoflow-ble';
import type { ActualLive, EcoflowDeviceView, EcoflowInput, EcoflowPreviewResult, RendererApi } from '../../../shared/ipc';
import { formatHM } from '../../../shared/time';
import type { AppState, EcoflowRegion } from '../../../shared/types';

/** `initiallyOpen`: start with the connect / change form expanded (D10). */
type SettingsProps = { state: AppState; api: RendererApi; initiallyOpen?: boolean };
type Mode = 'account' | 'keys' | 'ble';
const MODES: { value: Mode; label: string }[] = [
  { value: 'account', label: 'EcoFlow — вхід через акаунт' },
  { value: 'keys', label: 'EcoFlow — ключі розробника' },
  { value: 'ble', label: 'EcoFlow — Bluetooth (без інтернету)' },
];

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

/** The «Перевірка» box in Bluetooth mode: worked out from the scan, nothing is read from the station. */
function bleView(d: EcoflowDeviceView): { text: string; tone: Tone } {
  if (!bleSupported(d)) return { text: 'Модель поки не підтримується', tone: 'warn' };
  if (d.nearby) return { text: 'Станція поруч — стан світла з’явиться після збереження', tone: 'neutral' };
  return { text: 'Станцію не знайдено поруч — увімкніть її і тримайте поряд з комп’ютером', tone: 'neutral' };
}
const bleSupported = (d: EcoflowDeviceView) => d.supported ?? isRiver2Family(d.sn);

/** The live line of the Bluetooth source; a value the station has not sent yet is left out, never shown as 0. */
function liveText(l: ActualLive | null): string | null {
  if (!l) return null;
  if (l.link === 'connected') {
    const out = l.acOut === undefined ? null : `вихід AC ${l.acOut ? 'увімк' : 'вимк'}`;
    const soc = l.soc === undefined ? null : `заряд ${l.soc}%`;
    const input = l.invSilent ? ['Станція не повідомляє про вхід'] : [
      l.acInVolts === undefined ? null : `${l.acInVolts} В`,
      l.acInHz === undefined ? null : `${l.acInHz} Гц`,
      l.inputWatts === undefined ? null : `${l.inputWatts} Вт`,
    ].filter((p): p is string => p !== null);
    if (!l.invSilent && input.length) input[0] = `На вході ${input[0]}`;
    const parts = [...input, out, soc].filter((p): p is string => p !== null);
    return parts.length ? parts.join(' · ') : null;
  }
  if (l.link === 'searching' || l.link === 'connecting' || l.link === 'refused' || l.link === 'stalled' || l.link === 'unsupported') return BLE_LINK_TEXT[l.link];
  return BLE_PROBLEM_TEXT[l.link];
}

function BleLive({ api }: { api: RendererApi }) {
  const [live, setLive] = useState<ActualLive | null>(null);
  useEffect(() => {
    let pushed = false; let alive = true;
    const off = api.onActualLive(l => { pushed = true; setLive(l); });
    api.getActualLive().then(l => { if (alive && !pushed) setLive(l); }).catch(() => {});
    return () => { alive = false; off(); };
  }, [api]);
  const text = liveText(live);
  return text ? <span className="st-device-now" data-capture="live">{text}</span> : null;
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
 * A secret input React does not control: a controlled one mirrors its value into the `value` attribute, so the secret
 * would sit in the DOM. The value lives in a ref; the field gets it back (the property, not the attribute) whenever it
 * mounts again, after the stations step or a mode switch. `filled` drives the «Перевірити» button.
 */
function useSecretField(isFilled: (v: string) => boolean) {
  const value = useRef('');
  const field = useRef<HTMLInputElement | null>(null);
  const [filled, setFilled] = useState(false);
  // Stable, so React calls it on mount and unmount only, never while the user types.
  const ref = useCallback((el: HTMLInputElement | null) => {
    field.current = el;
    if (el) el.value = value.current;
  }, []);
  return {
    ref,
    filled,
    read: () => value.current,
    change: (v: string) => { value.current = v; setFilled(isFilled(v)); },
    clear: () => {
      value.current = '';
      if (field.current) field.current.value = '';
      setFilled(false);
    },
  };
}

/**
 * The keys live only in this component, the two secrets outside the DOM; the form is unmounted after save or cancel.
 * Two steps: the keys, then (after a successful check) the account's stations; «Назад» drops the check result and
 * keeps the keys.
 */
function EcoflowForm({ api, initialRegion, initialMode, onClose }: {
  api: RendererApi; initialRegion: EcoflowRegion; initialMode: Mode; onClose(): void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const password = useSecretField(v => v !== '');
  const [region, setRegion] = useState<EcoflowRegion>(initialRegion);
  const [accessKey, setAccessKey] = useState('');
  const secretKey = useSecretField(v => v.trim() !== '');
  const [checking, setChecking] = useState(false);
  const [devices, setDevices] = useState<EcoflowDeviceView[] | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [bluetooth, setBluetooth] = useState<string | null>(null);
  const [sn, setSn] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const seq = useRef(0);
  const headRef = useStepFocus(devices ? 'stations' : 'form', true);

  const input = (): EcoflowInput => mode === 'keys'
    ? { mode, region, accessKey: accessKey.trim(), secretKey: secretKey.read().trim() }
    : { mode, region, email: email.trim(), password: password.read() };
  const clearSecrets = () => { setAccessKey(''); secretKey.clear(); setEmail(''); password.clear(); };
  const resetResult = () => { seq.current++; setChecking(false); setDevices(null); setBluetooth(null); setTestError(null); setSn(null); setPreview(null); setSaveError(null); };

  async function choose(next: string, k: EcoflowInput) {
    const mine = ++seq.current;
    if (k.mode === 'ble') {
      // Nothing to read over the internet: the box comes from the scan.
      const d = devices?.find(x => x.sn === next);
      setSn(next); setSaveError(null); if (d) setPreview({ sn: next, ...bleView(d) });
      return;
    }
    setSn(next); setPreview({ sn: next, pending: true }); setSaveError(null);
    let view: { text: string; tone: Tone };
    try { view = previewView(await api.ecoflowPreview(k, next)); } catch { view = { text: 'Не вдалося прочитати показники', tone: 'neutral' }; }
    if (mine === seq.current) setPreview({ sn: next, ...view });
  }
  async function check() {
    const k = input(); resetResult(); setChecking(true);
    const mine = seq.current;
    let res;
    try { res = await api.ecoflowTest(k); } catch { res = { ok: false as const, error: mode === 'keys' ? 'Не вдалося перевірити ключі' : 'Не вдалося перевірити вхід' }; }
    if (mine !== seq.current) return;
    setChecking(false);
    if (!res.ok) { setTestError(res.error); return; }
    setDevices(res.devices);
    setBluetooth(res.bluetooth ?? null);
    if (res.devices.length === 1) {
      const only = res.devices[0];
      if (k.mode === 'ble') { setSn(only.sn); setPreview({ sn: only.sn, ...bleView(only) }); } else void choose(only.sn, k);
    }
  }
  async function save() {
    const device = devices?.find(d => d.sn === sn);
    if (!device) return;
    setSaving(true); setSaveError(null);
    let res;
    try { res = await api.ecoflowSave(input(), { sn: device.sn, label: device.label }); } catch { res = { ok: false as const, error: SAVE_FAILED }; }
    setSaving(false);
    if (res.ok) { clearSecrets(); onClose(); } else setSaveError(res.error);
  }

  const chosen = devices?.find(d => d.sn === sn);
  if (devices) {
    return (
      <div className="st-panel">
        <h2 className="st-title" ref={headRef} tabIndex={-1}>Станції в акаунті</h2>
        {bluetooth && <Alert text={bluetooth} />}
        {devices.length === 0 ? <p className="st-text">У цьому акаунті немає станцій</p> : (
          <fieldset className="st-stations">
            <legend className="st-sr">Станція</legend>
            {devices.map(d => (
              <label key={d.sn} className="st-station">
                <input type="radio" name="ecoflow-station" checked={sn === d.sn} onChange={() => void choose(d.sn, input())} />
                <span className="st-station-name">{d.label} <span>{`· …${d.sn.slice(-4)}`}</span></span>
                {mode === 'ble'
                  ? <span className={`st-station-state${d.nearby ? ' online' : ''}`}><i />{d.nearby ? 'поруч' : 'не знайдено поруч'}</span>
                  : <span className={`st-station-state${d.online ? ' online' : ''}`}><i />{d.online ? 'в мережі' : 'не в мережі'}</span>}
              </label>
            ))}
          </fieldset>
        )}
        {preview && <CheckResult preview={preview} />}
        <div className="st-actions">
          <button className="sv-primary" disabled={!sn || saving || (mode === 'ble' && !!chosen && !bleSupported(chosen))} onClick={() => void save()}>Зберегти</button>
          <button className="sv-btn st-ghost st-tall" disabled={saving} onClick={resetResult}>Назад</button>
        </div>
        {saveError && <Alert text={saveError} />}
      </div>
    );
  }

  const canCheck = !checking && (mode !== 'keys' ? email.trim() !== '' && password.filled : accessKey.trim() !== '' && secretKey.filled);
  const pickMode = (next: Mode) => { setMode(next); resetResult(); };
  const pickRegion = (next: EcoflowRegion) => { setRegion(next); resetResult(); };
  return (
    <div className="st-panel st-form">
      <h2 className="st-title" ref={headRef} tabIndex={-1}>Підключення EcoFlow</h2>
      <label className="st-field"><span className="st-label">Джерело</span>
        <span className="st-select">
          <select value={mode} onChange={e => pickMode(e.target.value as Mode)}>
            {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </label>
      <fieldset className="st-radios">
        <legend>Регіон</legend>
        <label className="st-radio">
          <input type="radio" name="ecoflow-region" checked={region === 'eu'} onChange={() => pickRegion('eu')} />Європа
        </label>
        <label className="st-radio">
          <input type="radio" name="ecoflow-region" checked={region === 'us'} onChange={() => pickRegion('us')} />Інший регіон <span>(api.ecoflow.com)</span>
        </label>
      </fieldset>
      {mode !== 'keys' ? (
        <>
          <label className="st-field"><span className="st-label">Email</span>
            <input className="st-input" type="email" autoComplete="off" value={email} onChange={e => { setEmail(e.target.value); resetResult(); }} />
          </label>
          <label className="st-field"><span className="st-label">Пароль</span>
            <input className="st-input" type="password" autoComplete="off" ref={password.ref} onChange={e => { password.change(e.target.value); resetResult(); }} />
          </label>
          <p className="st-hint">
            {mode === 'ble'
              ? 'Вхід потрібен один раз: станція пускає лише свій акаунт. Пароль не зберігається — лише ключ для цієї станції. Далі інтернет не потрібен. Поки віджет підключений, телефон зможе керувати станцією лише через інтернет.'
              : "Неофіційний спосіб — той самий вхід, що й у застосунку EcoFlow. Може перестати працювати, якщо EcoFlow щось змінить. Пароль зберігається зашифрованим лише на цьому комп'ютері."}
          </p>
        </>
      ) : (
        <>
          <label className="st-field"><span className="st-label">Access Key</span>
            <input className="st-input st-mono" type="password" autoComplete="off" value={accessKey} onChange={e => { setAccessKey(e.target.value); resetResult(); }} />
          </label>
          <label className="st-field"><span className="st-label">Secret Key</span>
            <input className="st-input" type="password" autoComplete="off" placeholder="Вставте Secret Key" ref={secretKey.ref}
              onChange={e => { secretKey.change(e.target.value); resetResult(); }} />
          </label>
          <p className="st-hint">
            Ключі видає EcoFlow після схвалення заявки розробника на developer-eu.ecoflow.com (зазвичай кілька днів).{' '}
            <button className="st-link" onClick={() => api.openEcoflowHelp()}>Як отримати ключі</button>
          </p>
        </>
      )}
      {testError && <Alert text={testError} />}
      <div className="st-actions">
        <button className={`sv-primary${checking ? ' st-busy' : ''}`} disabled={!canCheck} onClick={() => void check()}>
          {checking && <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" /></svg>}
          {checking ? (mode === 'ble' ? 'Шукаю станцію…' : 'Перевіряю…') : 'Перевірити'}
        </button>
        <button className="sv-btn st-ghost st-tall" onClick={() => { clearSecrets(); onClose(); }}>Скасувати</button>
      </div>
    </div>
  );
}

function EcoflowPanel({ state, api, initiallyOpen = false }: SettingsProps) {
  const source = state.settings.actualSource;
  const [editing, setEditing] = useState(initiallyOpen);
  const [error, setError] = useState<string | null>(null);
  const headRef = useStepFocus(editing ? 'form' : source ? 'connected' : 'idle');

  if (editing) {
    return <EcoflowForm api={api} initialRegion={source?.region ?? 'eu'} initialMode={source?.id === 'ecoflow' ? 'keys' : source?.id === 'ecoflow-ble' ? 'ble' : 'account'} onClose={() => setEditing(false)} />;
  }
  if (!source) {
    return (
      <div className="st-panel">
        <Head title="Фактичний стан світла" chip="EcoFlow" headRef={headRef} />
        <p className="st-text">Зарядна станція EcoFlow може показувати, чи є світло насправді.</p>
        <div className="st-actions"><button className="sv-primary" onClick={() => setEditing(true)}>Підключити EcoFlow</button></div>
      </div>
    );
  }
  const name = `EcoFlow · ${source.deviceName} · ${source.id === 'ecoflow' ? `ключ ${source.accessKeyHint}` : source.id === 'ecoflow-ble' ? `Bluetooth · акаунт ${source.accountHint}` : `акаунт ${source.accountHint}`}`;
  const now = currentText(state.actual);
  return (
    <div className="st-panel">
      <Head title="Фактичний стан світла" chip="EcoFlow" headRef={headRef} />
      <div className="st-device">
        <span className="st-icon st-icon-lg">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M8 6V4h8v2" /><path d="m12.5 9-3 4.5h4l-1 3.5" /></svg>
        </span>
        <div className="st-device-text">
          <span className="st-device-name" title={name} data-capture="device">{name}</span>
          {now && <span className="st-device-now"><i className={`sv-tone-${state.actual!.power}`} />{now}</span>}
          {source.id === 'ecoflow-ble' && <BleLive api={api} />}
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

export function ActualSettings({ state, api, initiallyOpen = false }: SettingsProps) {
  const ref = useRef<HTMLElement>(null);
  // Opened for the form: bring it into view (jsdom has no scrollIntoView).
  useEffect(() => { if (initiallyOpen) ref.current?.scrollIntoView?.({ block: 'start' }); }, [initiallyOpen]);
  return (
    <section className="sv-card st-card" ref={ref} data-capture="ecoflow">
      <EcoflowPanel state={state} api={api} initiallyOpen={initiallyOpen} />
    </section>
  );
}
