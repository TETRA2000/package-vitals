import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/database.js';
import type { SnapshotRow } from '../queries/snapshots.js';

function utcDate(s: SnapshotRow): string {
  return new Date(s.finishedAt ?? s.startedAt).toISOString().slice(0, 10);
}

function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function accountReportFileName(s: SnapshotRow): string {
  return `${utcDate(s)}-account-snapshot-${s.id}.md`;
}

export function repoChartFileName(s: SnapshotRow, fullName: string): string {
  const slash = fullName.indexOf('/');
  const owner = slash === -1 ? '' : fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  return `${utcDate(s)}-repo-${safe(owner)}-${safe(name)}-snapshot-${s.id}.md`;
}

/** Writes a report into `reportsDir`, records it, and returns its row id and absolute path. */
export function writeReport(
  db: Db,
  reportsDir: string,
  r: { kind: 'account' | 'repo'; snapshotId: number; repoId: number | null; fileName: string; content: string; createdAt: string },
): { id: number; path: string } {
  const dir = path.resolve(reportsDir);
  const file = path.resolve(dir, r.fileName);
  if (path.dirname(file) !== dir) throw new Error(`Report file name must stay inside the reports folder: ${r.fileName}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, r.content);
  const { lastInsertRowid } = db.prepare('INSERT INTO reports (snapshot_id, kind, repo_id, path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(r.snapshotId, r.kind, r.repoId, file, r.createdAt);
  return { id: Number(lastInsertRowid), path: file };
}
