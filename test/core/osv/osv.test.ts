import { describe, it, expect, vi } from 'vitest';
import { PublicApiClient, PublicApiError } from '../../../src/core/http/public-client.js';
import {
  OSV_ORIGIN,
  lookupOsv,
  normalizeAdvisory,
  osvFixedVersion,
  osvPackageKey,
  osvRangeText,
  type AdvisoryCache,
  type OsvAdvisory,
  type OsvPackage,
  type OsvRange,
} from '../../../src/core/osv/osv.js';
import type { PackageEcosystem } from '../../../src/core/types.js';
import { fakeHttp, type FakeHttpRoute } from '../../helpers/fake-http.js';

const BATCH = 'POST https://api.osv.dev/v1/querybatch';
const vulnUrl = (id: string) => `GET https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`;

interface Batch { queries: { package: { name: string; ecosystem: string }; version: string; page_token?: string }[] }

const pkg = (name: string, version: string, ecosystem: PackageEcosystem = 'npm'): OsvPackage => ({ ecosystem, name, version });
const osvClient = (f: ReturnType<typeof fakeHttp>) => new PublicApiClient({ origin: OSV_ORIGIN, fetch: f, sleep: async () => {} });
const batchCalls = (f: ReturnType<typeof fakeHttp>) => f.calls.filter((c) => c.method === 'POST').map((c) => c.body as Batch);
const getCalls = (f: ReturnType<typeof fakeHttp>) => f.calls.filter((c) => c.method === 'GET').map((c) => c.url);

function memoryCache(entries: Record<string, { modified: string; json: string }> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn((id: string) => store.get(id) ?? null),
    put: vi.fn((id: string, modified: string, json: string) => void store.set(id, { modified, json })),
  } satisfies AdvisoryCache & { store: unknown };
}

/** Answers every query with `{}`. */
const noVulns: FakeHttpRoute = (body) => ({ body: { results: (body as Batch).queries.map(() => ({})) } });

const semver = (...events: OsvRange['events']): OsvRange => ({ type: 'SEMVER', events });
const npmAffected = (name: string, ...ranges: OsvRange[]) => ({ package: { ecosystem: 'npm', name }, ranges });

const MINIMIST = {
  id: 'GHSA-xvch-5gv4-984h',
  modified: '2024-02-01T00:00:00Z',
  aliases: ['CVE-2021-44906'],
  summary: 'Prototype Pollution in minimist',
  details: 'Minimist <=1.2.5 is vulnerable to Prototype Pollution via file index.js.',
  affected: [
    npmAffected('minimist', semver({ introduced: '1.0.0' }, { fixed: '1.2.6' })),
    npmAffected('minimist', semver({ introduced: '0' }, { fixed: '0.2.4' })),
  ],
  database_specific: { severity: 'CRITICAL', github_reviewed: true },
};

const advisory = (ranges: OsvRange[], o: Partial<OsvAdvisory> = {}): OsvAdvisory => ({
  id: 'GHSA-test', aliases: [], summary: 's', severity: 'high', severitySource: 'advisory', ranges, ...o,
});

