import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type Db } from '../../../src/core/db/database.js';
import { getSnapshot } from '../../../src/core/queries/snapshots.js';
import { getReportPath } from '../../../src/core/queries/reports.js';
import { generateAccountReport, generateRepoChart } from '../../../src/core/reports/generate.js';
import { seedSnapshot } from '../../helpers/seed.js';

let db: Db;
let tmp: string;
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function setup() {
  db = openDatabase(':memory:');
  tmp = mkdtempSync(path.join(tmpdir(), 'pv-generate-'));
  const id = seedSnapshot(db, { repos: [{ name: 'a', alerts: [{}] }] });
  return getSnapshot(db, id)!;
}

describe('generate', () => {
  it('generateAccountReport writes the rendered report and records it', () => {
    const s = setup();
    const r = generateAccountReport(db, tmp, s, '2026-10-24T12:00:00.000Z');
    expect(r.path).toBe(path.join(tmp, '2026-10-24-account-snapshot-1.md'));
    expect(readFileSync(r.path, 'utf8')).toContain('TETRA2000');
    expect(getReportPath(db, r.id)).toBe(r.path);
  });

  it('generateRepoChart returns null for a repo outside the snapshot', () => {
    const s = setup();
    expect(generateRepoChart(db, tmp, s, 'TETRA2000/zzz', '2026-10-24T12:00:00.000Z')).toBeNull();
    const r = generateRepoChart(db, tmp, s, 'TETRA2000/a', '2026-10-24T12:00:00.000Z');
    expect(r?.path).toBe(path.join(tmp, '2026-10-24-repo-TETRA2000-a-snapshot-1.md'));
    expect(db.prepare('SELECT count(*) AS n FROM reports').get()).toEqual({ n: 1 });
  });
});
