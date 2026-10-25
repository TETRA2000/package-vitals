import { transaction, type Db } from '../db/database.js';
import { isComplete } from '../lockfiles/graph.js';
import type { RepoLockfileScan } from '../lockfiles/scan.js';
import type { AdvisoryCache } from '../osv/osv.js';
import { getSnapshot, previousCompleteSnapshot } from '../queries/snapshots.js';
import type { LatestLookup } from '../registry/registry.js';
import { isOutdated } from '../registry/upgrades.js';
import type { AlertsResult, CheckupScope, FindingRecord, Owner, PackageEcosystem, RepoInfo, SbomResult } from '../types.js';

/** Starts a snapshot in the `running` state and returns its id. */
export function createSnapshot(db: Db, owner: Owner, startedAt: string, scope: CheckupScope): number {
  const result = db.prepare(`INSERT INTO snapshots (owner_kind, owner_login, include_forks, include_archived, started_at, status)
    VALUES (?, ?, ?, ?, ?, 'running')`)
    .run(owner.kind, owner.login, Number(scope.includeForks), Number(scope.includeArchived), startedAt);
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

/**
 * Writes one repo's lockfile scan: its status on the repo's row, a row per lockfile, and, for each read lockfile,
 * the registry packages its roots declare. A package is dev only when every root that declares it does so as dev.
 */
export function recordLockfiles(db: Db, snapshotId: number, repoId: number, scan: RepoLockfileScan): void {
  transaction(db, () => {
    db.prepare(`UPDATE snapshot_repos SET lockfiles_status = ?, lockfiles_error = ?, tree_truncated = ?
      WHERE snapshot_id = ? AND repo_id = ?`).run(scan.status, scan.error, Number(scan.truncated), snapshotId, repoId);

    const insertLockfile = db.prepare(`INSERT INTO lockfiles (snapshot_id, repo_id, path, ecosystem, format, status, error,
      blob_sha, complete, js_bundler) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
    const insertDependency = db.prepare(`INSERT INTO direct_dependencies (lockfile_id, name, version, dev, lookup)
      VALUES (?, ?, ?, ?, 'skipped')`);
    for (const p of scan.projects) {
      const r = p.result;
      const format = r.status === 'ok' ? r.graph.format : r.status === 'unsupported' ? r.format : null;
      const error = r.status === 'ok' ? null : r.message;
      const complete = r.status === 'ok' ? Number(isComplete(r.graph)) : null;
      const { id } = insertLockfile.get(snapshotId, repoId, p.path, p.ecosystem, format, r.status, error, p.blobSha, complete,
        p.jsBundler) as { id: number };
      if (r.status !== 'ok') continue;

      // Keyed by name and version: two copies of one release are one row, dev only if every edge to either is.
      const direct = new Map<string, { name: string; version: string; dev: boolean }>();
      for (const e of r.graph.roots.flatMap((root) => root.edges)) {
        const n = r.graph.nodes[e.to];
        if (n === undefined || !n.registry) continue;
        const key = JSON.stringify([n.name, n.version]);
        const seen = direct.get(key);
        if (seen) seen.dev &&= e.kind === 'dev';
        else direct.set(key, { name: n.name, version: n.version, dev: e.kind === 'dev' });
      }
      for (const d of direct.values()) insertDependency.run(id, d.name, d.version, Number(d.dev));
    }
  });
}

/** Stores each package's newest release on every direct dependency of that ecosystem and name in the snapshot. */
export function recordLatestVersions(
  db: Db,
  snapshotId: number,
  results: { ecosystem: PackageEcosystem; name: string; lookup: LatestLookup }[],
): void {
  transaction(db, () => {
    const select = db.prepare(`SELECT d.lockfile_id AS lockfileId, d.version FROM direct_dependencies d
      JOIN lockfiles l ON l.id = d.lockfile_id WHERE l.snapshot_id = ? AND l.ecosystem = ? AND d.name = ?`);
    const update = db.prepare(`UPDATE direct_dependencies SET latest = ?, lookup = ?, outdated = ?
      WHERE lockfile_id = ? AND name = ? AND version = ?`);
    for (const { ecosystem, name, lookup } of results) {
      const latest = lookup.status === 'ok' ? lookup.latest : null;
      const rows = select.all(snapshotId, ecosystem, name) as { lockfileId: number; version: string }[];
      for (const row of rows) {
        // Null when either version can't be compared, so an unknown is never stored as up to date.
        const outdated = latest === null ? null : isOutdated(ecosystem, row.version, latest);
        update.run(latest, lookup.status, outdated === null ? null : Number(outdated), row.lockfileId, name, row.version);
      }
    }
  });
}

/**
 * Stores one repo's findings. A finding first seen in this snapshot (null `createdAt`) keeps the date of the same
 * OSV-only finding in the previous complete snapshot of the same owner and scope, or else takes `firstSeen`.
 */
export function insertFindings(db: Db, snapshotId: number, repoId: number, records: FindingRecord[], firstSeen: string): void {
  transaction(db, () => {
    const snapshot = getSnapshot(db, snapshotId);
    const previous = snapshot === null ? null : previousCompleteSnapshot(db, snapshot);
    const seenBefore = db.prepare(`SELECT min(created_at) AS createdAt FROM findings WHERE snapshot_id = ? AND repo_id = ?
      AND source = 'osv' AND manifest_path = ? AND ecosystem = ? AND package_name = ? AND advisory_id = ?`);
    const createdAt = (f: FindingRecord): string => {
      if (f.createdAt !== null) return f.createdAt;
      if (previous === null) return firstSeen;
      const row = seenBefore.get(previous.id, repoId, f.manifestPath, f.ecosystem, f.packageName, f.advisoryId) as
        { createdAt: string | null };
      return row.createdAt ?? firstSeen;
    };

    const insert = db.prepare(`INSERT INTO findings (snapshot_id, repo_id, alert_number, source, ecosystem, package_name,
      manifest_path, advisory_id, cve_id, severity, severity_source, summary, vulnerable_range, first_patched, created_at,
      scope, github_relationship, installed_versions, relationship, chains, chain_count, lockfile_read, lockfile_dev_only,
      js_bundler, tier, upgrades)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of records) {
      insert.run(snapshotId, repoId, f.alertNumber, f.source, f.ecosystem, f.packageName, f.manifestPath, f.advisoryId,
        f.cveId, f.severity, f.severitySource, f.summary, f.vulnerableRange, f.firstPatched, createdAt(f), f.scope,
        f.githubRelationship, JSON.stringify(f.installedVersions), f.relationship, JSON.stringify(f.chains), f.chainCount,
        Number(f.lockfileRead), f.lockfileDevOnly === null ? null : Number(f.lockfileDevOnly), f.jsBundler, f.tier,
        f.upgrades === null ? null : JSON.stringify(f.upgrades));
    }
  });
}

export function finishOsv(db: Db, snapshotId: number, osv: { status: 'ok' } | { status: 'error'; message: string }): void {
  db.prepare('UPDATE snapshots SET osv_status = ?, osv_error = ? WHERE id = ?')
    .run(osv.status, osv.status === 'error' ? osv.message : null, snapshotId);
}

/** OSV advisories kept across Checkups, so one whose `modified` hasn't changed isn't fetched again. */
export function sqliteAdvisoryCache(db: Db, now: () => Date): AdvisoryCache {
  return {
    get(id) {
      const row = db.prepare('SELECT modified, json FROM osv_advisories WHERE id = ?').get(id) as
        { modified: string; json: string } | undefined;
      return row === undefined ? null : { modified: row.modified, json: row.json };
    },
    put(id, modified, json) {
      db.prepare(`INSERT INTO osv_advisories (id, modified, json, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET modified = excluded.modified, json = excluded.json, fetched_at = excluded.fetched_at`)
        .run(id, modified, json, now().toISOString());
    },
  };
}
