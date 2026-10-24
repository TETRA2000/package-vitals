import type { Db } from '../db/database.js';
import type { SeverityCounts } from '../types.js';

export function openSeverityCounts(db: Db, snapshotId: number, repoId?: number): SeverityCounts {
  const rows = (repoId === undefined
    ? db.prepare(`SELECT severity, count(*) AS n FROM alerts WHERE snapshot_id = ? AND state = 'open' GROUP BY severity`)
      .all(snapshotId)
    : db.prepare(`SELECT severity, count(*) AS n FROM alerts WHERE snapshot_id = ? AND repo_id = ? AND state = 'open'
      GROUP BY severity`).all(snapshotId, repoId)) as { severity: keyof SeverityCounts; n: number }[];
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of rows) counts[r.severity] = r.n;
  return counts;
}

export interface SeverityChange {
  counts: SeverityCounts;
  /** Repos whose alerts were read in both snapshots; only these are counted. */
  comparedRepos: number;
  /** Repos whose alerts were read in only one of the two snapshots. */
  leftOutRepos: number;
}

/**
 * Open alerts in `snapshotId` minus those in `previousId`, over only the repos
 * read in both, so a repo that errored, lost monitoring, or is new can't pass
 * for alerts being fixed or found.
 */
export function openSeverityChange(db: Db, snapshotId: number, previousId: number): SeverityChange {
  const repos = db.prepare(`SELECT repo_id AS repoId,
      max(snapshot_id = ? AND alerts_status = 'ok') AS now, max(snapshot_id = ? AND alerts_status = 'ok') AS before
    FROM snapshot_repos WHERE snapshot_id IN (?, ?) GROUP BY repo_id`)
    .all(snapshotId, previousId, snapshotId, previousId) as { repoId: number; now: number; before: number }[];
  const compared = repos.filter((r) => r.now === 1 && r.before === 1).map((r) => r.repoId);
  const rows = db.prepare(`SELECT snapshot_id AS snapshotId, severity, count(*) AS n FROM alerts
    WHERE snapshot_id IN (?, ?) AND state = 'open' AND repo_id IN (SELECT value FROM json_each(?))
    GROUP BY snapshot_id, severity`)
    .all(snapshotId, previousId, JSON.stringify(compared)) as { snapshotId: number; severity: keyof SeverityCounts; n: number }[];
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const r of rows) counts[r.severity] += r.snapshotId === snapshotId ? r.n : -r.n;
  return { counts, comparedRepos: compared.length, leftOutRepos: repos.filter((r) => r.now !== r.before).length };
}

export interface StateCounts {
  open: number;
  dismissed: number;
  autoDismissed: number;
  fixed: number;
}

/** Alert counts by state. Dismissed alerts are never counted as fixed. */
export function alertStateCounts(db: Db, snapshotId: number): StateCounts {
  const rows = db.prepare('SELECT state, count(*) AS n FROM alerts WHERE snapshot_id = ? GROUP BY state')
    .all(snapshotId) as { state: string; n: number }[];
  const n = (state: string) => rows.find((r) => r.state === state)?.n ?? 0;
  return { open: n('open'), dismissed: n('dismissed'), autoDismissed: n('auto_dismissed'), fixed: n('fixed') };
}

export interface MonitoringSummary {
  checked: number;
  monitored: number;
  notMonitored: string[];
  errors: { repo: string; message: string }[];
  withOpenAlerts: number;
}

export function monitoringSummary(db: Db, snapshotId: number): MonitoringSummary {
  const repos = db.prepare(`SELECT r.full_name AS fullName, s.alerts_status AS status, s.alerts_error AS error
    FROM snapshot_repos s JOIN repos r ON r.id = s.repo_id WHERE s.snapshot_id = ? ORDER BY r.full_name`)
    .all(snapshotId) as { fullName: string; status: 'ok' | 'not_monitored' | 'error'; error: string | null }[];
  const { n } = db.prepare(`SELECT count(DISTINCT repo_id) AS n FROM alerts WHERE snapshot_id = ? AND state = 'open'`)
    .get(snapshotId) as { n: number };
  return {
    checked: repos.length,
    monitored: repos.filter((r) => r.status === 'ok').length,
    notMonitored: repos.filter((r) => r.status === 'not_monitored').map((r) => r.fullName),
    errors: repos.filter((r) => r.status === 'error').map((r) => ({ repo: r.fullName, message: r.error ?? '' })),
    withOpenAlerts: n,
  };
}

export interface WorstRepo {
  fullName: string;
  critical: number;
  high: number;
  open: number;
  oldestOpenAlert: string | null;
}

/** Repos with open alerts, worst first: by critical, then high, then all open alerts. */
export function worstRepos(db: Db, snapshotId: number, limit: number): WorstRepo[] {
  return db.prepare(`SELECT r.full_name AS fullName,
      sum(a.severity = 'critical') AS critical,
      sum(a.severity = 'high') AS high,
      count(*) AS open,
      min(a.created_at) AS oldestOpenAlert
    FROM alerts a JOIN repos r ON r.id = a.repo_id
    WHERE a.snapshot_id = ? AND a.state = 'open'
    GROUP BY a.repo_id
    ORDER BY critical DESC, high DESC, open DESC, fullName ASC
    LIMIT ?`).all(snapshotId, limit).map((r) => ({ ...(r as unknown as WorstRepo) }));
}

export interface TreatmentRow {
  ecosystem: string;
  packageName: string;
  repoCount: number;
  patchedVersions: string[];
}

/** Packages with an open critical alert, by how many repos they affect. */
export function criticalTreatmentPlan(db: Db, snapshotId: number, limit: number): TreatmentRow[] {
  const rows = db.prepare(`SELECT ecosystem, package_name AS packageName, count(DISTINCT repo_id) AS repoCount,
      json_group_array(DISTINCT first_patched) FILTER (WHERE first_patched IS NOT NULL) AS patched
    FROM alerts
    WHERE snapshot_id = ? AND state = 'open' AND severity = 'critical'
    GROUP BY ecosystem, package_name
    ORDER BY repoCount DESC, packageName ASC, ecosystem ASC
    LIMIT ?`).all(snapshotId, limit) as { ecosystem: string; packageName: string; repoCount: number; patched: string }[];
  return rows.map((r) => ({
    ecosystem: r.ecosystem,
    packageName: r.packageName,
    repoCount: r.repoCount,
    patchedVersions: (JSON.parse(r.patched) as string[]).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  }));
}

export type AgeBucket = 'under-30-days' | '30-90-days' | '90-365-days' | '1-2-years' | 'over-2-years';

export interface AgeBucketRow {
  bucket: AgeBucket;
  all: number;
  critical: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long open alerts have been open, in five buckets, always in this order. */
export function openAlertAges(db: Db, snapshotId: number, now: Date): AgeBucketRow[] {
  const rows: AgeBucketRow[] = (['under-30-days', '30-90-days', '90-365-days', '1-2-years', 'over-2-years'] as const)
    .map((bucket) => ({ bucket, all: 0, critical: 0 }));
  const alerts = db.prepare(`SELECT created_at AS createdAt, severity FROM alerts WHERE snapshot_id = ? AND state = 'open'`)
    .all(snapshotId) as { createdAt: string; severity: string }[];
  for (const a of alerts) {
    const days = (now.getTime() - Date.parse(a.createdAt)) / DAY_MS;
    const row = rows[days < 30 ? 0 : days < 90 ? 1 : days < 365 ? 2 : days < 730 ? 3 : 4]!;
    row.all++;
    if (a.severity === 'critical') row.critical++;
  }
  return rows;
}
