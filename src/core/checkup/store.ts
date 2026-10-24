import { transaction, type Db } from '../db/database.js';
import type { AlertsResult, Owner, RepoInfo, SbomResult } from '../types.js';

/** Starts a snapshot in the `running` state and returns its id. */
export function createSnapshot(db: Db, owner: Owner, startedAt: string): number {
  const result = db.prepare(`INSERT INTO snapshots (owner_kind, owner_login, started_at, status)
    VALUES (?, ?, ?, 'running')`).run(owner.kind, owner.login, startedAt);
  return Number(result.lastInsertRowid);
}

export function finishSnapshot(db: Db, id: number, status: 'complete' | 'failed', finishedAt: string, error?: string): void {
  db.prepare('UPDATE snapshots SET status = ?, finished_at = ?, error = ? WHERE id = ?')
    .run(status, finishedAt, error ?? null, id);
}

/** Inserts the repo, or updates every field if it is already known, and returns its id. */
export function upsertRepo(db: Db, repo: RepoInfo): number {
  const row = db.prepare(`INSERT INTO repos (full_name, is_private, is_fork, is_archived, default_branch, pushed_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (full_name) DO UPDATE SET
      is_private = excluded.is_private,
      is_fork = excluded.is_fork,
      is_archived = excluded.is_archived,
      default_branch = excluded.default_branch,
      pushed_at = excluded.pushed_at
    RETURNING id`).get(repo.fullName, Number(repo.isPrivate), Number(repo.isFork), Number(repo.isArchived),
    repo.defaultBranch, repo.pushedAt) as { id: number };
  return row.id;
}

/** Writes one repo's results for a snapshot: its status row, its alerts, and its SBOM packages. */
export function recordRepoResult(db: Db, snapshotId: number, repoId: number, alerts: AlertsResult, sbom: SbomResult): void {
  transaction(db, () => {
    db.prepare(`INSERT INTO snapshot_repos (snapshot_id, repo_id, alerts_status, alerts_error, sbom_status)
      VALUES (?, ?, ?, ?, ?)`).run(snapshotId, repoId, alerts.status, alerts.status === 'error' ? alerts.message : null, sbom.status);

    if (alerts.status === 'ok') {
      const insert = db.prepare(`INSERT INTO alerts (snapshot_id, repo_id, number, state, ecosystem, package_name,
        manifest_path, scope, relationship, ghsa_id, cve_id, severity, summary, vulnerable_range, first_patched,
        created_at, dismissed_at, dismissed_reason, dismissed_comment, fixed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const a of alerts.alerts) {
        insert.run(snapshotId, repoId, a.number, a.state, a.ecosystem, a.packageName, a.manifestPath, a.scope,
          a.relationship, a.ghsaId, a.cveId, a.severity, a.summary, a.vulnerableRange, a.firstPatched, a.createdAt,
          a.dismissedAt, a.dismissedReason, a.dismissedComment, a.fixedAt);
      }
    }

    if (sbom.status === 'ok') {
      const insert = db.prepare('INSERT INTO sbom_packages (snapshot_id, repo_id, name, version, purl) VALUES (?, ?, ?, ?, ?)');
      for (const p of sbom.packages) insert.run(snapshotId, repoId, p.name, p.version, p.purl);
    }
  });
}
