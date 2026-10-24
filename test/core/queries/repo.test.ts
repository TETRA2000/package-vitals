import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { repoAlerts } from '../../../src/core/queries/repo.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
afterEach(() => db.close());

describe('repoAlerts', () => {
  it('sorts open alerts by severity, then oldest first, and groups dismissed ones', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'other', alerts: [{ severity: 'critical' }] },
      { name: 'a', alerts: [
        { number: 10, severity: 'high', createdAt: '2024-01-01T00:00:00Z' },
        { number: 11, severity: 'critical', createdAt: '2025-01-01T00:00:00Z' },
        { number: 12, severity: 'critical', createdAt: '2023-01-01T00:00:00Z', firstPatched: null, cveId: null },
        { number: 13, state: 'dismissed', dismissedReason: 'tolerable_risk', dismissedComment: 'Package Vitals: dev only' },
        { number: 14, state: 'auto_dismissed' },
        { number: 15, state: 'fixed' },
      ] },
    ] });
    const view = repoAlerts(db, id, 'TETRA2000/a')!;
    expect(view).toMatchObject({ fullName: 'TETRA2000/a', alertsStatus: 'ok', alertsError: null });
    expect(view.repoId).toEqual(expect.any(Number));
    expect(view.open.map((a) => a.number)).toEqual([12, 11, 10]);
    expect(view.dismissed.map((a) => a.number)).toEqual([13, 14]);
    expect(view.open[0]).toEqual({ number: 12, state: 'open', ecosystem: 'npm', packageName: 'pkg',
      manifestPath: 'package-lock.json', scope: 'runtime', relationship: 'direct', ghsaId: 'GHSA-seed-4', cveId: null,
      severity: 'critical', summary: 'Seeded advisory', vulnerableRange: null, firstPatched: null,
      createdAt: '2023-01-01T00:00:00Z', dismissedAt: null, dismissedReason: null, dismissedComment: null, fixedAt: null });
    expect(view.dismissed[0]).toMatchObject({ dismissedReason: 'tolerable_risk', dismissedComment: 'Package Vitals: dev only' });
  });

  it('returns null for a repo that is not in the snapshot', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a' }] });
    expect(repoAlerts(db, id, 'TETRA2000/zzz')).toBeNull();
  });

  it('shows a not-monitored repo with empty lists', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'b', alertsStatus: 'not_monitored' }] });
    expect(repoAlerts(db, id, 'TETRA2000/b')).toMatchObject({ alertsStatus: 'not_monitored', alertsError: null, open: [], dismissed: [] });
  });
});
