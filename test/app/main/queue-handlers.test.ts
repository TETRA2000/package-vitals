import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { queueHandlers } from '../../../src/app/main/handlers/queue.js';
import { IpcInputError } from '../../../src/app/main/validate.js';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import type { FindingFilter } from '../../../src/core/types.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => db.close());

const handlers = (checkupRunning = false) => queueHandlers({ db, checkupRunning: () => checkupRunning });
const repoId = (name: string) =>
  (db.prepare('SELECT id FROM repos WHERE full_name = ?').get(`TETRA2000/${name}`) as { id: number }).id;
const all: FindingFilter = { severities: ['critical', 'high', 'medium', 'low'], repoId: null, ecosystem: null };

/** The message of the IpcInputError that `p` rejects with. Any other outcome fails the test. */
async function inputError(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
  expect(err).toBeInstanceOf(IpcInputError);
  return (err as IpcInputError).message;
}

describe('queue handlers', () => {
  it('getOverview with no complete snapshot', async () => {
    seedSnapshot(db, { status: 'failed', repos: [{ name: 'a', alerts: [{}] }] });
    seedSnapshot(db, { status: 'running', repos: [{ name: 'b', alerts: [{}] }] });
    expect(await handlers().getOverview(undefined))
      .toEqual({ snapshot: null, monitoring: null, repos: [], ecosystems: [], checkupRunning: false });
  });

  it('getOverview uses the latest complete snapshot, not a later running one', async () => {
    seedSnapshot(db, { repos: [{ name: 'old', alerts: [{ ecosystem: 'maven' }] }] });
    const id = seedSnapshot(db, { finishedAt: '2026-10-24T05:07:09.000Z', repos: [
      { name: 'a', alerts: [{ ecosystem: 'pip' }, { ecosystem: 'npm' }, { ecosystem: 'rubygems', state: 'fixed' }] },
      { name: 'b', alertsStatus: 'not_monitored' },
    ] });
    seedSnapshot(db, { status: 'running', repos: [{ name: 'c', alerts: [{ ecosystem: 'go' }] }] });

    expect(await handlers(true).getOverview(undefined)).toEqual({
      snapshot: { id, ownerLogin: 'TETRA2000', finishedAt: '2026-10-24T05:07:09.000Z', includeForks: false, includeArchived: false },
      monitoring: { checked: 2, monitored: 1, notMonitored: ['TETRA2000/b'], errors: [], withOpenAlerts: 1 },
      repos: [{ id: repoId('a'), fullName: 'TETRA2000/a' }, { id: repoId('b'), fullName: 'TETRA2000/b' }],
      ecosystems: ['npm', 'pip'],
      checkupRunning: true,
    });
  });

  it('listFindings refuses a snapshot that is not complete', async () => {
    const failed = seedSnapshot(db, { status: 'failed', repos: [{ name: 'a', alerts: [{}] }] });
    const running = seedSnapshot(db, { status: 'running', repos: [{ name: 'a', alerts: [{}] }] });
    for (const snapshotId of [failed, running, 99]) {
      expect(await inputError(handlers().listFindings({ snapshotId, filter: all })))
        .toBe(`Snapshot ${snapshotId} is not complete.`);
    }
  });

  it('listFindings returns rows with counts, leaving later counts null', async () => {
    const snapshotId = seedSnapshot(db, { repos: [
      { name: 'a', alerts: [{ severity: 'critical' }, { severity: 'critical' }, { severity: 'high' }] },
      { name: 'b', alerts: [{ severity: 'critical' }, { severity: 'low' }, { severity: 'high', state: 'dismissed' }] },
    ] });
    const { rows, counts } = await handlers().listFindings({ snapshotId, filter: { ...all, severities: ['high', 'low'] } });
    expect(rows.map((r) => [r.fullName, r.severity, r.triage])).toEqual([
      ['TETRA2000/a', 'high', 'not_triaged'], ['TETRA2000/b', 'low', 'not_triaged'],
    ]);
    expect(counts).toEqual({ critical: 3, notTriaged: 2, devOnly: null, reachable: null, uncertain: null });
  });

  it('getFinding returns null for an unknown key and rejects a malformed one', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{ severity: 'critical' }] }] });
    const key = { snapshotId, repoId: repoId('a'), number: 1 };
    expect(await handlers().getFinding(key)).toMatchObject({ ...key, fullName: 'TETRA2000/a', severity: 'critical' });
    expect(await handlers().getFinding({ ...key, number: 2 })).toBeNull();
    expect(await inputError(handlers().getFinding({ ...key, number: '1' }))).toMatch(/^key\.number /);
    expect(await inputError(handlers().getFinding({ ...key, path: '/etc/passwd' }))).toMatch(/^key /);
  });

  it('listRepoCards and getTreatmentPlan read only complete snapshots, and the plan has every package', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a', alerts: Array.from({ length: 12 },
      (_, i) => ({ severity: 'critical' as const, packageName: `pkg-${String(i).padStart(2, '0')}` })) }] });
    const running = seedSnapshot(db, { status: 'running', repos: [{ name: 'a' }] });

    const h = handlers();
    expect((await h.listRepoCards(snapshotId)).map((c) => [c.fullName, c.critical])).toEqual([['TETRA2000/a', 12]]);
    expect((await h.getTreatmentPlan(snapshotId)).map((r) => r.packageName))
      .toEqual(Array.from({ length: 12 }, (_, i) => `pkg-${String(i).padStart(2, '0')}`));
    for (const call of [(x: unknown) => h.listRepoCards(x), (x: unknown) => h.getTreatmentPlan(x)]) {
      expect(await inputError(call(running))).toBe(`Snapshot ${running} is not complete.`);
      expect(await inputError(call('1'))).toMatch(/^snapshotId /);
    }
  });
});
