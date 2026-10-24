# Package Vitals, Plan 1: Core, CLI, and Level 0 Checkup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `package-vitals` CLI that runs a Level 0 Checkup of the owner's GitHub account into a SQLite snapshot, and writes an account health report and per-repo charts in Markdown from that snapshot.

**Architecture:** A plain Node/TypeScript core with no Electron. It has a GET-only GitHub client, fetchers for repos, alerts, and SBOMs, a checkup orchestrator that writes one snapshot per run, read-only queries, and pure Markdown renderers. A thin CLI wires these together through injected dependencies (fetch, exec, clock, and output), so everything is testable without the network. This is stage 1 of the spec's suggested build order. Later plans add the Electron app, lockfiles, the plain-code check, triage, and MCP on top of this core.

**Tech Stack:**
- Node.js 24 or later, with built-in `node:sqlite`, `fetch`, `util.parseArgs`, and `child_process`. There are no runtime dependencies.
- TypeScript (strict, NodeNext modules, compiled with `tsc`).
- Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-10-24-package-vitals-design.md`. This plan covers Sections 2–4 (Level 0 only), the Checkup part of Section 7's "Other controls", and the app-generated parts of Section 10. The stack decision is in `docs/decisions/0001-tech-stack.md`.

**Plan decisions:** these are made here. The spec leaves them to the builder.
- **One npm package at the repo root.** The code is in `src/core` and `src/cli`. The Electron app and MCP server get their own folders in later plans and import `src/core`.
- **SQLite uses `node:sqlite` (`DatabaseSync`).** This was verified on 2026-10-24 in Node 24.5.0 and in Electron 45.0.0, which bundles Node 24.22.0, including WAL mode. `better-sqlite3` is not needed.
- **Data home:** `PACKAGE_VITALS_HOME` if set. Otherwise it is the same folder Electron's `app.getPath('userData')` will use for an app named `package-vitals`:
  - macOS: `~/Library/Application Support/package-vitals`
  - Linux: `$XDG_CONFIG_HOME/package-vitals`, falling back to `~/.config/package-vitals`
  - Windows: `%APPDATA%\package-vitals`
- **Alerts in every state:** fetch all of them by leaving out the `state` parameter. That returns `open`, `dismissed`, `auto_dismissed`, and `fixed`.
- **Snapshots are append-only.** Every Checkup inserts its own `snapshot_repos`, `alerts`, and `sbom_packages` rows, which is what makes trends possible.

## Global Constraints

- Node.js `>=24`. SQLite is accessed only through `node:sqlite`.
- The core must not depend on Electron: no `electron` import and no `safeStorage`, anywhere under `src/`.
- **The app never writes to GitHub itself.** The GitHub client issues GET requests only.
- **The GitHub token never leaves the host process.** It comes from `gh auth token`. It is never logged, never stored in the database, never written to reports, and never included in error messages.
- Forks and archived repos are skipped by default. The flags `--include-forks` and `--include-archived` include them.
- The collector limits how many requests run at once (default 8) and respects rate-limit headers.
- A 403 response saying "Dependabot alerts are disabled for this repository" means **not monitored**, never healthy.
- The collector fetches dismissed and fixed alerts as well as open ones.
- There is one SQLite file at `<data home>/vitals.db`, in WAL mode, and several processes can use it at once.
- Every figure in a report comes from the database.
- Repo-derived text is data, never markup. It is escaped in Markdown output.
- Reports count dismissed alerts separately from fixed ones.
- An owner is a user or an org. The first version handles only the authenticated user's own repos.

## Review Focus

1. **Advisory text containing `|`, line breaks, or HTML** (`<img src=x onerror=…>`). Report tables must stay intact, and the text must come out as text, not markup. The test is in Task 8.
2. **A 403 that is not "alerts disabled."** A missing permission or a rate limit must not be recorded as "not monitored." Rate limits are retried, and other 403s are recorded as errors. The tests are in Tasks 3 and 5.
3. **An interrupted or failed Checkup.** A snapshot left `running` or `failed` must never feed a report. Reports use the latest *complete* snapshot. The tests are in Tasks 6 and 7.
4. **Alerts with no patched version or no CVE** (`first_patched_version: null`, `cve_id: null`). These must be stored and shown as "No patched version", not crash or print "null". The tests are in Tasks 5 and 8.
5. **The app and the CLI using the database at the same time.** A read during another process's write must wait and then succeed, not fail with `SQLITE_BUSY`. The test is in Task 2.

---

## File Structure

```
package.json, tsconfig.json, tsconfig.test.json, vitest.config.ts
src/core/paths.ts                 data home and file locations
src/core/types.ts                 shared domain types
src/core/db/schema.ts             migration SQL
src/core/db/database.ts           openDatabase, transaction
src/core/github/client.ts         GET-only client: auth, pagination, rate limits, errors
src/core/github/token.ts          gh auth token
src/core/github/repos.ts          authenticated owner, repo listing
src/core/github/alerts.ts         Dependabot alerts for one repo
src/core/github/sbom.ts           SBOM for one repo
src/core/concurrency.ts           mapLimit
src/core/checkup/store.ts         snapshot writes
src/core/checkup/checkup.ts       runCheckup
src/core/queries/snapshots.ts     snapshot lookup
src/core/queries/account.ts       account-level aggregates
src/core/queries/repo.ts          one repo's alerts
src/core/reports/markdown.ts      escapeCell, formatCount, formatDate
src/core/reports/account-report.ts
src/core/reports/repo-chart.ts
src/core/reports/write.ts         file names, writing, reports table
src/cli/main.ts                   argument parsing and dispatch (testable)
src/cli/commands/checkup.ts
src/cli/commands/report.ts
src/cli/bin.ts                    executable entry point
test/helpers/fake-fetch.ts        fake GitHub HTTP
test/helpers/github-fixtures.ts   API-shaped JSON builders
test/helpers/seed.ts              seeds snapshots through store functions
test/**/<mirrors src>.test.ts
```

---

### Task 1: Project scaffold and data home

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `src/core/paths.ts`
- Test: `test/core/paths.test.ts`

**Interfaces:**
- Produces: `resolveDataHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): string`, and `dataPaths(home: string): { db: string; reports: string }`.

- [ ] **Step 1: Create the scaffold**
  - `package.json`:
    - `"name": "package-vitals"`, `"type": "module"`, `"private": true`, `"engines": { "node": ">=24" }`
    - `"bin": { "package-vitals": "dist/cli/bin.js" }`
    - scripts: `build`: `tsc -p tsconfig.json`, `test`: `vitest run`, `typecheck`: `tsc -p tsconfig.test.json --noEmit`
    - dev dependencies: `typescript`, `vitest`, `@types/node`
  - `tsconfig.json`: `strict`, `module`/`moduleResolution` set to `NodeNext`, `target` `ES2023`, `rootDir` `src`, `outDir` `dist`, `include` `["src"]`.
  - `tsconfig.test.json` extends it with `include` `["src", "test"]` and `noEmit`.
  - `vitest.config.ts` includes `test/**/*.test.ts`.
  - Run `npm install`.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveDataHome, dataPaths } from '../../src/core/paths.js';

describe('resolveDataHome', () => {
  it('prefers PACKAGE_VITALS_HOME', () => {
    expect(resolveDataHome({ PACKAGE_VITALS_HOME: '/tmp/pv' }, 'darwin', '/Users/t')).toBe('/tmp/pv');
  });
  it('uses Application Support on macOS', () => {
    expect(resolveDataHome({}, 'darwin', '/Users/t')).toBe('/Users/t/Library/Application Support/package-vitals');
  });
  it('uses XDG_CONFIG_HOME, then ~/.config, on Linux', () => {
    expect(resolveDataHome({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/t')).toBe('/x/cfg/package-vitals');
    expect(resolveDataHome({}, 'linux', '/home/t')).toBe('/home/t/.config/package-vitals');
  });
  it('uses APPDATA on Windows', () => {
    expect(resolveDataHome({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'win32', 'C:\\Users\\t'))
      .toBe('C:\\Users\\t\\AppData\\Roaming\\package-vitals');
  });
});

describe('dataPaths', () => {
  it('puts the database and reports under the home', () => {
    expect(dataPaths('/tmp/pv')).toEqual({ db: path.join('/tmp/pv', 'vitals.db'), reports: path.join('/tmp/pv', 'reports') });
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run test/core/paths.test.ts`
Expected: FAIL (cannot find module `paths.js`)

