/** Builders for GitHub API-shaped JSON. */

export function repoJson(
  fullName: string,
  o: { fork?: boolean; archived?: boolean; private?: boolean; pushed_at?: string } = {},
) {
  return {
    full_name: fullName,
    private: o.private ?? false,
    fork: o.fork ?? false,
    archived: o.archived ?? false,
    default_branch: 'main',
    pushed_at: o.pushed_at ?? '2026-10-01T00:00:00Z',
  };
}

export interface AlertOverrides {
  number?: number;
  state?: string;
  ecosystem?: string;
  name?: string;
  manifest_path?: string;
  scope?: string | null;
  relationship?: string | null;
  ghsa_id?: string;
  cve_id?: string | null;
  summary?: string;
  severity?: string;
  vulnerable_version_range?: string | null;
  /** The patched version's identifier, or null when there is none. */
  first_patched_version?: string | null;
  created_at?: string;
  dismissed_at?: string | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  fixed_at?: string | null;
}

/** A Dependabot alert as `GET /repos/{owner}/{repo}/dependabot/alerts` returns it. */
export function alertJson(o: AlertOverrides = {}) {
  const patched = o.first_patched_version === undefined ? '0.2.4' : o.first_patched_version;
  return {
    number: o.number ?? 41,
    state: o.state ?? 'open',
    dependency: {
      package: { ecosystem: o.ecosystem ?? 'npm', name: o.name ?? 'minimist' },
      manifest_path: o.manifest_path ?? 'package-lock.json',
      scope: o.scope === undefined ? 'runtime' : o.scope,
      relationship: o.relationship === undefined ? 'transitive' : o.relationship,
    },
    security_advisory: {
      ghsa_id: o.ghsa_id ?? 'GHSA-aaaa-bbbb-cccc',
      cve_id: o.cve_id === undefined ? 'CVE-2021-0001' : o.cve_id,
      summary: o.summary ?? 'Prototype pollution',
      severity: o.severity ?? 'critical',
    },
    security_vulnerability: {
      vulnerable_version_range: o.vulnerable_version_range === undefined ? '< 0.2.4' : o.vulnerable_version_range,
      first_patched_version: patched === null ? null : { identifier: patched },
    },
    created_at: o.created_at ?? '2022-03-18T00:00:00Z',
    dismissed_at: o.dismissed_at ?? null,
    dismissed_reason: o.dismissed_reason ?? null,
    dismissed_comment: o.dismissed_comment ?? null,
    fixed_at: o.fixed_at ?? null,
  };
}

/** An SPDX SBOM as `GET /repos/{owner}/{repo}/dependency-graph/sbom` returns it. */
export function sbomJson(
  rootSpdxId: string,
  packages: { SPDXID: string; name: string; versionInfo?: string; purl?: string }[],
) {
  return {
    sbom: {
      documentDescribes: [rootSpdxId],
      packages: packages.map(({ purl, ...p }) => ({
        ...p,
        ...(purl ? { externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: purl }] } : {}),
      })),
    },
  };
}

/** A recursive tree as `GET /repos/{owner}/{repo}/git/trees/HEAD?recursive=1` returns it. Entries are blobs unless typed. */
export function treeJson(
  entries: { path: string; sha: string; type?: 'blob' | 'tree'; size?: number }[],
  o: { truncated?: boolean } = {},
) {
  return {
    sha: 'f'.repeat(40),
    url: 'https://api.github.com/repos/o/r/git/trees/HEAD',
    tree: entries.map(({ path, sha, type = 'blob', size }) => ({
      path,
      mode: type === 'tree' ? '040000' : '100644',
      type,
      sha,
      ...(size === undefined ? {} : { size }),
    })),
    truncated: o.truncated ?? false,
  };
}

/** A blob as `GET /repos/{owner}/{repo}/git/blobs/{sha}` returns it: base64, with a line break after every 60 characters. */
export function blobJson(text: string) {
  const bytes = Buffer.from(text, 'utf8');
  const lines = bytes.toString('base64').match(/.{1,60}/g) ?? [];
  return { size: bytes.length, encoding: 'base64', content: lines.map((line) => `${line}\n`).join('') };
}
