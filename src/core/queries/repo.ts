import type { Db } from '../db/database.js';
import type { DependabotAlert } from '../types.js';

export interface RepoAlertsView {
  repoId: number;
  fullName: string;
  alertsStatus: 'ok' | 'not_monitored' | 'error';
  alertsError: string | null;
  open: DependabotAlert[];
  /** Both `dismissed` and `auto_dismissed` alerts. */
  dismissed: DependabotAlert[];
}

const ALERT_COLUMNS = `number, state, ecosystem, package_name AS packageName, manifest_path AS manifestPath, scope,
  relationship, ghsa_id AS ghsaId, cve_id AS cveId, severity, summary, vulnerable_range AS vulnerableRange,
  first_patched AS firstPatched, created_at AS createdAt, dismissed_at AS dismissedAt,
  dismissed_reason AS dismissedReason, dismissed_comment AS dismissedComment, fixed_at AS fixedAt`;

const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

/** One repo's alerts in a snapshot, or null if the repo isn't in it. */
export function repoAlerts(db: Db, snapshotId: number, fullName: string): RepoAlertsView | null {
  const repo = db.prepare(`SELECT s.repo_id AS repoId, r.full_name AS fullName, s.alerts_status AS alertsStatus,
      s.alerts_error AS alertsError
    FROM snapshot_repos s JOIN repos r ON r.id = s.repo_id
    WHERE s.snapshot_id = ? AND r.full_name = ?`).get(snapshotId, fullName) as
    Omit<RepoAlertsView, 'open' | 'dismissed'> | undefined;
  if (repo === undefined) return null;

  const alerts = (where: string, order: string) =>
    db.prepare(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE snapshot_id = ? AND repo_id = ? AND ${where} ORDER BY ${order}`)
      .all(snapshotId, repo.repoId).map((r) => ({ ...(r as unknown as DependabotAlert) }));
  return {
    ...repo,
    open: alerts(`state = 'open'`, `${SEVERITY_RANK}, created_at, number`),
    dismissed: alerts(`state IN ('dismissed', 'auto_dismissed')`, 'number'),
  };
}