- [ ] **Step 4: Implement `resolveDataHome` and `dataPaths` in `src/core/paths.ts`**

Use `path.win32` when `platform === 'win32'` and `path.posix` otherwise. On Windows, if `APPDATA` is unset, fall back to `<homeDir>\AppData\Roaming`.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run test/core/paths.test.ts && npm run typecheck`
Expected: PASS, with no type errors

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.test.json vitest.config.ts src/core/paths.ts test/core/paths.test.ts
git commit -m "feat: scaffold project and resolve data home"
```

---

### Task 2: Database and schema

**Files:**
- Create: `src/core/db/schema.ts`, `src/core/db/database.ts`
- Test: `test/core/db/database.test.ts`

**Interfaces:**
- Produces:
  - `type Db = DatabaseSync`, re-exported from `node:sqlite`
  - `openDatabase(file: string): Db`. It accepts `':memory:'`, creates parent folders, sets the pragmas `journal_mode = WAL`, `foreign_keys = ON`, and `busy_timeout = 5000`, then runs the migrations.
  - `transaction<T>(db: Db, fn: () => T): T`, which uses `BEGIN IMMEDIATE`, `COMMIT`, and `ROLLBACK`
  - `SCHEMA_VERSION = 1`, tracked in `PRAGMA user_version`

Migration 1 is the following exact SQL. Later tasks use these table and column names.

```sql
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('user','org')),
  owner_login TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  error TEXT
);
CREATE TABLE repos (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL UNIQUE,
  is_private INTEGER NOT NULL,
  is_fork INTEGER NOT NULL,
  is_archived INTEGER NOT NULL,
  default_branch TEXT,
  pushed_at TEXT
);
CREATE TABLE snapshot_repos (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  repo_id INTEGER NOT NULL REFERENCES repos(id),
  alerts_status TEXT NOT NULL CHECK (alerts_status IN ('ok','not_monitored','error')),
  alerts_error TEXT,
  sbom_status TEXT NOT NULL CHECK (sbom_status IN ('ok','unavailable')),
  PRIMARY KEY (snapshot_id, repo_id)
);
CREATE TABLE alerts (
  snapshot_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','dismissed','auto_dismissed','fixed')),
  ecosystem TEXT NOT NULL,
  package_name TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  scope TEXT,
  relationship TEXT,
  ghsa_id TEXT NOT NULL,
  cve_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  summary TEXT NOT NULL,
  vulnerable_range TEXT,
  first_patched TEXT,
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  dismissed_reason TEXT,
  dismissed_comment TEXT,
  fixed_at TEXT,
  PRIMARY KEY (snapshot_id, repo_id, number),
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE INDEX alerts_by_snapshot_state ON alerts(snapshot_id, state, severity);
CREATE TABLE sbom_packages (
  snapshot_id INTEGER NOT NULL,
  repo_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  purl TEXT,
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
  kind TEXT NOT NULL CHECK (kind IN ('account','repo')),
  repo_id INTEGER REFERENCES repos(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 1: Write the failing tests** in `test/core/db/database.test.ts`
  - `migrates a fresh database`: `PRAGMA user_version` is `1`, and `sqlite_master` lists exactly these tables: `alerts`, `reports`, `repos`, `sbom_packages`, `snapshot_repos`, `snapshots`.
  - `uses WAL for files and keeps data on reopen`: open a file in an `mkdtemp` folder, insert a snapshot, close, and reopen. `PRAGMA journal_mode` returns `wal`, `user_version` is still `1`, and the snapshot row is still there.
  - `enforces foreign keys`: inserting an `alerts` row for snapshot 99 throws.
  - `transaction rolls back on throw`: inserting a snapshot inside `transaction` and then throwing leaves 0 snapshots.
  - **Review Focus 5:** `a second connection waits for a writer instead of failing`:
    - Open connections A and B on the same file.
    - On A, run `BEGIN IMMEDIATE` and insert a snapshot. Schedule `COMMIT` on A with `setTimeout(…, 200)`.
    - Then, on B, run an insert inside `transaction` from a worker thread or a child process. `node:sqlite` is synchronous, so B must run in a separate thread for this test.
    - The test passes when B's insert succeeds after A commits, and the table ends up with 2 snapshots with no `SQLITE_BUSY`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/db/database.test.ts`
Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement `schema.ts` (`MIGRATIONS: string[]`, `SCHEMA_VERSION`) and `database.ts` (`openDatabase`, `transaction`)**

