import { describe, it, expect } from 'vitest';
import { GitHubClient } from '../../../src/core/github/client.js';
import { fetchRepoAlerts } from '../../../src/core/github/alerts.js';
import { fakeFetch, type FakeRoute } from '../../helpers/fake-fetch.js';
import { alertJson } from '../../helpers/github-fixtures.js';

const ALERTS = '/repos/TETRA2000/slack-deck/dependabot/alerts?per_page=100';

function alerts(route: FakeRoute) {
  const f = fakeFetch({ [ALERTS]: route });
  return { f, result: fetchRepoAlerts(new GitHubClient({ token: 't', fetch: f, sleep: async () => {} }), 'TETRA2000/slack-deck') };
}

describe('fetchRepoAlerts', () => {
  it('fetches all states', async () => {
    const { f, result } = alerts({ body: [] });
    expect(await result).toEqual({ status: 'ok', alerts: [] });
    expect(f.calls.map((c) => c.url)).toEqual([`https://api.github.com${ALERTS}`]);
  });

  it('maps every field', async () => {
    expect(await alerts({ body: [alertJson()] }).result).toEqual({ status: 'ok', alerts: [{
      number: 41, state: 'open', ecosystem: 'npm', packageName: 'minimist', manifestPath: 'package-lock.json',
      scope: 'runtime', relationship: 'transitive', ghsaId: 'GHSA-aaaa-bbbb-cccc', cveId: 'CVE-2021-0001',
      severity: 'critical', summary: 'Prototype pollution', vulnerableRange: '< 0.2.4', firstPatched: '0.2.4',
      createdAt: '2022-03-18T00:00:00Z', dismissedAt: null, dismissedReason: null, dismissedComment: null, fixedAt: null }] });
  });

  // Review Focus 4
  it('handles a missing patch and CVE', async () => {
    const r = await alerts({ body: [alertJson({ first_patched_version: null, cve_id: null })] }).result;
    expect(r).toMatchObject({ status: 'ok', alerts: [{ firstPatched: null, cveId: null }] });
  });

  it('maps moderate to medium', async () => {
    const r = await alerts({ body: [alertJson({ severity: 'moderate' })] }).result;
    expect(r).toMatchObject({ status: 'ok', alerts: [{ severity: 'medium' }] });
  });

  it('keeps dismissed fields', async () => {
    const r = await alerts({ body: [alertJson({ state: 'dismissed', dismissed_at: '2026-01-02T00:00:00Z',
      dismissed_reason: 'tolerable_risk', dismissed_comment: 'Package Vitals: dev only (snapshot 3)' })] }).result;
    expect(r).toMatchObject({ status: 'ok', alerts: [{ state: 'dismissed', dismissedAt: '2026-01-02T00:00:00Z',
      dismissedReason: 'tolerable_risk', dismissedComment: 'Package Vitals: dev only (snapshot 3)' }] });
  });

  it('rejects an alert with an unknown severity', async () => {
    await expect(alerts({ body: [alertJson({ severity: 'unknown' })] }).result).rejects.toThrow(/severity/);
  });

  it('disabled is not monitored', async () => {
    const r = await alerts({ status: 403, body: { message: 'Dependabot alerts are disabled for this repository.' } }).result;
    expect(r).toEqual({ status: 'not_monitored' });
  });

  // Review Focus 2
  it('other 403 is an error', async () => {
    const r = await alerts({ status: 403, body: { message: 'Resource not accessible by integration' },
      headers: { 'x-ratelimit-remaining': '4999' } }).result;
    expect(r).toEqual({ status: 'error', message: 'Resource not accessible by integration (HTTP 403)' });
  });

  it('a rate-limited 403 is retried, not recorded as not monitored', async () => {
    const r = await alerts([
      { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' } },
      { body: [alertJson()] }]).result;
    expect(r).toMatchObject({ status: 'ok', alerts: [{ number: 41 }] });
  });
});
