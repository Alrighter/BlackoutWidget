import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHomeNumResponse, factToDays, deriveLines } from '../../src/main/providers/dtek/parse';
import type { CurrentOutage, DaySchedule, ScheduleSnapshot } from '../../src/shared/types';

export interface FixtureSnapshotOpts {
  groupId?: string;
  lineIndex?: number;
  fetchedAt?: string;
  extraDays?: DaySchedule[];
  currentOutage?: CurrentOutage;
  sourceUpdatedAt?: string;
}

export function fixtureSnapshot(opts: FixtureSnapshotOpts = {}): ScheduleSnapshot {
  const raw = readFileSync(join(__dirname, '../fixtures/dtek/getHomeNum-stale-updateFact.json'), 'utf8');
  const resp = parseHomeNumResponse(JSON.parse(raw));
  const fact = resp.fact!;
  const schNames = resp.preset!.sch_names;
  const groupId = opts.groupId ?? 'GPV1.2';
  const lineIndex = opts.lineIndex ?? 1;
  const lines = deriveLines(resp.data['40'].sub_type_reason, fact, schNames);
  return {
    providerId: 'dtek-krem',
    address: { providerId: 'dtek-krem', city: 'м. Біла Церква', street: 'бул. Грушевського Михайла', house: '40', lineIndex, groupId },
    groupId,
    groupLabel: schNames[groupId],
    days: [...factToDays(fact, groupId), ...(opts.extraDays ?? [])],
    sourceUpdatedAt: opts.sourceUpdatedAt ?? fact.update,
    fetchedAt: opts.fetchedAt ?? '2026-10-17T08:48:00.000Z',
    lines,
    ...(opts.currentOutage ? { currentOutage: opts.currentOutage } : {}),
  };
}
