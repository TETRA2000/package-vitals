import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import {
  createSnapshot, finishOsv, finishSnapshot, insertFindings, recordLatestVersions, recordLockfiles, recordRepoResult,
  sqliteAdvisoryCache, upsertRepo,
} from '../../../src/core/checkup/store.js';
import type { DepEdge, DepGraph, DepNode } from '../../../src/core/lockfiles/graph.js';
import type { ProjectScan } from '../../../src/core/lockfiles/scan.js';
import type { CheckupScope, FindingRecord } from '../../../src/core/types.js';

const prod = (to: number): DepEdge => ({ to, kind: 'prod' });
const dev = (to: number): DepEdge => ({ to, kind: 'dev' });
const node = (id: number, name: string, version: string, registry = true): DepNode => ({ id, name, version, registry, lockDev: null });

const graph = (roots: DepGraph['roots'], nodes: DepNode[], o: Partial<DepGraph> = {}): DepGraph => ({
  format: 'npm-v3', roots, nodes, edges: nodes.map(() => []), unresolved: [], devKnown: true, ...o,
});

const project = (path: string, result: ProjectScan['result'], o: Partial<ProjectScan> = {}): ProjectScan => ({
  path, ecosystem: 'npm', blobSha: `sha-${path}`, result, jsBundler: null, ...o,
});

const SCOPE: CheckupScope = { includeForks: false, includeArchived: false };

let db: Db;
afterEach(() => db.close());

/** A snapshot with its repos recorded, as the Checkup leaves it before Level 1 writes. */
function snapshot(repos: string[], scope = SCOPE, startedAt = '2026-10-24T00:00:00.000Z'): { id: number; repoIds: number[] } {
  const id = createSnapshot(db, { kind: 'user', login: 'TETRA2000' }, startedAt, scope);
  const repoIds = repos.map((name) => {
    const repoId = upsertRepo(db, { fullName: `TETRA2000/${name}`, isPrivate: false, isFork: false, isArchived: false,
      defaultBranch: 'main', pushedAt: null });
    recordRepoResult(db, id, repoId, { status: 'ok', alerts: [] }, { status: 'unavailable', message: 'Not Found (HTTP 404)' });
    return repoId;
  });
  return { id, repoIds };
}

const all = (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params);

const finding = (o: Partial<FindingRecord> = {}): FindingRecord => ({
  alertNumber: null, source: 'osv', ecosystem: 'npm', packageName: 'mkdirp', manifestPath: 'package-lock.json',
  advisoryId: 'GHSA-mkdirp', cveId: null, severity: 'medium', severitySource: 'advisory', summary: 'mkdirp advisory',
  vulnerableRange: null, firstPatched: null, createdAt: null, scope: null, githubRelationship: null,
  installedVersions: ['0.5.1'], relationship: 'direct', chains: [], chainCount: 1, lockfileRead: true, lockfileDevOnly: false,
  jsBundler: null, tier: null, upgrades: null, ...o,
});

