import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LoeShapeError, archiveHtmls, archiveRevision, itemRevision, latestRevisions, loeHeadingDate, menuItemHtml, parseLoeRevision,
  type LoeRevision,
} from '../../src/main/providers/loe/schedule';
import type { Slot } from '../../src/shared/types';

const fx = (n: string): any => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'loe', n), 'utf8'));
const MENUS = fx('menus-photo-grafic-2026-10-20-trimmed.json');
const TODAY_ITEM = fx('menu_item-238-today-2026-10-20.json');
const TOMORROW_ITEM = fx('menu_item-256-tomorrow-2026-10-20.json');
const archive = (m: any = MENUS): any[] => m['hydra:member'][0].menuItems.find((i: any) => i.name === 'Arhiv').children;
const item = (id: number): string => archive().find((c: any) => c.id === id).rawHtml;

const OCT17 = item(1108);
const OCT17_MORNING = item(1104);
const APR10 = item(1075);
const FEB10 = item(975);
const PLACEHOLDER = item(540);

const fill = (s: Slot): Slot[] => Array<Slot>(48).fill(s);
/** All on except `off` in [from, to) slots. */
const offIn = (...ranges: [number, number][]): Slot[] =>
  Array.from({ length: 48 }, (_, i): Slot => (ranges.some(([a, b]) => i >= a && i < b) ? 'off' : 'on'));

/** 1108's text with one group line replaced. */
const withLine = (group: string, line: string): string =>
  OCT17.replace(new RegExp(`<p>Група ${group.replace('.', '\\.')}\\.[^<]*</p>`), `<p>${line}</p>`);