describe('lookupOsv', () => {
  it('queries unique packages in batches of 1000', async () => {
    const unique = [...Array.from({ length: 1999 }, (_, i) => pkg(`p${i}`, '1.0.0')), pkg('p0', '2.0.0'), pkg('rails', '7.0.0', 'rubygems')];
    const input = [...unique, ...unique.slice(0, 600), pkg('rails', '7.0.0', 'rubygems')];
    const f = fakeHttp({ [BATCH]: noVulns });
    const progress: [number, number][] = [];
    const result = await lookupOsv(osvClient(f), input, memoryCache(), { concurrency: 2, onProgress: (d, t) => progress.push([d, t]) });

    const batches = batchCalls(f);
    expect(batches.map((b) => b.queries.length).sort((a, b) => b - a)).toEqual([1000, 1000, 1]);
    expect(batches.find((b) => b.queries.length === 1)).toEqual({ queries: [{ package: { name: 'rails', ecosystem: 'RubyGems' }, version: '7.0.0' }] });
    expect(batches.flatMap((b) => b.queries)).toContainEqual({ package: { name: 'p0', ecosystem: 'npm' }, version: '2.0.0' });
    expect(new Set(batches.flatMap((b) => b.queries.map((q) => JSON.stringify(q)))).size).toBe(2001);
    expect(getCalls(f)).toEqual([]);
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);

    // Every distinct package has an entry; `{}` means none.
    expect(result.size).toBe(2001);
    expect(result.get(osvPackageKey(pkg('p0', '2.0.0')))).toEqual([]);
    expect(result.get(osvPackageKey(pkg('rails', '7.0.0', 'rubygems')))).toEqual([]);
    expect(osvPackageKey(pkg('rails', '7.0.0', 'rubygems'))).not.toBe(osvPackageKey(pkg('rails', '7.0.0')));
    expect(osvPackageKey(pkg('a', 'b@c'))).not.toBe(osvPackageKey(pkg('a@b', 'c')));

    expect(await lookupOsv(osvClient(f), [], memoryCache(), { concurrency: 2 })).toEqual(new Map());
  });

  it('follows next_page_token', async () => {
    const second = { ...MINIMIST, id: 'GHSA-vh95-rmgr-6w4m', aliases: ['CVE-2020-7598'] };
    const f = fakeHttp({
      [BATCH]: [
        { body: { results: [
          { vulns: [{ id: MINIMIST.id, modified: MINIMIST.modified }], next_page_token: 'page-2' },
          {},
        ] } },
        { body: { results: [{ vulns: [{ id: second.id, modified: second.modified }, { id: MINIMIST.id, modified: MINIMIST.modified }] }] } },
      ],
      [vulnUrl(MINIMIST.id)]: { body: MINIMIST },
      [vulnUrl(second.id)]: { body: second },
    });
    const progress: [number, number][] = [];
    const result = await lookupOsv(osvClient(f), [pkg('minimist', '0.0.8'), pkg('mkdirp', '0.5.1')], memoryCache(),
      { concurrency: 4, onProgress: (d, t) => progress.push([d, t]) });

    expect(batchCalls(f)).toEqual([
      { queries: [
        { package: { name: 'minimist', ecosystem: 'npm' }, version: '0.0.8' },
        { package: { name: 'mkdirp', ecosystem: 'npm' }, version: '0.5.1' },
      ] },
      { queries: [{ package: { name: 'minimist', ecosystem: 'npm' }, version: '0.0.8', page_token: 'page-2' }] },
    ]);
    expect(result.get(osvPackageKey(pkg('minimist', '0.0.8')))!.map((a) => a.id)).toEqual([MINIMIST.id, second.id]);
    expect(result.get(osvPackageKey(pkg('mkdirp', '0.5.1')))).toEqual([]);
    expect(getCalls(f).sort()).toEqual([vulnUrl(MINIMIST.id), vulnUrl(second.id)].map((r) => r.slice(4)).sort());
    expect(progress).toEqual([[1, 1], [2, 2], [3, 4], [4, 4]]);
  });

  it('stops following a next_page_token that never ends', async () => {
    const f = fakeHttp({ [BATCH]: () => ({ body: { results: [{ next_page_token: 'again' }] } }) });
    await expect(lookupOsv(osvClient(f), [pkg('minimist', '0.0.8')], memoryCache(), { concurrency: 1 }))
      .rejects.toThrow('OSV kept returning more pages.');
    expect(batchCalls(f).length).toBeLessThanOrEqual(100);
  });

  it('fetches each record once and reuses the cache while modified is unchanged', async () => {
    const changed = '2025-03-01T00:00:00Z';
    const batch = (modified: string): FakeHttpRoute => (body) => ({
      body: { results: (body as Batch).queries.map(() => ({ vulns: [{ id: MINIMIST.id, modified }] })) },
    });
    const both = [pkg('minimist', '0.0.8'), pkg('minimist', '1.2.5')];
    const cache = memoryCache();

    // A miss: one GET for the two packages, stored with the batch's `modified`.
    const f1 = fakeHttp({ [BATCH]: batch(MINIMIST.modified), [vulnUrl(MINIMIST.id)]: { body: MINIMIST } });
    const first = await lookupOsv(osvClient(f1), both, cache, { concurrency: 4 });
    expect(getCalls(f1)).toEqual(['https://api.osv.dev/v1/vulns/GHSA-xvch-5gv4-984h']);
    expect(cache.put.mock.calls).toEqual([[MINIMIST.id, MINIMIST.modified, JSON.stringify(MINIMIST)]]);
    for (const p of both) expect(first.get(osvPackageKey(p))).toEqual([normalizeAdvisory(MINIMIST, p)]);

    // The same `modified`: no GET at all.
    const f2 = fakeHttp({ [BATCH]: batch(MINIMIST.modified) });
    const second = await lookupOsv(osvClient(f2), both, cache, { concurrency: 4 });
    expect(getCalls(f2)).toEqual([]);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    // A changed `modified`: fetched again and the cache updated.
    const updated = { ...MINIMIST, modified: changed, summary: 'Prototype Pollution in minimist (updated)' };
    const f3 = fakeHttp({ [BATCH]: batch(changed), [vulnUrl(MINIMIST.id)]: { body: updated } });
    const third = await lookupOsv(osvClient(f3), both, cache, { concurrency: 4 });
    expect(getCalls(f3)).toHaveLength(1);
    expect(cache.put).toHaveBeenLastCalledWith(MINIMIST.id, changed, JSON.stringify(updated));
    expect(third.get(osvPackageKey(both[0]!))![0]!.summary).toBe('Prototype Pollution in minimist (updated)');

    // A cache entry that no longer parses is fetched again.
    const broken = memoryCache({ [MINIMIST.id]: { modified: MINIMIST.modified, json: '{not json' } });
    const f4 = fakeHttp({ [BATCH]: batch(MINIMIST.modified), [vulnUrl(MINIMIST.id)]: { body: MINIMIST } });
    await lookupOsv(osvClient(f4), both, broken, { concurrency: 4 });
    expect(getCalls(f4)).toHaveLength(1);
  });

  it('keeps batches and detail requests within the concurrency limit', async () => {
    const ids = ['GHSA-1', 'GHSA-2', 'GHSA-3', 'GHSA-4', 'GHSA-5'];
    const routes: Record<string, FakeHttpRoute> = {
      [BATCH]: (body) => ({ body: { results: (body as Batch).queries.map((q) => {
        const n = Number(q.package.name.slice(1));
        return n < ids.length ? { vulns: [{ id: ids[n], modified: 'm' }] } : {};
      }) } }),
    };
    for (const id of ids) routes[vulnUrl(id)] = { body: { id } };
    const f = fakeHttp(routes);
    const peak = { POST: 0, GET: 0 };
    let inFlight = 0;
    const slow: typeof f = Object.assign(async (url: string, init: Parameters<typeof f>[1]) => {
      peak[init.method] = Math.max(peak[init.method], ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return f(url, init);
    }, { calls: f.calls });
    const packages = Array.from({ length: 2500 }, (_, i) => pkg(`p${i}`, '1.0.0'));
    const result = await lookupOsv(osvClient(slow), packages, memoryCache(), { concurrency: 2 });
    expect(batchCalls(f)).toHaveLength(3);
    expect(getCalls(f)).toHaveLength(5);
    expect(peak).toEqual({ POST: 2, GET: 2 });
    expect(result.get(osvPackageKey(pkg('p4', '1.0.0')))!.map((a) => a.id)).toEqual(['GHSA-5']);
  });

  it('a batch that keeps failing rejects', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const down = fakeHttp({ [BATCH]: { status: 503 } });
    const client = new PublicApiClient({ origin: OSV_ORIGIN, fetch: down, sleep });
    const err = await lookupOsv(client, [pkg('minimist', '0.0.8')], memoryCache(), { concurrency: 4 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicApiError);
    expect(err).toMatchObject({ status: 503 });
    expect(down.calls).toHaveLength(4);

    // A detail request that fails rejects too, and nothing is cached.
    const cache = memoryCache();
    const noRecord = fakeHttp({ [BATCH]: { body: { results: [{ vulns: [{ id: MINIMIST.id, modified: MINIMIST.modified }] }] } } });
    await expect(lookupOsv(osvClient(noRecord), [pkg('minimist', '0.0.8')], cache, { concurrency: 4 }))
      .rejects.toMatchObject({ status: 404 });
    expect(cache.put).not.toHaveBeenCalled();

    // A response in the wrong form is a failure, never "no vulnerabilities".
    const bad: FakeHttpRoute[] = [
      { body: { results: [] } },
      { body: { results: [{ vulns: {} }] } },
      { body: { results: [{ vulns: [{ id: 7, modified: 'x' }] }] } },
      { body: { results: [{ vulns: [{ id: 'GHSA-1' }] }] } },
      { body: { results: [{ next_page_token: 5 }] } },
      { body: [] },
    ];
    for (const route of bad) {
      const f = fakeHttp({ [BATCH]: route });
      await expect(lookupOsv(osvClient(f), [pkg('minimist', '0.0.8')], memoryCache(), { concurrency: 1 }), JSON.stringify(route))
        .rejects.toThrow("OSV's response wasn't in the expected form.");
    }
    const wrongRecord = fakeHttp({
      [BATCH]: { body: { results: [{ vulns: [{ id: MINIMIST.id, modified: MINIMIST.modified }] }] } },
      [vulnUrl(MINIMIST.id)]: { body: { ...MINIMIST, id: 'GHSA-other' } },
    });
    await expect(lookupOsv(osvClient(wrongRecord), [pkg('minimist', '0.0.8')], cache, { concurrency: 1 }))
      .rejects.toThrow("OSV's response wasn't in the expected form.");
    expect(cache.put).not.toHaveBeenCalled();
  });
});

