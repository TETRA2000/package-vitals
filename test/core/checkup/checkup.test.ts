import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { GitHubClient, type FetchLike } from '../../../src/core/github/client.js';
import { runCheckup, type CheckupOptions } from '../../../src/core/checkup/checkup.js';
import { fakeFetch, type FakeRoute } from '../../helpers/fake-fetch.js';
import { alertJson, repoJson, sbomJson } from '../../helpers/github-fixtures.js';

const OWNER = { kind: 'user', login: 'TETRA2000' } as const;
const OPTS: CheckupOptions = { owner: OWNER, includeForks: false, includeArchived: false, concurrency: 8 };
const NOW = () => new Date('2026-10-24T00:00:00.000Z');

function routes(o: { aPushedAt?: string } = {}): Record<string, FakeRoute> {
  return {
    '/user/repos?affiliation=owner&per_page=100': { body: [
      repoJson('TETRA2000/a', { pushed_at: o.aPushedAt ?? '2026-10-01T00:00:00Z' }),
      repoJson('TETRA2000/b'),
      repoJson('TETRA2000/c'),
    ] },
    '/repos/TETRA2000/a/dependabot/alerts?per_page=100': { body: [
      alertJson({ number: 1, severity: 'critical' }),
      alertJson({ number: 2, severity: 'high', state: 'dismissed', dismissed_reason: 'tolerable_risk' }),
    ] },
    '/repos/TETRA2000/a/dependency-graph/sbom': { body: sbomJson('SPDXRef-root', [
      { SPDXID: 'SPDXRef-root', name: 'com.github.TETRA2000/a' },
      { SPDXID: 'SPDXRef-npm-minimist', name: 'npm:minimist', versionInfo: '0.0.8', purl: 'pkg:npm/minimist@0.0.8' },
    ]) },
    '/repos/TETRA2000/b/dependabot/alerts?per_page=100': {
      status: 403, body: { message: 'Dependabot alerts are disabled for this repository.' } },
  };
}

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function setup(fetch: FetchLike = fakeFetch(routes()), token = 't') {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const client = new GitHubClient({ token, fetch, sleep: async () => {} });
  return { db, deps: { db, client, now: NOW } };
}

const all = (db: Db, sql: string, ...params: (string | number)[]) =>
  db.prepare(sql).all(...params).map((r) => ({ ...r }));

