import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reportHandlers } from '../../../src/app/main/handlers/reports.js';
import { IpcInputError } from '../../../src/app/main/validate.js';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
let tmp: string;
let reportsDir: string;
let outside: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  tmp = mkdtempSync(path.join(tmpdir(), 'pv-rh-'));
  reportsDir = path.join(tmp, 'reports');
  outside = path.join(tmp, 'outside');
  mkdirSync(reportsDir);
  mkdirSync(outside);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const handlers = () => reportHandlers({ db, reportsDir, now: () => new Date('2026-10-24T12:00:00.000Z') });
function record(file: string): number {
  const snapshotId = seedSnapshot(db, { repos: [] });
  return Number(db.prepare("INSERT INTO reports (snapshot_id, kind, repo_id, path, created_at) VALUES (?, 'account', NULL, ?, '2026-10-24T00:00:00.000Z')")
    .run(snapshotId, file).lastInsertRowid);
}
const rejects = (p: Promise<unknown>, message: string) => expect(p).rejects.toThrow(message);

describe('report handlers', () => {
  it('lists and reads a generated report', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a' }] });
    const h = handlers();
    const entry = await h.generateReport({ kind: 'account', snapshotId });
    expect(await h.listReports(undefined)).toEqual([entry]);
    expect(await h.readReport(entry.id)).toContain('TETRA2000');
  });

  it('refuses a recorded path outside the reports folder', async () => {
    const file = path.join(outside, 'secret.md');
    writeFileSync(file, 'secret');
    const id = record(file);
    await rejects(handlers().readReport(id), 'Report not found.');
  });

  it('refuses a symlink that leads outside the reports folder', async () => {
    const target = path.join(outside, 'secret.md');
    writeFileSync(target, 'secret');
    const link = path.join(reportsDir, 'link.md');
    symlinkSync(target, link);
    await rejects(handlers().readReport(record(link)), 'Report not found.');
  });

  it('rejects an unknown id, a malformed id, a missing file, and a file over 5 MB', async () => {
    const h = handlers();
    await rejects(h.readReport(999), 'Report not found.');
    for (const bad of ['1', 0, -1, 1.5, null]) await expect(h.readReport(bad)).rejects.toBeInstanceOf(IpcInputError);
    const missing = path.join(reportsDir, 'gone.md');
    await rejects(h.readReport(record(missing)), 'Report file is missing.');
    const big = path.join(reportsDir, 'big.md');
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
    await rejects(h.readReport(record(big)), 'Report is too large to show.');
    const ok = path.join(reportsDir, 'ok.md');
    writeFileSync(ok, Buffer.alloc(5 * 1024 * 1024, 'a'));
    expect(await h.readReport(record(ok))).toHaveLength(5 * 1024 * 1024);
  });

  it('generates account and repo reports, and refuses an incomplete snapshot or a repo outside it', async () => {
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{}] }] });
    const other = seedSnapshot(db, { owner: 'X', repos: [{ name: 'b' }] });
    const running = seedSnapshot(db, { status: 'running', repos: [{ name: 'c' }] });
    const repoId = (n: string) => (db.prepare('SELECT id FROM repos WHERE full_name = ?').get(n) as { id: number }).id;
    const h = handlers();
    const account = await h.generateReport({ kind: 'account', snapshotId });
    expect(account).toMatchObject({ kind: 'account', snapshotId, repoFullName: null, createdAt: '2026-10-24T12:00:00.000Z' });
    const chart = await h.generateReport({ kind: 'repo', snapshotId, repoId: repoId('TETRA2000/a') });
    expect(chart).toMatchObject({ kind: 'repo', snapshotId, repoFullName: 'TETRA2000/a' });
    expect(await h.readReport(chart.id)).toContain('TETRA2000/a');
    await rejects(h.generateReport({ kind: 'account', snapshotId: running }), `Snapshot ${running} is not complete.`);
    await rejects(h.generateReport({ kind: 'account', snapshotId: 999 }), 'is not complete.');
    await rejects(h.generateReport({ kind: 'repo', snapshotId, repoId: repoId('X/b') }), 'Repo is not in this snapshot.');
    await rejects(h.generateReport({ kind: 'repo', snapshotId: other, repoId: 999 }), 'Repo is not in this snapshot.');
    await expect(h.generateReport({ kind: 'nope' })).rejects.toBeInstanceOf(IpcInputError);
  });
});
