import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, type CliDeps } from '../../src/cli/main.js';
import type { FetchLike } from '../../src/core/github/client.js';
import type { ExecLike } from '../../src/core/github/token.js';
import { fakeFetch, type FakeRoute } from '../helpers/fake-fetch.js';
import { alertJson, repoJson } from '../helpers/github-fixtures.js';

const TOKEN = 'gho_test';
const NO_CHECKUP = 'No completed checkup yet. Run `package-vitals checkup` first.';

const ROUTES: Record<string, FakeRoute> = {
  '/user': { body: { login: 'TETRA2000' } },
  '/user/repos?affiliation=owner&per_page=100': { body: [
    repoJson('TETRA2000/a'), repoJson('TETRA2000/b'), repoJson('TETRA2000/f', { fork: true })] },
  '/repos/TETRA2000/a/dependabot/alerts?per_page=100': { body: [alertJson({ number: 1, severity: 'critical' })] },
  '/repos/TETRA2000/b/dependabot/alerts?per_page=100': {
    status: 403, body: { message: 'Dependabot alerts are disabled for this repository.' } },
};

const everything: string[] = [];
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
afterAll(() => {
  // Across every test in this file, the token never reaches stdout or stderr.
  expect(everything.length).toBeGreaterThan(0);
  expect(everything.join('\n')).not.toContain(TOKEN);
});

function cli(o: { fetch?: FetchLike; exec?: ExecLike } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'pv-cli-'));
  homes.push(home);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    env: { PACKAGE_VITALS_HOME: home },
    platform: 'linux',
    homeDir: '/nonexistent',
    stdout: (s) => { out.push(s); everything.push(s); },
    stderr: (s) => { err.push(s); everything.push(s); },
    fetch: o.fetch ?? fakeFetch(ROUTES),
    exec: o.exec ?? (async () => ({ stdout: `${TOKEN}\n` })),
    now: () => new Date('2026-10-24T05:07:09.000Z'),
  };
  const run = async (...argv: string[]) => {
    out.length = 0;
    err.length = 0;
    return main(argv, deps);
  };
  return { home, out, err, run };
}

describe('package-vitals CLI', () => {
  it('checkup then report account, end to end', async () => {
    const c = cli();
    expect(await c.run('checkup')).toBe(0);
    expect(c.out).toEqual(['Checked 2 repos: 1 critical, 0 high, 0 medium, 0 low open alerts. 1 not monitored, 0 with errors. Snapshot 1.']);
    // Progress goes to stderr, one line per repo, in completion order.
    expect(c.err.map((l) => l.slice(0, 6))).toEqual(['[1/2] ', '[2/2] ']);
    expect(c.err.map((l) => l.slice(6)).sort()).toEqual(['TETRA2000/a', 'TETRA2000/b']);

    expect(await c.run('report', 'account')).toBe(0);
    expect(c.out).toHaveLength(1);
    const file = c.out[0]!;
    expect(file).toBe(path.join(c.home, 'reports', '2026-10-24-account-snapshot-1.md'));
    expect(readFileSync(file, 'utf8')).toContain('1 critical and 0 high open alerts across 1 repo.');
  });

  it('includes forks and archived repos when asked', async () => {
    const c = cli();
    expect(await c.run('checkup', '--include-forks', '--include-archived', '--concurrency', '2')).toBe(0);
    expect(c.out[0]).toMatch(/^Checked 3 repos: .* 1 not monitored, 1 with errors\. Snapshot 1\.$/);
  });

  it('report repo writes a chart', async () => {
    const c = cli();
    await c.run('checkup');
    expect(await c.run('report', 'repo', 'TETRA2000/a')).toBe(0);
    expect(c.out[0]).toBe(path.join(c.home, 'reports', '2026-10-24-repo-TETRA2000-a-snapshot-1.md'));
    expect(readFileSync(c.out[0]!, 'utf8')).toContain('# Repo chart: TETRA2000/a');

    expect(await c.run('report', 'repo', 'TETRA2000/zzz')).toBe(1);
    expect(c.err).toEqual(['Repo TETRA2000/zzz is not in snapshot 1.']);
    expect(c.out).toEqual([]);
  });

  it('report --snapshot uses that snapshot only if it is complete', async () => {
    const c = cli();
    await c.run('checkup');
    expect(await c.run('report', 'account', '--snapshot', '1')).toBe(0);
    expect(await c.run('report', 'account', '--snapshot', '2')).toBe(1);
    expect(c.err).toEqual([NO_CHECKUP]);
  });

  it('report before any checkup', async () => {
    const c = cli();
    expect(await c.run('report', 'account')).toBe(1);
    expect(c.err).toEqual([NO_CHECKUP]);
    expect(await c.run('report', 'repo', 'TETRA2000/a')).toBe(1);
    expect(c.err).toEqual([NO_CHECKUP]);
  });

  it('a failed checkup leaves no report to write', async () => {
    const c = cli({ fetch: fakeFetch({ ...ROUTES,
      '/user/repos?affiliation=owner&per_page=100': { status: 500, body: { message: 'Server Error' } } }) });
    expect(await c.run('checkup')).toBe(1);
    expect(c.err).toEqual(['Server Error (HTTP 500)']);
    expect(await c.run('report', 'account')).toBe(1);
    expect(c.err).toEqual([NO_CHECKUP]);
  });

  it('gh missing', async () => {
    const c = cli({ exec: async () => { throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); } });
    expect(await c.run('checkup')).toBe(1);
    expect(c.err).toEqual(['GitHub CLI (gh) is not installed.']);
  });

  it('usage', async () => {
    const c = cli();
    for (const argv of [[], ['frobnicate'], ['checkup', '--concurrency', '0'], ['checkup', '--concurrency', '33'],
      ['checkup', '--concurrency', '1.5'], ['checkup', '--concurrency', 'x'], ['checkup', '--frob'], ['checkup', 'extra'],
      ['report'], ['report', 'repo'], ['report', 'repo', 'no-slash'], ['report', 'account', 'extra'],
      ['report', 'account', '--snapshot', '0'], ['report', 'account', '--snapshot', 'latest']]) {
      expect(await c.run(...argv), argv.join(' ')).toBe(2);
      const text = c.err.join('\n');
      expect(text).toContain('package-vitals checkup [--include-forks] [--include-archived] [--concurrency N]');
      expect(text).toContain('package-vitals report account [--snapshot N]');
      expect(text).toContain('package-vitals report repo <owner/name> [--snapshot N]');
      expect(c.out).toEqual([]);
    }
  });
});
