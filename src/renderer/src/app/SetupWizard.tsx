import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import { dayCells } from '../../../shared/day-cells';
import { outageRanges } from '../../../shared/outage-ranges';
import { providerRegion, providerShortName, providerSingleCity } from '../../../shared/providers';
import type { DaySchedule, HouseInfo, LineInfo, WidgetStyle } from '../../../shared/types';
import { lowerFirst } from '../../../shared/widget-state';
import { Autocomplete, matches } from './Autocomplete';
import { DayStrip } from './DayStrip';
import { unwrapIpcError } from './ipc-error';
import { StyleThumb } from './StyleThumb';
import { STYLES } from './widget-styles';

type Step = 'provider' | 'city' | 'street' | 'house' | 'line' | 'style' | 'done';
/** The rail always lists all seven steps (setup-wizard.html); «Лінія» is passed over when the house has one line. */
const RAIL: { step: Step; label: string }[] = [
  { step: 'provider', label: 'Регіон / компанія' }, { step: 'city', label: 'Місто' }, { step: 'street', label: 'Вулиця' },
  { step: 'house', label: 'Будинок' }, { step: 'line', label: 'Лінія' }, { step: 'style', label: 'Стиль віджета' },
  { step: 'done', label: 'Готово' },
];
const TITLES: Record<Step, string> = {
  provider: 'Регіон і компанія', city: 'Місто', street: 'Вулиця', house: 'Будинок', line: 'Лінія', style: 'Стиль віджета', done: 'Готово',
};
const OUTAGE_NOTE = 'Зараз для цього будинку діє відключення — список ліній може бути неповним. Якщо вашої лінії немає, спробуйте пізніше.';
/** The thumbnails' scale on the style cards (setup-wizard.html). */
const THUMB_SCALE: Record<WidgetStyle, number> = { compact: 0.36, ring: 0.28, timeline: 0.26 };
const HOURS = ['00', '06', '12', '18', '24'];
const CHECK = 'm5 12.5 4.5 4.5L19 7.5';
/** Houses per row of the grid (= .wz-houses), and the count above which the step shows a filter field. */
const HOUSE_COLUMNS = 6;
const HOUSE_FILTER_FROM = 24;
const HOUSE_KEYS: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -HOUSE_COLUMNS, ArrowDown: HOUSE_COLUMNS };
/** Steps whose own field takes the focus (autoFocus) instead of the title. */
const FIELD_STEPS: Step[] = ['city', 'street'];

/** The provider's short name for the texts; before one is picked, the generic word. */
const short = (providerId: string | null): string => (providerId ? providerShortName(providerId) : 'постачальника');

function subline(step: Step, city: string | null, lineCount: number, providerId: string | null): string {
  switch (step) {
    case 'provider': return 'Оберіть, хто постачає світло у ваш будинок.';
    case 'city': return 'Почніть вводити назву — підкажемо варіанти.';
    // The city keeps its prefix («м. Буча», «с. Бузова»), which reads right in the genitive too.
    case 'street': return `Вулиці ${city ?? ''}.`;
    case 'house': return 'Оберіть номер будинку.';
    // During an outage the step shows even for one line.
    case 'line': return `${lineCount === 2 ? 'У цьому будинку дві лінії. ' : ''}Звірте графік на сьогодні з сайтом ${short(providerId)} і оберіть свою.`;
    case 'style': return 'Змінити можна будь-коли — у налаштуваннях або в меню трею.';
    case 'done': return 'Віджет уже на робочому столі.';
  }
}

/** Today's outages of a line, worded as on the schedule tab: «08:00–12:00, 16:00–20:00 (можливо)». */
function lineOutages(day: DaySchedule | null): string {
  if (!day) return 'Графік на сьогодні ще не отримано';
  const parts = outageRanges(day.slots);
  return parts.length ? parts.join(', ') : 'Відключень не заплановано';
}

/**
 * The house numbers as one radio group with a single Tab stop (roving tabindex): the picked house, else the first.
 * Arrows move the focus, ↑/↓ by a row; Space or Enter picks (the buttons' own click).
 */