describe('recordLockfiles', () => {
  it('records lockfiles, their status, and direct dependencies', () => {
    db = openDatabase(':memory:');
    const { id, repoIds: [web, api] } = snapshot(['web', 'api']);
    // vitest is dev-only (two copies at one version); typescript is dev in one root and prod in the other.
    const npm = graph(
      [
        { label: 'web', path: '.', edges: [prod(0), dev(1), dev(2), prod(3)] },
        { label: 'docs', path: 'docs', edges: [prod(2), dev(5)] },
      ],
      [node(0, 'left-pad', '1.3.0'), node(1, 'vitest', '2.0.0'), node(2, 'typescript', '5.6.0'),
        node(3, 'my-git-dep', '1.0.0', false), node(4, 'minimist', '1.2.8'), node(5, 'vitest', '2.0.0')],
      { edges: [[prod(4)], [], [], [], [], []] },
    );
    const gems = graph([{ label: 'Gemfile.lock', path: '.', edges: [prod(0)] }], [node(0, 'rake', '13.0.6')],
      { format: 'bundler', devKnown: false });
    recordLockfiles(db, id, web!, {
      status: 'ok', error: null, truncated: true, projects: [
        project('package-lock.json', { status: 'ok', graph: npm }, { jsBundler: 'vite (dependency)' }),
        project('Gemfile.lock', { status: 'ok', graph: gems }, { ecosystem: 'rubygems' }),
        project('old/package-lock.json', { status: 'unsupported', format: 'npm-v9', message: "npm lockfile version 9 isn't supported yet." }),
        project('broken/yarn.lock', { status: 'error', message: "Couldn't read this lockfile." }),
      ],
    });
    recordLockfiles(db, id, api!, { status: 'error', error: 'Not Found (HTTP 404)', truncated: false, projects: [] });

    expect(all('SELECT repo_id, lockfiles_status, lockfiles_error, tree_truncated FROM snapshot_repos ORDER BY repo_id')).toEqual([
      { repo_id: web, lockfiles_status: 'ok', lockfiles_error: null, tree_truncated: 1 },
      { repo_id: api, lockfiles_status: 'error', lockfiles_error: 'Not Found (HTTP 404)', tree_truncated: 0 },
    ]);
    expect(all(`SELECT snapshot_id, repo_id, path, ecosystem, format, status, error, blob_sha, complete, js_bundler
      FROM lockfiles ORDER BY id`)).toEqual([
      { snapshot_id: id, repo_id: web, path: 'package-lock.json', ecosystem: 'npm', format: 'npm-v3', status: 'ok', error: null,
        blob_sha: 'sha-package-lock.json', complete: 1, js_bundler: 'vite (dependency)' },
      { snapshot_id: id, repo_id: web, path: 'Gemfile.lock', ecosystem: 'rubygems', format: 'bundler', status: 'ok', error: null,
        blob_sha: 'sha-Gemfile.lock', complete: 0, js_bundler: null },
      { snapshot_id: id, repo_id: web, path: 'old/package-lock.json', ecosystem: 'npm', format: 'npm-v9', status: 'unsupported',
        error: "npm lockfile version 9 isn't supported yet.", blob_sha: 'sha-old/package-lock.json', complete: null, js_bundler: null },
      { snapshot_id: id, repo_id: web, path: 'broken/yarn.lock', ecosystem: 'npm', format: null, status: 'error',
        error: "Couldn't read this lockfile.", blob_sha: 'sha-broken/yarn.lock', complete: null, js_bundler: null },
    ]);
    expect(all(`SELECT l.path, d.name, d.version, d.dev, d.latest, d.lookup, d.outdated
      FROM direct_dependencies d JOIN lockfiles l ON l.id = d.lockfile_id ORDER BY l.id, d.name`)).toEqual([
      { path: 'package-lock.json', name: 'left-pad', version: '1.3.0', dev: 0, latest: null, lookup: 'skipped', outdated: null },
      { path: 'package-lock.json', name: 'typescript', version: '5.6.0', dev: 0, latest: null, lookup: 'skipped', outdated: null },
      { path: 'package-lock.json', name: 'vitest', version: '2.0.0', dev: 1, latest: null, lookup: 'skipped', outdated: null },
      { path: 'Gemfile.lock', name: 'rake', version: '13.0.6', dev: 0, latest: null, lookup: 'skipped', outdated: null },
    ]);
  });
});

describe('recordLatestVersions', () => {
  it('stores latest versions and outdated flags', () => {
    db = openDatabase(':memory:');
    /** A lockfile whose root declares each of `deps` for runtime. */
    const lockfile = (path: string, deps: [string, string][], ecosystem: ProjectScan['ecosystem'] = 'npm') => {
      const g = graph([{ label: 'web', path: '.', edges: deps.map((_, i) => prod(i)) }], deps.map(([n, v], i) => node(i, n, v)));
      return project(path, { status: 'ok', graph: g }, { ecosystem });
    };
    const ok = (projects: ProjectScan[]) => ({ status: 'ok' as const, error: null, truncated: false, projects });
    const { id, repoIds: [web, api] } = snapshot(['web', 'api']);
    recordLockfiles(db, id, web!, ok([
      lockfile('package-lock.json', [['left-pad', '1.3.0'], ['vitest', '2.0.0'], ['typescript', '5.6.0']]),
      lockfile('Gemfile.lock', [['left-pad', '1.0.0'], ['rake', '13.0.6']], 'rubygems'),
    ]));
    recordLockfiles(db, id, api!, ok([lockfile('package-lock.json', [['left-pad', '1.0.0']])]));
    const later = snapshot(['web']);
    recordLockfiles(db, later.id, later.repoIds[0]!, ok([lockfile('package-lock.json', [['left-pad', '1.0.0']])]));

    recordLatestVersions(db, id, [
      { ecosystem: 'npm', name: 'left-pad', lookup: { status: 'ok', latest: '1.3.0' } },
      { ecosystem: 'npm', name: 'vitest', lookup: { status: 'error', message: 'Service Unavailable (HTTP 503)' } },
      { ecosystem: 'npm', name: 'typescript', lookup: { status: 'ok', latest: 'next' } },
      { ecosystem: 'rubygems', name: 'rake', lookup: { status: 'not_found' } },
    ]);

    expect(all(`SELECT l.id AS lockfile, d.name, d.version, d.latest, d.lookup, d.outdated
      FROM direct_dependencies d JOIN lockfiles l ON l.id = d.lockfile_id ORDER BY l.id, d.name`)).toEqual([
      // web's package-lock.json
      { lockfile: 1, name: 'left-pad', version: '1.3.0', latest: '1.3.0', lookup: 'ok', outdated: 0 },
      { lockfile: 1, name: 'typescript', version: '5.6.0', latest: 'next', lookup: 'ok', outdated: null },
      { lockfile: 1, name: 'vitest', version: '2.0.0', latest: null, lookup: 'error', outdated: null },
      // web's Gemfile.lock: another ecosystem's left-pad is untouched.
      { lockfile: 2, name: 'left-pad', version: '1.0.0', latest: null, lookup: 'skipped', outdated: null },
      { lockfile: 2, name: 'rake', version: '13.0.6', latest: null, lookup: 'not_found', outdated: null },
      // api's package-lock.json
      { lockfile: 3, name: 'left-pad', version: '1.0.0', latest: '1.3.0', lookup: 'ok', outdated: 1 },
      // the later snapshot's is untouched too.
      { lockfile: 4, name: 'left-pad', version: '1.0.0', latest: null, lookup: 'skipped', outdated: null },
    ]);
  });
});

