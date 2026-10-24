/** A GitHub user or org whose repos are checked. */
export type Owner = { kind: 'user' | 'org'; login: string };

export interface RepoInfo {
  fullName: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';

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
