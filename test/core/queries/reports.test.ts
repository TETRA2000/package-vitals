import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { getReportPath, listReports } from '../../../src/core/queries/reports.js';
import { writeReport } from '../../../src/core/reports/write.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
afterEach(() => db.close());

describe('report queries', () => {
  it('listReports returns newest first with the repo name and file name', () => {
    db = openDatabase(':memory:');
    const snapshotId = seedSnapshot(db, { repos: [{ name: 'a' }] });
    const repoId = (db.prepare('SELECT id FROM repos').get() as { id: number }).id;
    const dir = mkdtempSync(path.join(tmpdir(), 'pv-reports-'));
    writeReport(db, dir, { kind: 'account', snapshotId, repoId: null, fileName: 'old.md', content: 'x', createdAt: '2026-10-01T00:00:00Z' });
    writeReport(db, dir, { kind: 'repo', snapshotId, repoId, fileName: 'new.md', content: 'x', createdAt: '2026-10-02T00:00:00Z' });
    writeReport(db, dir, { kind: 'account', snapshotId, repoId: null, fileName: 'tie.md', content: 'x', createdAt: '2026-10-02T00:00:00Z' });
    expect(listReports(db)).toEqual([
      { id: 3, kind: 'account', snapshotId, repoFullName: null, fileName: 'tie.md', createdAt: '2026-10-02T00:00:00Z' },
      { id: 2, kind: 'repo', snapshotId, repoFullName: 'TETRA2000/a', fileName: 'new.md', createdAt: '2026-10-02T00:00:00Z' },
      { id: 1, kind: 'account', snapshotId, repoFullName: null, fileName: 'old.md', createdAt: '2026-10-01T00:00:00Z' },
    ]);
    expect(getReportPath(db, 2)).toBe(path.join(dir, 'new.md'));
  });

  it('getReportPath returns null for an unknown id', () => {
    db = openDatabase(':memory:');
    expect(getReportPath(db, 42)).toBeNull();
  });
});