describe('normalizeAdvisory', () => {
  it('normalizes severity, summary, and ranges', () => {
    const p = pkg('minimist', '0.0.8');
    const sev = (json: Record<string, unknown>) => {
      const a = normalizeAdvisory({ summary: 's', ...json }, p);
      return [a.severity, a.severitySource];
    };
    expect(sev({ id: 'GHSA-1', database_specific: { severity: 'CRITICAL' } })).toEqual(['critical', 'advisory']);
    expect(sev({ id: 'GHSA-1', database_specific: { severity: 'HIGH' } })).toEqual(['high', 'advisory']);
    expect(sev({ id: 'GHSA-1', database_specific: { severity: 'moderate' } })).toEqual(['medium', 'advisory']);
    expect(sev({ id: 'GHSA-1', database_specific: { severity: 'LOW' } })).toEqual(['low', 'advisory']);
    expect(sev({ id: 'MAL-2025-1234' })).toEqual(['critical', 'malware']);
    expect(sev({ id: 'MAL-2025-1234', database_specific: { severity: 'LOW' } })).toEqual(['low', 'advisory']);
    expect(sev({ id: 'GHSA-1', database_specific: { severity: 'UNKNOWN' } })).toEqual(['critical', 'assumed']);
    expect(sev({ id: 'GHSA-1', database_specific: { severity: 3 } })).toEqual(['critical', 'assumed']);
    expect(sev({ id: 'GHSA-1', database_specific: 'HIGH' })).toEqual(['critical', 'assumed']);
    expect(sev({ id: 'OSV-2025-1' })).toEqual(['critical', 'assumed']);

    expect(normalizeAdvisory(MINIMIST, p)).toEqual({
      id: 'GHSA-xvch-5gv4-984h',
      aliases: ['CVE-2021-44906'],
      summary: 'Prototype Pollution in minimist',
      severity: 'critical',
      severitySource: 'advisory',
      ranges: [semver({ introduced: '1.0.0' }, { fixed: '1.2.6' }), semver({ introduced: '0' }, { fixed: '0.2.4' })],
    });

    // The summary, or else the first line of the details (up to 200 characters), or else the ID.
    const summary = (json: Record<string, unknown>) => normalizeAdvisory({ id: 'MAL-2025-1', ...json }, p).summary;
    expect(summary({ summary: 'Malicious code in minimist', details: 'More.' })).toBe('Malicious code in minimist');
    expect(summary({ summary: '  ', details: '\n  Malicious code in minimist (npm)\nThe package ...' })).toBe('Malicious code in minimist (npm)');
    expect(summary({ details: `${'x'.repeat(250)}\nsecond` })).toBe('x'.repeat(200));
    expect(summary({ details: `${'x'.repeat(199)}😀😀` })).toBe(`${'x'.repeat(199)}😀`);
    expect(summary({ summary: 5, details: ['no'] })).toBe('MAL-2025-1');
    expect(summary({})).toBe('MAL-2025-1');

    // Only this package's ranges, only SEMVER and ECOSYSTEM ones, and only the events OSV defines.
    const messy = normalizeAdvisory({
      id: 'GHSA-2',
      aliases: ['CVE-2', 7, null, 'MAL-2'],
      affected: [
        npmAffected('minimist', semver({ introduced: '0' }, { fixed: '1.0.0' })),
        { package: { ecosystem: 'RubyGems', name: 'minimist' }, ranges: [semver({ introduced: '0' }, { fixed: '9.0.0' })] },
        npmAffected('other', semver({ introduced: '0' }, { fixed: '8.0.0' })),
        { package: { ecosystem: 'npm', name: 'minimist' }, ranges: [
          { type: 'GIT', repo: 'https://github.com/x/y', events: [{ introduced: '0' }, { fixed: 'abc123' }] },
          { type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }, { limit: '3.0.0' }, 42, null, { fixed: 3 }, { last_affected: '2.5.0' }] },
          { type: 'SEMVER' },
          { type: 'SEMVER', events: 'nope' },
          'junk',
        ] },
        { package: { ecosystem: 'npm', name: 'minimist' }, ranges: 'junk' },
        { package: 'minimist' },
        null,
      ],
    }, p);
    expect(messy.aliases).toEqual(['CVE-2', 'MAL-2']);
    expect(messy.ranges).toEqual([
      semver({ introduced: '0' }, { fixed: '1.0.0' }),
      { type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }, { last_affected: '2.5.0' }] },
    ]);

    const gem = normalizeAdvisory({ id: 'GHSA-3', affected: [
      { package: { ecosystem: 'RubyGems', name: 'actionpack' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '6.1.7.4' }] }] },
      { package: { ecosystem: 'npm', name: 'actionpack' }, ranges: [semver({ introduced: '0' }, { fixed: '1.0.0' })] },
    ] }, pkg('actionpack', '6.1.7.3', 'rubygems'));
    expect(gem.ranges).toEqual([{ type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '6.1.7.4' }] }]);

    // External data in any shape never throws.
    for (const junk of [null, 'GHSA-1', 42, [], { id: 5, affected: {}, aliases: 'CVE-1' }]) {
      expect(normalizeAdvisory(junk, p)).toMatchObject({ aliases: [], severity: 'critical', severitySource: 'assumed', ranges: [] });
    }
  });
});