Apply each migration whose index is at or above the current `user_version` inside one transaction, then set `PRAGMA user_version`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/core/db/database.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db test/core/db
git commit -m "feat: add SQLite database with schema v1"
```

---

### Task 3: GitHub client

**Files:**
- Create: `src/core/github/client.ts`, `test/helpers/fake-fetch.ts`
- Test: `test/core/github/client.test.ts`

**Interfaces:**
- Produces (`client.ts`):
  - `type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<Response>`
  - `class GitHubApiError extends Error { status: number; apiMessage: string; url: string }`. Its `message` is `` `${apiMessage} (HTTP ${status})` `` and never includes headers.
  - `interface GitHubClientOptions { token: string; fetch?: FetchLike; baseUrl?: string; sleep?: (ms: number) => Promise<void>; now?: () => number; maxRetries?: number }`. The defaults are global `fetch`, `https://api.github.com`, `setTimeout`, `Date.now`, and `3`.
  - `class GitHubClient { getJson<T>(pathOrUrl: string): Promise<T>; paginate<T>(path: string): Promise<T[]> }`. The client has no method that sends anything other than GET.
- Produces (`test/helpers/fake-fetch.ts`):
  - `fakeFetch(routes: Record<string, FakeRoute>): FetchLike & { calls: { url: string; method: string; headers: Record<string, string> }[] }`
  - Route keys are a path plus its query string, for example `/user/repos?affiliation=owner&per_page=100`.
  - `FakeRoute` is one of:
    - `{ status?: number; body?: unknown; headers?: Record<string, string> }`
    - an array of those, served in order, one per call
  - Unknown routes return 404 with `{ "message": "Not Found" }`.

Every request sends these headers:
- `Authorization: Bearer <token>`
- `Accept: application/vnd.github+json`
- `X-GitHub-Api-Version: 2022-11-28`
- `User-Agent: package-vitals`

How rate limits are handled:
- **403 or 429 with `retry-after`:** sleep `retry-after × 1000` ms, then retry.
- **403 or 429 with `x-ratelimit-remaining: 0`:** sleep `x-ratelimit-reset × 1000 − now() + 1000` ms, then retry.
- **Any other 4xx or 5xx:** throw `GitHubApiError`, using the body's `message` when it has one.
- Give up after `maxRetries` retries, by throwing the last error.

- [ ] **Step 1: Write the failing tests**

