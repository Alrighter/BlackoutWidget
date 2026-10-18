import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import { dayCells } from '../../../shared/day-cells';
import type { DaySchedule, HouseInfo, LineInfo, WidgetStyle } from '../../../shared/types';
import { Autocomplete } from './Autocomplete';
import { DayStrip } from './DayStrip';
import { unwrapIpcError } from './ipc-error';
import { STYLES } from './widget-styles';

type Step = 'provider' | 'city' | 'street' | 'house' | 'line' | 'style';
const OUTAGE_NOTE = 'Зараз для цього будинку діє відключення — список ліній може бути неповним. Якщо вашої лінії немає, спробуйте пізніше.';
const TITLES: Record<Step, string> = {
  provider: 'Компанія', city: 'Населений пункт', street: 'Вулиця', house: 'Будинок', line: 'Лінія', style: 'Стиль віджета',
};

interface LoadError { captcha: boolean; message: string }
interface Loaded<T> { data: T | null; error: LoadError | null; loading: boolean; retry(): void }

function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [s, setS] = useState<{ data: T | null; error: LoadError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setS({ data: null, error: null, loading: true });
    load().then(
      data => { if (alive) setS({ data, error: null, loading: false }); },
      e => { if (alive) setS({ data: null, error: unwrapIpcError(e), loading: false }); },
    );
    return () => { alive = false; };
    // `key` captures everything `load` closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { ...s, retry: useCallback(() => setAttempt(a => a + 1), []) };
}

function Status<T>({ res, api, children }: { res: Loaded<T>; api: RendererApi; children(data: T): ReactNode }) {
  const [busy, setBusy] = useState(false);
  if (res.loading) return <p className="muted">Завантаження…</p>;
  if (res.error) {
    const { captcha, message } = res.error;
    return (
      <div className="banner warn">
        <span>{captcha ? 'Сайт ДТЕК просить пройти перевірку' : message}</span>
        {captcha ? (
          <button disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.solveCaptcha(); } catch { /* the retry below reports the problem again */ }
            setBusy(false);
            res.retry();
          }}>Пройти перевірку</button>
        ) : <button onClick={res.retry}>Спробувати ще раз</button>}
      </div>
    );
  }
  return <>{children(res.data as T)}</>;
}

