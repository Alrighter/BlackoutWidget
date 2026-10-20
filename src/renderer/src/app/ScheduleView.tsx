import { useState, type ReactNode } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import { outageParts, recentOutages } from '../../../shared/actual-view';
import { dayCells, type DayCell } from '../../../shared/day-cells';
import { outageRanges } from '../../../shared/outage-ranges';
import { providerShortName } from '../../../shared/providers';
import { addDays, formatDM, formatHM, parseDtekDateTime } from '../../../shared/time';
import type { AppState, DaySchedule } from '../../../shared/types';
import { computeWidgetView, countdownText } from '../../../shared/widget-state';
import { ActualStrip } from './ActualStrip';
import { DayStrip } from './DayStrip';

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
const BOLT = 'M13.5 2 4.5 13.5H11l-1.5 8.5 9-11.5H12z';

/** «Відключення: …» under the grid; on today's tab during an emergency it also says when the emergency began. */
function outageLine(day: DaySchedule, emergencyFrom?: string): string {
  const parts = outageRanges(day.slots);
  const line = parts.length ? `Відключення: ${parts.join(', ')}` : 'Відключень не заплановано';
  return emergencyFrom ? `${line} · аварійне з ${emergencyFrom}` : line;
}

function Banner({ tone, title, text, action }: {
  tone: 'warn' | 'danger'; title: string; text?: string; action?: { label: string; run(): void };
}) {
  return (
    <div className={`sv-banner ${tone}`} data-capture="banner">
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20.5h20z" /><path d="M12 10v4.5" /><path d="M12 17.6v.1" /></svg>
      <div className="sv-banner-text">
        <span className="sv-banner-title" title={title}>{title}</span>
        {text && <span className="sv-banner-sub" title={text}>{text}</span>}
      </div>
      {action && <button className="sv-btn" onClick={action.run}>{action.label}</button>}
    </div>
  );
}

/** Hour labels, the day's cells, the «Фактично» row under them on the same scale, and the «now» marker across. */
function DayGrid({ cells, emptyText, actualRow, now }: {
  cells: DayCell[] | null; emptyText: string; actualRow: ReactNode; now?: { min: number; label: string };
}) {
  const left = now ? `${(now.min / 1440) * 100}%` : undefined;
  return (
    <div className="sv-grid" data-capture="grid">
      <div className="sv-grid-labels"><span /><span>Графік</span><span>Фактично</span></div>
      <div className="sv-grid-main">
        <div className="sv-hours" aria-hidden="true">{HOURS.map(h => <span key={h}>{h}</span>)}</div>
        {cells ? <DayStrip cells={cells} /> : <div className="sv-noday"><span>{emptyText}</span></div>}
        <div className="sv-actual-row">{actualRow}</div>
        {now && (
          <>
            <div className="sv-now" style={{ left }} />
            <div className="sv-now-pill" style={{ left }}>{now.label}</div>
          </>
        )}
      </div>
    </div>
  );
}

function RowNote({ children }: { children: ReactNode }) {
  return <div className="sv-row-note">{children}</div>;
}

