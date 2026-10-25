import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { countFindings, findingEcosystems, getFinding, listFindings, snapshotRepos }
  from '../../../src/core/queries/findings.js';
import type { FindingFilter } from '../../../src/core/types.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
afterEach(() => db.close());

const repoId = (name: string) =>
  (db.prepare('SELECT id FROM repos WHERE full_name = ?').get(`TETRA2000/${name}`) as { id: number }).id;
const all: FindingFilter = { severities: ['critical', 'high', 'medium', 'low'], repoId: null, ecosystem: null };

function seed(): number {
  db = openDatabase(':memory:');
  return seedSnapshot(db, { repos: [
    { name: 'a', alerts: [
      { severity: 'high', createdAt: '2020-01-01T00:00:00Z' },
      { severity: 'critical', createdAt: '2024-01-01T00:00:00Z' },
      { severity: 'critical', createdAt: '2022-01-01T00:00:00Z' },
      { severity: 'critical', state: 'dismissed' },
    ] },
    { name: 'b', alerts: [{ severity: 'critical', createdAt: '2023-01-01T00:00:00Z' }] },
  ] });
}

describe('finding queries', () => {
  it('lists open alerts only, critical first, then oldest first', () => {
    const id = seed();
    const rows = listFindings(db, id, all);
    expect(rows.map((r) => [r.fullName, r.severity, r.createdAt.slice(0, 4)])).toEqual([
      ['TETRA2000/a', 'critical', '2022'], ['TETRA2000/b', 'critical', '2023'],
      ['TETRA2000/a', 'critical', '2024'], ['TETRA2000/a', 'high', '2020'],
    ]);
    expect(rows.every((r) => r.triage === 'not_triaged')).toBe(true);
    expect(rows[0]).toMatchObject({ snapshotId: id, repoId: repoId('a'), packageName: 'pkg', ecosystem: 'npm' });
  });

  it('filters by severity, repo, and ecosystem', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'a', alerts: [{ severity: 'high' }, { severity: 'low', ecosystem: 'pip' }] },
      { name: 'b', alerts: [{ severity: 'high', ecosystem: 'pip' }] },
    ] });
    expect(listFindings(db, id, { ...all, severities: ['low'] })).toHaveLength(1);
    expect(listFindings(db, id, { ...all, severities: [] })).toHaveLength(0);
    expect(listFindings(db, id, { ...all, repoId: repoId('b') }).map((r) => r.fullName)).toEqual(['TETRA2000/b']);
    expect(listFindings(db, id, { ...all, ecosystem: 'pip' })).toHaveLength(2);
    expect(listFindings(db, id, { severities: ['high'], repoId: repoId('b'), ecosystem: 'pip' })).toHaveLength(1);
  });

  it('getFinding returns the detail, or null for a closed or unknown alert', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a', alerts: [
      { severity: 'high', cveId: null, firstPatched: null, vulnerableRange: '< 2.0.0' },
      { state: 'fixed' },
    ] }] });
    const key = { snapshotId: id, repoId: repoId('a'), number: 1 };
    expect(getFinding(db, key)).toMatchObject({ ...key, fullName: 'TETRA2000/a', cveId: null, firstPatched: null,
      vulnerableRange: '< 2.0.0', scope: 'runtime', relationship: 'direct', triage: 'not_triaged' });
    expect(getFinding(db, { ...key, number: 2 })).toBeNull();
    expect(getFinding(db, { ...key, number: 99 })).toBeNull();
  });

  it('countFindings counts criticals regardless of the severity filter', () => {
    const id = seed();
    const a = repoId('a');
    expect(countFindings(db, id, { severities: ['high'], repoId: a, ecosystem: null })).toEqual({ critical: 2, matching: 1 });
    expect(countFindings(db, id, { ...all, ecosystem: 'pip' })).toEqual({ critical: 0, matching: 0 });
    expect(countFindings(db, id, all)).toEqual({ critical: 3, matching: 4 });
  });

  it('findingEcosystems and snapshotRepos list what the filters offer', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'b', alerts: [{ ecosystem: 'pip' }, { ecosystem: 'npm' }, { ecosystem: 'npm' }, { ecosystem: 'go', state: 'fixed' }] },
      { name: 'a', alertsStatus: 'not_monitored' },
    ] });
    expect(findingEcosystems(db, id)).toEqual(['npm', 'pip']);
    expect(snapshotRepos(db, id)).toEqual([
      { id: repoId('a'), fullName: 'TETRA2000/a' }, { id: repoId('b'), fullName: 'TETRA2000/b' }]);
  });
});
