import { describe, expect, it } from 'vitest';
import {
  buildTrendsImport,
  googleTrendsExploreUrl,
  parseTrendsCsv,
  termWithCity,
  trendCityRegion,
  trendDirection,
  trendImportSchema,
  trendSettingsSchema,
} from '../src';

describe('googleTrendsExploreUrl', () => {
  it('builds the same comparison link as Google Trends', () => {
    expect(
      googleTrendsExploreUrl({
        keywords: ['wedding invitation', 'birthday invitation'],
        country: 'IN',
        timeRange: 'past_90_days',
        category: 293,
      }),
    ).toBe(
      'https://trends.google.com/explore?geo=IN&date=today%203-m&cat=293&q=wedding%2520invitation%2Cbirthday%2520invitation',
    );
    // Worldwide and all categories leave those parameters out; a region replaces the country.
    expect(
      googleTrendsExploreUrl({
        keywords: ['invitation'],
        country: null,
        timeRange: 'past_12_months',
        category: 0,
      }),
    ).toBe('https://trends.google.com/explore?date=today%2012-m&q=invitation');
    expect(
      googleTrendsExploreUrl({ keywords: ['invitation'], country: 'IN', region: 'IN-GJ', timeRange: 'past_7_days', category: 0 }), // prettier-ignore
    ).toBe('https://trends.google.com/explore?geo=IN-GJ&date=now%207-d&q=invitation');
  });
});

const interestCsv = [
  '\uFEFFCategory: All categories',
  '',
  'Week,wedding invitation: (India),"housewarming invitation: (India)"',
  '2026-07-20,54,<1',
  '2026-07-27,100,3',
  '2026-08-03,,5',
].join('\r\n');

const regionCsv = [
  'Category: All categories',
  '',
  'Region,wedding invitation: (25/07/2026 - 23/10/2026),digital invitation: (25/07/2026 - 23/10/2026)',
  'Kerala,98%,2%',
  'Gujarat,90%,10%',
  'Lakshadweep,,',
].join('\n');

const relatedQueriesCsv = [
  'Category: All categories',
  '',
  'TOP',
  'wedding invitation card,100',
  'wedding invitation video,42',
  '',
  'RISING',
  'wedding invitation video maker,Breakout',
  'e invite for wedding,+250%',
].join('\n');

const relatedTopicsCsv = [
  'Category: All categories',
  '',
  'TOP',
  'Wedding - Topic,100',
  'Invitation - Topic,48',
  '',
  'RISING',
  'Canva - Software company,+300%',
].join('\n');

