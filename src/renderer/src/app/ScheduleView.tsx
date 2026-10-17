import { useState } from 'react';
import type { RendererApi } from '../../../shared/ipc';
import { addDays, formatDM, formatHM } from '../../../shared/time';
import type { AppState, DaySchedule } from '../../../shared/types';
import { computeWidgetView, slotRuns } from '../../../shared/widget-state';
import { DayStrip } from './DayStrip';

const hm = (slotIndex: number) => `${String(Math.floor(slotIndex / 2)).padStart(2, '0')}:${slotIndex % 2 ? '30' : '00'}`;

function outageRanges(day: DaySchedule): string {
  const parts = slotRuns(day.slots)
    .filter(r => r.slot === 'off' || r.slot === 'maybe-off')
    .map(r => `${hm(r.start)}–${hm(r.end)}${r.slot === 'maybe-off' ? ' (можливо)' : ''}`);
  return parts.length ? parts.join(', ') : 'Відключень не заплановано';
}

export function ScheduleView({ state, now, api }: { state: AppState; now: Date; api: RendererApi }) {
  const [tab, setTab] = useState<'today' | 'tomorrow'>('today');
  const { snapshot } = state;
  const view = snapshot ? computeWidgetView(snapshot, now) : null;
  const todayKey = view?.todayKey ?? '';
  const tomorrowKey = todayKey ? addDays(todayKey, 1) : '';
  const day = tab === 'today' ? view?.today ?? null : view?.tomorrow ?? null;

  return (
    <div className="schedule">
      {view?.outageBadge && snapshot?.currentOutage && (
        <div className="banner danger"><strong>{view.outageBadge}</strong><span>{snapshot.currentOutage.text}</span></div>
      )}
      {state.lineChanged && (
        <div className="banner warn">
          <span>Схема підключення змінилась — перевірте лінію</span>
          <button onClick={() => api.openMainWindow('setup')}>Змінити адресу</button>
        </div>
      )}
      {state.phase === 'captcha' && (
        <div className="banner warn">
          <span>Сайт ДТЕК просить пройти перевірку</span>
          <button onClick={() => void api.solveCaptcha()}>Пройти перевірку</button>
        </div>
      )}
      {state.phase === 'error' && (
        <div className="banner warn"><span>{`Не вдалося оновити: ${state.lastError ?? 'невідома помилка'}`}</span></div>
      )}

      {!snapshot || !view ? (
        <p className="muted">Дані ще не отримано</p>
      ) : (
        <div className="panel">
          <h2>{view.title}</h2>
          <p className="muted">{view.nextText}</p>
          <div role="tablist" className="tabs">
            <button role="tab" aria-selected={tab === 'today'} className={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')}>{`Сьогодні ${formatDM(todayKey)}`}</button>
            <button role="tab" aria-selected={tab === 'tomorrow'} className={tab === 'tomorrow' ? 'active' : ''} onClick={() => setTab('tomorrow')}>{`Завтра ${formatDM(tomorrowKey)}`}</button>
          </div>
          {day ? (
            <>
              <DayStrip slots={day.slots} labels />
              <p className="ranges">{outageRanges(day)}</p>
              <div className="legend muted">
                <span><i className="half on" /> Світло є</span>
                <span><i className="half off" /> Немає</span>
                <span><i className="half maybe" /> Можливо немає</span>
                <span><i className="half unknown" /> Невідомо</span>
              </div>
            </>
          ) : (
            <p className="muted">{tab === 'today' ? 'Графік на сьогодні ще не отримано' : 'Графік на завтра ще не опубліковано'}</p>
          )}
          <p className="muted">
            {`Оновлено о ${formatHM(new Date(snapshot.fetchedAt))}${snapshot.sourceUpdatedAt ? ` · графік ДТЕК від ${snapshot.sourceUpdatedAt}` : ''}`}
          </p>
        </div>
      )}
    </div>
  );
}