describe('parseLoeRevision', () => {
  it('reads archive item 1108: 17.10.2026 as of 18:56, group 1.1 off 20:00-22:00', () => {
    const rev = parseLoeRevision(OCT17);
    expect(rev.date).toBe('2026-10-17');
    expect(rev.updatedAt).toBe('18:56 17.10.2026');
    expect(Object.keys(rev.groups).sort()).toEqual(['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']);
    expect(rev.groups['1.1']).toEqual(offIn([40, 44]));
    expect(rev.groups['1.1'].slice(40, 44)).toEqual(['off', 'off', 'off', 'off']);
    expect(rev.groups['5.1']).toEqual(offIn([24, 32]));
  });

  it('«Група 6.2. Електроенергія є.» is all on', () => {
    expect(parseLoeRevision(OCT17).groups['6.2']).toEqual(fill('on'));
  });

  it('«з 23:00 до 24:00» is off in slots 46-47, half hours included', () => {
    const rev = parseLoeRevision(APR10);
    expect(rev.groups['2.1']).toEqual(offIn([21, 28], [46, 48]));
    expect(rev.groups['2.1'].slice(46)).toEqual(['off', 'off']);
    expect(rev.groups['5.2']).toEqual(offIn([0, 7], [22, 27]));
  });

  it('reads five ranges in one line (item 975)', () => {
    expect(parseLoeRevision(FEB10).groups['2.1']).toEqual(offIn([0, 4], [8, 20], [21, 22], [30, 40], [46, 48]));
  });

  it('item 540\'s «з 00:00 до 00:00» throws', () => {
    expect(() => parseLoeRevision(PLACEHOLDER)).toThrow(LoeShapeError);
    expect(() => parseLoeRevision(PLACEHOLDER)).toThrow('text: empty range');
  });

  it('a text missing group 3.2 throws', () => {
    const missing = OCT17.replace(/<p>Група 3\.2\.[^<]*<\/p>/, '');
    expect(missing).not.toContain('Група 3.2');
    expect(() => parseLoeRevision(missing)).toThrow('text: lines');
  });

  it('a group twice or an unknown group throws', () => {
    expect(() => parseLoeRevision(withLine('3.2', 'Група 3.1. Електроенергія є.'))).toThrow('text: group twice');
    expect(() => parseLoeRevision(withLine('3.2', 'Група 7.1. Електроенергія є.'))).toThrow('text: unknown group');
  });

  it('«з 10:15 до 11:00» throws', () => {
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 10:15 до 11:00.'))).toThrow('text: time');
  });

  it('«з 12:00 до 11:00» throws', () => {
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 12:00 до 11:00.'))).toThrow('text: empty range');
  });

  it('overlapping or descending ranges throw; touching ranges are fine', () => {
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 10:00 до 12:00, з 11:00 до 13:00.')))
      .toThrow('text: range order');
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 14:00 до 16:00, з 10:00 до 12:00.')))
      .toThrow('text: range order');
    const touching = parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 10:00 до 12:00, з 12:00 до 13:00.'));
    expect(touching.groups['1.1']).toEqual(offIn([20, 26]));
  });

  it('24:00 only ends a range; 24:30 and 25:00 throw', () => {
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 24:00 до 24:00.'))).toThrow('text: time');
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 23:00 до 24:30.'))).toThrow('text: time');
    expect(() => parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 23:00 до 25:00.'))).toThrow('text: time');
    expect(parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 00:00 до 24:00.')).groups['1.1']).toEqual(fill('off'));
  });

  it('any other wording of a group line throws', () => {
    for (const line of [
      'Група 1.1. Електроенергії немає.',
      'Група 1.1. Електроенергії немає з 10:00 до 12:00',
      'Група 1.1. Електроенергії немає з 10:00 по 12:00.',
      'Група 1.1. Електроенергія відсутня.',
      'Група 1.1. Можливе відключення з 10:00 до 12:00.',
    ]) {
      expect(() => parseLoeRevision(withLine('1.1', line))).toThrow('text: group line');
    }
  });

  it('an extra line, a missing heading or a missing stamp throws', () => {
    expect(() => parseLoeRevision(OCT17.replace('</div>', '<p>Увага!</p></div>'))).toThrow('text: lines');
    expect(() => parseLoeRevision(OCT17.replace('Графік погодинних відключень на', 'Графік на'))).toThrow('text: heading');
    expect(() => parseLoeRevision(OCT17.replace('Інформація станом на', 'Станом на'))).toThrow('text: stamp');
  });

  it('a heading or stamp that is not a real date or time throws', () => {
    expect(() => parseLoeRevision(OCT17.replace('на 17.10.2026', 'на 31.02.2026'))).toThrow('text: heading');
    expect(() => parseLoeRevision(OCT17.replace('станом на 18:56', 'станом на 24:56'))).toThrow('text: stamp');
    expect(() => parseLoeRevision(OCT17.replace('18:56 17.10.2026', '18:56 32.10.2026'))).toThrow('text: stamp');
  });

  it('error messages are fixed reasons, never the text', () => {
    try {
      parseLoeRevision(withLine('1.1', 'Група 1.1. Електроенергії немає з 10:15 до 11:00.'));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toMatch(/10:15|Група|Електро/);
    }
  });
});

describe('loeHeadingDate', () => {
  it('reads the heading date, with or without bold, or nothing', () => {
    expect(loeHeadingDate(OCT17)).toBe('2026-10-17');
    expect(loeHeadingDate(PLACEHOLDER)).toBe('2024-08-12');
    expect(loeHeadingDate('')).toBeUndefined();
    expect(loeHeadingDate('<p>Інша сторінка</p>')).toBeUndefined();
    expect(loeHeadingDate(OCT17.replace('на 17.10.2026', 'на 31.02.2026'))).toBeUndefined();
  });
});

describe('menu items and the archive', () => {
  it('the Today and Tomorrow items give their rawHtml when the shape is the known one', () => {
    expect(menuItemHtml(TODAY_ITEM, 'Today')).toBe('');
    expect(menuItemHtml(TOMORROW_ITEM, 'Tomorrow')).toBe('');
    expect(menuItemHtml({ ...TODAY_ITEM, rawHtml: OCT17 }, 'Today')).toBe(OCT17);
  });

  it('any other item is unreadable', () => {
    for (const bad of [
      null, [], 'Today', { ...TODAY_ITEM, name: 'Arhiv' }, { ...TODAY_ITEM, menu: '/api/menus/10' },
      { ...TODAY_ITEM, rawHtml: undefined }, { ...TODAY_ITEM, rawHtml: null }, { ...TODAY_ITEM, description: 5 },
    ]) {
      expect(() => menuItemHtml(bad, 'Today')).toThrow(LoeShapeError);
    }
    expect(() => menuItemHtml(TODAY_ITEM, 'Tomorrow')).toThrow(LoeShapeError);
  });

  it('a Today or Tomorrow item with only a picture is unreadable; imageUrl must be a string (R8)', () => {
    for (const name of ['Today', 'Tomorrow'] as const) {
      const item = name === 'Today' ? TODAY_ITEM : TOMORROW_ITEM;
      expect(() => menuItemHtml({ ...item, imageUrl: '/media/6ad39ab31c408_GPV.png' }, name)).toThrow(`menu item: ${name} image only`);
      expect(() => menuItemHtml({ ...item, imageUrl: undefined }, name)).toThrow(`menu item: ${name} fields`);
      expect(() => menuItemHtml({ ...item, imageUrl: null }, name)).toThrow(`menu item: ${name} fields`);
    }
    // A text with its picture is the normal published item.
    expect(menuItemHtml({ ...TODAY_ITEM, rawHtml: OCT17, imageUrl: '/media/6ad39ab31c408_GPV.png' }, 'Today')).toBe(OCT17);
  });

  it('a Today item with only a description stays empty, the quiet shape (R8)', () => {
    expect(menuItemHtml({ ...TODAY_ITEM, description: 'Отримано вказівку НЕК «Укренерго» про відміну застосування ГПВ' }, 'Today')).toBe('');
  });

  it('the archive gives the rawHtml of each child of «Arhiv», a missing one as empty', () => {
    const htmls = archiveHtmls(MENUS);
    expect(htmls).toHaveLength(9);
    expect(htmls[0]).toBe('');
    expect(htmls[1]).toBe('');
    expect(htmls[8]).toBe(OCT17);
  });

  it('archive children with only a picture (248) or only a description (372) are skipped, not unreadable (R8)', () => {
    const [imageOnly, descriptionOnly] = [248, 372].map((id) => archive().find((c: any) => c.id === id));
    expect(imageOnly.imageUrl).not.toBe('');
    expect(descriptionOnly.description).not.toBe('');
    const htmls = archiveHtmls(MENUS);
    expect([htmls[0], htmls[1]]).toEqual(['', '']);
    expect(archiveRevision(htmls[0], ['2024-07-23'])).toBeUndefined();
    expect(archiveRevision(htmls[1], ['2024-11-20'])).toBeUndefined();
  });

  it('an archive without «Arhiv» or with an odd child is unreadable', () => {
    const noArhiv = structuredClone(MENUS);
    noArhiv['hydra:member'][0].menuItems = noArhiv['hydra:member'][0].menuItems.filter((i: any) => i.name !== 'Arhiv');
    expect(() => archiveHtmls(noArhiv)).toThrow('menus: archive');
    const oddChild = structuredClone(MENUS);
    archive(oddChild)[3].rawHtml = 7;
    expect(() => archiveHtmls(oddChild)).toThrow(LoeShapeError);
    expect(() => archiveHtmls({})).toThrow(LoeShapeError);
    expect(() => archiveHtmls([])).toThrow(LoeShapeError);
  });
});

describe('picking the revision', () => {
  const DATES = ['2026-10-17', '2026-10-18'];

  it('a Today or Tomorrow item: empty is none, anything else is parsed strictly whatever its date', () => {
    expect(itemRevision('')).toBeUndefined();
    expect(itemRevision(APR10)?.date).toBe('2026-04-10');
    expect(() => itemRevision(PLACEHOLDER)).toThrow('text: empty range');
  });

  it('an archive item headed another day, or with no heading, is skipped without reading its lines', () => {
    expect(archiveRevision('', DATES)).toBeUndefined();
    expect(archiveRevision(PLACEHOLDER, DATES)).toBeUndefined();
    expect(archiveRevision('<p>Щось інше</p>', DATES)).toBeUndefined();
    expect(archiveRevision(OCT17, DATES)?.updatedAt).toBe('18:56 17.10.2026');
  });

  it('an archive item headed today whose lines fail is unreadable', () => {
    const broken = withLine('1.1', 'Група 1.1. Електроенергії немає з 10:15 до 11:00.');
    expect(() => archiveRevision(broken, DATES)).toThrow('text: time');
  });

  it('per date the latest «станом на» wins, in whatever order the items come', () => {
    const morning = parseLoeRevision(OCT17_MORNING);
    const evening = parseLoeRevision(OCT17);
    expect(morning.updatedAt).toBe('10:59 17.10.2026');
    for (const list of [[morning, evening], [evening, morning]]) {
      const picked = latestRevisions(list, DATES);
      expect([...picked.keys()]).toEqual(['2026-10-17']);
      expect(picked.get('2026-10-17')?.updatedAt).toBe('18:56 17.10.2026');
    }
  });

  it('compares «станом на» across days by date, not as text', () => {
    // A tomorrow schedule published the evening before, then revised in the morning of its day.
    const eve: LoeRevision = { date: '2026-10-18', updatedAt: '19:05 17.10.2026', groups: {} };
    const morning: LoeRevision = { date: '2026-10-18', updatedAt: '08:00 18.10.2026', groups: {} };
    expect(latestRevisions([eve, morning], DATES).get('2026-10-18')).toBe(morning);
    expect(latestRevisions([morning, eve], DATES).get('2026-10-18')).toBe(morning);
  });

  it('a tie keeps the first one read; other dates are left out', () => {
    const a: LoeRevision = { date: '2026-10-17', updatedAt: '18:56 17.10.2026', groups: {} };
    const b: LoeRevision = { ...a, groups: {} };
    const other: LoeRevision = { date: '2026-04-10', updatedAt: '22:19 10.04.2026', groups: {} };
    const picked = latestRevisions([a, other, b], DATES);
    expect(picked.get('2026-10-17')).toBe(a);
    expect(picked.has('2026-04-10')).toBe(false);
  });
});
