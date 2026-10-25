import { describe, expect, it } from 'vitest';
import { renderFindingMarkdown } from '../../../src/core/reports/finding-markdown.js';
import type { FindingDetail } from '../../../src/core/types.js';

const detail: FindingDetail = {
  snapshotId: 7, repoId: 1, number: 42, fullName: 'TETRA2000/a', severity: 'critical', ecosystem: 'npm',
  packageName: 'minimist', ghsaId: 'GHSA-xvch-5gv4-984h', summary: 'Prototype Pollution in minimist',
  manifestPath: 'package-lock.json', createdAt: '2022-03-18T10:00:00Z', triage: 'not_triaged',
  cveId: 'CVE-2021-44906', scope: 'runtime', relationship: 'direct', vulnerableRange: '< 1.2.6', firstPatched: '1.2.6',
};

describe('renderFindingMarkdown', () => {
  it('renders a full detail', () => {
    expect(renderFindingMarkdown(detail)).toBe([
      '### minimist (npm) in TETRA2000/a',
      '',
      '- Severity: Critical',
      '- Advisory: GHSA-xvch-5gv4-984h (CVE-2021-44906): Prototype Pollution in minimist',
      '- Manifest: `package-lock.json`',
      '- Scope: Runtime',
      '- Vulnerable versions: &lt; 1.2.6',
      '- Patched in: 1.2.6',
      '- Open since: 2022-03-18',
      '- Triage: Not triaged',
      '- Alert: https://github.com/TETRA2000/a/security/dependabot/42',
    ].join('\n'));
  });

  it('says No CVE and No patched version', () => {
    const md = renderFindingMarkdown({ ...detail, cveId: null, firstPatched: null, scope: null, vulnerableRange: null, severity: 'low' });
    expect(md).toContain('(No CVE)');
    expect(md).toContain('- Patched in: No patched version');
    expect(md).toContain('- Scope: —');
    expect(md).toContain('- Vulnerable versions: —');
    expect(md).toContain('- Severity: Low');
  });

  it('escapes the summary', () => {
    const md = renderFindingMarkdown({ ...detail, summary: 'a | <img src=x> `code`' });
    expect(md).toContain('a \\| &lt;img src=x&gt; \\`code\\`');
  });
});
