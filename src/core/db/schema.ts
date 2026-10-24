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
];

export const SCHEMA_VERSION = MIGRATIONS.length;