export function SetupWizard({ api, onDone }: { api: RendererApi; onDone(): void }) {
  const [step, setStep] = useState<Step>('provider');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [street, setStreet] = useState<string | null>(null);
  const [house, setHouse] = useState<string | null>(null);
  const [line, setLine] = useState<LineInfo | null>(null);
  const [style, setStyle] = useState<WidgetStyle>('compact');
  const [houseLines, setHouseLines] = useState<LineInfo[]>([]);
  const [houseOutage, setHouseOutage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const providers = useLoad(() => api.listProviders(), 'providers');
  useEffect(() => {
    if (!providerId && providers.data?.length) setProviderId(providers.data[0].id);
  }, [providers.data, providerId]);

  const cities = useLoad(() => (step === 'city' && providerId ? api.listCities(providerId) : Promise.resolve([] as string[])),
    `c:${step === 'city'}:${providerId}`);
  const streets = useLoad(() => (step === 'street' && providerId && city ? api.listStreets(providerId, city) : Promise.resolve([] as string[])),
    `s:${step === 'street'}:${providerId}:${city}`);
  const houses = useLoad(() => (step === 'house' && providerId && city && street ? api.listHouses(providerId, city, street) : Promise.resolve([] as HouseInfo[])),
    `h:${step === 'house'}:${providerId}:${city}:${street}`);
  const previews = useLoad(
    () => (step === 'line' && providerId && city && street && house ? api.previewLines(providerId, city, street, house) : Promise.resolve([] as { line: LineInfo; today: DaySchedule | null }[])),
    `p:${step === 'line'}:${providerId}:${city}:${street}:${house}`);

  const noLines = step === 'house' && house !== null && houseLines.length === 0;
  const canNext =
    step === 'provider' ? !!providerId
    : step === 'city' ? !!city
    : step === 'street' ? !!street
    : step === 'house' ? house !== null && !noLines
    : step === 'line' ? !!line
    : !saving;

  // During an outage the list holds only the outage's queues, so the line must always be chosen explicitly.
  const needsLineStep = houseLines.length > 1 || houseOutage;
  const order: Step[] = ['provider', 'city', 'street', 'house', ...(needsLineStep ? ['line' as const] : []), 'style'];
  const back = () => setStep(order[Math.max(0, order.indexOf(step) - 1)]);
  const next = async () => {
    if (step !== 'style') {
      if (step === 'house' && houseLines.length === 1 && !houseOutage) setLine(houseLines[0]);
      setStep(order[order.indexOf(step) + 1]);
      return;
    }
    if (!providerId || !city || !street || !house || !line) return;
    setSaving(true); setSaveError(null);
    try {
      await api.saveAddress({ providerId, city, street, house, lineIndex: line.index, groupId: line.groupId });
      await api.setWidgetStyle(style);
      onDone();
    } catch (e) {
      setSaveError(unwrapIpcError(e).message);
      setSaving(false);
    }
  };

  const resetBelow = (from: 'city' | 'street') => {
    if (from === 'city') setStreet(null);
    setHouse(null); setLine(null); setHouseLines([]); setHouseOutage(false);
  };

  return (
    <div className="wizard panel">
      <ol className="steps" aria-label="Кроки">
        {order.map(s => <li key={s} className={s === step ? 'current' : order.indexOf(s) < order.indexOf(step) ? 'past' : ''}>{TITLES[s]}</li>)}
      </ol>
      <h2>{TITLES[step]}</h2>

      {step === 'provider' && (
        <Status res={providers} api={api}>{list => (
          <div className="cards">
            {list.map(p => (
              <button key={p.id} className={`card${providerId === p.id ? ' selected' : ''}`} onClick={() => setProviderId(p.id)}>{p.displayName}</button>
            ))}
          </div>
        )}</Status>
      )}

      {step === 'city' && (
        <Status res={cities} api={api}>{list => (
          <Autocomplete label="Населений пункт" options={list} value={city}
            onChange={v => { if (v !== city) resetBelow('city'); setCity(v); }} />
        )}</Status>
      )}

      {step === 'street' && (
        <Status res={streets} api={api}>{list => (
          <Autocomplete label="Вулиця" options={list} value={street}
            onChange={v => { if (v !== street) resetBelow('street'); setStreet(v); }} />
        )}</Status>
      )}

      {step === 'house' && (
        <Status res={houses} api={api}>{list => (
          <>
            <Autocomplete label="Будинок" options={list.map(h => h.house)} value={house}
              onChange={v => {
                const info = list.find(h => h.house === v);
                setHouse(v); setLine(null); setHouseLines(info?.lines ?? []); setHouseOutage(!!info?.outageActive);
              }} />
            {house !== null && houseOutage && <div className="banner warn">{OUTAGE_NOTE}</div>}
            {/* During an outage an empty list is expected to be temporary; the note above says what to do. */}
            {noLines && !houseOutage && <div className="banner warn">Для цього будинку ДТЕК не публікує графік відключень</div>}
          </>
        )}</Status>
      )}

      {step === 'line' && (
        <Status res={previews} api={api}>{list => (
          <>
            <div className="cards">
              {list.map(({ line: l, today }) => (
                <button key={l.index} className={`card${line?.index === l.index ? ' selected' : ''}`} onClick={() => setLine(l)}>
                  <strong>{`Лінія ${l.index} · ${l.label}`}</strong>
                  <DayStrip cells={dayCells(today?.slots ?? null)} />
                </button>
              ))}
            </div>
            {houseOutage && <div className="banner warn">{OUTAGE_NOTE}</div>}
            <p className="muted">Звірте з сайтом ДТЕК, якщо не впевнені</p>
          </>
        )}</Status>
      )}

      {step === 'style' && (
        <div className="cards" role="radiogroup" aria-label="Стиль віджета">
          {STYLES.map(s => (
            <button key={s.id} role="radio" aria-checked={style === s.id} className={`card${style === s.id ? ' selected' : ''}`} onClick={() => setStyle(s.id)}>
              <strong>{s.name}</strong><span className="muted">{s.hint}</span>
            </button>
          ))}
        </div>
      )}

      {saveError && <div className="banner warn">{saveError}</div>}
      <div className="nav">
        <button className="secondary" onClick={back} disabled={step === 'provider'}>Назад</button>
        <button className="primary" onClick={next} disabled={!canNext}>{step === 'style' ? 'Готово' : 'Далі'}</button>
      </div>
    </div>
  );
}
