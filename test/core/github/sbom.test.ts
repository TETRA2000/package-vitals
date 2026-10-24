import { describe, it, expect } from 'vitest';
import { GitHubClient } from '../../../src/core/github/client.js';
import { fetchRepoSbom } from '../../../src/core/github/sbom.js';
import { fakeFetch } from '../../helpers/fake-fetch.js';
import { sbomJson } from '../../helpers/github-fixtures.js';

const SBOM = '/repos/TETRA2000/slack-deck/dependency-graph/sbom';
const client = (f: ReturnType<typeof fakeFetch>) => new GitHubClient({ token: 't', fetch: f });

describe('fetchRepoSbom', () => {
  it('sbom maps packages and drops the root', async () => {
    const f = fakeFetch({ [SBOM]: { body: sbomJson('SPDXRef-root', [
      { SPDXID: 'SPDXRef-root', name: 'com.github.TETRA2000/slack-deck' },
      { SPDXID: 'SPDXRef-npm-minimist', name: 'npm:minimist', versionInfo: '0.0.8', purl: 'pkg:npm/minimist@0.0.8' },
    ]) } });
    expect(await fetchRepoSbom(client(f), 'TETRA2000/slack-deck')).toEqual({ status: 'ok', packages: [
      { name: 'npm:minimist', version: '0.0.8', purl: 'pkg:npm/minimist@0.0.8' }] });
  });

  it('keeps a package with no version or purl', async () => {
    const f = fakeFetch({ [SBOM]: { body: sbomJson('SPDXRef-root', [{ SPDXID: 'SPDXRef-x', name: 'actions:checkout' }]) } });
    expect(await fetchRepoSbom(client(f), 'TETRA2000/slack-deck')).toEqual({ status: 'ok', packages: [
      { name: 'actions:checkout', version: null, purl: null }] });
  });

  it('sbom 404 is unavailable', async () => {
    expect(await fetchRepoSbom(client(fakeFetch({})), 'TETRA2000/slack-deck'))
      .toEqual({ status: 'unavailable', message: 'Not Found (HTTP 404)' });
  });
});