function HouseGrid({ houses, picked, onPick }: { houses: HouseInfo[]; picked: string | null; onPick(h: HouseInfo): void }) {
  const stop = houses.some(h => h.house === picked) ? picked : houses[0]?.house;
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = HOUSE_KEYS[e.key];
    if (!by) return;
    e.preventDefault();
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    buttons[buttons.indexOf(e.target as HTMLButtonElement) + by]?.focus();
  };
  return (
    <div className="wz-houses" role="radiogroup" aria-label="Номер будинку" data-capture="houses" onKeyDown={move}>
      {houses.map(h => (
        <button key={h.house} type="button" role="radio" aria-checked={picked === h.house} tabIndex={h.house === stop ? 0 : -1}
          className="wz-house" title={h.house} onClick={() => onPick(h)}>
          {h.house}
        </button>
      ))}
    </div>
  );
}

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

/** A warning in the step's body (the schedule tab's banner, wrapping). */
function Note({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="sv-banner warn wz-note">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20.5h20z" /><path d="M12 10v4.5" /><path d="M12 17.6v.1" /></svg>
      <span className="wz-note-text">{text}</span>
      {children}
    </div>
  );
}

function Status<T>({ res, api, providerId, children }: { res: Loaded<T>; api: RendererApi; providerId: string | null; children(data: T): ReactNode }) {
  const [busy, setBusy] = useState(false);
  if (res.loading) return <p className="wz-muted">Завантаження…</p>;
  if (res.error) {
    const { captcha, message } = res.error;
    return (
      <Note text={captcha ? 'Сайт ДТЕК просить пройти перевірку' : message}>
        {captcha ? (
          <button className="sv-btn" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await api.solveCaptcha(providerId ?? undefined); } catch { /* the retry below reports the problem again */ }
            setBusy(false);
            res.retry();
          }}>Пройти перевірку</button>
        ) : <button className="sv-btn" onClick={res.retry}>Спробувати ще раз</button>}
      </Note>
    );
  }
  return <>{children(res.data as T)}</>;
}

