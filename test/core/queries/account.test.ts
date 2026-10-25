import { describe, it, expect, afterEach } from 'vitest';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { alertStateCounts, criticalTreatmentPlan, monitoringSummary, openAlertAges, openSeverityCounts, repoCards, worstRepos }
  from '../../../src/core/queries/account.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
afterEach(() => db.close());

const repoId = (name: string) =>
  (db.prepare('SELECT id FROM repos WHERE full_name = ?').get(`TETRA2000/${name}`) as { id: number }).id;

describe('account queries', () => {
  it('openSeverityCounts counts only open alerts', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'a', alerts: [{ severity: 'critical' }, { severity: 'critical' }, { severity: 'critical', state: 'dismissed' }] },
      { name: 'b', alerts: [{ severity: 'high', state: 'fixed' }, { severity: 'low' }] },
    ] });
    expect(openSeverityCounts(db, id)).toEqual({ critical: 2, high: 0, medium: 0, low: 1 });
    expect(openSeverityCounts(db, id, repoId('a'))).toEqual({ critical: 2, high: 0, medium: 0, low: 0 });
  });

  it('alertStateCounts keeps dismissed and fixed apart', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a', alerts: [
      { state: 'open' }, { state: 'open' }, { state: 'dismissed' }, { state: 'auto_dismissed' },
      { state: 'fixed' }, { state: 'fixed' }, { state: 'fixed' }] }] });
    expect(alertStateCounts(db, id)).toEqual({ open: 2, dismissed: 1, autoDismissed: 1, fixed: 3 });
  });

  it('monitoringSummary', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'b', alertsStatus: 'not_monitored' },
      { name: 'a', alerts: [{ state: 'open' }] },
      { name: 'c', alertsStatus: 'error', alertsError: 'Not Found (HTTP 404)' },
      { name: 'd', alerts: [{ state: 'fixed' }] },
    ] });
    expect(monitoringSummary(db, id)).toEqual({ checked: 4, monitored: 2, notMonitored: ['TETRA2000/b'],
      errors: [{ repo: 'TETRA2000/c', message: 'Not Found (HTTP 404)' }], withOpenAlerts: 1 });
  });

  it('worstRepos order', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'x', alerts: [{ severity: 'critical', createdAt: '2024-05-05T00:00:00Z' }, { severity: 'critical' },
        { severity: 'high', createdAt: '2023-01-01T00:00:00Z', state: 'fixed' }, { severity: 'high' }] },
      { name: 'y', alerts: [{ severity: 'critical' }, { severity: 'critical' }, { severity: 'high' }, { severity: 'high' }, { severity: 'high' }] },
      { name: 'z', alerts: Array.from({ length: 9 }, () => ({ severity: 'high' as const })) },
      { name: 'clean', alerts: [{ severity: 'critical', state: 'fixed' }] },
    ] });
    const worst = worstRepos(db, id, 10);
    expect(worst.map((r) => r.fullName)).toEqual(['TETRA2000/y', 'TETRA2000/x', 'TETRA2000/z']);
    expect(worst[1]).toEqual({ fullName: 'TETRA2000/x', critical: 2, high: 1, open: 3, oldestOpenAlert: '2024-05-05T00:00:00Z' });
    expect(worstRepos(db, id, 1).map((r) => r.fullName)).toEqual(['TETRA2000/y']);
  });

  it('worstRepos breaks ties by name', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'q', alerts: [{}] }, { name: 'p', alerts: [{}] }] });
    expect(worstRepos(db, id, 10).map((r) => r.fullName)).toEqual(['TETRA2000/p', 'TETRA2000/q']);
  });

  it('criticalTreatmentPlan', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'a', alerts: [
        { severity: 'critical', packageName: 'form-data', firstPatched: '4.0.4' },
        { severity: 'critical', packageName: 'form-data', firstPatched: '2.5.4' },
        { severity: 'critical', packageName: 'tar' },
        { severity: 'high', packageName: 'lodash', firstPatched: '4.17.21' },
      ] },
      { name: 'b', alerts: [
        { severity: 'critical', packageName: 'form-data', firstPatched: '4.0.4' },
        { severity: 'critical', packageName: 'tar', state: 'dismissed', firstPatched: '6.2.1' },
      ] },
    ] });
    expect(criticalTreatmentPlan(db, id, 10)).toEqual([
      { ecosystem: 'npm', packageName: 'form-data', repoCount: 2, patchedVersions: ['2.5.4', '4.0.4'] },
      { ecosystem: 'npm', packageName: 'tar', repoCount: 1, patchedVersions: [] },
    ]);
    expect(criticalTreatmentPlan(db, id, 1)).toHaveLength(1);
  });

  it('openAlertAges', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a', alerts: [
      { createdAt: '2026-10-10T00:00:00Z' },
      { createdAt: '2026-08-01T00:00:00Z' },
      { createdAt: '2025-12-01T00:00:00Z', severity: 'critical' },
      { createdAt: '2025-01-01T00:00:00Z' },
      { createdAt: '2019-05-01T00:00:00Z' },
      { createdAt: '2019-05-01T00:00:00Z', severity: 'critical', state: 'fixed' },
    ] }] });
    expect(openAlertAges(db, id, new Date('2026-10-24T00:00:00Z'))).toEqual([
      { bucket: 'under-30-days', all: 1, critical: 0 },
      { bucket: '30-90-days', all: 1, critical: 0 },
      { bucket: '90-365-days', all: 1, critical: 1 },
      { bucket: '1-2-years', all: 1, critical: 0 },
      { bucket: 'over-2-years', all: 1, critical: 0 },
    ]);
  });

  it('openAlertAges always returns five rows', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [] });
    expect(openAlertAges(db, id, new Date('2026-10-24T00:00:00Z')).map((r) => [r.bucket, r.all])).toEqual([
      ['under-30-days', 0], ['30-90-days', 0], ['90-365-days', 0], ['1-2-years', 0], ['over-2-years', 0]]);
  });

  it('repoCards puts the worst repos first, then repos without data, then clean repos', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [
      { name: 'e' },
      { name: 'd', alertsStatus: 'not_monitored' },
      { name: 'c', alertsStatus: 'error', alertsError: 'Bad Gateway (HTTP 502)' },
      { name: 'b', alerts: [{ severity: 'high' }, { severity: 'high' }] },
      { name: 'a', alerts: [{ severity: 'critical', createdAt: '2022-02-02T00:00:00Z' }, { severity: 'critical', state: 'fixed' }] },
    ] });
    const cards = repoCards(db, id);
    expect(cards.map((c) => c.fullName)).toEqual(['a', 'b', 'c', 'd', 'e'].map((n) => `TETRA2000/${n}`));
    expect(cards[0]).toMatchObject({ repoId: repoId('a'), status: 'ok', error: null, critical: 1, high: 0, open: 1,
      oldestOpenAlert: '2022-02-02T00:00:00Z' });
    expect(cards[1]).toMatchObject({ critical: 0, high: 2, open: 2 });
    expect(cards[2]).toMatchObject({ status: 'error', error: 'Bad Gateway (HTTP 502)', open: 0, oldestOpenAlert: null });
    expect(cards[3]).toMatchObject({ status: 'not_monitored', error: null });
    expect(cards[4]).toMatchObject({ status: 'ok', open: 0, critical: 0, high: 0 });
  });

  it('criticalTreatmentPlan returns every row without a limit', () => {
    db = openDatabase(':memory:');
    const id = seedSnapshot(db, { repos: [{ name: 'a', alerts: [
      { severity: 'critical', packageName: 'p1' }, { severity: 'critical', packageName: 'p2' },
      { severity: 'critical', packageName: 'p3' }] }] });
    expect(criticalTreatmentPlan(db, id)).toHaveLength(3);
    expect(criticalTreatmentPlan(db, id, 2)).toHaveLength(2);
  });
});
