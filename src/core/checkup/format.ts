import { formatCount, formatPlural } from '../reports/markdown.js';
import type { CheckupSummary } from '../types.js';

export function formatCheckupSummary(s: CheckupSummary): string {
  return `Checked ${formatPlural(s.reposChecked, 'repo')}: ${formatCount(s.open.critical)} critical, `
    + `${formatCount(s.open.high)} high, ${formatCount(s.open.medium)} medium, ${formatCount(s.open.low)} low open alerts. `
    + `${formatCount(s.notMonitored)} not monitored, ${formatCount(s.errors)} with errors. Snapshot ${s.snapshotId}.`;
}

/** The warning for repos whose alerts couldn't be read, or null when there were none. */
export function checkupWarning(s: CheckupSummary): string | null {
  if (s.errors === 0) return null;
  return `Warning: alerts for ${formatPlural(s.errors, 'repo')} couldn't be read and aren't counted. `
    + 'Run the checkup again to retry.';
}