describe('osvFixedVersion', () => {
  it('finds the fixed version for the installed version', () => {
    const minimist = normalizeAdvisory(MINIMIST, pkg('minimist', '0.0.8'));
    expect(osvFixedVersion(minimist, 'npm', '0.0.8')).toBe('0.2.4');
    expect(osvFixedVersion(minimist, 'npm', '1.2.5')).toBe('1.2.6');
    expect(osvFixedVersion(minimist, 'npm', '1.0.0')).toBe('1.2.6');
    expect(osvFixedVersion(minimist, 'npm', '1.2.6')).toBeNull();
    expect(osvFixedVersion(minimist, 'npm', '0.5.0')).toBeNull();
    expect(osvFixedVersion(minimist, 'npm', 'git+ssh://git@github.com/substack/minimist.git')).toBeNull();

    const lastAffected = advisory([semver({ introduced: '0' }, { last_affected: '2.0.0' })]);
    expect(osvFixedVersion(lastAffected, 'npm', '1.0.0')).toBeNull();
    expect(osvFixedVersion(lastAffected, 'npm', '2.0.0')).toBeNull();

    const actionpack = advisory([{ type: 'ECOSYSTEM', events: [
      { introduced: '0' }, { fixed: '6.1.7.4' }, { introduced: '7.0.0' }, { fixed: '7.0.5.1' }] }]);
    expect(osvFixedVersion(actionpack, 'rubygems', '6.1.7.3')).toBe('6.1.7.4');
    expect(osvFixedVersion(actionpack, 'rubygems', '7.0.4')).toBe('7.0.5.1');
    expect(osvFixedVersion(actionpack, 'rubygems', '6.1.7.4')).toBeNull();

    // An interval with no closing event has no fix.
    expect(osvFixedVersion(advisory([semver({ introduced: '1.0.0' })]), 'npm', '5.0.0')).toBeNull();
    // A second introduced inside an open interval doesn't start a new one.
    expect(osvFixedVersion(advisory([semver({ introduced: '1.0.0' }, { introduced: '1.5.0' }, { fixed: '2.0.0' })]), 'npm', '1.2.0')).toBe('2.0.0');
    expect(osvFixedVersion(advisory([semver({ introduced: '1.0.0' }, { introduced: '1.5.0' }, { fixed: '2.0.0' })]), 'npm', '3.0.0')).toBeNull();
    // A bound that can't be compared skips its interval.
    expect(osvFixedVersion(advisory([semver({ introduced: 'abc' }, { fixed: '2.0.0' }), semver({ introduced: '0' }, { fixed: '1.5.0' })]), 'npm', '1.2.0')).toBe('1.5.0');
    // Overlapping intervals: the version is fixed only past all of them, and not at all if one has no fix.
    expect(osvFixedVersion(advisory([semver({ introduced: '0' }, { fixed: '1.0.5' }), semver({ introduced: '0.5.0' }, { fixed: '1.0.7' })]), 'npm', '0.9.0')).toBe('1.0.7');
    expect(osvFixedVersion(advisory([semver({ introduced: '0' }, { fixed: '1.2.6' }), semver({ introduced: '1.0.0' })]), 'npm', '1.1.0')).toBeNull();
  });
});

describe('osvRangeText', () => {
  it('writes ranges as text', () => {
    expect(osvRangeText(normalizeAdvisory(MINIMIST, pkg('minimist', '0.0.8')))).toBe('>= 1.0.0, < 1.2.6; < 0.2.4');
    expect(osvRangeText(advisory([
      semver({ introduced: '1.0.0' }, { last_affected: '2.0.0' }, { introduced: '3.0.0' }),
      semver({ introduced: '0' }, { last_affected: '0.5.0' }),
      semver({ introduced: '1.0.0' }, { last_affected: '2.0.0' }),
    ]))).toBe('>= 1.0.0, <= 2.0.0; >= 3.0.0; <= 0.5.0');
    expect(osvRangeText(advisory([semver({ introduced: '0' })]))).toBe('all versions');
    expect(osvRangeText(advisory([]))).toBeNull();
    expect(osvRangeText(advisory([semver({ fixed: '1.0.0' })]))).toBeNull();
  });
});
