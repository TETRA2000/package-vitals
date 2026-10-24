import { GitHubApiError, type GitHubClient } from './client.js';
import type { SbomPackage, SbomResult } from '../types.js';

interface SbomJson {
  sbom: {
    documentDescribes?: string[];
    packages?: {
      SPDXID: string;
      name: string;
      versionInfo?: string;
      externalRefs?: { referenceType: string; referenceLocator: string }[];
    }[];
  };
}

/** The dependency graph's SPDX SBOM for one repo, without the repo's own root package. */
export async function fetchRepoSbom(client: GitHubClient, fullName: string): Promise<SbomResult> {
  let json: SbomJson;
  try {
    json = await client.getJson<SbomJson>(`/repos/${fullName}/dependency-graph/sbom`);
  } catch (err) {
    if (!(err instanceof GitHubApiError)) throw err;
    return { status: 'unavailable', message: err.message };
  }
  const roots = new Set(json.sbom.documentDescribes ?? []);
  const packages: SbomPackage[] = (json.sbom.packages ?? [])
    .filter((p) => !roots.has(p.SPDXID))
    .map((p) => ({
      name: p.name,
      version: p.versionInfo ?? null,
      purl: p.externalRefs?.find((r) => r.referenceType === 'purl')?.referenceLocator ?? null,
    }));
  return { status: 'ok', packages };
}
