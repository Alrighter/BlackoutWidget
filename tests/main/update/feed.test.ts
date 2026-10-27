import { downloadBase, feedConfig, releasePage, UPDATE_FEED } from '../../../src/main/update/feed';

const TEST_FEED = 'https://github.com/Alrighter/BlackoutWidget/releases/download/update-test';

test('normal builds read the latest full GitHub release', () => {
  expect(feedConfig('')).toEqual({ provider: 'github', owner: 'Alrighter', repo: 'BlackoutWidget' });
  expect(downloadBase('', '1.0.2')).toBe('https://github.com/Alrighter/BlackoutWidget/releases/download/v1.0.2/');
});

test('a test feed is read as a generic feed, its files next to its yml', () => {
  expect(feedConfig(TEST_FEED)).toEqual({ provider: 'generic', url: TEST_FEED });
  expect(downloadBase(TEST_FEED, '1.0.1-test.2')).toBe(`${TEST_FEED}/`);
});

test('the release page of a version', () => {
  expect(releasePage('1.0.2')).toBe('https://github.com/Alrighter/BlackoutWidget/releases/tag/v1.0.2');
});

test('no feed override outside a build', () => {
  expect(UPDATE_FEED).toBe('');
});