describe('insertFindings', () => {
  it('stores findings with their JSON fields', () => {
    db = openDatabase(':memory:');
    const { id, repoIds: [web] } = snapshot(['web']);
    insertFindings(db, id, web!, [
      finding({
        alertNumber: 41, source: 'both', packageName: 'minimist', advisoryId: 'GHSA-xvch-5gv4-984h', cveId: 'CVE-2021-44906',
        severity: 'critical', summary: 'Prototype Pollution in minimist', vulnerableRange: '< 0.2.4', firstPatched: '0.2.4',
        createdAt: '2022-03-18T00:00:00Z', scope: 'development', githubRelationship: 'transitive',
        installedVersions: ['0.0.8', '1.2.5'], relationship: 'transitive',
        chains: [{ root: 'web', links: [{ name: 'mkdirp', version: '0.5.1' }, { name: 'minimist', version: '0.0.8' }], dev: true }],
        chainCount: 12, lockfileDevOnly: true, jsBundler: 'vite (dependency)', tier: 'not_shipped',
        upgrades: [{ name: 'mkdirp', from: '0.5.1', to: '1.0.0' }],
      }),
      finding({ severitySource: 'assumed', installedVersions: [], relationship: null, chainCount: 0, lockfileRead: false,
        lockfileDevOnly: null }),
    ], '2026-10-24T00:00:00.000Z');

    expect(all('SELECT * FROM findings ORDER BY id')).toEqual([
      {
        id: 1, snapshot_id: id, repo_id: web, alert_number: 41, source: 'both', ecosystem: 'npm', package_name: 'minimist',
        manifest_path: 'package-lock.json', advisory_id: 'GHSA-xvch-5gv4-984h', cve_id: 'CVE-2021-44906', severity: 'critical',
        severity_source: 'advisory', summary: 'Prototype Pollution in minimist', vulnerable_range: '< 0.2.4', first_patched: '0.2.4',
        created_at: '2022-03-18T00:00:00Z', scope: 'development', github_relationship: 'transitive',
        installed_versions: '["0.0.8","1.2.5"]', relationship: 'transitive',
        chains: '[{"root":"web","links":[{"name":"mkdirp","version":"0.5.1"},{"name":"minimist","version":"0.0.8"}],"dev":true}]',
        chain_count: 12, lockfile_read: 1, lockfile_dev_only: 1, js_bundler: 'vite (dependency)', tier: 'not_shipped',
        upgrades: '[{"name":"mkdirp","from":"0.5.1","to":"1.0.0"}]',
      },
      {
        id: 2, snapshot_id: id, repo_id: web, alert_number: null, source: 'osv', ecosystem: 'npm', package_name: 'mkdirp',
        manifest_path: 'package-lock.json', advisory_id: 'GHSA-mkdirp', cve_id: null, severity: 'medium',
        severity_source: 'assumed', summary: 'mkdirp advisory', vulnerable_range: null, first_patched: null,
        created_at: '2026-10-24T00:00:00.000Z', scope: null, github_relationship: null,
        installed_versions: '[]', relationship: null, chains: '[]', chain_count: 0, lockfile_read: 0, lockfile_dev_only: null,
        js_bundler: null, tier: null, upgrades: null,
      },
    ]);
  });

  it('an OSV-only finding keeps its first-seen date in a later snapshot', () => {
    db = openDatabase(':memory:');
    const dates = (snapshotId: number) =>
      all('SELECT created_at AS createdAt FROM findings WHERE snapshot_id = ? ORDER BY id', snapshotId)
        .map((r) => (r as { createdAt: string }).createdAt);

    const first = snapshot(['web'], SCOPE, '2026-10-01T00:00:00.000Z');
    insertFindings(db, first.id, first.repoIds[0]!, [
      finding(),
      // Dependabot's date for an advisory doesn't pass to an OSV-only finding.
      finding({ alertNumber: 7, source: 'dependabot', advisoryId: 'GHSA-other', createdAt: '2025-01-01T00:00:00Z' }),
    ], '2026-10-01T00:00:00.000Z');
    finishSnapshot(db, first.id, 'complete', '2026-10-01T01:00:00.000Z');
    // A failed snapshot in between is passed over.
    const failed = snapshot(['web'], SCOPE, '2026-10-05T00:00:00.000Z');
    insertFindings(db, failed.id, failed.repoIds[0]!, [finding({ createdAt: '2026-10-05T00:00:00.000Z' })], '2026-10-05T00:00:00.000Z');
    finishSnapshot(db, failed.id, 'failed', '2026-10-05T01:00:00.000Z');

    const second = snapshot(['web', 'api'], SCOPE, '2026-10-08T00:00:00.000Z');
    insertFindings(db, second.id, second.repoIds[0]!, [
      finding(),
      finding({ advisoryId: 'GHSA-other' }),
      finding({ manifestPath: 'docs/package-lock.json' }),
      finding({ packageName: 'mkdirp-classic' }),
      finding({ ecosystem: 'rubygems' }),
    ], '2026-10-08T00:00:00.000Z');
    insertFindings(db, second.id, second.repoIds[1]!, [finding()], '2026-10-08T00:00:00.000Z');
    finishSnapshot(db, second.id, 'complete', '2026-10-08T01:00:00.000Z');
    expect(dates(second.id)).toEqual([
      '2026-10-01T00:00:00.000Z', // the same finding
      '2026-10-08T00:00:00.000Z', // another advisory
      '2026-10-08T00:00:00.000Z', // another manifest
      '2026-10-08T00:00:00.000Z', // another package
      '2026-10-08T00:00:00.000Z', // another ecosystem
      '2026-10-08T00:00:00.000Z', // another repo
    ]);

    // A snapshot of another scope starts over.
    const withForks = snapshot(['web'], { includeForks: true, includeArchived: false }, '2026-10-15T00:00:00.000Z');
    insertFindings(db, withForks.id, withForks.repoIds[0]!, [finding()], '2026-10-15T00:00:00.000Z');
    expect(dates(withForks.id)).toEqual(['2026-10-15T00:00:00.000Z']);
  });
});