export function SetupWizard({ api, autostart, widgetStyle, onDone, onCancel }: {
  api: RendererApi;
  /** settings.autostart, for the «Готово» step's switch (it works as the one in the settings). */
  autostart: boolean;
  /** settings.widgetStyle: the style step starts from it, so changing the address keeps the style. */
  widgetStyle: WidgetStyle;
  onDone(): void;
  /** Leave without saving; shown when an address is already set. */
  onCancel?(): void;
}) {
  const [step, setStep] = useState<Step>('provider');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [street, setStreet] = useState<string | null>(null);
  const [house, setHouse] = useState<string | null>(null);
  const [line, setLine] = useState<LineInfo | null>(null);
  const [style, setStyle] = useState<WidgetStyle>(widgetStyle);
  const [houseLines, setHouseLines] = useState<LineInfo[]>([]);
  const [houseOutage, setHouseOutage] = useState(false);
  const [houseQuery, setHouseQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const uid = useId();

  // The step's content changes under the button just pressed, so the new step's title takes the focus (as the EcoFlow
  // card's steps do), unless the step's own field takes it with autoFocus; not on the first show.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (!FIELD_STEPS.includes(step)) titleRef.current?.focus();
  }, [step]);

  const providers = useLoad(() => api.listProviders(), 'providers');
  // Only a lone provider is preselected; with several the person chooses.
  useEffect(() => {
    if (!providerId && providers.data?.length === 1) pickProvider(providers.data[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    : step === 'style' ? true
    : !saving;

  // During an outage the list holds only the outage's queues, so the line must always be chosen explicitly.
  const needsLineStep = houseLines.length > 1 || houseOutage;
  // A single-city provider (Kyiv) has no city to choose, so the step is passed over.
  const singleCity = providerId ? providerSingleCity(providerId) : undefined;
  const order: Step[] = ['provider', ...(singleCity ? [] : ['city' as const]), 'street', 'house', ...(needsLineStep ? ['line' as const] : []), 'style', 'done'];
  const back = () => setStep(order[Math.max(0, order.indexOf(step) - 1)]);
  const next = async () => {
    if (step !== 'done') {
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
    setHouse(null); setLine(null); setHouseLines([]); setHouseOutage(false); setHouseQuery('');
  };
  /** A different provider drops everything chosen below it: a city of one region is never sent to another. */
  const pickProvider = (id: string) => {
    if (id !== providerId) {
      resetBelow('city');
      setCity(providerSingleCity(id) ?? null);
    }
    setProviderId(id);
  };
  const pickHouse = (h: HouseInfo) => { setHouse(h.house); setLine(null); setHouseLines(h.lines); setHouseOutage(!!h.outageActive); };

  const num = RAIL.findIndex(r => r.step === step) + 1;
  const place = `${city}, ${street}, ${house}`;
  const choice = line ? `Лінія ${line.index} · ${lowerFirst(line.label)} · стиль «${STYLES.find(s => s.id === style)?.name}»` : '';

  return (
    <div className="wz" data-capture="wizard">
      <nav className="wz-rail" aria-label="Кроки" data-capture="wz-rail">
        <div className="wz-rail-title">Перше налаштування</div>
        <ol className="wz-steps">
          {RAIL.map(({ step: s, label }, i) => {
            const state = i + 1 < num ? 'done' : i + 1 === num ? 'now' : 'next';
            return (
              <li key={s} className={`wz-step ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
                {/* A done step shows ✓ instead of its number; screen readers still hear the number, and that it's done. */}
                <span className="wz-step-num">
                  {state === 'done'
                    ? <><svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true"><path d={CHECK} /></svg><span className="st-sr">{i + 1}</span></>
                    : i + 1}
                </span>
                <span className="wz-step-text">
                  <span className="wz-step-label">{label}</span>
                  {s === 'line' && <span className="wz-step-sub">якщо в будинку дві лінії</span>}
                  {state === 'done' && <span className="st-sr">, пройдено</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>

      <main className="wz-main" data-capture="wz-main">
        <div className="wz-count">{`Крок ${num} з 7`}</div>
        <h2 className="wz-title" ref={titleRef} tabIndex={-1}>{TITLES[step]}</h2>
        <p className="wz-desc" data-capture="wz-desc">{subline(step, city, houseLines.length, providerId)}</p>

        <div className="wz-body" data-capture="wz-body">
          {step === 'provider' && (
            <Status res={providers} api={api} providerId={providerId}>{list => (
              <fieldset className="wz-opts">
                <legend className="st-sr">Регіон</legend>
                {list.map(p => {
                  const region = providerRegion(p.id);
                  return (
                    <label key={p.id} className="wz-opt">
                      <input type="radio" name="wz-provider" checked={providerId === p.id} onChange={() => pickProvider(p.id)} />
                      <span className="wz-opt-text">
                        <span className="wz-opt-name">{region ?? p.displayName}</span>
                        {region && <span className="wz-opt-sub" title={p.displayName} data-capture="provider-sub">{p.displayName}</span>}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            )}</Status>
          )}

          {step === 'city' && (
            <Status res={cities} api={api} providerId={providerId}>{list => (
              <Autocomplete label="Місто або село" options={list} value={city}
                onChange={v => { if (v !== city) resetBelow('city'); setCity(v); }} />
            )}</Status>
          )}

          {step === 'street' && (
            <>
              <div className="wz-chips"><span className="sv-chip wz-chip" title={city ?? ''}>{city}</span></div>
              <Status res={streets} api={api} providerId={providerId}>{list => (
                <>
                  <Autocomplete label="Вулиця" options={list} value={street}
                    onChange={v => { if (v !== street) resetBelow('street'); setStreet(v); }} />
                  {list.length === 0 && <Note text={`Для цього населеного пункту немає адрес у ${short(providerId)}`} />}
                </>
              )}</Status>
            </>
          )}

          {step === 'house' && (
            <>
              <div className="wz-chips wz-chips-house"><span className="sv-chip wz-chip" title={`${city}, ${street}`}>{`${city}, ${street}`}</span></div>
              <Status res={houses} api={api} providerId={providerId}>{list => {
                // A long street gets a filter field over the grid (the house search the step used to have). The picked
                // house always stays in the grid, so the choice is never hidden.
                const filtered = list.length > HOUSE_FILTER_FROM;
                const found = filtered ? list.filter(h => matches(h.house, houseQuery)) : list;
                const shown = filtered ? list.filter(h => h.house === house || matches(h.house, houseQuery)) : list;
                return (
                  <>
                    {filtered && (
                      <>
                        <label className="st-label wz-label" htmlFor={`${uid}-house`}>Номер будинку</label>
                        <input id={`${uid}-house`} className="st-input wz-input wz-filter" value={houseQuery} placeholder="Пошук номера"
                          autoFocus onChange={e => setHouseQuery(e.target.value)} />
                      </>
                    )}
                    {shown.length > 0 && <HouseGrid houses={shown} picked={house} onPick={pickHouse} />}
                    {found.length === 0 && <p className="wz-muted">Нічого не знайдено</p>}
                    {house !== null && houseOutage && <Note text={OUTAGE_NOTE} />}
                    {/* During an outage an empty list is expected to be temporary; the note above says what to do. */}
                    {noLines && !houseOutage && <Note text={`Для цього будинку ${short(providerId)} не публікує графік відключень`} />}
                  </>
                );
              }}</Status>
            </>
          )}

          {step === 'line' && (
            <Status res={previews} api={api} providerId={providerId}>{list => (
              <>
                <fieldset className="wz-opts wz-lines">
                  <legend className="st-sr">Лінія</legend>
                  {list.map(({ line: l, today }) => {
                    const ranges = lineOutages(today);
                    const sumId = `${uid}-line-${l.index}`;
                    // The whole card picks the line; the radio inside is what the keyboard and screen readers use.
                    return (
                      <div key={l.index} className="wz-opt wz-line" onClick={() => setLine(l)}>
                        <div className="wz-line-head">
                          <label className="wz-line-pick">
                            <input type="radio" name="wz-line" checked={line?.index === l.index} aria-describedby={sumId} onChange={() => setLine(l)} />
                            <span className="wz-opt-name">{`Лінія ${l.index} · ${lowerFirst(l.label)}`}</span>
                          </label>
                          <span className="wz-line-sum" id={sumId} title={ranges} data-capture="line-summary">{ranges}</span>
                        </div>
                        <DayStrip cells={dayCells(today?.slots ?? null)} />
                        <div className="wz-hours" aria-hidden="true">{HOURS.map(h => <span key={h}>{h}</span>)}</div>
                      </div>
                    );
                  })}
                </fieldset>
                {houseOutage && <Note text={OUTAGE_NOTE} />}
                <button type="button" className="st-link wz-link" onClick={() => providerId && api.openProviderSite(providerId)}>{`Відкрити графік на сайті ${short(providerId)}`}</button>
              </>
            )}</Status>
          )}

          {step === 'style' && (
            <div className="wz-styles" role="radiogroup" aria-label="Стиль віджета">
              {STYLES.map(s => (
                <button key={s.id} type="button" role="radio" aria-checked={style === s.id} className="st-style wz-style" title={s.hint}
                  onClick={() => setStyle(s.id)}>
                  <span className="wz-thumb bw-dark-thumb" data-capture={`thumb-box-${s.id}`}><StyleThumb style={s.id} scale={THUMB_SCALE[s.id]} /></span>
                  <span className="wz-style-name">{s.name}</span>
                </button>
              ))}
            </div>
          )}

          {step === 'done' && (
            <>
              <div className="wz-card wz-summary">
                <span className="wz-done">
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d={CHECK} /></svg>
                </span>
                <span className="wz-summary-text">
                  <span className="wz-summary-main" title={place} data-capture="summary-place">{place}</span>
                  <span className="wz-summary-sub" title={choice} data-capture="summary-choice">{choice}</span>
                </span>
              </div>
              <div className="wz-card wz-auto">
                <label className="wz-auto-label" htmlFor="wz-autostart" id="wz-autostart-name">Запускати разом із системою</label>
                <button id="wz-autostart" role="switch" aria-checked={autostart} aria-labelledby="wz-autostart-name"
                  className="st-switch" onClick={() => void api.setAutostart(!autostart)} />
              </div>
              <p className="st-hint wz-hint">Фактичний стан світла можна підключити пізніше: Налаштування → EcoFlow.</p>
            </>
          )}
        </div>

        {saveError && <Note text={saveError} />}
        <div className="wz-nav" data-capture="wz-nav">
          {onCancel && <button className="sv-btn st-ghost st-tall wz-cancel" onClick={onCancel}>Скасувати</button>}
          <button className="sv-btn st-tall" onClick={back} disabled={step === 'provider'}>Назад</button>
          <button className="sv-primary wz-next" onClick={next} disabled={!canNext}>{step === 'done' ? 'Завершити' : 'Далі'}</button>
        </div>
      </main>
    </div>
  );
}
