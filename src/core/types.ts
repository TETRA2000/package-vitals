/** A GitHub user or org whose repos are checked. */
export type Owner = { kind: 'user' | 'org'; login: string };

/** Which repos a Checkup covers. Snapshots are only compared with snapshots of the same scope. */
export interface CheckupScope {
  includeForks: boolean;
  includeArchived: boolean;
}

export interface RepoInfo {
  fullName: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Where a severity came from: the advisory itself, a malicious-package record, or assumed for want of either. */
export type SeveritySource = 'advisory' | 'malware' | 'assumed';

export type AlertState = 'open' | 'dismissed' | 'auto_dismissed' | 'fixed';

export interface DependabotAlert {
  number: number;
  state: AlertState;
  ecosystem: string;
  packageName: string;
  manifestPath: string;
  scope: 'runtime' | 'development' | null;
  relationship: string | null;
  ghsaId: string;
  cveId: string | null;
  severity: Severity;
  summary: string;
  vulnerableRange: string | null;
  firstPatched: string | null;
  createdAt: string;
  dismissedAt: string | null;
  dismissedReason: string | null;
  dismissedComment: string | null;
  fixedAt: string | null;
}

/** `not_monitored` means Dependabot alerts are turned off for the repo. It never means healthy. */
export type AlertsResult =
  | { status: 'ok'; alerts: DependabotAlert[] }
  | { status: 'not_monitored' }
  | { status: 'error'; message: string };

export interface SbomPackage {
  name: string;
  version: string | null;
  purl: string | null;
}

export type SbomResult = { status: 'ok'; packages: SbomPackage[] } | { status: 'unavailable'; message: string };

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface MonitoringSummary {
  checked: number;
  monitored: number;
  notMonitored: string[];
  errors: { repo: string; message: string }[];
  withOpenAlerts: number;
}

export interface TreatmentRow {
  ecosystem: string;
  packageName: string;
  repoCount: number;
  patchedVersions: string[];
}

export interface CheckupSummary {
  snapshotId: number;
  reposChecked: number;
  notMonitored: number;
  errors: number;
  open: SeverityCounts;
}

export interface FindingKey {
  snapshotId: number;
  repoId: number;
  number: number;
}

export interface FindingFilter {
  severities: Severity[];
  repoId: number | null;
  ecosystem: string | null;
}

export type TriageState = 'not_triaged'; // Plans 3-5 add the others

export interface FindingRow extends FindingKey {
  fullName: string;
  severity: Severity;
  ecosystem: string;
  packageName: string;
  ghsaId: string;
  summary: string;
  manifestPath: string;
  createdAt: string;
  triage: TriageState;
}

export interface FindingDetail extends FindingRow {
  cveId: string | null;
  scope: 'runtime' | 'development' | null;
  relationship: string | null;
  vulnerableRange: string | null;
  firstPatched: string | null;
}

export interface RepoCard {
  repoId: number;
  fullName: string;
  status: 'ok' | 'not_monitored' | 'error';
  error: string | null;
  critical: number;
  high: number;
  open: number;
  oldestOpenAlert: string | null;
}

export interface ReportEntry {
  id: number;
  kind: 'account' | 'repo';
  snapshotId: number;
  repoFullName: string | null;
  fileName: string;
  createdAt: string;
}

/** Package ecosystems the Checkup reads lockfiles for, named as Dependabot names them. */
export type PackageEcosystem = 'npm' | 'rubygems';

export interface ChainLink {
  name: string;
  version: string;
}

/** From a project root (`root` is its label) down to the vulnerable package, which is the last link. */
export interface DependencyChain {
  root: string;
  links: ChainLink[];
  dev: boolean;
}

export type Relationship = 'direct' | 'transitive' | 'mixed';

/** A direct dependency to move to a newer release, so that a vulnerable package it brings in goes away. */
export interface Upgrade {
  name: string;
  from: string;
  to: string;
}