export function ScheduleView({ state, now, api, onConnectEcoflow }: {
  state: AppState; now: Date; api: RendererApi;
  /** «Підключити» / «Підключити EcoFlow» (D10): open the settings with the EcoFlow form. */
  onConnectEcoflow(): void;
}) {
  const [tab, setTab] = useState<'today' | 'tomorrow'>('today');
  const { snapshot } = state;
  const view = snapshot ? computeWidgetView(snapshot, now, state.actual) : null;
  const todayKey = view?.todayKey ?? '';
  const tomorrowKey = todayKey ? addDays(todayKey, 1) : '';
  const outages = state.actual ? recentOutages(state.actual.history, now) : [];
  const isToday = tab === 'today';
  const day = isToday ? view?.today ?? null : view?.tomorrow ?? null;
  // A saved source without a status yet is not «not connected»: nothing to offer then.
  const ecoflow = !!state.actual || !!state.settings.actualSource;
  const nowMin = view && isToday ? Math.round(view.nowFraction * 1440) : undefined;
  const emergency = isToday ? view?.emergency : undefined;
  const cells = day ? dayCells(day.slots, nowMin, emergency) : null;
  const emergencyStart = emergency && snapshot?.currentOutage?.start ? parseDtekDateTime(snapshot.currentOutage.start) : undefined;
  const count = view ? countdownText(view) : undefined;

  const connectNote = (
    <RowNote>
      <span>Підключіть EcoFlow, щоб бачити, чи є світло насправді</span>
      <button className="sv-link" onClick={onConnectEcoflow}>Підключити</button>
    </RowNote>
  );
  const actualRow = !ecoflow ? connectNote
    : !isToday ? <RowNote><span>з’явиться, коли настане день</span></RowNote>
    : <ActualStrip parts={view?.actualStrip ?? []} />;

  return (
    <div className="sv">
      {view?.outageBadge && snapshot?.currentOutage && (
        <Banner tone="danger" title={`${view.outageBadge} відключення`} text={`${providerShortName(snapshot.providerId)}: «${snapshot.currentOutage.text}»`} />
      )}
      {state.lineChanged && (
        <Banner tone="warn" title="Схема підключення змінилась — перевірте лінію" text="Графік для вашої адреси тепер може бути іншим."
          action={{ label: 'Змінити адресу', run: () => api.openMainWindow('setup') }} />
      )}
      {state.phase === 'captcha' && (
        <Banner tone="warn" title="Сайт ДТЕК просить пройти перевірку" text="Поки її не пройдено, графік не оновлюється."
          action={{ label: 'Пройти перевірку', run: () => void api.solveCaptcha(snapshot?.providerId ?? state.settings.address?.providerId) }} />
      )}
      {state.phase === 'error' && <Banner tone="warn" title={`Не вдалося оновити: ${state.lastError ?? 'невідома помилка'}`} />}

      {!snapshot || !view ? (
        <div className="sv-card sv-nodata">Дані ще не отримано</div>
      ) : (
        <section className="sv-card" data-capture="card">
          <div className="sv-head">
            <div className="sv-head-main">
              <div className="sv-status-row">
                <span className={`sv-dot sv-tone-${view.state}`} />
                <h2 className="sv-status" data-capture="status">{view.title}</h2>
                {view.outageBadge && <span className="sv-badge">{view.outageBadge}</span>}
                {view.actual && (
                  <span className="sv-chip" title="Фактичний стан · EcoFlow">
                    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d={BOLT} /></svg>Фактично · EcoFlow
                  </span>
                )}
              </div>
              <div className="sv-line" data-capture="line">{view.nextText}</div>
            </div>
            {count && (
              <div className="sv-count">
                <span className="sv-count-num">{count}</span>
                <span className="sv-count-cap">{view.countdownCaption}</span>
              </div>
            )}
          </div>

          <div className="sv-dayrow">
            <div role="tablist" aria-label="День" className="sv-seg">
              <button role="tab" aria-selected={isToday} className="sv-seg-btn" onClick={() => setTab('today')}>{`Сьогодні ${formatDM(todayKey)}`}</button>
              <button role="tab" aria-selected={!isToday} className="sv-seg-btn" onClick={() => setTab('tomorrow')}>{`Завтра ${formatDM(tomorrowKey)}`}</button>
            </div>
            <div className="sv-legend" role="group" aria-label="Легенда" data-capture="legend">
              <span><i className="on" />Світло є</span>
              <span><i className="off" />Немає</span>
              <span><i className="maybe" />Можливо немає</span>
              <span><i className="unknown" />Невідомо</span>
              {cells?.some(c => c.emergency) && <span><i className="emergency" />{view.outageBadge ?? 'Аварійне'}</span>}
            </div>
          </div>

          <DayGrid cells={cells} actualRow={actualRow}
            emptyText={isToday ? 'Графік на сьогодні ще не отримано' : 'Графік на завтра ще не опубліковано'}
            now={nowMin === undefined ? undefined : { min: nowMin, label: formatHM(now) }} />

          {isToday && snapshot.note && <div className="sv-note-line" data-capture="note">{snapshot.note}</div>}

          <div className="sv-foot">
            <span className="sv-outage-line" data-capture="outage-line">
              {day ? outageLine(day, emergencyStart && formatHM(emergencyStart)) : ''}
            </span>
            <span className="sv-updated" data-capture="updated">
              {`Оновлено о ${formatHM(new Date(snapshot.fetchedAt))}${snapshot.sourceUpdatedAt ? ` · графік ${providerShortName(snapshot.providerId)} від ${snapshot.sourceUpdatedAt}` : ''}`}
              {view.stale && <span className="sv-stale">дані застаріли</span>}
            </span>
          </div>
        </section>
      )}

      {snapshot && (state.actual || !ecoflow) && (
        <section className="sv-section">
          <div className="sv-section-head">
            <h3 className="sv-section-title">Фактичні відключення <span>· 7 днів</span></h3>
            <span className="sv-section-src">за даними EcoFlow</span>
          </div>
          {!state.actual ? (
            <div className="sv-connect">
              <div className="sv-connect-text">
                <span className="sv-connect-title">Тут будуть реальні відключення</span>
                <span className="sv-connect-sub">Зарядна станція EcoFlow може показувати, чи є світло насправді.</span>
              </div>
              <button className="sv-primary" onClick={onConnectEcoflow}>Підключити EcoFlow</button>
            </div>
          ) : outages.length ? (
            <ul className="sv-outages">
              {outages.map(o => {
                const p = outageParts(o, now);
                return (
                  <li key={o.start} className={`sv-outage${p.live ? ' live' : ''}`}>
                    <span className="sv-outage-date">{p.date}</span>
                    <span className="sv-outage-range">{p.live && <i className="sv-live-dot" />}{p.range}</span>
                    <span className="sv-outage-dur">{p.duration}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="sv-note">За останні 7 днів відключень не зафіксовано</p>
          )}
        </section>
      )}
    </div>
  );
}