```ts
const TOKEN = 't0k3n-secret';
it('sends auth and API headers with GET', async () => {
  const f = fakeFetch({ '/user': { body: { login: 'TETRA2000' } } });
  await new GitHubClient({ token: TOKEN, fetch: f }).getJson('/user');
  expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.github.com/user' });
  expect(f.calls[0].headers).toMatchObject({
    Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'package-vitals' });
});
it('follows Link rel="next" across pages', async () => {
  const next = (p: number) => ({ link: `<https://api.github.com/items?per_page=2&page=${p}>; rel="next"` });
  const f = fakeFetch({
    '/items?per_page=2': { body: [1, 2], headers: next(2) },
    '/items?per_page=2&page=2': { body: [3, 4], headers: next(3) },
    '/items?per_page=2&page=3': { body: [5] } });
  expect(await new GitHubClient({ token: TOKEN, fetch: f }).paginate<number>('/items?per_page=2')).toEqual([1, 2, 3, 4, 5]);
});
it('throws GitHubApiError without leaking the token', async () => {
  const err = await new GitHubClient({ token: TOKEN, fetch: fakeFetch({}) }).getJson('/nope').catch(e => e);
  expect(err).toBeInstanceOf(GitHubApiError);
  expect(err).toMatchObject({ status: 404, apiMessage: 'Not Found' });
  expect(`${err} ${err.stack} ${JSON.stringify(err)}`).not.toContain(TOKEN);
});
it('waits for the primary rate limit reset, then retries', async () => {
  const sleep = vi.fn(async () => {});
  const f = fakeFetch({ '/user': [
    { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1010' } },
    { body: { login: 'TETRA2000' } }] });
  const c = new GitHubClient({ token: TOKEN, fetch: f, sleep, now: () => 1_000_000 });
  expect(await c.getJson('/user')).toEqual({ login: 'TETRA2000' });
  expect(sleep).toHaveBeenCalledWith(11_000);
});
it('honours retry-after on 429', async () => { /* 429 with retry-after: '3', then 200: sleep called with 3000 */ });
it('does not retry a permission 403', async () => {
  // Review Focus 2: 403, x-ratelimit-remaining '4999', message 'Resource not accessible by integration'
  // → rejects with GitHubApiError status 403, and sleep is never called
});
it('gives up after maxRetries', async () => { /* 4 responses of 429 with retry-after: '1' → rejects with status 429; sleep called 3 times */ });
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/github/client.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `fakeFetch`, `GitHubApiError`, and `GitHubClient`**

For `paginate`, parse `rel="next"` from the `link` header and resolve it against `baseUrl`. Every page must be a JSON array, or it throws `TypeError`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/core/github/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/github/client.ts test/helpers/fake-fetch.ts test/core/github/client.test.ts
git commit -m "feat: add GET-only GitHub client with pagination and rate limits"
```

---

### Task 4: Token, owner, and repo listing

**Files:**
- Create: `src/core/types.ts`, `src/core/github/token.ts`, `src/core/github/repos.ts`, `test/helpers/github-fixtures.ts`
- Test: `test/core/github/token.test.ts`, `test/core/github/repos.test.ts`

**Interfaces:**
- Consumes: `GitHubClient` (Task 3)
- Produces (`types.ts`):
  - `type Owner = { kind: 'user' | 'org'; login: string }`
  - `interface RepoInfo { fullName: string; isPrivate: boolean; isFork: boolean; isArchived: boolean; defaultBranch: string | null; pushedAt: string | null }`
- Produces (`token.ts`):
  - `type ExecLike = (cmd: string, args: string[]) => Promise<{ stdout: string }>`. It rejects with an error that has `code` (for example `ENOENT`) or a non-zero exit.
  - `class ToolError extends Error`
  - `getGitHubToken(exec: ExecLike): Promise<string>`. It runs `gh auth token` and returns the trimmed output. It throws a `ToolError` with one of these exact messages:
    - `GitHub CLI (gh) is not installed.` when the error is `ENOENT`
    - ``GitHub CLI is not logged in. Run `gh auth login`.`` otherwise, or when the output is empty
- Produces (`repos.ts`):
  - `getAuthenticatedOwner(client): Promise<Owner>`. It calls `GET /user` and returns `{ kind: 'user', login }`.
  - `listOwnerRepos(client, owner: Owner, opts: { includeForks: boolean; includeArchived: boolean }): Promise<RepoInfo[]>`, sorted by `fullName`. Users use `/user/repos?affiliation=owner&per_page=100`, and orgs use `/orgs/{login}/repos?type=all&per_page=100`.
- Produces (`github-fixtures.ts`): `repoJson(fullName: string, o?: { fork?: boolean; archived?: boolean; private?: boolean; pushed_at?: string })`, which returns the API shape `{ full_name, private, fork, archived, default_branch: 'main', pushed_at }`.

- [ ] **Step 1: Write the failing tests**
  - Token:
    - Output `"gho_abc\n"` gives `gho_abc`.
    - An exec that rejects with `{ code: 'ENOENT' }` gives the "not installed" message.
    - An exec that rejects with `{ code: 1 }` gives the "not logged in" message.
    - Empty output gives the "not logged in" message.
  - Repos:
    - `getAuthenticatedOwner` returns `{ kind: 'user', login: 'TETRA2000' }`.
    - The user listing calls exactly `/user/repos?affiliation=owner&per_page=100`. The org listing for `{ kind: 'org', login: 'acme' }` calls `/orgs/acme/repos?type=all&per_page=100`.
    - Given `TETRA2000/b`, a fork `TETRA2000/a`, an archived `TETRA2000/c`, and `TETRA2000/d`, the defaults return `['TETRA2000/b', 'TETRA2000/d']`. Both include flags return all four, sorted.
    - Fields map correctly: `private` to `isPrivate`, `pushed_at` to `pushedAt`, and so on.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/github/token.test.ts test/core/github/repos.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `types.ts`, `token.ts`, `repos.ts`, and `repoJson`**

- [ ] **Step 4: Run the tests and make sure they pass**

Run: the same command
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/github/token.ts src/core/github/repos.ts test/helpers/github-fixtures.ts test/core/github/token.test.ts test/core/github/repos.test.ts
git commit -m "feat: read gh token and list owner repos"
```

---

### Task 5: Dependabot alerts and SBOM fetchers

**Files:**
- Create: `src/core/github/alerts.ts`, `src/core/github/sbom.ts`
- Modify: `src/core/types.ts`, `test/helpers/github-fixtures.ts`
- Test: `test/core/github/alerts.test.ts`, `test/core/github/sbom.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `GitHubApiError` (Task 3)
- Produces (added to `types.ts`):
  - `type Severity = 'critical' | 'high' | 'medium' | 'low'`
  - `type AlertState = 'open' | 'dismissed' | 'auto_dismissed' | 'fixed'`
  - `interface DependabotAlert { number: number; state: AlertState; ecosystem: string; packageName: string; manifestPath: string; scope: 'runtime' | 'development' | null; relationship: string | null; ghsaId: string; cveId: string | null; severity: Severity; summary: string; vulnerableRange: string | null; firstPatched: string | null; createdAt: string; dismissedAt: string | null; dismissedReason: string | null; dismissedComment: string | null; fixedAt: string | null }`
  - `type AlertsResult = { status: 'ok'; alerts: DependabotAlert[] } | { status: 'not_monitored' } | { status: 'error'; message: string }`
  - `interface SbomPackage { name: string; version: string | null; purl: string | null }`
  - `type SbomResult = { status: 'ok'; packages: SbomPackage[] } | { status: 'unavailable'; message: string }`
  - `interface SeverityCounts { critical: number; high: number; medium: number; low: number }`
- Produces:
  - `fetchRepoAlerts(client, fullName: string): Promise<AlertsResult>`. It paginates `/repos/{fullName}/dependabot/alerts?per_page=100`, with no `state` parameter so that every state comes back.
  - `fetchRepoSbom(client, fullName: string): Promise<SbomResult>`, using `GET /repos/{fullName}/dependency-graph/sbom`.
- Produces (fixtures): `alertJson(o?: Partial<…>)` and `sbomJson(rootSpdxId: string, packages: { SPDXID: string; name: string; versionInfo?: string; purl?: string }[])`. The API shapes they mirror:

```json
{ "number": 41, "state": "open",
  "dependency": { "package": { "ecosystem": "npm", "name": "minimist" },
                  "manifest_path": "package-lock.json", "scope": "runtime", "relationship": "transitive" },
  "security_advisory": { "ghsa_id": "GHSA-aaaa-bbbb-cccc", "cve_id": "CVE-2021-0001",
                         "summary": "Prototype pollution", "severity": "critical" },
  "security_vulnerability": { "vulnerable_version_range": "< 0.2.4",
                              "first_patched_version": { "identifier": "0.2.4" } },
  "created_at": "2022-03-18T00:00:00Z", "dismissed_at": null, "dismissed_reason": null,
  "dismissed_comment": null, "fixed_at": null }
```

```json
{ "sbom": { "documentDescribes": ["SPDXRef-root"],
            "packages": [ { "SPDXID": "SPDXRef-root", "name": "com.github.TETRA2000/slack-deck" },
                          { "SPDXID": "SPDXRef-npm-minimist", "name": "npm:minimist", "versionInfo": "0.0.8",
                            "externalRefs": [ { "referenceType": "purl", "referenceLocator": "pkg:npm/minimist@0.0.8" } ] } ] } }
```

How errors map in `fetchRepoAlerts`:
- A `GitHubApiError` with status 403 whose `apiMessage` matches `/Dependabot alerts are disabled/i` becomes `{ status: 'not_monitored' }`.
- Any other `GitHubApiError` becomes `{ status: 'error', message: err.message }`.
- Severity `moderate` maps to `medium`.

- [ ] **Step 1: Write the failing tests**
  - `fetches all states`: the only call is `/repos/TETRA2000/slack-deck/dependabot/alerts?per_page=100`.
  - `maps every field`: the fixture above gives `{ number: 41, state: 'open', ecosystem: 'npm', packageName: 'minimist', manifestPath: 'package-lock.json', scope: 'runtime', relationship: 'transitive', ghsaId: 'GHSA-aaaa-bbbb-cccc', cveId: 'CVE-2021-0001', severity: 'critical', summary: 'Prototype pollution', vulnerableRange: '< 0.2.4', firstPatched: '0.2.4', createdAt: '2022-03-18T00:00:00Z', dismissedAt: null, dismissedReason: null, dismissedComment: null, fixedAt: null }`.
  - **Review Focus 4:** `handles a missing patch and CVE`: `first_patched_version: null` and `cve_id: null` give `firstPatched: null` and `cveId: null`.
  - `maps moderate to medium`.
  - `keeps dismissed fields`: `state: 'dismissed'`, `dismissed_reason: 'tolerable_risk'`, and `dismissed_comment: 'Package Vitals: …'` are carried through.
  - `disabled is not monitored`: 403 `{ message: 'Dependabot alerts are disabled for this repository.' }` gives `{ status: 'not_monitored' }`.
  - **Review Focus 2:** `other 403 is an error`: 403 `{ message: 'Resource not accessible by integration' }` (with `x-ratelimit-remaining: '4999'`) gives `{ status: 'error', message: 'Resource not accessible by integration (HTTP 403)' }`.
  - `sbom maps packages and drops the root`: the fixture gives `[{ name: 'npm:minimist', version: '0.0.8', purl: 'pkg:npm/minimist@0.0.8' }]`.
  - `sbom 404 is unavailable`: gives `{ status: 'unavailable', message: 'Not Found (HTTP 404)' }`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/github/alerts.test.ts test/core/github/sbom.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the type additions, `alerts.ts`, `sbom.ts`, and the fixture builders**

- [ ] **Step 4: Run the tests and make sure they pass**

Run: the same command
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/github/alerts.ts src/core/github/sbom.ts test/helpers/github-fixtures.ts test/core/github/alerts.test.ts test/core/github/sbom.test.ts
git commit -m "feat: fetch Dependabot alerts and SBOMs per repo"
```

---

### Task 6: Checkup orchestration and snapshot store

**Files:**
- Create: `src/core/concurrency.ts`, `src/core/checkup/store.ts`, `src/core/checkup/checkup.ts`
- Test: `test/core/concurrency.test.ts`, `test/core/checkup/checkup.test.ts`

**Interfaces:**
- Consumes: `Db`, `transaction` (Task 2), `GitHubClient` (Task 3), `listOwnerRepos` (Task 4), `fetchRepoAlerts`, `fetchRepoSbom`, and types (Task 5)
- Produces:
  - `mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>`. Results come back in input order, and at most `limit` calls run at once.
  - From `store.ts`:
    - `createSnapshot(db, owner: Owner, startedAt: string): number`, with status `running`
    - `finishSnapshot(db, id: number, status: 'complete' | 'failed', finishedAt: string, error?: string): void`
    - `upsertRepo(db, repo: RepoInfo): number`. It inserts the repo, or updates every field on a `full_name` conflict, and returns `repos.id`.
    - `recordRepoResult(db, snapshotId: number, repoId: number, alerts: AlertsResult, sbom: SbomResult): void`. It writes the `snapshot_repos` row, all `alerts` rows, and all `sbom_packages` rows in one `transaction`.
  - From `checkup.ts`:
    - `interface CheckupDeps { db: Db; client: GitHubClient; now: () => Date; onProgress?: (p: { done: number; total: number; repo: string }) => void }`
    - `interface CheckupOptions { owner: Owner; includeForks: boolean; includeArchived: boolean; concurrency: number }`
    - `interface CheckupSummary { snapshotId: number; reposChecked: number; notMonitored: number; errors: number; open: SeverityCounts }`
    - `runCheckup(deps: CheckupDeps, opts: CheckupOptions): Promise<CheckupSummary>`

How a Checkup runs:
1. Create the snapshot.
2. List the repos. If listing throws, finish the snapshot as `failed` with the error's message, then rethrow.
3. Upsert each repo.
4. Use `mapLimit(repos, concurrency, …)` to fetch alerts and the SBOM for each repo, call `recordRepoResult`, and call `onProgress`.
5. Finish the snapshot as `complete`.

A per-repo error never fails the snapshot. Timestamps are `now().toISOString()`.

- [ ] **Step 1: Write the failing tests**
  - `mapLimit preserves order and never exceeds limit`: run 10 items with `limit` 3 and random 1–5 ms delays. The highest number of calls running at once is 3 or fewer, and the results match the input order.
  - `runCheckup records a complete snapshot`. Use a fake GitHub with `/user/repos…` returning `TETRA2000/a`, `TETRA2000/b`, and `TETRA2000/c`, where:
    - `a` returns 2 alerts, one open critical and one dismissed high, and its SBOM is OK with 1 package.
    - `b` is "disabled" (403).
    - `c` has a 404 alerts route, and its SBOM returns 404.

    Expected:
    - The snapshot `status` is `complete`, and `finished_at` is not null.
    - The `snapshot_repos` statuses are `a: ok, b: not_monitored, c: error`.
    - `alerts` has 2 rows, with states `open` and `dismissed`.
    - `sbom_packages` has 1 row.
    - The summary equals `{ snapshotId: 1, reposChecked: 3, notMonitored: 1, errors: 1, open: { critical: 1, high: 0, medium: 0, low: 0 } }`.
  - **Review Focus 3:** `a failed listing marks the snapshot failed`: when `/user/repos…` returns 500, `runCheckup` rejects, and the snapshot row has `status` `failed` and a non-null `error`.
  - `a second checkup appends a snapshot and upserts repos`: run twice, with `a`'s `pushed_at` changed in between. That gives 2 snapshots, still 3 `repos` rows, and `a.pushed_at` holding the new value.
  - `reports progress`: `onProgress` is called 3 times with `total: 3`, and the final `done` is `3`.
  - `never stores the token`: after a Checkup run with token `t0k3n-secret`, a dump of every row of every table (`SELECT *` over the names in `sqlite_master`) doesn't contain `t0k3n-secret`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/concurrency.test.ts test/core/checkup/checkup.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `concurrency.ts`, `store.ts`, and `checkup.ts`**

- [ ] **Step 4: Run the tests and make sure they pass**

Run: the same command
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/concurrency.ts src/core/checkup test/core/concurrency.test.ts test/core/checkup
git commit -m "feat: run a Level 0 checkup into a snapshot"
```

---

### Task 7: Report queries

**Files:**
- Create: `src/core/queries/snapshots.ts`, `src/core/queries/account.ts`, `src/core/queries/repo.ts`, `test/helpers/seed.ts`
- Test: `test/core/queries/snapshots.test.ts`, `test/core/queries/account.test.ts`, `test/core/queries/repo.test.ts`

**Interfaces:**
- Consumes: the store functions (Task 6) and types (Tasks 4 and 5)
- Produces (`snapshots.ts`):
  - `interface SnapshotRow { id: number; ownerKind: 'user' | 'org'; ownerLogin: string; startedAt: string; finishedAt: string | null; status: 'running' | 'complete' | 'failed' }`
  - `getSnapshot(db, id: number): SnapshotRow | null`
  - `latestCompleteSnapshot(db, ownerLogin?: string): SnapshotRow | null`
  - `previousCompleteSnapshot(db, s: SnapshotRow): SnapshotRow | null`, which is the latest complete snapshot for the same owner with a smaller `id`
- Produces (`account.ts`). Every function takes `(db, snapshotId, …)`:
  - `openSeverityCounts(db, snapshotId, repoId?: number): SeverityCounts`
  - `interface StateCounts { open: number; dismissed: number; autoDismissed: number; fixed: number }` and `alertStateCounts(db, snapshotId): StateCounts`
  - `interface MonitoringSummary { checked: number; monitored: number; notMonitored: string[]; errors: { repo: string; message: string }[]; withOpenAlerts: number }` and `monitoringSummary(db, snapshotId)`. The repo names are sorted.
  - `interface WorstRepo { fullName: string; critical: number; high: number; open: number; oldestOpenAlert: string | null }` and `worstRepos(db, snapshotId, limit: number)`. These are ordered by critical, then high, then open, all descending, then by `fullName` ascending. Only repos with at least one open alert are included.
  - `interface TreatmentRow { ecosystem: string; packageName: string; repoCount: number; patchedVersions: string[] }` and `criticalTreatmentPlan(db, snapshotId, limit: number)`:
    - It covers open critical alerts only.
    - `repoCount` counts distinct repos.
    - `patchedVersions` holds the distinct non-null `first_patched` values, sorted.
    - Rows are ordered by `repoCount` descending, then `packageName` ascending.
  - `type AgeBucket = 'under-30-days' | '30-90-days' | '90-365-days' | '1-2-years' | 'over-2-years'`, `interface AgeBucketRow { bucket: AgeBucket; all: number; critical: number }`, and `openAlertAges(db, snapshotId, now: Date): AgeBucketRow[]`:
    - It always returns 5 rows, in the order above.
    - The age is `now − created_at` in days, with buckets split at `< 30`, `< 90`, `< 365`, and `< 730`.
- Produces (`repo.ts`):
  - `interface RepoAlertsView { fullName: string; alertsStatus: 'ok' | 'not_monitored' | 'error'; alertsError: string | null; open: DependabotAlert[]; dismissed: DependabotAlert[] }`
  - `repoAlerts(db, snapshotId, fullName: string): RepoAlertsView | null`:
    - `open` is sorted by severity rank (critical first), then by `createdAt` ascending.
    - `dismissed` covers both `dismissed` and `auto_dismissed`.
- Produces (`seed.ts`):
  - `seedSnapshot(db, spec: { owner?: string; status?: 'running' | 'complete' | 'failed'; finishedAt?: string; repos: { name: string; alertsStatus?: 'ok' | 'not_monitored' | 'error'; alerts?: Partial<DependabotAlert>[] }[] }): number`
  - It is built on the store functions. `name` is the repo name without its owner, and the full name is `` `${owner ?? 'TETRA2000'}/${name}` ``. Alert defaults: `state` `open`, `severity` `high`, `ecosystem` `npm`, and an increasing `number`.

- [ ] **Step 1: Write the failing tests**
  - **Review Focus 3:** `latestCompleteSnapshot ignores running and failed snapshots`: seed snapshot 1 as complete, 2 as failed, and 3 as running. The result is snapshot 1. `previousCompleteSnapshot` of snapshot 1 is `null`.
  - `openSeverityCounts counts only open alerts`: 2 open critical, 1 dismissed critical, and 1 fixed high give `{ critical: 2, high: 0, medium: 0, low: 0 }`.
  - `alertStateCounts keeps dismissed and fixed apart`: gives `{ open: 2, dismissed: 1, autoDismissed: 1, fixed: 3 }` for a matching seed.
  - `monitoringSummary`: repos `b` (not monitored), `a` (ok, 1 open alert), `c` (error with message `Not Found (HTTP 404)`), and `d` (ok, no alerts) give `{ checked: 4, monitored: 2, notMonitored: ['TETRA2000/b'], errors: [{ repo: 'TETRA2000/c', message: 'Not Found (HTTP 404)' }], withOpenAlerts: 1 }`.
  - `worstRepos order`: `x` (2 critical, 1 high), `y` (2 critical, 3 high), and `z` (0 critical, 9 high) give `['TETRA2000/y', 'TETRA2000/x', 'TETRA2000/z']`. `oldestOpenAlert` is the earliest `createdAt` among open alerts.
  - `criticalTreatmentPlan`: `form-data` is critical in repos `a` and `b`, with two alerts in `a`, patched in `4.0.4` and `2.5.4`. `tar` is critical in repo `a`. The result is `[{ ecosystem: 'npm', packageName: 'form-data', repoCount: 2, patchedVersions: ['2.5.4', '4.0.4'] }, { …, packageName: 'tar', repoCount: 1 }]`.
  - `openAlertAges`: with `now = 2026-10-24T00:00:00Z` and open alerts created on 2026-10-10, 2026-08-01, 2025-12-01 (critical), 2025-01-01, and 2019-05-01, each bucket has `all: 1`. `90-365-days` has `critical: 1`.
  - `repoAlerts`: open alerts are sorted critical before high, then oldest first. `dismissed` includes `auto_dismissed`. An unknown repo gives `null`. A not-monitored repo gives `alertsStatus: 'not_monitored'` with empty lists.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/queries`
Expected: FAIL

- [ ] **Step 3: Implement `seed.ts` and the three query modules** in SQL against the Task 2 schema

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/core/queries`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/queries test/core/queries test/helpers/seed.ts
git commit -m "feat: add snapshot and report queries"
```

---

### Task 8: Markdown reports

**Files:**
- Create: `src/core/reports/markdown.ts`, `src/core/reports/account-report.ts`, `src/core/reports/repo-chart.ts`, `src/core/reports/write.ts`
- Test: `test/core/reports/markdown.test.ts`, `test/core/reports/account-report.test.ts`, `test/core/reports/repo-chart.test.ts`, `test/core/reports/write.test.ts`

**Interfaces:**
- Consumes: the queries (Task 7) and `Db` (Task 2)
- Produces (`markdown.ts`):
  - `escapeCell(text: string): string`. It replaces `&`, `<`, and `>` with `&amp;`, `&lt;`, and `&gt;`, escapes `|` as `\|`, and collapses line breaks and runs of whitespace into a single space.
  - `formatCount(n: number): string`, using `en-US` grouping.
  - `formatChange(n: number | null): string`, which gives `+N`, `-N`, `0`, or `n/a`.
  - `formatDate(iso: string | null): string`, which gives `YYYY-MM-DD` or `—`.
  - `formatTimestamp(iso: string): string`, which gives `YYYY-MM-DD HH:MM` in UTC.
  - `formatPlural(n: number, word: string): string`, which gives `1 repo`, `2 repos`, or `10,007 repos`, with the count formatted by `formatCount`. Every "{n} repos" in report and CLI copy uses it.
- Produces (`account-report.ts`):
  - `interface AccountReportData { ownerLogin: string; snapshotId: number; finishedAt: string; open: SeverityCounts; change: SeverityCounts | null; states: StateCounts; monitoring: MonitoringSummary; worst: WorstRepo[]; treatment: TreatmentRow[]; ages: AgeBucketRow[] }`
  - `buildAccountReportData(db, snapshotId: number, now: Date): AccountReportData`. It uses `worstRepos` with limit 10 and `criticalTreatmentPlan` with limit 10. `change` is the current minus the previous complete snapshot, or `null` when there is no previous one.
  - `renderAccountReport(d: AccountReportData): string`
- Produces (`repo-chart.ts`):
  - `interface RepoChartData { snapshotId: number; finishedAt: string; view: RepoAlertsView; open: SeverityCounts; oldestOpenAlert: string | null }`
  - `buildRepoChartData(db, snapshotId: number, fullName: string): RepoChartData | null`
  - `renderRepoChart(d: RepoChartData): string`
- Produces (`write.ts`):
  - `accountReportFileName(s: SnapshotRow): string`, giving `` `${date}-account-snapshot-${id}.md` ``
  - `repoChartFileName(s: SnapshotRow, fullName: string): string`, giving `` `${date}-repo-${owner}-${name}-snapshot-${id}.md` ``. Here `date` is the UTC date of `finishedAt`, and every character outside `[A-Za-z0-9._-]` in the owner or name becomes `_`.
  - `writeReport(db, reportsDir: string, r: { kind: 'account' | 'repo'; snapshotId: number; repoId: number | null; fileName: string; content: string; createdAt: string }): string`. It creates `reportsDir`, writes the file, inserts a `reports` row, and returns the absolute path. It throws if the resolved path is outside `reportsDir`.

The account report has this exact structure. Headings and fixed phrases are copy.

```markdown
# Account health report: {ownerLogin}

Snapshot {snapshotId}, completed {YYYY-MM-DD HH:MM} UTC.

## Headline

{open.critical} critical and {open.high} high open alerts across {formatPlural(monitoring.withOpenAlerts, 'repo')}. Triage has not run yet, so these are Dependabot's raw counts.

## Open alerts by severity

| Severity | Open | Change since previous snapshot |
|---|---:|---:|
| Critical | … | … |   (then High, Medium, Low)

## Alert states

| Open | Dismissed | Auto-dismissed | Fixed |
|---:|---:|---:|---:|

## Repos

{formatPlural(checked, 'repo')} checked: {monitored} monitored, {notMonitored} not monitored, {errors} with errors.

### Not monitored

Dependabot alerts are turned off for these repos, so they have no data:

- `owner/name`            (or the single line "None.")

### Errors                 (this section appears only when there are errors)

- `owner/name`: {escaped message}

## Worst repos

| Repo | Critical | High | Open | Oldest open alert |

## Treatment plan

Packages with an open critical alert, by how many repos they affect:

| Package | Ecosystem | Repos | Patched in |   ("Patched in" joins with ", ", or shows "No patched version")

## How long alerts have been open

| Age | All open | Critical |   (rows: Under 30 days, 30–90 days, 90–365 days, 1–2 years, Over 2 years)
```

The repo chart has this structure:
- `# Repo chart: {fullName}`
- the same snapshot line as the account report
- `## Vital signs`, with a table `| Critical | High | Medium | Low | Oldest open alert |`
- `## Open alerts`, with a table `| Severity | Package | Ecosystem | Manifest | Scope | Advisory | Patched in |`. The Advisory cell is `{ghsaId}: {summary}`. When there are none, it shows `No open alerts.` instead.
- `## Dismissed alerts`, with a table `| Package | Advisory | Reason | Comment |`, or `No dismissed alerts.`

Two cases replace everything after the snapshot line with one sentence:
- For `not_monitored`: `Dependabot alerts are turned off for this repo, so there is no data.`
- For `error`: ``The Checkup couldn't read alerts for this repo: {escaped alertsError}``

Every repo-derived string in either report goes through `escapeCell`.

- [ ] **Step 1: Write the failing tests**
  - `escapeCell`:
    - `'a|b'` gives `'a\\|b'`
    - `'x\n  y'` gives `'x y'`
    - `'<img src=x onerror=alert(1)>'` gives `'&lt;img src=x onerror=alert(1)&gt;'`
    - `'A & B'` gives `'A &amp; B'`
  - `formatCount(10007)` gives `'10,007'`. `formatChange` gives `'+3'` for 3, `'-2'` for -2, `'0'` for 0, and `'n/a'` for null.
  - `formatPlural(1, 'repo')` gives `'1 repo'`, and `formatPlural(126, 'repo')` gives `'126 repos'`.
  - `formatTimestamp('2026-10-24T05:07:09Z')` gives `'2026-10-24 05:07'`.
  - `renderAccountReport`, with data `open: { critical: 522, high: 4439, medium: 4018, low: 1028 }`, `withOpenAlerts: 126`, and `change: null`:
    - The output contains `522 critical and 4,439 high open alerts across 126 repos.`
    - It contains `| Critical | 522 | n/a |`.
    - It contains `## Not monitored` followed by `None.` when the list is empty.
    - It has no `### Errors` section when there are no errors.
    - A treatment row with `patchedVersions: []` renders `No patched version` (**Review Focus 4**).
  - `buildAccountReportData` with two seeded complete snapshots, where criticals go 2 then 5, gives `change.critical === 3`. The rendered output contains `| Critical | 5 | +3 |`.
  - **Review Focus 1:** `renderRepoChart` escapes advisory text: the summary `Bad | thing\n<img src=x onerror=alert(1)>` renders in one table row as `Bad \| thing &lt;img src=x onerror=alert(1)&gt;`, and the output contains no `<img`.
  - `renderRepoChart` shows `No open alerts.` for a monitored repo with no open alerts. It shows exactly the not-monitored sentence for a not-monitored repo.
  - `writeReport`:
    - It writes `<tmp>/reports/2026-10-24-account-snapshot-3.md` and inserts 1 `reports` row.
    - `repoChartFileName` for `TETRA2000/slack-deck` gives `2026-10-24-repo-TETRA2000-slack-deck-snapshot-3.md`.
    - A `fileName` of `'../escape.md'` throws.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/core/reports`
Expected: FAIL

- [ ] **Step 3: Implement `markdown.ts`, `account-report.ts`, `repo-chart.ts`, and `write.ts`**

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/core/reports`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/reports test/core/reports
git commit -m "feat: render account and repo Markdown reports"
```

---

### Task 9: CLI

**Files:**
- Create: `src/cli/main.ts`, `src/cli/commands/checkup.ts`, `src/cli/commands/report.ts`, `src/cli/bin.ts`
- Test: `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `resolveDataHome` and `dataPaths` (Task 1), `openDatabase` (Task 2), `GitHubClient` and `FetchLike` (Task 3), `getGitHubToken`, `ExecLike`, `ToolError`, and `getAuthenticatedOwner` (Task 4), `runCheckup` (Task 6), `getSnapshot` and `latestCompleteSnapshot` (Task 7), and the report builders, renderers, and writers (Task 8)
- Produces:
  - `interface CliDeps { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; homeDir: string; stdout: (s: string) => void; stderr: (s: string) => void; fetch: FetchLike; exec: ExecLike; now: () => Date }`
  - `main(argv: string[], deps: CliDeps): Promise<number>`. It returns the exit code: `0` for success, `1` for an error, and `2` for a usage error.
  - `bin.ts` starts with `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning`. It calls `main(process.argv.slice(2), realDeps)`, where `realDeps.exec` wraps `execFile`, and sets `process.exitCode`.

Commands:
- **`checkup [--include-forks] [--include-archived] [--concurrency N]`**
  - `N` is an integer from 1 to 32, with a default of 8. Anything else is a usage error (exit 2).
  - Progress goes to stderr as `[{done}/{total}] {repo}`.
  - On success, stdout gets exactly: `Checked {formatPlural(reposChecked, 'repo')}: {critical} critical, {high} high, {medium} medium, {low} low open alerts. {notMonitored} not monitored, {errors} with errors. Snapshot {snapshotId}.`. Counts use `formatCount`.
- **`report account [--snapshot N]`** writes the account report and prints the absolute path.
- **`report repo <owner/name> [--snapshot N]`** writes the repo chart and prints the absolute path. If the repo isn't in the snapshot, stderr gets `Repo {name} is not in snapshot {id}.` and the exit code is 1.
- **Errors:**
  - With no complete snapshot, or when `--snapshot` names a snapshot that isn't complete, stderr gets ``No completed checkup yet. Run `package-vitals checkup` first.`` and the exit code is 1.
  - A `ToolError` prints its message and exits with 1.
  - No arguments, or an unknown command, prints usage text that lists the three command forms above to stderr and exits with 2.

- [ ] **Step 1: Write the failing tests** in `test/cli/cli.test.ts`. These use a temp `PACKAGE_VITALS_HOME`, `fakeFetch`, and an `exec` that returns `gho_test\n`.
  - `checkup then report account, end to end`:
    - The fake GitHub has `/user` giving `TETRA2000` and 2 repos: one with 1 open critical alert, one disabled.
    - `main(['checkup'])` returns 0, and stdout is exactly `Checked 2 repos: 1 critical, 0 high, 0 medium, 0 low open alerts. 1 not monitored, 0 with errors. Snapshot 1.`
    - Then `main(['report', 'account'])` returns 0, and stdout is a path under `<home>/reports/` to a file that contains `1 critical and 0 high open alerts across 1 repo.`
  - `report repo writes a chart`: after the Checkup, `main(['report', 'repo', 'TETRA2000/a'])` returns 0, and the file contains `# Repo chart: TETRA2000/a`. An unknown repo returns 1, with stderr `Repo TETRA2000/zzz is not in snapshot 1.`
  - `report before any checkup`: returns 1, with the "No completed checkup yet" message.
  - `gh missing`: when `exec` rejects with `{ code: 'ENOENT' }`, `checkup` returns 1, with stderr `GitHub CLI (gh) is not installed.`
  - `usage`: `main([])` and `main(['frobnicate'])` return 2. `main(['checkup', '--concurrency', '0'])` returns 2.
  - `token is never printed`: across all of the above, stdout and stderr never contain `gho_test`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run test/cli`
Expected: FAIL

- [ ] **Step 3: Implement `main.ts` (`util.parseArgs`, with dispatch to the command modules), `commands/checkup.ts`, `commands/report.ts`, and `bin.ts`**

- [ ] **Step 4: Run the tests, the whole suite, and the build**

Run: `npm test && npm run typecheck && npm run build && node dist/cli/bin.js; echo "exit $?"`
Expected: all tests PASS, no type errors, the build succeeds, and the last command prints usage followed by `exit 2`

- [ ] **Step 5: Check the Electron constraint**

Run: `grep -rn "electron" src/ || echo "no electron imports"`
Expected: `no electron imports`

- [ ] **Step 6: Commit**

```bash
git add src/cli test/cli
git commit -m "feat: add package-vitals CLI for checkup and reports"
```

---

### Task 10: Verify against the real account (read-only, nothing committed)

**Interfaces:**
- Consumes: the built CLI (Task 9)

This only reads from GitHub. Measured on 2026-10-24, the account had 355 active repos, 10,007 open alerts (522 critical, 4,439 high, 4,018 medium, 1,028 low), and 10 repos with Dependabot turned off. Expect small drift since then.

- [ ] **Step 1: Run a Checkup into a throwaway home**

Run: `export PACKAGE_VITALS_HOME="$(mktemp -d)"; gh api rate_limit --jq .resources.core.remaining; node dist/cli/bin.js checkup; gh api rate_limit --jq .resources.core.remaining`
Expected: the summary line says about 355 repos, with critical near 522 and `10 not monitored`. Fetching dismissed and fixed alerts adds pages, so expect a few hundred more requests than the measured 360, but well under 5,000.

- [ ] **Step 2: Check that dismissed and fixed alerts were stored**

Run: `node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.PACKAGE_VITALS_HOME+'/vitals.db');console.log(d.prepare('select state, count(*) n from alerts group by state').all())"`
Expected: rows for `open` (about 10,000) and for at least one of `fixed`, `dismissed`, or `auto_dismissed`

- [ ] **Step 3: Generate and read both reports**

Run: `node dist/cli/bin.js report account && node dist/cli/bin.js report repo TETRA2000/slack-deck`
Expected: two paths are printed. The account report's headline reads `522 critical and 4,439 high open alerts across 126 repos.` (give or take drift), the Treatment plan lists `form-data` first, and both files render cleanly in a Markdown viewer.

- [ ] **Step 4: Record the result** in the PR description or hand-off notes: the actual counts, the API requests used, and the run time. Don't commit the throwaway home.

---

## Later plans

Each one follows the spec's build order and gets its own plan:

2. The Electron app: priority queue, side panel, repo cards, treatment plan, and Reports view, with UI hardening
3. Level 1 lockfiles (npm and RubyGems), OSV API lookup and comparison, dependency chains, direct vs. transitive, and tier 1, including the bundler rule. This plan also adds the "outdated dependencies" vital sign, because it needs lockfile versions and registry metadata. Plan 1's vital signs leave it out.
4. The plain-code check: tier 2 on hardened shallow clones
5. Sandboxed Claude triage, the job queue, verdict validation, caching, overrides, OpenVEX, dismiss and reopen scripts, and dismissal tracking
6. The MCP server, the three skills, and reports with Claude-written narrative
