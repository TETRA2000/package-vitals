import type { Db } from '../../src/core/db/database.js';
import {
  createSnapshot, finishOsv, finishSnapshot, insertFindings, recordLockfiles, recordRepoResult, upsertRepo,
} from '../../src/core/checkup/store.js';
import { buildRepoFindings } from '../../src/core/findings/build.js';
import type { AlertsResult, DependabotAlert, FindingRecord } from '../../src/core/types.js';

/** A `Gemfile.lock` is RubyGems'; any other path is npm's. */
export interface SeedLockfile {
  path: string;
  status: 'ok' | 'unsupported' | 'error';
  error?: string;
  format?: string;
  /** `lookup` defaults to `ok` when `latest` is given and to `skipped` otherwise. */
  directDependencies?: { name: string; version: string; latest?: string; lookup?: string; outdated?: boolean }[];
}

export interface SeedRepo {
  /** The repo name without its owner. */
  name: string;
  alertsStatus?: 'ok' | 'not_monitored' | 'error';
  /** The message for an `error` repo. Defaults to `Not Found (HTTP 404)`. */
  alertsError?: string;
  alerts?: Partial<DependabotAlert>[];
  /** Changes to the finding built from an open alert, keyed by alert number. */
  findingOverrides?: Record<number, Partial<FindingRecord>>;
  /** OSV-only findings, each completed with defaults. */
  osvFindings?: Partial<FindingRecord>[];
  lockfiles?: SeedLockfile[];
  /** Defaults, when `osv` isn't null, to `ok` for a repo with lockfiles and to `none` otherwise. */
  lockfilesStatus?: 'ok' | 'none' | 'empty' | 'error';
}

export interface SeedSpec {
  owner?: string;
  includeForks?: boolean;
  includeArchived?: boolean;
  status?: 'running' | 'complete' | 'failed';
  finishedAt?: string;
  /** How the OSV lookup went. Defaults to `ok`. Null means Level 1 never ran: no OSV or lockfile status is stored. */
  osv?: 'ok' | { error: string } | null;
  repos: SeedRepo[];
}

const STARTED_AT = '2026-10-24T00:00:00.000Z';
const ALERT_CREATED_AT = '2026-01-01T00:00:00Z';

/** Seeds one snapshot through the store functions, except for lockfile rows, and returns its id. */
export function seedSnapshot(db: Db, spec: SeedSpec): number {
  const owner = spec.owner ?? 'TETRA2000';
  const osv = spec.osv === undefined ? 'ok' : spec.osv;
  const snapshotId = createSnapshot(db, { kind: 'user', login: owner }, STARTED_AT,
    { includeForks: spec.includeForks ?? false, includeArchived: spec.includeArchived ?? false });
  let number = 0;
  let osvNumber = 0;
  for (const repo of spec.repos) {
    const repoId = upsertRepo(db, { fullName: `${owner}/${repo.name}`, isPrivate: false, isFork: false,
      isArchived: false, defaultBranch: 'main', pushedAt: null });
    const status = repo.alertsStatus ?? 'ok';
    const alerts: AlertsResult =
      status === 'ok' ? { status, alerts: (repo.alerts ?? []).map((a) => ({ ...alertDefaults(++number), ...a })) }
      : status === 'error' ? { status, message: repo.alertsError ?? 'Not Found (HTTP 404)' }
      : { status };
    recordRepoResult(db, snapshotId, repoId, alerts, { status: 'unavailable', message: 'Not Found (HTTP 404)' });

    const lockfiles = repo.lockfiles ?? [];
    const lockfilesStatus = repo.lockfilesStatus ?? (osv === null ? null : lockfiles.length > 0 ? 'ok' : 'none');
    if (lockfilesStatus !== null) {
      recordLockfiles(db, snapshotId, repoId, { status: lockfilesStatus, error: null, truncated: false, projects: [] });
    }
    for (const lockfile of lockfiles) seedLockfile(db, snapshotId, repoId, lockfile);

    const fromAlerts = buildRepoFindings({ alerts: alerts.status === 'ok' ? alerts.alerts : [], projects: [], osv: null })
      .map(({ record }) => ({ ...record, ...repo.findingOverrides?.[record.alertNumber!] }));
    const fromOsv = (repo.osvFindings ?? []).map((f) => ({ ...osvFindingDefaults(++osvNumber), ...f }));
    insertFindings(db, snapshotId, repoId, [...fromAlerts, ...fromOsv], STARTED_AT);
  }
  if (osv !== null) finishOsv(db, snapshotId, osv === 'ok' ? { status: 'ok' } : { status: 'error', message: osv.error });
  const status = spec.status ?? 'complete';
  if (status !== 'running') finishSnapshot(db, snapshotId, status, spec.finishedAt ?? '2026-10-24T01:00:00.000Z');
  return snapshotId;
}

/** Writes a lockfile row and its direct dependencies as given, without a graph behind them. */
function seedLockfile(db: Db, snapshotId: number, repoId: number, l: SeedLockfile): void {
  const ecosystem = l.path === 'Gemfile.lock' || l.path.endsWith('/Gemfile.lock') ? 'rubygems' : 'npm';
  const { id } = db.prepare(`INSERT INTO lockfiles (snapshot_id, repo_id, path, ecosystem, format, status, error, blob_sha,
    complete, js_bundler) VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, NULL) RETURNING id`)
    .get(snapshotId, repoId, l.path, ecosystem, l.format ?? null, l.status, l.error ?? null, l.status === 'ok' ? 1 : null) as
    { id: number };
  const insert = db.prepare(`INSERT INTO direct_dependencies (lockfile_id, name, version, dev, latest, lookup, outdated)
    VALUES (?, ?, ?, 0, ?, ?, ?)`);
  for (const d of l.directDependencies ?? []) {
    insert.run(id, d.name, d.version, d.latest ?? null, d.lookup ?? (d.latest === undefined ? 'skipped' : 'ok'),
      d.outdated === undefined ? null : Number(d.outdated));
  }
}

function alertDefaults(number: number): DependabotAlert {
  return {
    number,
    state: 'open',
    ecosystem: 'npm',
    packageName: 'pkg',
    manifestPath: 'package-lock.json',
    scope: 'runtime',
    relationship: 'direct',
    ghsaId: `GHSA-seed-${number}`,
    cveId: null,
    severity: 'high',
    summary: 'Seeded advisory',
    vulnerableRange: null,
    firstPatched: null,
    createdAt: ALERT_CREATED_AT,
    dismissedAt: null,
    dismissedReason: null,
    dismissedComment: null,
    fixedAt: null,
  };
}

function osvFindingDefaults(n: number): FindingRecord {
  return {
    alertNumber: null,
    source: 'osv',
    ecosystem: 'npm',
    packageName: 'pkg',
    manifestPath: 'package-lock.json',
    advisoryId: `GHSA-osv-${n}`,
    cveId: null,
    severity: 'high',
    severitySource: 'advisory',
    summary: 'Seeded OSV advisory',
    vulnerableRange: null,
    firstPatched: null,
    createdAt: ALERT_CREATED_AT,
    scope: null,
    githubRelationship: null,
    installedVersions: ['1.0.0'],
    relationship: null,
    chains: [],
    chainCount: 0,
    lockfileRead: true,
    lockfileDevOnly: null,
    jsBundler: null,
    tier: null,
    upgrades: null,
  };
}
