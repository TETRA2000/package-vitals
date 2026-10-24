import path from 'node:path';
import type { Db } from '../db/database.js';
import type { ReportEntry } from '../types.js';

/** Saved reports, newest first. Paths stay out of the result; see `getReportPath`. */
export function listReports(db: Db): ReportEntry[] {
  const rows = db.prepare(`SELECT p.id, p.kind, p.snapshot_id AS snapshotId, r.full_name AS repoFullName,
      p.path, p.created_at AS createdAt
    FROM reports p LEFT JOIN repos r ON r.id = p.repo_id
    ORDER BY p.created_at DESC, p.id DESC`).all() as (Omit<ReportEntry, 'fileName'> & { path: string })[];
  return rows.map(({ path: file, ...r }) => ({ ...r, fileName: path.basename(file) }));
}

/** A report's file path, for the main process only. The renderer never sees a path. */
export function getReportPath(db: Db, id: number): string | null {
  const row = db.prepare('SELECT path FROM reports WHERE id = ?').get(id) as { path: string } | undefined;
  return row?.path ?? null;
}