describe('finishOsv', () => {
  it('records the OSV status', () => {
    db = openDatabase(':memory:');
    const ok = snapshot([]).id;
    const failed = snapshot([]).id;
    finishOsv(db, ok, { status: 'ok' });
    finishOsv(db, failed, { status: 'error', message: 'Service Unavailable (HTTP 503)' });
    expect(all('SELECT id, osv_status, osv_error FROM snapshots ORDER BY id')).toEqual([
      { id: ok, osv_status: 'ok', osv_error: null },
      { id: failed, osv_status: 'error', osv_error: 'Service Unavailable (HTTP 503)' },
    ]);
  });
});

describe('sqliteAdvisoryCache', () => {
  it('the advisory cache round-trips', () => {
    db = openDatabase(':memory:');
    let now = new Date('2026-10-24T00:00:00.000Z');
    const cache = sqliteAdvisoryCache(db, () => now);
    expect(cache.get('GHSA-xvch-5gv4-984h')).toBeNull();

    cache.put('GHSA-xvch-5gv4-984h', '2024-01-01T00:00:00Z', '{"id":"GHSA-xvch-5gv4-984h"}');
    expect(cache.get('GHSA-xvch-5gv4-984h')).toEqual({ modified: '2024-01-01T00:00:00Z', json: '{"id":"GHSA-xvch-5gv4-984h"}' });

    now = new Date('2026-10-25T00:00:00.000Z');
    cache.put('GHSA-xvch-5gv4-984h', '2025-06-01T00:00:00Z', '{"id":"GHSA-xvch-5gv4-984h","v":2}');
    expect(cache.get('GHSA-xvch-5gv4-984h')).toEqual({ modified: '2025-06-01T00:00:00Z', json: '{"id":"GHSA-xvch-5gv4-984h","v":2}' });
    expect(all('SELECT id, fetched_at FROM osv_advisories')).toEqual([
      { id: 'GHSA-xvch-5gv4-984h', fetched_at: '2026-10-25T00:00:00.000Z' },
    ]);
  });
});