describe('parseTrendsCsv', () => {
  it('reads an "Interest over time" export', () => {
    expect(parseTrendsCsv(interestCsv)).toEqual({
      kind: 'interest_over_time',
      related: null,
      regions: null,
      topics: null,
      headerNote: 'India',
      warnings: [],
      interest: {
        dates: ['2026-07-20', '2026-07-27', '2026-08-03'],
        series: [
          { keyword: 'wedding invitation', values: [54, 100, null], average: 77 },
          { keyword: 'housewarming invitation', values: [0, 3, 5], average: 2.7 },
        ],
      },
    });
  });

  it('reads an "Interest by subregion" export with several terms as shares', () => {
    const parsed = parseTrendsCsv(regionCsv);
    expect(parsed.kind).toBe('interest_by_region');
    expect(parsed.headerNote).toBe('25/07/2026 - 23/10/2026');
    expect(parsed.regions).toEqual({
      resolution: 'REGION',
      keywords: ['wedding invitation', 'digital invitation'],
      comparison: 'share',
      regions: [
        { geoCode: null, name: 'Kerala', values: [98, 2] },
        { geoCode: null, name: 'Gujarat', values: [90, 10] },
        // Too few searches: no value, never zero.
        { geoCode: null, name: 'Lakshadweep', values: [null, null] },
      ],
    });
    expect(
      parseTrendsCsv('City,invitation: (1/1/2026 - 2/1/2026)\nSurat,100\nPune,61').regions,
    ).toMatchObject({
      resolution: 'CITY',
      comparison: 'single',
    });
  });

  it('reads a "Related queries" export with top and rising sections', () => {
    expect(parseTrendsCsv(relatedQueriesCsv, 'relatedQueries.csv')).toMatchObject({
      kind: 'related_queries',
      related: {
        keyword: null,
        top: [
          { query: 'wedding invitation card', value: 100 },
          { query: 'wedding invitation video', value: 42 },
        ],
        rising: [
          { query: 'wedding invitation video maker', value: 'Breakout' },
          { query: 'e invite for wedding', value: '+250%' },
        ],
      },
    });
  });

  it('reads a "Related topics" export and splits the topic type', () => {
    expect(parseTrendsCsv(relatedTopicsCsv, 'relatedEntities.csv')).toMatchObject({
      kind: 'related_topics',
      topics: {
        keyword: null,
        top: [
          { topic: 'Wedding', type: 'Topic', value: 100 },
          { topic: 'Invitation', type: 'Topic', value: 48 },
        ],
        rising: [{ topic: 'Canva', type: 'Software company', value: '+300%' }],
      },
    });
  });

  it('returns nothing for files it does not recognise instead of guessing', () => {
    expect(parseTrendsCsv('name,email\nA,a@example.test')).toMatchObject({ kind: null, interest: null, related: null, regions: null, topics: null }); // prettier-ignore
  });
});

describe('buildTrendsImport', () => {
  it('combines the files of one comparison and assigns related files to the only term', () => {
    const single = interestCsv
      .replace(',"housewarming invitation: (India)"', '')
      .replace(/,(<1|3|5)\r?$/gm, '');
    const preview = buildTrendsImport([
      { name: 'multiTimeline.csv', content: single },
      { name: 'relatedQueries.csv', content: relatedQueriesCsv },
      { name: 'relatedEntities.csv', content: relatedTopicsCsv },
      { name: 'notes.csv', content: 'hello,world' },
    ]);
    expect(preview.ok).toBe(true);
    expect(preview.keywords).toEqual(['wedding invitation']);
    expect(preview.files.map((f) => f.kind)).toEqual(['interest_over_time', 'related_queries', 'related_topics', null]); // prettier-ignore
    expect(preview.files[1]).toMatchObject({ keywords: ['wedding invitation'], rows: 4, first: 'wedding invitation card' }); // prettier-ignore
    expect(preview.files[3]!.error).toMatch(/Not a Google Trends export/);
    expect(preview.data.related[0]!.keyword).toBe('wedding invitation');
    expect(preview.data.topics![0]!.keyword).toBe('wedding invitation');
    expect(preview.warnings).toEqual([]);
  });

  it('asks which term a related file belongs to when the comparison has several, and flags mismatched files', () => {
    const preview = buildTrendsImport([
      { name: 'multiTimeline.csv', content: interestCsv },
      { name: 'geoMap.csv', content: regionCsv },
      { name: 'relatedQueries.csv', content: relatedQueriesCsv },
    ]);
    expect(preview.keywords).toEqual(['wedding invitation', 'housewarming invitation']);
    expect(preview.data.related[0]!.keyword).toBeNull();
    expect(preview.warnings.join(' ')).toMatch(/compare different terms/);
    expect(preview.warnings.join(' ')).toMatch(/relatedQueries\.csv: choose which term/);
    const chosen = buildTrendsImport([
      { name: 'multiTimeline.csv', content: interestCsv },
      { name: 'relatedQueries.csv', content: relatedQueriesCsv, keyword: 'wedding invitation' },
    ]);
    expect(chosen.data.related[0]!.keyword).toBe('wedding invitation');
    expect(chosen.warnings).toEqual([]);
  });
});

