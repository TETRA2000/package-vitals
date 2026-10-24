import { GitHubApiError, type GitHubClient } from './client.js';
import type { AlertState, AlertsResult, DependabotAlert, Severity } from '../types.js';

interface AlertJson {
  number: number;
  state: string;
  dependency: {
    package: { ecosystem: string; name: string };
    manifest_path: string;
    scope?: string | null;
    relationship?: string | null;
  };
  security_advisory: { ghsa_id: string; cve_id: string | null; summary: string; severity: string };
  security_vulnerability: {
    vulnerable_version_range?: string | null;
    first_patched_version: { identifier: string } | null;
  };
  created_at: string;
  dismissed_at: string | null;
  dismissed_reason: string | null;
  dismissed_comment: string | null;
  fixed_at: string | null;
}

const STATES: readonly string[] = ['open', 'dismissed', 'auto_dismissed', 'fixed'] satisfies AlertState[];
const SEVERITIES: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low',
};

/**
 * Every Dependabot alert for one repo, in every state. Leaving out `state`
 * returns open, dismissed, auto-dismissed, and fixed alerts.
 */
export async function fetchRepoAlerts(client: GitHubClient, fullName: string): Promise<AlertsResult> {
  let alerts: AlertJson[];
  try {
    alerts = await client.paginate<AlertJson>(`/repos/${fullName}/dependabot/alerts?per_page=100`);
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    if (err.status === 403 && /Dependabot alerts are disabled/i.test(err.apiMessage)) return { status: 'not_monitored' };
    return { status: 'error', message: err.message };
  }
  return { status: 'ok', alerts: alerts.map(toAlert) };
}

function toAlert(a: AlertJson): DependabotAlert {
  const severity = SEVERITIES[a.security_advisory.severity];
  if (!severity) throw new TypeError(`Alert ${a.number} has an unknown severity: ${a.security_advisory.severity}`);
  if (!STATES.includes(a.state)) throw new TypeError(`Alert ${a.number} has an unknown state: ${a.state}`);
  const scope = a.dependency.scope;
  return {
    number: a.number,
    state: a.state as AlertState,
    ecosystem: a.dependency.package.ecosystem,
    packageName: a.dependency.package.name,
    manifestPath: a.dependency.manifest_path,
    scope: scope === 'runtime' || scope === 'development' ? scope : null,
    relationship: a.dependency.relationship ?? null,
    ghsaId: a.security_advisory.ghsa_id,
    cveId: a.security_advisory.cve_id ?? null,
    severity,
    summary: a.security_advisory.summary,
    vulnerableRange: a.security_vulnerability.vulnerable_version_range ?? null,
    firstPatched: a.security_vulnerability.first_patched_version?.identifier ?? null,
    createdAt: a.created_at,
    dismissedAt: a.dismissed_at ?? null,
    dismissedReason: a.dismissed_reason ?? null,
    dismissedComment: a.dismissed_comment ?? null,
    fixedAt: a.fixed_at ?? null,
  };
}