describe('runCheckup', () => {
  it('records a complete snapshot', async () => {
    const { db, deps } = setup();
    const summary = await runCheckup(deps, OPTS);

    expect(summary).toEqual({ snapshotId: 1, reposChecked: 3, notMonitored: 1, errors: 1,
      open: { critical: 1, high: 0, medium: 0, low: 0 } });
    expect(all(db, 'SELECT id, status, started_at, finished_at, error FROM snapshots')).toEqual([
      { id: 1, status: 'complete', started_at: '2026-10-24T00:00:00.000Z', finished_at: '2026-10-24T00:00:00.000Z', error: null }]);
    expect(all(db, `SELECT r.full_name, s.alerts_status, s.alerts_error, s.sbom_status FROM snapshot_repos s
      JOIN repos r ON r.id = s.repo_id ORDER BY r.full_name`)).toEqual([
      { full_name: 'TETRA2000/a', alerts_status: 'ok', alerts_error: null, sbom_status: 'ok' },
      { full_name: 'TETRA2000/b', alerts_status: 'not_monitored', alerts_error: null, sbom_status: 'unavailable' },
      { full_name: 'TETRA2000/c', alerts_status: 'error', alerts_error: 'Not Found (HTTP 404)', sbom_status: 'unavailable' },
    ]);
    expect(all(db, 'SELECT number, state, severity, first_patched, dismissed_reason FROM alerts ORDER BY number')).toEqual([
      { number: 1, state: 'open', severity: 'critical', first_patched: '0.2.4', dismissed_reason: null },
      { number: 2, state: 'dismissed', severity: 'high', first_patched: '0.2.4', dismissed_reason: 'tolerable_risk' },
    ]);
    expect(all(db, 'SELECT name, version, purl FROM sbom_packages')).toEqual([
      { name: 'npm:minimist', version: '0.0.8', purl: 'pkg:npm/minimist@0.0.8' }]);
  });

  // Review Focus 3
  it('a failed listing marks the snapshot failed', async () => {
    const { db, deps } = setup(fakeFetch({ '/user/repos?affiliation=owner&per_page=100': { status: 500, body: { message: 'Server Error' } } }));
    await expect(runCheckup(deps, OPTS)).rejects.toThrow('Server Error (HTTP 500)');
    expect(all(db, 'SELECT status, error, finished_at FROM snapshots')).toEqual([
      { status: 'failed', error: 'Server Error (HTTP 500)', finished_at: '2026-10-24T00:00:00.000Z' }]);
  });

  // Review Focus 3
  it('an unexpected error mid-run marks the snapshot failed instead of leaving it running', async () => {
    const { db, deps } = setup();
    const onProgress = () => { throw new Error('progress sink broke'); };
    await expect(runCheckup({ ...deps, onProgress }, OPTS)).rejects.toThrow('progress sink broke');
    expect(all(db, 'SELECT status, error FROM snapshots')).toEqual([{ status: 'failed', error: 'progress sink broke' }]);
  });

  it('a network error for one repo is recorded for that repo, not as a failed snapshot', async () => {
    const f = fakeFetch(routes());
    const flaky: FetchLike = (url, init) =>
      url.includes('/repos/TETRA2000/c/') ? Promise.reject(new TypeError('fetch failed')) : f(url, init);
    const { db, deps } = setup(flaky);
    const summary = await runCheckup(deps, OPTS);
    expect(summary.errors).toBe(1);
    expect(all(db, 'SELECT status FROM snapshots')).toEqual([{ status: 'complete' }]);
    expect(all(db, `SELECT s.alerts_status, s.alerts_error, s.sbom_status FROM snapshot_repos s JOIN repos r ON r.id = s.repo_id
      WHERE r.full_name = 'TETRA2000/c'`)).toEqual([{ alerts_status: 'error', alerts_error: 'fetch failed', sbom_status: 'unavailable' }]);
  });

  it('a second checkup appends a snapshot and upserts repos', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const run = (r: Record<string, FakeRoute>) =>
      runCheckup({ db, client: new GitHubClient({ token: 't', fetch: fakeFetch(r) }), now: NOW }, OPTS);
    await run(routes());
    const second = await run(routes({ aPushedAt: '2026-10-23T12:00:00Z' }));

    expect(second.snapshotId).toBe(2);
    expect(all(db, 'SELECT id, status FROM snapshots ORDER BY id')).toEqual([{ id: 1, status: 'complete' }, { id: 2, status: 'complete' }]);
    expect(all(db, 'SELECT count(*) AS n FROM repos')).toEqual([{ n: 3 }]);
    expect(all(db, "SELECT pushed_at FROM repos WHERE full_name = 'TETRA2000/a'")).toEqual([{ pushed_at: '2026-10-23T12:00:00Z' }]);
    expect(all(db, 'SELECT snapshot_id, count(*) AS n FROM alerts GROUP BY snapshot_id')).toEqual([
      { snapshot_id: 1, n: 2 }, { snapshot_id: 2, n: 2 }]);
  });

  it('reports progress', async () => {
    const { deps } = setup();
    const onProgress = vi.fn();
    await runCheckup({ ...deps, onProgress }, OPTS);
    expect(onProgress).toHaveBeenCalledTimes(3);
    for (const [p] of onProgress.mock.calls) expect(p.total).toBe(3);
    expect(onProgress.mock.calls.at(-1)![0].done).toBe(3);
    expect(onProgress.mock.calls.map(([p]) => p.repo).sort()).toEqual(['TETRA2000/a', 'TETRA2000/b', 'TETRA2000/c']);
  });

  it('keeps no more requests in flight than the concurrency limit', async () => {
    const f = fakeFetch(routes());
    let inFlight = 0;
    let peak = 0;
    const counting: FetchLike = async (url, init) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try { return await f(url, init); } finally { inFlight--; }
    };
    const { deps } = setup(counting);
    await runCheckup(deps, { ...OPTS, concurrency: 2 });
    expect(peak).toBe(2);
  });

  it('never stores the token', async () => {
    const { db, deps } = setup(fakeFetch(routes()), 't0k3n-secret');
    await runCheckup(deps, OPTS);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => (r as { name: string }).name);
    expect(tables.length).toBeGreaterThan(0);
    const dump = JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM "${t}"`).all()));
    expect(dump).toContain('TETRA2000/a');
    expect(dump).not.toContain('t0k3n-secret');
  });
});