describe('trendDirection', () => {
  it('compares the first and last thirds, ignoring incomplete periods', () => {
    expect(trendDirection([10, 12, 11, 20, 25, 30, 35, 40, 45])).toBe('rising');
    expect(trendDirection([50, 48, 52, 50, 49, 51, 50, 52, 49])).toBe('stable');
    expect(trendDirection([60, 55, 50, 40, 30, 25, 20, 15, 10])).toBe('falling');
    expect(trendDirection([0, 0, 0, 0, 0, 0, 0])).toBe('no_data');
    expect(trendDirection([10, 20])).toBe('no_data');
    // A sharp drop in the last, still incomplete, period does not count.
    expect(trendDirection([50, 50, 50, 50, 50, 50, 50, 5], [false, false, false, false, false, false, false, true])).toBe('stable'); // prettier-ignore
  });
});

describe('trend settings', () => {
  it('validates terms, places and data types the way Google Trends does', () => {
    expect(trendSettingsSchema.safeParse({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(trendSettingsSchema.safeParse({ keywords: ['wedding "invitation"'] }).success).toBe(false);
    expect(trendSettingsSchema.parse({ keywords: ['wedding invitation'] })).toMatchObject({
      country: null,
      region: null,
      timeRange: 'past_90_days',
      category: 0,
      include: ['interest', 'regions', 'related_queries', 'related_topics'],
      suggestPlacements: true,
    });
    // Interest over time is always included.
    expect(trendSettingsSchema.parse({ keywords: ['x y'], include: ['regions'] }).include).toEqual(['interest', 'regions']); // prettier-ignore
    expect(trendSettingsSchema.parse({ keywords: ['x y'], country: 'IN', region: 'in-gj' }).region).toBe(
      'IN-GJ',
    );
    expect(trendSettingsSchema.safeParse({ keywords: ['x y'], country: 'US', region: 'IN-GJ' }).success).toBe(
      false,
    );
    expect(trendSettingsSchema.safeParse({ keywords: ['x y'], region: 'IN-GJ' }).success).toBe(false);
    expect(trendSettingsSchema.safeParse({ keywords: ['x y'], provider: 'SCRAPER' }).success).toBe(false);
    expect(trendImportSchema.safeParse({ files: [] }).success).toBe(false);
  });
});

describe('city filter', () => {
  it('compares searches that mention the city, in the city’s state', () => {
    expect(termWithCity('wedding card', 'Surat')).toBe('wedding card surat');
    expect(termWithCity('wedding card surat', 'Surat')).toBe('wedding card surat');
    expect(trendCityRegion('IN', 'surat')).toBe('IN-GJ');
    expect(trendCityRegion('IN', 'Navsari')).toBeNull();
    // A known city fills in its state.
    expect(trendSettingsSchema.parse({ keywords: ['wedding card'], country: 'IN', city: 'Surat' })).toMatchObject({ region: 'IN-GJ', city: 'Surat' }); // prettier-ignore
    // A city not in the list keeps the chosen region (or none).
    expect(trendSettingsSchema.parse({ keywords: ['wedding card'], country: 'IN', region: 'IN-GJ', city: 'Navsari' })).toMatchObject({ region: 'IN-GJ' }); // prettier-ignore
    expect(trendSettingsSchema.parse({ keywords: ['wedding card'], country: 'IN', city: 'Navsari' }).region).toBeNull(); // prettier-ignore
    const wrongState = trendSettingsSchema.safeParse({ keywords: ['wedding card'], country: 'IN', region: 'IN-MH', city: 'Surat' }); // prettier-ignore
    expect(wrongState.success).toBe(false);
    expect(wrongState.error?.issues[0]?.message).toMatch(/Surat is in Gujarat/);
    expect(trendSettingsSchema.safeParse({ keywords: ['wedding card'], city: 'Surat' }).success).toBe(false);
    expect(trendSettingsSchema.safeParse({ keywords: ['wedding card'], country: 'IN', city: 'surat123' }).success).toBe(false); // prettier-ignore
  });
});
