import { buildFeed, downloadBase, feedConfig, releasePage, UPDATE_FEED } from '../../../src/main/update/feed';

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

test('buildFeed: no override is no feed', () => {
  expect(buildFeed(undefined, '1.0.1')).toBe('');
  expect(buildFeed('', '1.0.1')).toBe('');
  expect(buildFeed('  ', '1.0.1')).toBe('');
});

test('buildFeed: a test version takes the feed, without a trailing slash', () => {
  expect(buildFeed(`${TEST_FEED}/`, '1.0.1-test.1')).toBe(TEST_FEED);
  expect(buildFeed(TEST_FEED, '1.0.1-test.2')).toBe(TEST_FEED);
});

test('buildFeed: a release version refuses a feed, so a test feed never ships', () => {
  expect(() => buildFeed(TEST_FEED, '1.0.1')).toThrow(/BW_UPDATE_FEED.*1\.0\.1/);
});

test('buildFeed: the feed must be an https URL', () => {
  expect(() => buildFeed('github.com/x', '1.0.1-test.1')).toThrow(/https/);
  expect(() => buildFeed('http://example.test/feed', '1.0.1-test.1')).toThrow(/https/);
});
