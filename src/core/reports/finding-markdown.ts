import { dependabotAlertUrl } from '../github/urls.js';
import type { FindingDetail, Severity } from '../types.js';
import { codeSpan, escapeCell, formatDate } from './markdown.js';

const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const SCOPE_LABEL = { runtime: 'Runtime', development: 'Development' } as const;

/** One finding as Markdown to paste into an issue or chat. Repo-derived text is escaped. */
export function renderFindingMarkdown(d: FindingDetail): string {
  return [
    `### ${escapeCell(d.packageName)} (${escapeCell(d.ecosystem)}) in ${escapeCell(d.fullName)}`,
    '',
    `- Severity: ${SEVERITY_LABEL[d.severity]}`,
    `- Advisory: ${escapeCell(d.ghsaId)} (${d.cveId === null ? 'No CVE' : escapeCell(d.cveId)}): ${escapeCell(d.summary)}`,
    `- Manifest: ${codeSpan(d.manifestPath)}`,
    `- Scope: ${d.scope === null ? '—' : SCOPE_LABEL[d.scope]}`,
    `- Vulnerable versions: ${d.vulnerableRange === null ? '—' : escapeCell(d.vulnerableRange)}`,
    `- Patched in: ${d.firstPatched === null ? 'No patched version' : escapeCell(d.firstPatched)}`,
    `- Open since: ${formatDate(d.createdAt)}`,
    '- Triage: Not triaged',
    `- Alert: ${dependabotAlertUrl(d.fullName, d.number)}`,
  ].join('\n');
}
