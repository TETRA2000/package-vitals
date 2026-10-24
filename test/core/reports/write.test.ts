import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { getSnapshot } from '../../../src/core/queries/snapshots.js';
import { accountReportFileName, repoChartFileName, writeReport } from '../../../src/core/reports/write.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
let tmp: string;
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function setup() {
  db = openDatabase(':memory:');
  tmp = mkdtempSync(path.join(tmpdir(), 'pv-reports-'));
  for (let i = 0; i < 3; i++) seedSnapshot(db, { finishedAt: '2026-10-24T23:59:00.000Z', repos: [{ name: 'slack-deck' }] });
  return getSnapshot(db, 3)!;
}

describe('report files', () => {
  it('names files by UTC date and snapshot', () => {
    const s = setup();
    expect(accountReportFileName(s)).toBe('2026-10-24-account-snapshot-3.md');
    expect(repoChartFileName(s, 'TETRA2000/slack-deck')).toBe('2026-10-24-repo-TETRA2000-slack-deck-snapshot-3.md');
    expect(repoChartFileName({ ...s, finishedAt: '2026-10-25T08:00:00+09:00' }, 'we!rd/na me')).toBe(
      '2026-10-24-repo-we_rd-na_me-snapshot-3.md');
  });

  it('writes the report and records it', () => {
    const s = setup();
    const reports = path.join(tmp, 'reports');
    const file = writeReport(db, reports, { kind: 'account', snapshotId: s.id, repoId: null,
      fileName: accountReportFileName(s), content: '# hi\n', createdAt: '2026-10-24T12:00:00.000Z' });
    expect(file).toBe(path.join(reports, '2026-10-24-account-snapshot-3.md'));
    expect(path.isAbsolute(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('# hi\n');
    expect(db.prepare('SELECT snapshot_id, kind, repo_id, path, created_at FROM reports').all().map((r) => ({ ...r }))).toEqual([
      { snapshot_id: 3, kind: 'account', repo_id: null, path: file, created_at: '2026-10-24T12:00:00.000Z' }]);
  });

  it('refuses a file name outside the reports folder', () => {
    setup();
    const reports = path.join(tmp, 'reports');
    for (const fileName of ['../escape.md', 'sub/dir.md', '', '.']) {
      expect(() => writeReport(db, reports, { kind: 'account', snapshotId: 3, repoId: null, fileName,
        content: 'x', createdAt: '2026-10-24T12:00:00.000Z' })).toThrow();
    }
    expect(existsSync(path.join(tmp, 'escape.md'))).toBe(false);
    expect(db.prepare('SELECT count(*) AS n FROM reports').get()).toEqual({ n: 0 });
  });
});
