/**
 * Migrations, in order. Migration N (0-based) takes the database from
 * `user_version` N to N + 1. Never edit a migration that has shipped; add one.
 */
export const MIGRATIONS: string[] = [
  `
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','org')),
  owner_login TEXT NOT NULL,
  include_forks INTEGER NOT NULL CHECK (include_forks IN (0,1)),
  include_archived INTEGER NOT NULL CHECK (include_archived IN (0,1)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  error TEXT
);
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  is_private INTEGER NOT NULL,
  is_fork INTEGER NOT NULL,
  is_archived INTEGER NOT NULL,
  default_branch TEXT,
  pushed_at TEXT
);
CREATE TABLE snapshot_repos (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  alerts_status TEXT NOT NULL CHECK (alerts_status IN ('ok','not_monitored','error')),
  alerts_error TEXT,
  sbom_status TEXT NOT NULL CHECK (sbom_status IN ('ok','unavailable')),
  PRIMARY KEY (snapshot_id, repo_id)
);
CREATE TABLE alerts (
  snapshot_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','dismissed','auto_dismissed','fixed')),
  ecosystem TEXT NOT NULL,
  package_name TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  scope TEXT,
  relationship TEXT,
  ghsa_id TEXT NOT NULL,
  cve_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  summary TEXT NOT NULL,
  vulnerable_range TEXT,
  first_patched TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  dismissed_reason TEXT,
  dismissed_comment TEXT,
  fixed_at TEXT,
  PRIMARY KEY (snapshot_id, repo_id, number),
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE INDEX alerts_by_snapshot_state ON alerts(snapshot_id, state, severity);
CREATE TABLE sbom_packages (
  snapshot_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  purl TEXT,
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  kind TEXT NOT NULL CHECK (kind IN ('account','repo')),
  repo_id INTEGER REFERENCES repos(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`,
  // Level 1: lockfiles, their direct dependencies, cached OSV advisories, and findings. Every open alert of an
  // older snapshot becomes a Dependabot finding without lockfile facts.
  `
ALTER TABLE snapshots ADD COLUMN osv_status TEXT CHECK (osv_status IN ('ok','error'));
ALTER TABLE snapshots ADD COLUMN osv_error TEXT;
ALTER TABLE snapshot_repos ADD COLUMN lockfiles_status TEXT CHECK (lockfiles_status IN ('ok','none','empty','error'));
ALTER TABLE snapshot_repos ADD COLUMN lockfiles_error TEXT;
ALTER TABLE snapshot_repos ADD COLUMN tree_truncated INTEGER NOT NULL DEFAULT 0;
CREATE TABLE lockfiles (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL, repo_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm','rubygems')),
  format TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','unsupported','error')),
  error TEXT,
  blob_sha TEXT NOT NULL,
  complete INTEGER CHECK (complete IN (0,1)),
  js_bundler TEXT,
  UNIQUE (snapshot_id, repo_id, path),
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE TABLE direct_dependencies (
  lockfile_id INTEGER NOT NULL REFERENCES lockfiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, version TEXT NOT NULL,
  dev INTEGER NOT NULL CHECK (dev IN (0,1)),
  latest TEXT,
  lookup TEXT NOT NULL CHECK (lookup IN ('ok','not_found','error','skipped')),
  outdated INTEGER CHECK (outdated IN (0,1)),
  PRIMARY KEY (lockfile_id, name, version)
);
CREATE TABLE osv_advisories (id TEXT PRIMARY KEY, modified TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL, repo_id INTEGER NOT NULL,
  alert_number INTEGER,
  source TEXT NOT NULL CHECK (source IN ('dependabot','osv','both')),
  ecosystem TEXT NOT NULL, package_name TEXT NOT NULL, manifest_path TEXT NOT NULL,
  advisory_id TEXT NOT NULL, cve_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  severity_source TEXT NOT NULL CHECK (severity_source IN ('advisory','malware','assumed')),
  summary TEXT NOT NULL, vulnerable_range TEXT, first_patched TEXT,
  created_at TEXT NOT NULL,
  scope TEXT, github_relationship TEXT,
  installed_versions TEXT NOT NULL DEFAULT '[]',
  relationship TEXT CHECK (relationship IN ('direct','transitive','mixed')),
  chains TEXT NOT NULL DEFAULT '[]',
  chain_count INTEGER NOT NULL DEFAULT 0,
  lockfile_read INTEGER NOT NULL DEFAULT 0 CHECK (lockfile_read IN (0,1)),
  lockfile_dev_only INTEGER CHECK (lockfile_dev_only IN (0,1)),
  js_bundler TEXT,
  tier TEXT CHECK (tier IN ('not_shipped')),
  upgrades TEXT,
  UNIQUE (snapshot_id, repo_id, alert_number),
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE INDEX findings_by_snapshot ON findings(snapshot_id, tier, severity);
INSERT INTO findings (snapshot_id, repo_id, alert_number, source, ecosystem, package_name, manifest_path,
    advisory_id, cve_id, severity, severity_source, summary, vulnerable_range, first_patched, created_at,
    scope, github_relationship)
  SELECT snapshot_id, repo_id, number, 'dependabot', ecosystem, package_name, manifest_path, ghsa_id, cve_id,
    severity, 'advisory', summary, vulnerable_range, first_patched, created_at, scope, relationship
  FROM alerts WHERE state = 'open';
`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;
