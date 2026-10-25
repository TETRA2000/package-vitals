import type { Db } from '../db/database.js';
import type { FindingDetail, FindingFilter, FindingKey, FindingRow } from '../types.js';

const SEVERITY_RANK = `CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

const FINDING_COLUMNS = `a.snapshot_id AS snapshotId, a.repo_id AS repoId, a.number, r.full_name AS fullName,
  a.severity, a.ecosystem, a.package_name AS packageName, a.ghsa_id AS ghsaId, a.summary,
  a.manifest_path AS manifestPath, a.created_at AS createdAt`;

/** The repo and ecosystem parts of a filter, as SQL over alias `a`. */
function scopeSql(filter: FindingFilter): { sql: string; params: (string | number)[] } {
  const sql: string[] = [];
  const params: (string | number)[] = [];
  if (filter.repoId !== null) { sql.push('AND a.repo_id = ?'); params.push(filter.repoId); }
  if (filter.ecosystem !== null) { sql.push('AND a.ecosystem = ?'); params.push(filter.ecosystem); }
  return { sql: sql.join(' '), params };
}

/** Open alerts matching the filter: critical first, then oldest first. */
export function listFindings(db: Db, snapshotId: number, filter: FindingFilter): FindingRow[] {
  const scope = scopeSql(filter);
  return db.prepare(`SELECT ${FINDING_COLUMNS}
    FROM alerts a JOIN repos r ON r.id = a.repo_id
    WHERE a.snapshot_id = ? AND a.state = 'open'
      AND a.severity IN (SELECT value FROM json_each(?)) ${scope.sql}
    ORDER BY ${SEVERITY_RANK}, a.created_at ASC, r.full_name ASC, a.number ASC`)
    .all(snapshotId, JSON.stringify(filter.severities), ...scope.params)
    .map((r) => ({ ...(r as unknown as Omit<FindingRow, 'triage'>), triage: 'not_triaged' as const }));
}

/** One open alert in full, or null if the key isn't an open alert in that snapshot. */
export function getFinding(db: Db, key: FindingKey): FindingDetail | null {
  const row = db.prepare(`SELECT ${FINDING_COLUMNS}, a.cve_id AS cveId, a.scope, a.relationship,
      a.vulnerable_range AS vulnerableRange, a.first_patched AS firstPatched
    FROM alerts a JOIN repos r ON r.id = a.repo_id
    WHERE a.snapshot_id = ? AND a.repo_id = ? AND a.number = ? AND a.state = 'open'`)
    .get(key.snapshotId, key.repoId, key.number);
  return row === undefined ? null : { ...(row as unknown as Omit<FindingDetail, 'triage'>), triage: 'not_triaged' };
}

/**
 * `critical` counts open critical alerts within the repo and ecosystem filters,
 * whatever the severity filter says. `matching` counts rows matching the whole filter.
 */
export function countFindings(db: Db, snapshotId: number, filter: FindingFilter): { critical: number; matching: number } {
  const scope = scopeSql(filter);
  const row = db.prepare(`SELECT
      count(*) FILTER (WHERE a.severity = 'critical') AS critical,
      count(*) FILTER (WHERE a.severity IN (SELECT value FROM json_each(?))) AS matching
    FROM alerts a WHERE a.snapshot_id = ? AND a.state = 'open' ${scope.sql}`)
    .get(JSON.stringify(filter.severities), snapshotId, ...scope.params) as { critical: number; matching: number };
  return { critical: row.critical, matching: row.matching };
}

/** Ecosystems with at least one open alert, sorted. */
export function findingEcosystems(db: Db, snapshotId: number): string[] {
  return (db.prepare(`SELECT DISTINCT ecosystem FROM alerts WHERE snapshot_id = ? AND state = 'open' ORDER BY ecosystem`)
    .all(snapshotId) as { ecosystem: string }[]).map((r) => r.ecosystem);
}

/** Every repo in the snapshot, sorted by name. */
export function snapshotRepos(db: Db, snapshotId: number): { id: number; fullName: string }[] {
  return db.prepare(`SELECT r.id, r.full_name AS fullName FROM snapshot_repos s JOIN repos r ON r.id = s.repo_id
    WHERE s.snapshot_id = ? ORDER BY r.full_name`).all(snapshotId).map((r) => ({ ...(r as { id: number; fullName: string }) }));
}
