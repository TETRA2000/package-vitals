import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../src/core/db/database.js';
import { seedSnapshot } from './seed.js';

let db: Db;
afterEach(() => db.close());

const all = (sql: string) => db.prepare(sql).all();

describe('seedSnapshot', () => {
  it('stores findings, lockfiles, and Level 1 status', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, {
      osv: { error: 'Service Unavailable (HTTP 503)' },
      repos: [
        {
          name: 'web',
          alerts: [{}, { state: 'dismissed' }, { severity: 'critical' }],
          findingOverrides: { 3: { tier: 'not_shipped', lockfileRead: true, lockfileDevOnly: true } },
          osvFindings: [{ packageName: 'mkdirp' }],
          lockfiles: [
            { path: 'package-lock.json', status: 'ok', format: 'npm-v3', directDependencies: [
              { name: 'mkdirp', version: '0.5.1', latest: '3.0.1', outdated: true },
              { name: 'left-pad', version: '1.3.0' },
            ] },
            { path: 'api/Gemfile.lock', status: 'error', error: "Couldn't read this lockfile." },
          ],
        },
        { name: 'api', alertsStatus: 'not_monitored' },
        { name: 'docs', lockfilesStatus: 'error' },
      ],
    });

    expect(all('SELECT osv_status, osv_error FROM snapshots')).toEqual([
      { osv_status: 'error', osv_error: 'Service Unavailable (HTTP 503)' },
    ]);
    expect(all('SELECT repo_id, lockfiles_status FROM snapshot_repos ORDER BY repo_id')).toEqual([
      { repo_id: 1, lockfiles_status: 'ok' }, { repo_id: 2, lockfiles_status: 'none' }, { repo_id: 3, lockfiles_status: 'error' },
    ]);
    expect(all(`SELECT alert_number, source, package_name, advisory_id, severity, created_at, tier, lockfile_dev_only
      FROM findings ORDER BY id`)).toEqual([
      { alert_number: 1, source: 'dependabot', package_name: 'pkg', advisory_id: 'GHSA-seed-1', severity: 'high',
        created_at: '2026-01-01T00:00:00Z', tier: null, lockfile_dev_only: null },
      { alert_number: 3, source: 'dependabot', package_name: 'pkg', advisory_id: 'GHSA-seed-3', severity: 'critical',
        created_at: '2026-01-01T00:00:00Z', tier: 'not_shipped', lockfile_dev_only: 1 },
      { alert_number: null, source: 'osv', package_name: 'mkdirp', advisory_id: 'GHSA-osv-1', severity: 'high',
        created_at: '2026-01-01T00:00:00Z', tier: null, lockfile_dev_only: null },
    ]);
    expect(all('SELECT path, ecosystem, format, status, error, blob_sha, complete FROM lockfiles ORDER BY id')).toEqual([
      { path: 'package-lock.json', ecosystem: 'npm', format: 'npm-v3', status: 'ok', error: null, blob_sha: 'seed', complete: 1 },
      { path: 'api/Gemfile.lock', ecosystem: 'rubygems', format: null, status: 'error', error: "Couldn't read this lockfile.",
        blob_sha: 'seed', complete: null },
    ]);
    expect(all('SELECT name, version, dev, latest, lookup, outdated FROM direct_dependencies ORDER BY name')).toEqual([
      { name: 'left-pad', version: '1.3.0', dev: 0, latest: null, lookup: 'skipped', outdated: null },
      { name: 'mkdirp', version: '0.5.1', dev: 0, latest: '3.0.1', lookup: 'ok', outdated: 1 },
    ]);
  });

  it('a snapshot without Level 1 has no OSV or lockfile status', () => {
    db = openDatabase(':memory:');
    seedSnapshot(db, { osv: null, repos: [{ name: 'web', alerts: [{}] }] });
    expect(all('SELECT osv_status FROM snapshots')).toEqual([{ osv_status: null }]);
    expect(all('SELECT lockfiles_status FROM snapshot_repos')).toEqual([{ lockfiles_status: null }]);
    expect(all('SELECT source FROM findings')).toEqual([{ source: 'dependabot' }]);
  });
});
