# Package Vitals, Plan 3: Lockfiles, OSV, Dependency Chains, and Tier 1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Checkup reads npm and RubyGems lockfiles. It looks every locked package up in OSV, compares the results with Dependabot, and works out dependency chains, direct vs. transitive, and tier 1 ("not shipped"). It also counts outdated dependencies. The queue, side panel, repo cards, and reports show all of it.

**Architecture:**
- Level 1 runs inside the Checkup, after each repo's Level 0 calls. It lists the repo's files through the Git Trees API and fetches only lockfiles and their companions (`package.json`, `Gemfile`) as blobs. It never clones.
- The core's own parsers turn each lockfile into a dependency graph (`DepGraph`). Pure functions answer the questions the spec asks: dev-only, direct or transitive, and the shortest chains.
- Then the host makes three kinds of public, credential-free lookups:
  - OSV (`POST /v1/querybatch`, then `GET /v1/vulns/{id}`, cached across Checkups)
  - npm and RubyGems, for latest versions and for direct-dependency upgrades
- A pure builder joins Dependabot alerts and OSV results into **findings**, the queue's new unit, and stores them in the snapshot. Each finding has a source, chains, a relationship, and tier 1.
- This is stage 3 of the spec's build order. Tier 2 and the bundler half of tier 1 (Plan 4) and Claude triage (Plan 5) come later.

**Tech Stack:** As in Plans 1 and 2 (Node 24, TypeScript 7, `node:sqlite`, Electron 45, React 19, Vitest 5). Plus `yaml@2.9.1`, the core's first runtime dependency. It has no dependencies of its own and no install scripts, and it is used only to read `pnpm-lock.yaml`.

**Spec:** `docs/superpowers/specs/2026-10-24-package-vitals-design.md`. This plan covers:
- Section 4, "Level 1: lockfiles (npm and RubyGems)", in full
- Section 5, tier 1, except the bundler rule's plain-code check (Plan 4). Until then a dev-only finding in a bundler repo stays "Not triaged".
- The parts of Section 7 that Plan 2 left for this plan:
  - installed version, dependency chain, direct-dependency upgrade, and outdated dependencies
  - the dev-only count, and the tier and source filters
- The Section 10 report figures that depend on them

It builds on Plans 1 and 2 (`docs/superpowers/plans/2026-10-24-package-vitals-{1-core-checkup,2-electron-app}.md`).

**What the owner's account holds** (read-only survey on 2026-10-25, 360 tree requests and one blob per lockfile):
- 350 of 355 trees were read: 4 repos are empty (HTTP 409) and 1 returned 404. No tree is truncated.
- Lockfiles: 69 `package-lock.json` (58 v3, 5 v2, 6 v1), 27 `yarn.lock` (all classic v1), 5 `pnpm-lock.yaml` (all v9.0), and 27 `Gemfile.lock`. There are also 146 `package.json` and 30 `Gemfile`, and no `npm-shrinkwrap.json`.
- None of them is under `node_modules/` or `vendor/`. The largest is 1.1 MB, and the total is about 21 MB.
- Dependabot's `manifest_path` is the lockfile path for every npm and Ruby alert, apart from 321 alerts on `package.json` and 6 on `.gemspec` files, in repos without a lockfile.
- Relationship, over 6,758 sampled open alerts: 1,072 direct, 3,724 transitive, 1,902 unknown, and 60 inconclusive.
- OSV (checked live): 1,000 queries per batch is the limit (1,001 returns HTTP 400 `too many queries`), and a full batch takes about 3 s. A result with no vulnerabilities is `{}`. GHSA records carry `database_specific.severity`; `MAL-` (malicious package) records have no severity and no aliases. RubyGems ranges are of type `ECOSYSTEM`.
- npm: `GET /-/package/<name>/dist-tags` is tiny and works for scoped names as `@scope%2Fname`. The abbreviated document (`Accept: application/vnd.npm.install-v1+json`) has each version's `dependencies` and `deprecated`, but can be MB-sized (`@types/node` is 2.3 MB).
- RubyGems: `GET /api/v1/versions/<name>/latest.json` returns HTTP 200 with `{"version":"unknown"}` for a gem that doesn't exist. `GET /info/<name>` (the compact index) lists every version with its dependencies.

**Plan decisions.** The spec leaves these to the builder. Those marked *(confirm)* are deviations for the owner to confirm.
- **Supported formats:** npm lockfile v1–v3 (and `npm-shrinkwrap.json`), yarn classic v1, pnpm lockfile v9, and Bundler's `Gemfile.lock` with the `Gemfile`'s groups. *(confirm)*
  - Spec Section 12 also names yarn berry and older pnpm. The account has none, so those files are recorded as **unsupported** and shown in a notice. They are never read as "no dependencies".
- **`yaml@2.9.1`, pinned exactly, is the core's first runtime dependency,** for `pnpm-lock.yaml`. *(confirm)* Plans 1 and 2 had kept the core dependency-free; a hand-written YAML reader for untrusted files is the riskier choice.
- **Findings become the queue's unit.** A finding is one open Dependabot alert, or one OSV advisory with no Dependabot alert, for a (repo, manifest, package).
  - Finding keys become `{ snapshotId, findingId }`.
  - Migration 2 backfills older snapshots' open alerts as Dependabot findings, so existing data keeps working.
- **Matching OSV to Dependabot:**
  - The two must have the same repo, the same project (lockfile), the same package, and the same advisory: the GHSA ID, or a CVE through the aliases.
  - A match with an open alert makes that finding's source **both**. A match with a dismissed or auto-dismissed alert adds nothing, because it counts as that alert. A match with only a *fixed* alert becomes an OSV-only finding, since the lockfile is still vulnerable.
  - OSV records that alias each other (GHSA and MAL) for the same package are one finding, under the GHSA ID.
- **OSV-only severity** is GHSA's `database_specific.severity`. A `MAL-` record is critical (malicious package). Anything else is critical with severity source "assumed", which the side panel says.
- **OSV-only age** is when Package Vitals first saw the finding: the created date carries over from the previous complete snapshot of the same scope.
- **Tier 1 rule (conservative).** A finding is "not shipped" only when every one of these holds:
  1. No source says runtime: Dependabot's scope isn't `runtime`, and the lockfile analysis isn't false.
  2. Some source says dev-only:
     - When the lockfile was read, the lockfile analysis must say dev-only. The analysis says that only when:
       - the graph is complete (roots known, no unresolved required dependency, groups known),
       - every installed copy of the package (any version, not only the vulnerable ones) is reachable, but not through a runtime edge, and
       - npm's own `dev` flag, where present, agrees.
     - When no lockfile was read, Dependabot's `development` scope is enough, except for npm.
  3. For npm, the project's lockfile was read and no JS bundler was detected.
  4. The finding is npm or RubyGems. Spec Section 5 says findings in other ecosystems "stay not triaged" in this version.
- **JS bundler detection** follows the spec's list, plus `react-scripts`, `@vue/cli-service`, `@angular-devkit/build-angular`, `browserify`, `@rspack/core`, and `tsup`, and (added in Task 7's review) Metro/Expo/React Native, Rsbuild, `@vercel/ncc`, Docusaurus, VitePress, tsdown, rolldown, Snowpack, and Parcel 2. It looks at dependencies, config files, and scripts in the project and its workspaces. Uncertainty (too many `package.json` files to read, a truncated tree, an unreadable `package.json`, or a workspace pattern too costly to match) counts as a bundler. A repo with more than 50 lockfiles isn't read at all and shows in a notice.
- **Outdated dependencies:** a direct dependency (prod or dev) whose locked version is older than the registry's latest release: npm's `latest` dist-tag, or RubyGems' `latest.json`.
  - It is counted per repo, once per ecosystem and name.
  - Git, path, and link dependencies are skipped.
  - Failed lookups are counted as "not checked", never as up to date.
- **Direct-dependency upgrade:**
  - For each direct dependency D on a path to the vulnerable package, find the lowest stable, non-deprecated release of D, above the locked one, that declares none of D's children leading there.
  - Offer the upgrade only when, with those edges removed, no root reaches the vulnerable package. It is based on D's declared dependencies; a new version's own new dependencies aren't followed, and the side panel says so.
  - No upgrade is offered when the vulnerable package is itself direct (the patched version is the fix), or when some direct dependency has no qualifying release.
  - This needs the npm abbreviated document or the RubyGems compact index, so it is fetched only for direct dependencies on vulnerable chains.
- **Storage:** lockfiles and their direct dependencies are stored per snapshot, and graphs are kept only in memory during the Checkup. A finding stores up to 10 shortest chains as JSON, plus the total number of shortest chains (counted up to 10,000). OSV records are cached across snapshots by ID and `modified`.
- **Level 1 runs for every repo,** including ones Dependabot doesn't monitor. Those are exactly where OSV shows what Dependabot misses.
- **Failures never fail the snapshot.**
  - A tree, blob, or parse failure is recorded for its repo or lockfile.
  - An OSV failure is recorded for the snapshot, and OSV-only findings are then missing, which every view says.
  - A registry failure leaves dependencies "not checked".
- **Queue order:** triage state first (not triaged, then not shipped), then severity, then oldest first.
- **The summary strip's Dev-only** counts not-shipped findings.
- **The treatment plan** counts critical findings that tier 1 hasn't ruled out, OSV-only ones included.
- **The account report** keeps its Dependabot alert tables, which are comparable with earlier snapshots. It adds sections for OSV and for plain-code triage.
- **The commit SHA isn't recorded yet;** Plan 4's clones record it. Lockfiles store their blob SHA, which is the lockfile hash verdict caching will need.

## Global Constraints

- The core and CLI need Node.js `>=24`. The app runs on Electron `^45`. SQLite is used only through `node:sqlite`.
- The core must not depend on Electron (`test/core/no-electron.test.ts`).
- **Level 1 fetches files through the Git Trees API (`git/trees/HEAD?recursive=1`), not a sparse clone.** It filters for the file names below, then fetches only those blobs. It ignores paths under `node_modules/` and `vendor/`.
  - npm: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, and `pnpm-lock.yaml`
  - RubyGems: `Gemfile.lock` and `Gemfile`
- The Checkup stays API-only plus lockfiles and never clones. Nothing from a repo is executed. Only the core's own parsers read lockfiles.
- Vulnerabilities are looked up through `POST https://api.osv.dev/v1/querybatch`, with details fetched for each match.
- **The GitHub client stays GET-only, and the GitHub token goes only to `api.github.com`.** OSV, npm, and RubyGems requests carry no credentials. They send only package names and versions, never a repo name, path, or token.
- **Plain-code tiers must be conservative.** When in doubt, don't rule the finding out.
- Each finding records its source: Dependabot, OSV, or both.
- **The app never writes to GitHub itself.**
- Repo-derived text is always rendered as text, never as HTML, and escaped in Markdown. That includes package names, versions, workspace names, lockfile paths, chains, advisory text, and parse errors. Parse errors never quote file content.
- Views and reports read only complete snapshots. A failed or interrupted Checkup never feeds a report.
- Counts that need later plans (reachable, uncertain) show "—", never 0. Anything not computed in a snapshot shows "—" or a notice, never 0.
- Every figure comes from the database.
- Never edit a migration that has shipped; this plan adds migration 2.
- Development and testing happen on macOS first. The Linux CI workflow must stay green.

## Review Focus

1. **A finding wrongly ruled out as not shipped (the spec's worst failure).** Inputs that must leave the finding "Not triaged":
   - a package reachable from both a dev and a runtime dependency
   - npm's `devOptional`
   - an unresolved required dependency
   - npm v1 without `package.json`
   - a `Gemfile` that can't be parsed, or gems in custom groups
   - Dependabot `runtime` against a dev-only lockfile
   - an npm finding with no lockfile read
   - a JS bundler detected in a workspace's dependencies, a config file, or a script

   Tests: Tasks 2, 3, 6, 7, and 10.
2. **Hostile or broken lockfiles:**
   - invalid JSON or YAML, a YAML alias bomb, or merge-conflict markers
   - packages named `__proto__` or `constructor`
   - dependency cycles, or nesting 100,000 levels deep
   - a lockfile over 20 MB

   Each must be recorded as an error for that lockfile only, with a fixed message. There is no hang, no crash, and no prototype pollution. Tests: Tasks 3–7.
3. **OSV, npm, or RubyGems failing:** HTTP 429 or 5xx, network errors, a batch that still fails after retries, `{"version":"unknown"}`, and 404 for private packages. The snapshot still completes. The OSV failure is shown as missing data, never as "no OSV findings", and failed lookups show as "not checked". Tests: Tasks 8, 9, 12, 14, and 15.
4. **OSV matched against Dependabot wrongly**, which produces duplicates or hides findings:
   - a CVE-only alias match, or GHSA plus MAL records for one package
   - one advisory across two installed versions
   - hits on dismissed and on fixed alerts
   - `rubygems` vs `RubyGems`
   - `package.json` manifests

   Tests: Task 10.
5. **Lockfile text on screen and in reports.** Package, workspace, and root names, versions, and lockfile paths containing `<img src=x onerror=alert(1)>`, Markdown links, pipes, or backticks must stay literal. That applies to chains, the side panel, notices, reports, and copied Markdown. Tests: Tasks 14, 15, and 16.

---

## File Structure

```
package.json, package-lock.json                 + "yaml": "2.9.1" in dependencies
src/core/types.ts                               + Level 1, chain, finding, and progress types
src/core/versions.ts                            version order and GHSA ranges for npm and RubyGems
src/core/lockfiles/graph.ts                     DepGraph, ParseResult, reachability, dev-only, chains
src/core/lockfiles/package-json.ts              package.json reading
src/core/lockfiles/npm.ts                       package-lock.json and npm-shrinkwrap.json, v1–v3
src/core/lockfiles/yarn.ts                      yarn.lock v1 (berry → unsupported)
src/core/lockfiles/pnpm.ts                      pnpm-lock.yaml v9 (older → unsupported)
src/core/lockfiles/bundler.ts                   Gemfile.lock and Gemfile groups
src/core/lockfiles/scan.ts                      tree listing, blob fetch, projects, JS bundler detection
src/core/http/public-client.ts                  credential-free client pinned to one origin
src/core/osv/osv.ts                             OSV batch lookup, advisory cache, normalization
src/core/registry/registry.ts                   npm and RubyGems latest versions and version metadata
src/core/registry/upgrades.ts                   outdated check and direct-dependency upgrade planning
src/core/findings/tier-one.ts                   the tier 1 rule
src/core/findings/build.ts                      alerts + lockfiles + OSV → findings for one repo
src/core/db/schema.ts                           + migration 2
src/core/checkup/{store,checkup,account-checkup,format}.ts
src/core/queries/{findings,account,repo,level1}.ts
src/core/reports/{account-report,repo-chart,finding-markdown,finding-text}.ts
src/core/github/urls.ts                         + GitHub advisory URL
src/cli/commands/checkup.ts                     progress phases
src/app/shared/api.ts, src/app/main/{validate,main}.ts, src/app/main/handlers/{queue,actions}.ts
src/app/renderer/views/{QueueView,RepoCardsView}.tsx, src/app/renderer/App.tsx
src/app/renderer/components/{FindingList,SidePanel,Notices,CheckupButton}.tsx, styles.css
test/helpers/fake-http.ts                       fake for the public APIs (GET and POST)
test/helpers/github-fixtures.ts                 + treeJson, blobJson
test/helpers/seed.ts                            + findings, lockfiles, OSV status
README.md
```

---

### Task 1: Version order and GHSA ranges

**Files:**
- Create: `src/core/versions.ts`
- Modify: `src/core/types.ts`
- Test: `test/core/versions.test.ts`

**Interfaces:**
- Produces, in `types.ts`: `export type PackageEcosystem = 'npm' | 'rubygems'` (Dependabot's names)
- Produces, in `versions.ts`:
  - `compareVersions(ecosystem: PackageEcosystem, a: string, b: string): number | null`. The result is negative, zero, or positive, or null when either version isn't valid for the ecosystem.
    - npm uses SemVer 2.0 precedence. A leading `v` or `=` is allowed, and build metadata is ignored.
    - RubyGems uses Gem::Version order:
      - A version's segments are runs of digits or of letters. A `-` is read as `.pre.`.
      - A letter segment sorts before any number.
      - Missing segments count as 0, so `1.0` equals `1`.
  - `isStableVersion(ecosystem, v): boolean`. That means no SemVer prerelease for npm, and no letter segment for RubyGems.
  - `inVulnerableRange(ecosystem, version: string, range: string | null): boolean | null` takes GHSA's `vulnerable_version_range`: comparators (`=`, `<`, `<=`, `>`, `>=`, each followed by a version) separated by commas, all of which must hold. The result is null for a null range, an unparseable range, or an invalid version.

- [ ] **Step 1: Write the failing tests**
  - `compares npm versions by SemVer precedence`:
    - Sorting `['2.0.0', '1.0.0', '1.10.0', '1.0.0-beta', '1.0.1', '1.0.0-alpha.1', '1.0.0-alpha']` gives `['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1', '1.10.0', '2.0.0']`.
    - `v1.2.3` and `1.2.3+build.5` both equal `1.2.3`.
    - `compareVersions('npm', 'latest', '1.0.0')` is null.
  - `compares gem versions like Gem::Version`:
    - Sorting gives `['1.0.a', '1.0.b1', '1.0', '1.0.1', '1.9', '1.10', '2.0.0.rc1', '2.0.0']`.
    - `1.0` equals `1`.
  - `knows stable versions`: npm `1.0.0` is stable and `1.0.0-rc.1` isn't; gems `7.1.0` is stable and `7.1.0.beta1` isn't.
  - `evaluates GHSA ranges`:
    - true: `0.0.8` in `< 0.2.4`; `1.2.5` in `>= 1.0.0, < 1.2.6`; `2.0.0` in `= 2.0.0`; gem `6.1.7.3` in `< 6.1.7.4`
    - false: `1.2.6` in `>= 1.0.0, < 1.2.6`
    - null: a null range, `~> 1.0`, and version `git+https://x`
- [ ] **Step 2: Run** `npx vitest run test/core/versions.test.ts`. Expected: FAIL, because the module doesn't exist.
- [ ] **Step 3: Implement** `versions.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: compare npm and gem versions and read GHSA ranges`.

---

### Task 2: The dependency graph and its questions

**Files:**
- Create: `src/core/lockfiles/graph.ts`
- Modify: `src/core/types.ts`
- Test: `test/core/lockfiles/graph.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
```ts
export interface ChainLink { name: string; version: string }
/** From a project root (`root` is its label) down to the vulnerable package, which is the last link. */
export interface DependencyChain { root: string; links: ChainLink[]; dev: boolean }
export type Relationship = 'direct' | 'transitive' | 'mixed';
```
- Produces, in `graph.ts`:
```ts
export type LockfileFormat = 'npm-v1' | 'npm-v2' | 'npm-v3' | 'yarn-v1' | 'pnpm-v9' | 'bundler';
export type EdgeKind = 'prod' | 'dev' | 'optional' | 'peer';
export interface DepEdge { to: number; kind: EdgeKind }
/** `registry`: comes from the public registry, not git, a path, or a tarball. `lockDev`: the lockfile's own dev flag, null when the format has none. */
export interface DepNode { id: number; name: string; version: string; registry: boolean; lockDev: boolean | null }
/** A project or workspace package. Its edges are its declared dependencies; only root edges can be 'dev'. */
export interface DepRoot { label: string; path: string; edges: DepEdge[] }
export interface DepGraph {
  format: LockfileFormat;
  roots: DepRoot[];
  nodes: DepNode[];      // nodes[i].id === i
  edges: DepEdge[][];    // edges[nodeId]: that package's own dependencies
  unresolved: string[];  // required dependencies the lockfile doesn't resolve, as "<from> > <name>"
  devKnown: boolean;     // false when dev and runtime can't be told apart (a Gemfile that couldn't be read)
}
export type ParseResult =
  | { status: 'ok'; graph: DepGraph }
  | { status: 'unsupported'; format: string; message: string }
  | { status: 'error'; message: string };
```
- Functions, which are iterative so that they end on cycles:
  - `isComplete(g): boolean`: has roots, has no unresolved dependency, and `devKnown`.
  - `reachable(g): Set<number>` and `runtimeReachable(g): Set<number>`. Runtime reachability starts at root edges of kind `prod`, `optional`, or `peer`, then follows every node edge.
  - `directIds(g): Set<number>`
  - `devOnly(g, targets: number[]): boolean | null`:
    - null when the graph isn't complete, `targets` is empty, or a target is unreachable
    - false when a target is runtime-reachable or has `lockDev === false`
    - true otherwise
  - `relationshipOf(g, targets): Relationship | null` (null for no targets)
  - `chainsTo(g, targets, limit = 10): { chains: DependencyChain[]; total: number }`:
    - It returns the shortest chains from any root, ordered by length, then root order, then link names.
    - `total` counts all shortest chains, up to 10,000.
    - `dev` is true when the chain's root edge is `dev`.

- [ ] **Step 1: Write the failing tests.** Build graphs as literals.
  - `a package reachable from a dev and a runtime dependency is not dev-only`: with root `prod→a→x` and `dev→b→x`, `devOnly([x])` is false and `devOnly([b])` is true.
  - `optional and peer edges are runtime`
  - `an incomplete graph gives no answer`: `devOnly` is null with `unresolved: ['a > gone']`, with `devKnown: false`, and with no roots.
  - `an unreachable target gives no answer`
  - `npm's own flag can veto dev-only`: the graph says dev-only, but the node has `lockDev: false`, so the result is false.
  - `cycles end`: with `a→b→a` from a dev root, `devOnly([b])` is true, and `chainsTo` returns one chain `[a, b]`.
  - `chainsTo lists the shortest chains`:
    - Root `slack-deck` `prod→mkdirp 0.5.1→minimist 0.0.8` gives `{ root: 'slack-deck', links: [{ name: 'mkdirp', version: '0.5.1' }, { name: 'minimist', version: '0.0.8' }], dev: false }`.
    - With 12 equal-length paths and `limit` 10, the result has 10 chains and `total` 12.
  - `relationshipOf tells direct, transitive, and mixed apart`
- [ ] **Step 2: Run** `npx vitest run test/core/lockfiles/graph.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `graph.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: model dependency graphs and find dev-only packages and chains`.

---

### Task 3: package.json and npm lockfiles

**Files:**
- Create: `src/core/lockfiles/package-json.ts`, `src/core/lockfiles/npm.ts`
- Test: `test/core/lockfiles/package-json.test.ts`, `test/core/lockfiles/npm.test.ts`

**Interfaces:**
- Consumes: `DepGraph`, `ParseResult` (Task 2).
- Produces:
```ts
/** Maps, not objects, so names like `constructor` and `__proto__` are ordinary keys. */
export interface PackageJson {
  name: string | null;
  dependencies: Map<string, string>; devDependencies: Map<string, string>;
  optionalDependencies: Map<string, string>; peerDependencies: Map<string, string>;
  scripts: Map<string, string>;
  workspaces: string[];   // the array form or `workspaces.packages`
}
export function readPackageJson(text: string): PackageJson | null   // null unless it is a JSON object
export function parseNpmLock(text: string, packageJson: PackageJson | null): ParseResult
```
- Rules for `parseNpmLock`:
  - **Versions:** `lockfileVersion` 1 is `npm-v1`, 2 is `npm-v2` (read `packages`, ignore the legacy `dependencies`), and 3 is `npm-v3`. Any other version is unsupported, with `Unsupported package-lock.json version <n>.`
  - **Errors:**
    - text that isn't JSON: `Not valid JSON.`
    - JSON that isn't an object with `lockfileVersion`: `Not a package-lock.json file.`
    - anything thrown while reading: `Couldn't read this lockfile.` No message quotes the file.
  - **v2/v3 roots:** `packages[""]` is the root (label `name` ?? `packageJson?.name` ?? `.`, path `.`). Every non-link entry whose key has no `node_modules` segment is a workspace root (label `name` ?? key, path = key). Root edges come from its `dependencies` (prod), `devDependencies` (dev), `optionalDependencies` (optional), and `peerDependencies` (peer).
  - **v2/v3 nodes:**
    - Every key containing `node_modules/` is a node.
    - Its name is the entry's `name` (aliases), or else the path after the last `node_modules/` (scoped: two segments).
    - `lockDev` is `dev === true`, so `devOptional` isn't dev.
    - `registry` is true when `resolved` is missing or starts with `https://registry.npmjs.org/` or `https://registry.yarnpkg.com/`.
    - A `link: true` entry points at its `resolved` path; an edge to a link whose target is a root is dropped.
  - **v2/v3 edge resolution** (Node's lookup): from location `L`, try `L/node_modules/<n>`, then each shorter parent's `…/node_modules/<n>`, down to `node_modules/<n>`.
  - **Unresolved dependencies:** one listed in `optionalDependencies`, or marked optional in `peerDependenciesMeta`, is skipped. Any other is added to `unresolved`.
  - **v1:** read the nested `dependencies` tree.
    - Each entry is a node, with `lockDev` = `dev === true`.
    - Edges come from `requires`, resolved in the entry's own `dependencies`, then each ancestor's, then the top level.
    - The single root comes from `packageJson`. Without it the graph has no roots, so it is incomplete.

- [ ] **Step 1: Write the failing tests.** Fixtures are objects passed through `JSON.stringify`.
  - `package-json.test.ts`:
    - `reads dependencies, scripts, and both workspaces forms`
    - `returns null for anything but a JSON object`: inputs `'[]'`, `'1'`, and `'{'`.
    - `keeps dependencies named __proto__ and constructor`
  - `npm.test.ts`:
    - `reads a v3 lockfile`: root `slack-deck` depends on `mkdirp ^0.5.1` and devDepends on `jest`. `chainsTo` minimist is `slack-deck → mkdirp 0.5.1 → minimist 0.0.8`, and `isComplete` is true.
    - `resolves nested node_modules before hoisted ones`: with `node_modules/a/node_modules/x` at 2.0.0 and `node_modules/x` at 1.0.0, `a` reaches 2.0.0 and the root reaches 1.0.0.
    - `reads dev flags, and devOptional isn't dev`
    - `workspaces are roots and links point at them`
    - `an alias keeps its real package name`: `node_modules/foo` with `{ name: 'lodash', version: '4.17.21' }` is node `lodash`.
    - `records unresolved required dependencies but not missing optional ones`
    - `marks non-registry packages`: the `resolved` values `git+ssh://…` and `file:…` give `registry: false`.
    - `reads a v1 lockfile with package.json`, and `a v1 lockfile without package.json has no roots`
    - `reports unsupported versions and broken files without quoting them`: version 4 (unsupported), `'{"lockfileVersion": 3, '` (`Not valid JSON.`), `'[]'` (`Not a package-lock.json file.`)
    - `survives hostile names and deep nesting`:
      - Packages named `__proto__` and `constructor` become nodes and resolve.
      - `Object.prototype` gains no keys.
      - A v1 lockfile nested 100,000 levels deep doesn't throw. It returns either `ok` or `error`, and an `error` has the message `Couldn't read this lockfile.`
- [ ] **Step 2: Run** `npx vitest run test/core/lockfiles`. Expected: FAIL.
- [ ] **Step 3: Implement** `package-json.ts` and `npm.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: read package.json and npm lockfiles v1 to v3`.

---

### Task 4: yarn.lock (classic)

**Files:**
- Create: `src/core/lockfiles/yarn.ts`
- Test: `test/core/lockfiles/yarn.test.ts`

**Interfaces:**
- Consumes: `PackageJson`, `readPackageJson` (Task 3), and `ParseResult`.
- Produces: `parseYarnLock(text: string, roots: { path: string; packageJson: PackageJson }[]): ParseResult`. The caller passes the project's `package.json` and its workspaces' (Task 7).
- Rules:
  - **Unsupported and broken files:**
    - A top-level `__metadata:` key means yarn berry, which is unsupported: `{ format: 'yarn-berry', message: "Yarn 2+ lockfiles aren't supported yet." }`.
    - A line starting with `<<<<<<<` is an error: `The lockfile has merge conflict markers.`
    - Bad structure is an error: `Not a valid yarn.lock file (line <n>).`
  - **Entries:**
    - `#` starts a comment.
    - An entry header is an unindented line ending in `:`, listing descriptors separated by `, `, each optionally double-quoted.
    - Body lines are indented 2 spaces: `key value` or `key "value"`.
    - `dependencies:` and `optionalDependencies:` open maps of `name range` indented 4 spaces.
    - Other keys are ignored.
  - **Nodes:**
    - There is one node per entry. Its name comes from the first descriptor, cut at the first `@` after position 0 (so git ranges containing `@` and `alias@npm:real@range` split correctly). A range `npm:<real>@<range>` names the real package.
    - `version` comes from the entry.
    - `registry` is true when the `resolved` host is `registry.yarnpkg.com` or `registry.npmjs.org`.
    - `lockDev` is null.
  - **Edges:**
    - Every descriptor maps to its entry.
    - Root edges come from each root's `dependencies`, `devDependencies`, and `optionalDependencies`, looked up as `<name>@<range>`. Peer dependencies are ignored, because yarn classic doesn't install them. A dependency named like another root's `name` (a workspace) is dropped.
    - Node edges come from `dependencies` (prod) and `optionalDependencies` (optional).
    - A missing required descriptor is added to `unresolved`.
  - **Roots:** each root's label is its `name` ?? `path`. With no roots the graph is incomplete.

- [ ] **Step 1: Write the failing tests**
  - `reads entries, shared descriptors, and dependencies`
  - `roots come from package.json files`: a devDependency's chain has `dev: true`, and `devOnly` is true for its subtree.
  - `npm: aliases name the real package`
  - `workspace packages are roots, not nodes`
  - `records unresolved required dependencies`
  - `berry, conflict markers, and broken files`: the exact statuses and messages above.
  - `hostile names`: an entry `"__proto__@^1.0.0":` resolves as a node, and `Object.prototype` gains no keys.
- [ ] **Step 2: Run** `npx vitest run test/core/lockfiles/yarn.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `yarn.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: read yarn classic lockfiles`.

---

### Task 5: pnpm-lock.yaml v9

**Files:**
- Modify: `package.json`, `package-lock.json` (`npm install --save-exact yaml@2.9.1`, in `dependencies`)
- Create: `src/core/lockfiles/pnpm.ts`
- Test: `test/core/lockfiles/pnpm.test.ts`

**Interfaces:**
- Produces: `parsePnpmLock(text: string): ParseResult`
- Rules:
  - **Parsing:** parse with `parse(text, { maxAliasCount: 100 })` from `yaml`. A parse error, an alias-count error included, gives `Not valid YAML.`
  - **Versions:** `lockfileVersion` `'9.0'` (or the number 9) is `pnpm-v9`. Any other value is unsupported, with `pnpm lockfile version <v> isn't supported yet.` A missing value is an error, with `Not a pnpm-lock.yaml file.`
  - **Roots:** each key of `importers` is a root, with path = key and label = key.
    - Its edges come from `dependencies` (prod), `devDependencies` (dev), and `optionalDependencies` (optional). Each entry is `{ specifier, version }`.
    - A `version` starting with `link:` is a workspace link and is dropped.
  - **Nodes:** there is one node per key of `snapshots`. A key is `<name>@<version>`, optionally followed by a peer suffix `(…)`.
    - The name is the part before the `@` that starts the version; scoped names begin with `@`.
    - The version is the part after that `@`, up to any `(`.
    - `registry` is true when `packages['<name>@<version>'].resolution` has `integrity` and no `tarball`, `type`, or `directory`.
    - `lockDev` is null.
  - **Edges:**
    - A dependency `n` with version `v` resolves to snapshot key `n@v`. When `v` itself contains `@` and doesn't start with `link:`, it is an alias: `v` is the snapshot key.
    - Node edges come from each snapshot's `dependencies` (prod) and `optionalDependencies` (optional). `transitivePeerDependencies` is ignored.
    - A missing required key is added to `unresolved`.

- [ ] **Step 1: Write the failing tests**
  - `reads importers, snapshots, and peer suffixes`: `vite: { specifier: ^5.0.0, version: 5.0.0(@types/node@20.0.0) }` resolves to the snapshot `vite@5.0.0(@types/node@20.0.0)`, node `vite 5.0.0`. The scoped name `@babel/core` parses.
  - `workspace importers are roots, and link: dependencies are dropped`
  - `aliases resolve to the real package`: `string-width-cjs: string-width@4.2.3`.
  - `older lockfile versions are unsupported`: `'6.0'`.
  - `invalid YAML, an alias bomb, and __proto__ keys`:
    - Ten levels of 10-way aliases give `Not valid YAML.` in under 1 s.
    - An importer key `__proto__` leaves `Object.prototype` unchanged.
- [ ] **Step 2: Run** `npx vitest run test/core/lockfiles/pnpm.test.ts`. Expected: FAIL.
- [ ] **Step 3: Install `yaml` and implement** `pnpm.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: read pnpm v9 lockfiles`.

---

### Task 6: Gemfile.lock and Gemfile groups

**Files:**
- Create: `src/core/lockfiles/bundler.ts`
- Test: `test/core/lockfiles/bundler.test.ts`

**Interfaces:**
- Produces:
  - `parseGemfileGroups(text: string): Map<string, string[]> | null`. It maps each gem name to its groups; an empty array means the default group. It returns null when the blocks don't balance.
  - `parseGemfileLock(lockText: string, gemfileText: string | null): ParseResult`
- Gemfile rules (text only, never evaluated):
  - `#` comments are stripped.
  - A gem line is `gem 'name'` or `gem "name"`. Its groups are:
    - options `group: :x`, `groups: [:x, :y]`, `:group => :x`, or `:groups => [...]`, as symbols or strings
    - plus every enclosing `group … do` block
  - The block stack:
    - pushes on a line whose code ends in `do` or `do |…|`, or starts with `if`, `unless`, `case`, `begin`, `while`, or `until` used as a statement
    - pops on `end`
- Gemfile.lock rules:
  - **Sections:** `GEM`, `GIT`, and `PATH` hold specs. `DEPENDENCIES` lists the direct gems. Every other section is ignored, including `PLATFORMS`, `RUBY VERSION`, `BUNDLED WITH`, and `CHECKSUMS`.
  - **Specs:**
    - A spec line is `name (version)` indented 4 spaces. A platform suffix is stripped: `-` followed by `x86`, `x64`, `x86_64`, `i386`–`i686`, `arm…`, `aarch64`, `universal`, `java`, `jruby`, `mswin…`, `mingw…`, `darwin…`, `linux…`, `freebsd…`, or `solaris…`, and the rest of the version. One gem version on several platforms is one node.
    - Lines indented 6 spaces under a spec (`dep (reqs)` or `dep`) are its prod edges, resolved by gem name.
    - `registry` is true only under a `GEM` section with `remote: https://rubygems.org/`.
    - `lockDev` is null.
  - **Root:** there is one root, with label `.` and path `.`. Its edges come from `DEPENDENCIES` lines (`name`, an optional `!`, optional `(reqs)`).
    - An edge is `dev` when the gem's Gemfile groups are non-empty and all in `development` or `test`. Otherwise it is `prod`, which includes gems missing from the Gemfile, such as a `gemspec`'s.
    - `devKnown` is true only when the groups parsed.
  - **Unresolved:** a spec dependency with no spec of that name is added to `unresolved`.
  - **Errors:** conflict markers give `The lockfile has merge conflict markers.` No `DEPENDENCIES` section gives `Not a Gemfile.lock file.`

- [ ] **Step 1: Write the failing tests**
  - `reads GEM, GIT, and PATH specs and the direct gems`
  - `Gemfile groups make development and test gems dev`. Each case:
    - `group :development, :test do` block: dev
    - `gem 'pry', group: :development`: dev
    - `gem 'x', groups: ["test"]`: dev
    - `gem 'y', :group => :test`: dev
    - a custom `group :production`: prod
  - `strips platforms and ignores CHECKSUMS`: `nokogiri (1.15.4-arm64-darwin)` and `(1.15.4-x86_64-linux)` are one node, `1.15.4`.
  - `an unparseable Gemfile or none leaves groups unknown`: `devOnly` is null.
  - `gemspec gems and gems missing from the Gemfile are runtime`
  - `only rubygems.org gems are registry gems`
  - `broken lockfiles`: the exact messages.
- [ ] **Step 2: Run** `npx vitest run test/core/lockfiles/bundler.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `bundler.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: read Gemfile.lock with the Gemfile's groups`.

---

### Task 7: Scan a repo's lockfiles

**Files:**
- Create: `src/core/lockfiles/scan.ts`
- Modify: `src/core/types.ts`, `test/helpers/github-fixtures.ts` (+ `treeJson(entries)` and `blobJson(text)`, base64 with line breaks as GitHub sends it)
- Test: `test/core/lockfiles/scan.test.ts`

**Interfaces:**
- Consumes: the parsers (Tasks 3–6), `GitHubClient`, `GitHubApiError`, and `fakeFetch`.
- Produces:
```ts
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024;
export const MAX_PACKAGE_JSONS = 50;
export const MAX_LOCKFILES_PER_REPO = 50;   // more → status 'error', "More than 50 lockfiles; this repo's lockfiles weren't read.", no blob requests
export interface TreeEntry { path: string; type: string; sha: string; size?: number }
export interface LockfileCandidate { path: string; ecosystem: PackageEcosystem; kind: 'npm' | 'yarn' | 'pnpm' | 'bundler'; sha: string; size: number }
export interface ProjectScan { path: string; ecosystem: PackageEcosystem; blobSha: string; result: ParseResult; jsBundler: string | null }
export interface RepoLockfileScan { status: 'ok' | 'none' | 'empty' | 'error'; error: string | null; truncated: boolean; projects: ProjectScan[] }
export function findLockfiles(tree: TreeEntry[]): LockfileCandidate[]
export function workspacePackageJsonPaths(patterns: string[], treePaths: string[], projectDir: string): string[]
export function detectJsBundler(packageJsons: PackageJson[], treePaths: string[], projectDir: string): string | null
export async function scanRepoLockfiles(client: GitHubClient, fullName: string): Promise<RepoLockfileScan>
```
- Rules:
  - **The tree:** `GET /repos/<fullName>/git/trees/HEAD?recursive=1`.
    - HTTP 409 means `empty`. Any other `GitHubApiError` means `error`, with its message.
    - `truncated: true` sets the flag, and the scan uses the files it got.
    - No candidates means `none`.
  - **`findLockfiles`:**
    - Candidates are blobs whose basename is one of the lockfile names. A path with a `node_modules` or `vendor` segment is skipped.
    - When one directory has both `npm-shrinkwrap.json` and `package-lock.json`, only the shrinkwrap counts, because npm uses it.
    - The result is sorted by path.
  - **Blobs:** `GET /repos/<fullName>/git/blobs/<sha>`, decoded from base64 to UTF-8. A size over `MAX_LOCKFILE_BYTES` is an error, `The lockfile is larger than 20 MB.`, and its blob isn't requested. A failed blob request is an error with the `GitHubApiError` message.
  - **Companions:**
    - JS projects read `<dir>/package.json`. For yarn, the `package.json` files matched by the root's `workspaces` globs are read too.
    - After parsing, the `package.json` at each graph root's path is read for bundler detection, up to `MAX_PACKAGE_JSONS`. If there are more, `jsBundler` is `unknown (more than 50 package.json files)`.
    - Ruby projects read `<dir>/Gemfile`.
    - A companion that can't be fetched or parsed is treated as absent, so the parser reports what it couldn't learn.
  - **`workspacePackageJsonPaths`:**
    - In a pattern, `**` matches any number of directories and `*` matches one segment; everything else is literal.
    - A `!pattern` excludes.
    - The result is `package.json` paths under `projectDir`, never under `node_modules`.
  - **`detectJsBundler`** returns the first match, as `<tool> (dependency)`, `<tool> (config file <basename>)`, or `<tool> (script "<name>")`. It returns null for Ruby projects and when nothing matches.
    - Dependencies, in any of the four maps: `vite`, `webpack`, `rollup`, `esbuild`, `parcel`, `parcel-bundler`, `next`, `nuxt`, `@sveltejs/kit`, `@remix-run/dev`, `astro`, `gatsby`, `react-scripts`, `@vue/cli-service`, `@angular-devkit/build-angular`, `browserify`, `@rspack/core`, `tsup`, `expo`, `react-native`, `metro`, `@rsbuild/core`, `@vercel/ncc`, `@docusaurus/core`, `vitepress`, `tsdown`, `rolldown`, `snowpack`, `@parcel/core`.
    - Config files: basenames anywhere under `projectDir` (not in `node_modules`) matching `/^(vite|webpack|rollup|next|nuxt|svelte|remix|astro|rspack|tsup|esbuild|metro|rsbuild|docusaurus|tsdown|rolldown)\.config\.[cm]?[jt]s$|^gatsby-config\.[cm]?[jt]s$|^\.parcelrc$/`, plus any path ending in `.vitepress/config.[cm]?[jt]s`.
    - Scripts: any value matching `/(^|[^\w-])(vite|webpack|rollup|esbuild|parcel|next|nuxt|nuxi|svelte-kit|remix|astro|gatsby|react-scripts|vue-cli-service|browserify|rspack|tsup|expo|react-native|metro|rsbuild|ncc|docusaurus|vitepress|tsdown|rolldown|snowpack)([^\w-]|$)|(^|[^\w-])ng\s+build\b/`.
  - **Workspace globs** run on a step budget (`MAX_GLOB_STEPS`); running out means `unknown (a workspace pattern isn't supported)`.

- [ ] **Step 1: Write the failing tests**
  - `finds lockfiles and skips node_modules and vendor`:
    - `vendor/bundle/x/Gemfile.lock` and `web/node_modules/a/package-lock.json` are skipped.
    - Of a shrinkwrap and a package-lock in one directory, only the shrinkwrap is kept.
  - `scans each lockfile with its package.json and Gemfile`: a fake tree with `package-lock.json`, `package.json`, `api/Gemfile.lock`, and `api/Gemfile` gives two `ok` projects with formats `npm-v3` and `bundler`.
  - `empty, missing, and lockfile-free repos`: `empty`, then `error` with `Not Found (HTTP 404)`, then `none`.
  - `a truncated tree is flagged`
  - `one bad lockfile doesn't stop the others`. The other projects are `ok`, and:
    - invalid JSON is an error
    - a 21 MB entry is an error, and its blob is never requested (check `fake.calls`)
    - a blob returning HTTP 500 is an error with `Internal Server Error (HTTP 500)`
  - `detects a JS bundler`:
    - It is found from a workspace's devDependency `vite`, from `apps/web/next.config.mjs`, and from a script `"build": "webpack --mode production"`.
    - A library with only `jest`, or with only `vitest` and `vitest.config.ts`, gives null.
  - `matches workspace globs`: `packages/*`, `apps/**`, and `!packages/skip`.
- [ ] **Step 2: Run** `npx vitest run test/core/lockfiles/scan.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `scan.ts` and the fixtures.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: find and read a repo's lockfiles through the trees API`.

---

### Task 8: The public API client and OSV

**Files:**
- Create: `src/core/http/public-client.ts`, `src/core/osv/osv.ts`, `test/helpers/fake-http.ts`
- Test: `test/core/http/public-client.test.ts`, `test/core/osv/osv.test.ts`

**Interfaces:**
- Produces, in `public-client.ts`:
```ts
export type PublicFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<Response>;
export class PublicApiError extends Error { readonly status: number; readonly url: string }  // message: `<statusText or 'Request failed'> (HTTP <status>)`
export class PublicApiClient {
  constructor(opts: { origin: string; fetch?: PublicFetch; sleep?: (ms: number) => Promise<void>; maxRetries?: number });
  getJson<T>(path: string, accept?: string): Promise<T>;
  getText(path: string): Promise<string>;
  postJson<T>(path: string, body: unknown): Promise<T>;
}
```
  - It takes paths only. A path that isn't absolute, or that resolves to another origin, is rejected before any request.
  - It sends `User-Agent: package-vitals`, `Accept` (default `application/json`), and, for POST, `Content-Type: application/json`. It never sends an `Authorization` header.
  - Network `TypeError`s and HTTP 429, 502, 503, and 504 are retried up to `maxRetries` (default 3). The backoff is 1 s, 4 s, then 16 s, or a 429's `Retry-After` seconds.
- Produces, in `test/helpers/fake-http.ts`: `fakeHttp(routes: Record<string, FakeResponse | FakeResponse[] | ((body: unknown) => FakeResponse)>): PublicFetch & { calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] }`. Routes are keyed `"<METHOD> <full URL>"`, and unknown routes return 404.
- Produces, in `osv.ts`:
```ts
export const OSV_ORIGIN = 'https://api.osv.dev';
export const OSV_BATCH_SIZE = 1000;
export interface OsvPackage { ecosystem: PackageEcosystem; name: string; version: string }
export interface OsvRange { type: string; events: { introduced?: string; fixed?: string; last_affected?: string }[] }
/** One OSV record as it applies to one package. */
export interface OsvAdvisory { id: string; aliases: string[]; summary: string; severity: Severity; severitySource: SeveritySource; ranges: OsvRange[] }
export interface AdvisoryCache { get(id: string): { modified: string; json: string } | null; put(id: string, modified: string, json: string): void }
export function osvPackageKey(p: OsvPackage): string
export async function lookupOsv(client: PublicApiClient, packages: OsvPackage[], cache: AdvisoryCache,
  opts: { concurrency: number; onProgress?: (done: number, total: number) => void }): Promise<Map<string, OsvAdvisory[]>>
export function normalizeAdvisory(json: unknown, p: OsvPackage): OsvAdvisory
export function osvFixedVersion(a: OsvAdvisory, ecosystem: PackageEcosystem, version: string): string | null
export function osvRangeText(a: OsvAdvisory): string | null
```
  - `types.ts` gains `export type SeveritySource = 'advisory' | 'malware' | 'assumed'`.
- OSV rules:
  - **Ecosystem names:** `npm` stays `npm`, and `rubygems` becomes `RubyGems`.
  - **Queries:** packages are deduplicated by key and sent in batches of at most `OSV_BATCH_SIZE` to `POST /v1/querybatch` as `{ queries: [{ package: { name, ecosystem }, version }] }`. A result's `next_page_token` is followed by re-querying that package with `page_token`. A result of `{}` means no vulnerabilities.
  - **Details:** each distinct ID is fetched once. A cache entry with the same `modified` is used as is. Otherwise the client sends `GET /v1/vulns/<encodeURIComponent(id)>` and updates the cache.
  - **Concurrency:** batches and detail requests share `opts.concurrency`. `onProgress` counts batches plus detail requests. Any request that still fails after retries rejects the whole lookup.
  - **`normalizeAdvisory`:**
    - severity:
      - from `database_specific.severity`: `CRITICAL` → critical, `HIGH` → high, `MODERATE` → medium, `LOW` → low (`advisory`)
      - otherwise an ID starting with `MAL-` → critical (`malware`)
      - otherwise critical (`assumed`)
    - summary: `summary`, or else the first line of `details` cut to 200 characters, or else the ID
    - ranges: those of the `affected` entries for this package and ecosystem
    - aliases: `aliases`, or else `[]`
  - **`osvFixedVersion`:** walk each range's events in order. `introduced` opens an interval, with `0` meaning the start. `fixed` closes it exclusively and `last_affected` inclusively. Return the `fixed` of the interval containing `version`. Return null when no interval contains it, or when the interval was closed by `last_affected`.
  - **`osvRangeText`:** each interval is written as `>= a, < b`, `< b`, `<= c`, or `>= a`, and the intervals are joined with `; `.

- [ ] **Step 1: Write the failing tests**
  - `public-client.test.ts`:
    - `sends no credentials and stays on its origin`: no `authorization` header is sent, and the client rejects `https://evil.example/x`, `//evil.example/x`, and `x`.
    - `retries network errors, 429, and gateway errors, then gives up`: the sleeps are `[1000, 4000, 16000]`, and `Retry-After: 7` waits 7000.
    - `posts JSON`
    - `errors carry the status, never the body`
  - `osv.test.ts`:
    - `queries unique packages in batches of 1000`: 2,001 packages with duplicates give POSTs of sizes `[1000, 1000, 1]`, and a gem is sent as `RubyGems`.
    - `follows next_page_token`
    - `fetches each record once and reuses the cache while modified is unchanged`: with the same `modified` there is no GET; with a changed one there is a GET and a `put`.
    - `normalizes severity, summary, and ranges`, covering the four severity cases and the summary fallback.
    - `finds the fixed version for the installed version`:
      - minimist's ranges `[{introduced:'1.0.0'},{fixed:'1.2.6'}]` and `[{introduced:'0'},{fixed:'0.2.4'}]` give `0.0.8` → `0.2.4` and `1.2.5` → `1.2.6`
      - an interval closed by `last_affected` gives null
      - the RubyGems `ECOSYSTEM` range gives `6.1.7.3` → `6.1.7.4`
    - `writes ranges as text`: `>= 1.0.0, < 1.2.6; < 0.2.4`.
    - `a batch that keeps failing rejects`
- [ ] **Step 2: Run** `npx vitest run test/core/http test/core/osv`. Expected: FAIL.
- [ ] **Step 3: Implement** the client, the fake, and `osv.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: look packages up in OSV through a credential-free client`.

---

### Task 9: Registries, outdated dependencies, and direct-dependency upgrades

**Files:**
- Create: `src/core/registry/registry.ts`, `src/core/registry/upgrades.ts`
- Modify: `src/core/types.ts` (+ `export interface Upgrade { name: string; from: string; to: string }`)
- Test: `test/core/registry/registry.test.ts`, `test/core/registry/upgrades.test.ts`

**Interfaces:**
- Produces, in `registry.ts`:
```ts
export const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
export const RUBYGEMS_ORIGIN = 'https://rubygems.org';
export interface RegistryVersion { version: string; dependencies: string[]; deprecated: boolean }
export type LatestLookup = { status: 'ok'; latest: string } | { status: 'not_found' } | { status: 'error'; message: string };
/** Never rejects: a failure is a value, so one package can't fail a Checkup. */
export interface PackageRegistry {
  latest(name: string): Promise<LatestLookup>;
  versions(name: string): Promise<RegistryVersion[] | null>;
}
export function npmRegistry(client: PublicApiClient): PackageRegistry
export function rubygemsRegistry(client: PublicApiClient): PackageRegistry
export function parseCompactIndex(text: string): RegistryVersion[]
```
  - **npm:**
    - The latest version comes from `GET /-/package/<name>/dist-tags` (its `latest`). A scoped name is sent as `@scope%2Fname`, and other names through `encodeURIComponent`. HTTP 404, or no `latest`, gives `not_found`.
    - Versions come from `GET /<name>` with `Accept: application/vnd.npm.install-v1+json`. A version's dependencies are the keys of its `dependencies`, `optionalDependencies`, and `peerDependencies`. It is deprecated when `deprecated` is a string.
  - **RubyGems:**
    - The latest version comes from `GET /api/v1/versions/<name>/latest.json`. `"unknown"` gives `not_found`.
    - Versions come from `GET /info/<name>`, read with `parseCompactIndex`:
      - The `---` line is skipped.
      - Each line is `VERSION[-PLATFORM] DEPS|META`, where `DEPS` is `name:reqs` pairs separated by commas.
      - Platform variants of one version are merged, taking the union of their dependencies.
      - `deprecated` is false, since yanked versions aren't listed.
- Produces, in `upgrades.ts`:
  - `isOutdated(ecosystem, locked: string, latest: string): boolean | null` (null when either version is unparseable)
  - `planDirectUpgrades(ecosystem, graph: DepGraph, targets: number[], versionsOf: (name: string) => RegistryVersion[] | null): Upgrade[] | null`, which works in three steps:
    1. If a target is a direct dependency, return null.
    2. For each direct node D from which a target is reachable:
       - The blockers are D's children that are targets, or from which a target is reachable.
       - The candidates are `versionsOf(D.name)` that are stable, not deprecated, and above D's version, in ascending order.
       - Pick the first candidate that declares none of the blockers' names. If none does, or `versionsOf` gives null, return null.
    3. Remove every D→blocker edge. If a root still reaches a target, return null. Otherwise return the upgrades, deduplicated and sorted by name.

- [ ] **Step 1: Write the failing tests**
  - `registry.test.ts` (with `fakeHttp`):
    - `npm latest and versions`:
      - `@types/node`'s request goes to `/-/package/@types%2Fnode/dist-tags`, and 404 gives `not_found`.
      - mkdirp's abbreviated document gives `0.5.1 [minimist]` (deprecated), `0.5.6 [minimist]`, and `1.0.0 []`.
    - `RubyGems treats "unknown" as not found`
    - `reads the compact index`: lines from `rack-test`, with platform variants merged.
    - `a failed lookup is a value, not a throw`
  - `upgrades.test.ts`:
    - `isOutdated`: `('npm','0.5.1','3.0.1')` is true, equal versions are false, `('npm','git+ssh://x','1.0.0')` is null, and gem versions work too.
    - `suggests the lowest release that drops the dependency`: for `slack-deck → mkdirp 0.5.1 → minimist 0.0.8`, using the mkdirp versions above, the result is `[{ name: 'mkdirp', from: '0.5.1', to: '1.0.0' }]`.
    - `follows deeper chains`: for `app → a 1.0.0 → b 1.0.0 → x`, where `a 1.5.0` still declares `b` and `a 2.0.0` declares nothing, the result upgrades `a` to `2.0.0`.
    - `returns null when the package is also direct, another chain keeps it, or no release drops it`
- [ ] **Step 2: Run** `npx vitest run test/core/registry`. Expected: FAIL.
- [ ] **Step 3: Implement** `registry.ts` and `upgrades.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: check npm and RubyGems for newer versions and upgrades`.

---

### Task 10: Findings and tier 1

**Files:**
- Create: `src/core/findings/tier-one.ts`, `src/core/findings/build.ts`
- Modify: `src/core/types.ts`
- Test: `test/core/findings/tier-one.test.ts`, `test/core/findings/build.test.ts`

**Interfaces:**
- Consumes: the graph functions (Task 2), `ProjectScan` (Task 7), `OsvAdvisory`, `osvPackageKey`, `osvFixedVersion`, `osvRangeText` (Task 8), and `inVulnerableRange`, `compareVersions` (Task 1).
- Produces, in `types.ts`:
```ts
export type FindingSource = 'dependabot' | 'osv' | 'both';
export interface FindingRecord {
  alertNumber: number | null; source: FindingSource;
  ecosystem: string; packageName: string; manifestPath: string;
  advisoryId: string; cveId: string | null; severity: Severity; severitySource: SeveritySource;
  summary: string; vulnerableRange: string | null; firstPatched: string | null;
  createdAt: string | null;           // null: first seen in this snapshot (the store fills it in)
  scope: 'runtime' | 'development' | null; githubRelationship: string | null;
  installedVersions: string[]; relationship: Relationship | null;
  chains: DependencyChain[]; chainCount: number;
  lockfileRead: boolean; lockfileDevOnly: boolean | null; jsBundler: string | null;
  tier: 'not_shipped' | null;
  upgrades: Upgrade[] | null;         // filled in by the Checkup (Task 12)
}
```
- Produces, in `tier-one.ts`: `tierOne(f: { ecosystem: string; scope: 'runtime' | 'development' | null; lockfileRead: boolean; lockfileDevOnly: boolean | null; jsBundler: string | null }): 'not_shipped' | null`. The rule is the plan decision above:
  - null when `scope` is `runtime` or `lockfileDevOnly` is false
  - for npm: `not_shipped` only when `lockfileRead`, `lockfileDevOnly` is true, and `jsBundler` is null
  - for rubygems: `not_shipped` when `lockfileDevOnly` is true, or when the lockfile wasn't read and `scope` is `development`
  - for any other ecosystem: always null (spec Section 5: they "stay not triaged")
- Produces, in `build.ts`:
  - `interface BuiltFinding { record: FindingRecord; projectPath: string | null; targets: number[] }`. `targets` are the node IDs of the installed vulnerable instances in that project's graph, which the Checkup needs for upgrades.
  - `buildRepoFindings(input: { alerts: DependabotAlert[]; projects: ProjectScan[]; osv: Map<string, OsvAdvisory[]> | null }): BuiltFinding[]`. A null `osv` means OSV failed or didn't run.
  - **The project for an alert:**
    - It is the `ok` project whose `path` equals `manifestPath`.
    - Failing that, when the manifest's basename is `package.json` or `Gemfile`, it is the only lockfile of that ecosystem in the same directory (counting unreadable ones), provided it parsed.
    - Dependabot's `npm` matches npm, yarn, and pnpm projects, and `rubygems` matches Bundler projects.
  - **Dependabot findings:** there is one per open alert.
    - Its targets are the nodes named like the package whose `inVulnerableRange` isn't false, plus the registry nodes of that name whose OSV list matches the alert.
    - From them come `installedVersions` (sorted, unique), `chainsTo` (limit 10), and `relationshipOf`. `devOnly` is judged over every node with the package's name, so any shipped copy keeps the finding.
    - `lockfileRead` is true when a project was found.
    - The source is `both` when a target's OSV advisories match the alert, otherwise `dependabot`.
  - **Matching an advisory to an alert:** the advisory's ID or aliases include the alert's GHSA ID, or, when the alert has a CVE, its ID or aliases include that CVE.
  - **OSV-only findings:**
    - For each `ok` project and each registry node, the node's advisories are grouped by package name and by advisories linked through IDs or aliases.
    - A group is skipped when an alert in an `open`, `dismissed`, or `auto_dismissed` state, for the same project and package, matches any advisory in it.
    - Otherwise the group becomes one finding:
      - `advisoryId` is the GHSA ID, or else the lowest ID.
      - `cveId` is the first alias starting with `CVE-`.
      - `severity` is the highest in the group. At equal severity, `advisory` beats `malware`, which beats `assumed`.
      - `summary` and `vulnerableRange` (`osvRangeText`) come from the representative advisory.
      - `firstPatched` is `osvFixedVersion` for the highest installed version.
      - `createdAt` is null, and `scope` and `githubRelationship` are null.
  - **Tier:** every record gets `tier` from `tierOne`.
  - **Order:** Dependabot findings by alert number, then OSV-only findings by package name, then advisory ID.

- [ ] **Step 1: Write the failing tests**
  - `tier-one.test.ts`, table-driven. Each row:
    - npm, read, dev-only, no bundler, scope `development` → not_shipped
    - the same with scope null (an OSV-only finding) → not_shipped
    - npm with bundler `vite (dependency)` → null
    - npm not read, scope `development` → null
    - scope `runtime` with dev-only true → null
    - dev-only false with scope `development` → null
    - rubygems not read, scope `development` → not_shipped
    - rubygems read, dev-only null, scope `development` → null
    - pip, not read, scope `development` → null
    - rust, not read, scope `development` → null
  - `build.test.ts`:
    - `an alert takes installed versions, chains, and relationship from its lockfile`: for an alert on minimist `< 0.2.4`, with nodes `0.0.8` (under mkdirp) and `1.2.8` (direct), `installedVersions` is `['0.0.8']`, the relationship is `transitive`, and the chain is `slack-deck → mkdirp 0.5.1 → minimist 0.0.8`.
    - `an OSV match makes it "both", through the GHSA ID or a CVE alias`
    - `a match with a dismissed alert adds nothing; with a fixed alert it is OSV only`
    - `OSV-only findings group versions and linked records`:
      - `GHSA-mh6f-8j2x-4483` aliased with `MAL-2025-20690` for flatmap-stream gives one finding under the GHSA ID, critical.
      - Two installed versions under one advisory give one finding with both versions.
    - `rubygems alerts match RubyGems results`
    - `a package.json manifest uses the lockfile beside it`, and `an alert with no lockfile keeps Level 0 data`: `installedVersions: []`, `chains: []`, and `lockfileRead: false`.
    - `without OSV there are no OSV-only findings and nothing is "both"`
    - `a dev-only finding in a bundler project stays not triaged`
- [ ] **Step 2: Run** `npx vitest run test/core/findings`. Expected: FAIL.
- [ ] **Step 3: Implement** `tier-one.ts` and `build.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: join Dependabot and OSV into findings with tier 1`.

---

### Task 11: Schema 2 and the store

**Files:**
- Modify: `src/core/db/schema.ts`, `src/core/checkup/store.ts`, `test/helpers/seed.ts`
- Test: `test/core/db/database.test.ts`, `test/core/checkup/store.test.ts` (new)

**Interfaces:**
- Migration 2 (append it to `MIGRATIONS`):
```sql
ALTER TABLE snapshots ADD COLUMN osv_status TEXT CHECK (osv_status IN ('ok','error'));
ALTER TABLE snapshots ADD COLUMN osv_error TEXT;
ALTER TABLE snapshot_repos ADD COLUMN lockfiles_status TEXT CHECK (lockfiles_status IN ('ok','none','empty','error'));
ALTER TABLE snapshot_repos ADD COLUMN lockfiles_error TEXT;
ALTER TABLE snapshot_repos ADD COLUMN tree_truncated INTEGER NOT NULL DEFAULT 0;
CREATE TABLE lockfiles (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL, repo_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  ecosystem TEXT NOT NULL CHECK (ecosystem IN ('npm','rubygems')),
  format TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','unsupported','error')),
  error TEXT,
  blob_sha TEXT NOT NULL,
  complete INTEGER CHECK (complete IN (0,1)),
  js_bundler TEXT,
  UNIQUE (snapshot_id, repo_id, path),
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE TABLE direct_dependencies (
  lockfile_id INTEGER NOT NULL REFERENCES lockfiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, version TEXT NOT NULL,
  dev INTEGER NOT NULL CHECK (dev IN (0,1)),
  latest TEXT,
  lookup TEXT NOT NULL CHECK (lookup IN ('ok','not_found','error','skipped')),
  outdated INTEGER CHECK (outdated IN (0,1)),
  PRIMARY KEY (lockfile_id, name, version)
);
CREATE TABLE osv_advisories (id TEXT PRIMARY KEY, modified TEXT NOT NULL, json TEXT NOT NULL, fetched_at TEXT NOT NULL);
CREATE TABLE findings (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL, repo_id INTEGER NOT NULL,
  alert_number INTEGER,
  source TEXT NOT NULL CHECK (source IN ('dependabot','osv','both')),
  ecosystem TEXT NOT NULL, package_name TEXT NOT NULL, manifest_path TEXT NOT NULL,
  advisory_id TEXT NOT NULL, cve_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  severity_source TEXT NOT NULL CHECK (severity_source IN ('advisory','malware','assumed')),
  summary TEXT NOT NULL, vulnerable_range TEXT, first_patched TEXT,
  created_at TEXT NOT NULL,
  scope TEXT, github_relationship TEXT,
  installed_versions TEXT NOT NULL DEFAULT '[]',
  relationship TEXT CHECK (relationship IN ('direct','transitive','mixed')),
  chains TEXT NOT NULL DEFAULT '[]',
  chain_count INTEGER NOT NULL DEFAULT 0,
  lockfile_read INTEGER NOT NULL DEFAULT 0 CHECK (lockfile_read IN (0,1)),
  lockfile_dev_only INTEGER CHECK (lockfile_dev_only IN (0,1)),
  js_bundler TEXT,
  tier TEXT CHECK (tier IN ('not_shipped')),
  upgrades TEXT,
  UNIQUE (snapshot_id, repo_id, alert_number),
  FOREIGN KEY (snapshot_id, repo_id) REFERENCES snapshot_repos(snapshot_id, repo_id) ON DELETE CASCADE
);
CREATE INDEX findings_by_snapshot ON findings(snapshot_id, tier, severity);
INSERT INTO findings (snapshot_id, repo_id, alert_number, source, ecosystem, package_name, manifest_path,
    advisory_id, cve_id, severity, severity_source, summary, vulnerable_range, first_patched, created_at,
    scope, github_relationship)
  SELECT snapshot_id, repo_id, number, 'dependabot', ecosystem, package_name, manifest_path, ghsa_id, cve_id,
    severity, 'advisory', summary, vulnerable_range, first_patched, created_at, scope, relationship
  FROM alerts WHERE state = 'open';
```
- Produces, in `store.ts`:
  - `recordLockfiles(db, snapshotId, repoId, scan: RepoLockfileScan): void` writes, in one transaction:
    - the repo's `lockfiles_status`, `lockfiles_error`, and `tree_truncated`
    - one `lockfiles` row per project: `format` is the graph's format, or the unsupported format, or null; `error` is the `unsupported` or `error` message; `complete` is `isComplete` for `ok` projects
    - one `direct_dependencies` row per registry node that a root edge reaches, with `dev = 1` only when every root edge to it is `dev`, and `lookup 'skipped'`
  - `recordLatestVersions(db, snapshotId, results: { ecosystem: PackageEcosystem; name: string; lookup: LatestLookup }[]): void` updates every row of that ecosystem and name in the snapshot: `latest`, `lookup`, and `outdated` (from `isOutdated`, NULL when unknown).
  - `insertFindings(db, snapshotId, repoId, records: FindingRecord[], firstSeen: string): void`. A null `createdAt` takes the `created_at` of the OSV-only finding with the same repo, manifest, ecosystem, package, and advisory in the previous complete snapshot of the same owner and scope. Without one it takes `firstSeen`.
  - `finishOsv(db, snapshotId, osv: { status: 'ok' } | { status: 'error'; message: string }): void`
  - `sqliteAdvisoryCache(db, now: () => Date): AdvisoryCache`
- Produces, in `seed.ts`:
  - `seedSnapshot` builds findings through `buildRepoFindings` with no projects, and stores their `record`s with `insertFindings`.
  - New `SeedRepo` fields:
    - `findingOverrides?: Record<number, Partial<FindingRecord>>`, keyed by alert number
    - `osvFindings?: Partial<FindingRecord>[]`, completed with defaults
    - `lockfiles?: { path: string; status: 'ok' | 'unsupported' | 'error'; error?: string; format?: string; directDependencies?: { name: string; version: string; latest?: string; lookup?: string; outdated?: boolean }[] }[]`
    - `lockfilesStatus?`
  - New `SeedSpec` field: `osv?: 'ok' | { error: string } | null`. The default is `'ok'`. Null means Level 1 never ran: `osv_status` and `lockfiles_status` stay NULL.
  - When `osv` isn't null, a repo's `lockfiles_status` defaults to `'ok'` if it has `lockfiles`, and to `'none'` otherwise.

- [ ] **Step 1: Write the failing tests**
  - `database.test.ts`: `migration 2 adds Level 1 tables and turns open alerts into findings`. Build a version-1 file by running `MIGRATIONS[0]` and setting `user_version = 1`. Insert one open and one dismissed alert, then reopen it with `openDatabase`. The result has `user_version` 2 and exactly one finding, with `source 'dependabot'`, `severity_source 'advisory'`, and `tier` NULL.
  - `store.test.ts`:
    - `records lockfiles, their status, and direct dependencies`: a dev-only direct dependency gets `dev = 1`, and a package that is both direct-dev and direct-prod gets `dev = 0`.
    - `stores latest versions and outdated flags`, where `not_found` leaves `outdated` NULL
    - `stores findings with their JSON fields`
    - `an OSV-only finding keeps its first-seen date in a later snapshot`, but not across a different scope
    - `the advisory cache round-trips`
- [ ] **Step 2: Run** `npx vitest run test/core/db test/core/checkup/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, the store functions, and the seed changes.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass, including every test that seeds data.
- [ ] **Step 5: Commit** with `feat: store lockfiles, findings, and OSV records (schema 2)`.

---

### Task 12: The Checkup runs Level 1

**Files:**
- Modify:
  - `src/core/checkup/checkup.ts`, `src/core/checkup/account-checkup.ts`, `src/core/checkup/format.ts`
  - `src/core/types.ts`: `CheckupSummary` and `CheckupProgress`
  - `src/app/shared/api.ts`: re-export `CheckupProgress` from the core
  - `src/app/main/main.ts`
  - `src/app/renderer/components/CheckupButton.tsx`
  - `src/cli/commands/checkup.ts`
- Test:
  - `test/core/checkup/checkup.test.ts`, `test/core/checkup/account-checkup.test.ts`
  - `test/cli/cli.test.ts`
  - `test/app/renderer/CheckupButton.test.tsx`
  - format tests next to the existing ones

**Interfaces:**
- Produces:
```ts
export interface CheckupProgress { phase: 'repos' | 'advisories' | 'versions'; done: number; total: number; repo: string | null }
export interface Level1Clients { osv: PublicApiClient; npm: PackageRegistry; rubygems: PackageRegistry }
export interface CheckupDeps { db: Db; client: GitHubClient; now: () => Date; level1?: Level1Clients; onProgress?: (p: CheckupProgress) => void }
export interface CheckupSummary {
  /* existing fields */
  level1: { lockfiles: { read: number; unsupported: number; failed: number }; reposFailed: number;
    osv: 'ok' | 'error' | 'skipped'; osvOnly: number; notShipped: number } | null;   // null without Level 1
}
```
- The `runCheckup` flow. Any throw still marks the snapshot `failed` and rethrows.
  1. **Repos phase:** for each repo, under the existing concurrency, call alerts, then the SBOM, then, when `level1` is set, `scanRepoLockfiles`. Record each result (`recordRepoResult`, `recordLockfiles`) and keep the alerts and scan in memory. Progress: `{ phase: 'repos', repo }`.
  2. **Advisories phase:** `lookupOsv` over the registry nodes of every `ok` project, with concurrency 4 and the SQLite cache. Progress: `phase: 'advisories'`.
     - A rejection becomes `finishOsv(error, message)` and a null OSV map; the Checkup goes on.
  3. **Findings:** run `buildRepoFindings` for each repo. Without `level1`, it gets no projects and a null OSV map.
  4. **Versions phase** (only with `level1`), with concurrency 8 per registry. Progress: `phase: 'versions'`.
     - Look up `latest` for every distinct (ecosystem, name) among direct registry dependencies, then `recordLatestVersions`.
     - For each finding with `targets`, fetch `versions` for the direct dependencies from which a target is reachable, once per (ecosystem, name) across the Checkup. Set `record.upgrades` from `planDirectUpgrades(ecosystem, graph, targets, …)` on that project's graph.
  5. **Finish:** `insertFindings` for each repo (with `firstSeen` = the snapshot's start), `finishOsv(ok)` unless it failed, then `finishSnapshot('complete')`.
- **`runAccountCheckup`** always passes `level1`. The deps gain `publicFetch?: PublicFetch`, which tests use.
- **`formatCheckupSummary`** appends, when there is `level1`:
  - ` Lockfiles: <read> read, <unsupported> unsupported, <failed> couldn't be read.`
  - When OSV is ok: ` OSV found <osvOnly> findings that Dependabot doesn't report.`
  - Always: ` <notShipped> findings are dev-only (not shipped).`
- **`checkupWarning`** adds, joined by a space:
  - when OSV failed: `Warning: the OSV lookup failed, so findings that Dependabot doesn't report are missing.`
  - when lockfiles failed: `Warning: <n> lockfiles couldn't be read; their findings have no dependency chains.`
  - when repos failed: `Warning: files couldn't be listed for <n> repos, so their lockfiles weren't read.`
- **Progress text:**
  - The CLI prints `[<done>/<total>] <repo>`, `[advisories <done>/<total>]`, and `[versions <done>/<total>]`.
  - The Checkup button shows `Checking… <done> / <total> · <repo>`, `Looking up advisories… <done> / <total>`, and `Checking package versions… <done> / <total>`.

- [ ] **Step 1: Write the failing tests**
  - `checkup.test.ts`. Keep the existing tests, which run without `level1`, and add:
    - `scans lockfiles, looks up OSV, and stores findings`. One repo has a v3 lockfile (`slack-deck → mkdirp 0.5.1 → minimist 0.0.8`) and an open minimist alert. OSV returns the alert's GHSA for minimist and another advisory for mkdirp. The npm registry returns mkdirp `latest 3.0.1` and the versions from Task 9. The results:
      - the alert's finding is `both`, with `upgrades [mkdirp 0.5.1 → 1.0.0]`
      - mkdirp has an OSV-only finding
      - mkdirp's direct dependency row has `outdated = 1`
      - `osv_status` is `ok`
      - `summary.level1` is as expected
    - `an OSV outage is recorded and the snapshot still completes`: four 503s for `querybatch` give `osv_status 'error'` with `osv_error 'Service Unavailable (HTTP 503)'`, every finding is `dependabot`, and `status` is `complete`.
    - `registry failures leave dependencies unchecked`: `lookup 'error'` and `outdated` NULL.
    - `public requests carry only package names and versions`: no public call has an `authorization` header, and no request body or URL contains `TETRA2000` or a lockfile path.
    - `a failure in a later phase still marks the snapshot failed`: `onProgress` throws in the `versions` phase.
  - `account-checkup.test.ts`: `runs Level 1 by default`. With `publicFetch` faked, the snapshot's `osv_status` isn't NULL.
  - Format tests for the new sentences and warnings, the CLI progress lines, and the Checkup button's three labels.
- [ ] **Step 2: Run** `npx vitest run test/core/checkup test/cli test/app/renderer/CheckupButton.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the flow, the summary, the progress text, and the wiring.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: run the lockfile scan, OSV, and registry checks in the Checkup`.

---

### Task 13: The queue reads findings

The finding key changes, so this task carries it through main and the renderer to keep the build green. New UI comes in Task 15.

**Files:**
- Modify:
  - `src/core/types.ts`
  - `src/core/queries/findings.ts`, `src/core/queries/account.ts` (`repoCards`, `criticalTreatmentPlan`)
  - `src/core/github/urls.ts`
  - `src/app/shared/api.ts`, `src/app/main/validate.ts`, `src/app/main/handlers/queue.ts`, `src/app/main/handlers/actions.ts`
  - `src/app/renderer/App.tsx`, `src/app/renderer/views/QueueView.tsx`, `src/app/renderer/components/FindingList.tsx`, `src/app/renderer/components/SidePanel.tsx`
  - `src/core/reports/finding-markdown.ts` (only for the `advisoryId` rename)
  - `test/e2e/app.e2e.test.ts`, wherever it builds finding keys
- Create: `src/core/queries/level1.ts`
- Test: the matching files under `test/core/queries`, `test/app/main`, and `test/app/renderer`, plus `test/core/queries/level1.test.ts`

**Interfaces:**
- Produces, in `types.ts` (replacing the Plan 2 shapes; `ghsaId` becomes `advisoryId` everywhere):
```ts
export interface FindingKey { snapshotId: number; findingId: number }
export type TriageState = 'not_triaged' | 'not_shipped';   // Plans 4–5 add the others
export interface FindingFilter { severities: Severity[]; repoId: number | null; ecosystem: string | null; triage: TriageState | null; source: FindingSource | null }
export interface FindingRow extends FindingKey {
  repoId: number; fullName: string; severity: Severity; ecosystem: string; packageName: string; advisoryId: string;
  summary: string; manifestPath: string; createdAt: string; triage: TriageState; source: FindingSource;
}
export interface FindingDetail extends FindingRow {
  alertNumber: number | null; cveId: string | null; severitySource: SeveritySource;
  scope: 'runtime' | 'development' | null; relationship: Relationship | null; githubRelationship: string | null;
  vulnerableRange: string | null; firstPatched: string | null; installedVersions: string[];
  chains: DependencyChain[]; chainCount: number; lockfileRead: boolean; lockfileDevOnly: boolean | null;
  jsBundler: string | null; upgrades: Upgrade[] | null; githubUrl: string | null;
}
export interface RepoCard { /* Plan 2 fields */ outdated: number | null; outdatedUnchecked: number }
export interface Level1Summary {
  scanned: boolean;
  osv: { status: 'ok' | 'error'; error: string | null } | null;
  reposNotScanned: { repo: string; message: string }[];
  lockfileProblems: { repo: string; path: string; status: 'unsupported' | 'error'; message: string }[];
  truncatedRepos: string[];
}
```
- **Queries** (all over `findings` for one snapshot):
  - `listFindings(db, snapshotId, filter)`:
    - It applies every filter.
    - The order is triage (not triaged 0, not shipped 1), then severity, then `created_at`, then `fullName`, then `id`.
    - `triage` is `tier ?? 'not_triaged'`.
  - `getFinding(db, key)` parses the JSON columns. `githubUrl` is:
    - `dependabotAlertUrl` when there is an alert number
    - else `advisoryUrl(id)` = `https://github.com/advisories/<id>` for an ID matching `/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/`
    - else null
  - `countFindings(db, snapshotId, filter): { critical: number; matching: number; notTriaged: number; notShipped: number }`:
    - `critical` ignores the severity and triage filters.
    - `matching` uses the whole filter.
    - The two triage counts use the whole filter apart from `triage`.
  - `findingEcosystems` reads `findings`.
  - `repoCards`:
    - Counts come from open findings of every tier.
    - `outdated` is the number of distinct (ecosystem, name) pairs with `outdated = 1` across the repo's `ok` lockfiles. It is null when the repo has no `ok` lockfile.
    - `outdatedUnchecked` counts distinct names with `lookup` of `error` or `not_found`.
  - `criticalTreatmentPlan` counts critical findings with `tier IS NULL`, OSV-only ones included.
  - `level1Summary(db, snapshotId): Level1Summary`. `scanned` is false when every repo's `lockfiles_status` is NULL.
- **Main:**
  - `parseFindingKey` takes exactly `snapshotId` and `findingId`. The filter parser takes exactly the five keys: `triage` is null or one of the `TriageState`s, and `source` is null or one of the `FindingSource`s.
  - `listFindings` returns `counts: { critical, notTriaged, devOnly, reachable: null, uncertain: null }`. `devOnly` is `notShipped`, or null when the snapshot wasn't scanned.
  - `Overview` gains `level1: Level1Summary | null`.
  - `openFindingOnGitHub` opens `githubUrl`. When it is null, it throws `IpcInputError('This finding has no GitHub page.')`.
- **Renderer plumbing only:**
  - The selection keys become `{ snapshotId, findingId }`, and the list rows are keyed by `findingId`.
  - `DEFAULT_QUEUE_FILTER` and `repoQueueFilter` gain `triage: null` and `source: null`.

- [ ] **Step 1: Write the failing tests**
  - `findings.test.ts`, rewritten over seeded findings:
    - `not shipped findings sink below not triaged ones, then severity and age order`
    - `filters by triage and source`
    - `counts critical, matching, not triaged, and not shipped`
    - `getFinding returns chains, versions, upgrades, and the right GitHub URL`: an alert URL, an advisory URL for an OSV-only GHSA finding, and null for `MAL-…`
  - `account.test.ts`:
    - `repo cards count outdated dependencies, unchecked ones, and — without lockfiles`
    - `the treatment plan leaves out ruled-out findings and includes OSV-only ones`
  - `level1.test.ts`: `summarizes OSV status, unread lockfiles, and unscanned repos`, and `a snapshot without Level 1 is not scanned`
  - `validate.test.ts`: the new key and filter, plus extra keys and unknown triage or source values, all rejected.
  - `action-handlers.test.ts`: `opens the advisory page for an OSV-only finding`, and `refuses a finding with no GitHub page`.
  - `queue-handlers.test.ts`: `devOnly is the not-shipped count, and null when the snapshot wasn't scanned`.
  - Update the renderer tests for the new key.
- [ ] **Step 2: Run** `npx vitest run`. Expected: the new and updated tests fail.
- [ ] **Step 3: Implement** the types, queries, main changes, and renderer plumbing.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build && npm run test:e2e`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: build the queue from findings`.

---

### Task 14: Reports and Copy as Markdown

**Files:**
- Create: `src/core/reports/finding-text.ts`
- Modify:
  - `src/core/reports/account-report.ts`, `src/core/reports/repo-chart.ts`, `src/core/reports/finding-markdown.ts`
  - `src/core/queries/account.ts`: add `findingSourceCounts` and `findingTriageCounts`, and the `outdated` column in `worstRepos`
  - `src/core/queries/repo.ts`: `repoFindings(db, snapshotId, repoId): FindingDetail[]`, in queue order and sharing `getFinding`'s row mapping, and `repoLockfiles(db, snapshotId, repoId): { path: string; format: string | null; status: string; error: string | null; jsBundler: string | null }[]`
- Test: `test/core/reports/{account-report,repo-chart,finding-markdown,finding-text}.test.ts`

**Interfaces:**
- Produces, in `finding-text.ts`. It is pure and imports nothing from Node, so the renderer can use it too. Every function returns plain text, which callers escape.
  - `describeChain(c: DependencyChain): string` returns `slack-deck → mkdirp 0.5.1 → minimist 0.0.8`, with ` (dev)` added for a dev chain.
  - `describeTriage(d: FindingDetail): string` returns exactly one of these, checked in order:
    1. `Not shipped: every dependency chain to it is dev-only in the lockfile.` (`triage` is `not_shipped`, and `lockfileDevOnly` is true)
    2. `Not shipped: Dependabot marks it as a development dependency.` (`triage` is `not_shipped` otherwise)
    3. `Not triaged: it's dev-only, but this project uses a bundler (<jsBundler>), so the plain-code check has to confirm it isn't bundled.` (`jsBundler` is set, and `lockfileDevOnly` is true)
    4. `Not triaged: a runtime dependency chain pulls it in.` (`lockfileDevOnly` false)
    5. `Not triaged: no lockfile was read for it.` (npm, not read)
    6. `Not triaged.`
  - `describeFix(d: FindingDetail): string` returns `Patched in <v>` or `No patched version`, followed by `; or upgrade <name> to <to> to drop it` for each upgrade, joined with ` and `.
  - `describeSeverity(d): string` returns the label, plus ` (malicious package)` or ` (assumed: OSV gives no severity)`.
- **Account report:**
  - The headline's last sentence is replaced by one of:
    - `Lockfiles weren't scanned in this snapshot, so these are Dependabot's raw counts.`
    - Or both of:
      - `Plain-code triage marks <n> critical findings as not shipped (dev-only).`
      - Either `OSV reports <m> findings that Dependabot doesn't.` or `The OSV lookup failed, so findings that Dependabot doesn't report are missing.`
  - New `## Findings after plain-code triage` section, with columns `| Severity | Findings | Not shipped | Left to triage |`.
  - New `## Dependabot and OSV` section, with columns `| Severity | Both | Dependabot only | OSV only |`. When OSV failed, the Both and OSV only columns show `—`, under the line `The OSV lookup failed: <error>.`
  - Under Repos:
    - `### Lockfiles that couldn't be read`, with entries `` - `repo/path`: message ``
    - `### Repos whose files couldn't be listed`
  - Worst repos gains an `Outdated` column (`—` when null).
  - The treatment plan's lead becomes `Packages with an open critical finding that plain-code triage hasn't ruled out, by how many repos they affect:`.
- **Repo chart:**
  - Vital signs gains `Outdated`.
  - New `## Lockfiles` section: `| Lockfile | Format | Status | Bundler |`.
  - `## Open findings` replaces `## Open alerts`: `| Severity | Package | Installed | Source | Triage | Chain | Advisory | Fix |`.
    - Chain is the first chain, plus ` (+<n> more)`.
    - Triage is `Not triaged` or `Not shipped`.
  - The dismissed table is unchanged.
- **Copy as Markdown** adds lines for source, installed versions, relationship, up to 3 chains, triage (`describeTriage`), and fix (`describeFix`). Its last line is `- Link: <githubUrl>`, left out when there is no URL.

- [ ] **Step 1: Write the failing tests**
  - `finding-text.test.ts`: each exact string above.
  - `account-report.test.ts`:
    - `reports triage and source counts`
    - `says when OSV failed or lockfiles weren't scanned`
    - `lists unreadable lockfiles with their paths escaped`: a path of ``web/<img src=x onerror=alert(1)>|`x`/yarn.lock`` comes out literal through markdown-it, as in Plan 1's tests.
    - `worst repos show outdated counts`
  - `repo-chart.test.ts`:
    - `shows lockfiles and findings with chain, triage, and fix`
    - `a hostile package name in a chain stays literal`
  - `finding-markdown.test.ts`:
    - `includes chains, triage, and fix`
    - `links an OSV-only finding to its advisory, and a MAL finding to nothing`
- [ ] **Step 2: Run** `npx vitest run test/core/reports`. Expected: FAIL.
- [ ] **Step 3: Implement** the text helpers, the queries, and the report changes.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: report OSV, chains, triage, and outdated dependencies`.

---

### Task 15: The app shows Level 1

**Files:**
- Modify:
  - `src/app/renderer/views/QueueView.tsx`, `src/app/renderer/views/RepoCardsView.tsx`
  - `src/app/renderer/components/FindingList.tsx`, `src/app/renderer/components/SidePanel.tsx`, `src/app/renderer/components/Notices.tsx`
  - `src/app/renderer/styles.css`
- Test: `test/app/renderer/{QueueView,SidePanel,RepoCardsView,Notices,App}.test.tsx` (`Notices.test.tsx` is new)

**Interfaces:**
- Consumes: `describeChain`, `describeTriage`, `describeFix`, `describeSeverity` (Task 14); `Overview.level1`, `FindingDetail`, and `RepoCard` (Task 13).
- **Queue filters:**
  - `Triage` select: `All`, `Not triaged`, `Not shipped`.
  - `Source` select: `All sources`, `Dependabot and OSV`, `Dependabot only`, `OSV only`. It is disabled when OSV failed or the snapshot wasn't scanned, with the visible text `OSV results are missing from this snapshot.`
- **Rows** add a `Not shipped` tag and an `OSV only` tag where they apply. The tags are text, not icons.
- **Side panel** (all values render as React text):
  - `Severity` uses `describeSeverity`.
  - New rows:
    - `Source`: `Dependabot and OSV`, `Dependabot`, or `OSV only`
    - `Installed`: the versions, or `—`
    - `Relationship`: `Direct`, `Transitive`, `Direct and transitive`, or GitHub's value followed by ` (from GitHub)`
    - `Dependency chains`: a list of `describeChain`, with `and <n> more` when `chainCount` exceeds the shown chains
  - `Triage` uses `describeTriage`. `Fix` uses `describeFix`, with the note `Based on the upgraded version's declared dependencies.` when there are upgrades.
  - `Open on GitHub` is disabled, with the text `No GitHub page`, when `githubUrl` is null.
- **Repo cards** show `Outdated <n>`, `Outdated <n> (<m> not checked)`, or `Outdated —`.
- **Notices** (each a collapsed `<details>`, as in Plan 2):
  - The not-monitored wording becomes `… Dependabot alerts are turned off, so only the lockfile scan covers it.` (or `them`).
  - New:
    - `The OSV lookup failed: <error>. Findings that Dependabot doesn't report are missing.`
    - `<n> lockfile(s) couldn't be read:` (`repo/path: message`)
    - `<n> repo(s) couldn't be listed:`
    - `<n> repo(s) have more files than GitHub lists, so some lockfiles may be missing:`
    - for an unscanned snapshot: `Lockfiles weren't scanned in this snapshot. Run a Checkup to add OSV findings and dependency chains.`

- [ ] **Step 1: Write the failing tests**
  - `QueueView.test.tsx`:
    - `sends the triage and source filters`
    - `disables the source filter when OSV results are missing`
    - `tags not-shipped and OSV-only rows`
  - `SidePanel.test.tsx`:
    - `shows source, installed versions, relationship, and chains`
    - `hostile names in chains render as text`: a chain root and link of `<img src=x onerror=alert(1)>` render as literal text, with no `img` element.
    - `shows triage and fix with upgrades`
    - `disables Open on GitHub without a page`
  - `RepoCardsView.test.tsx`: the three `Outdated` forms.
  - `Notices.test.tsx`: each new notice, and the new not-monitored wording.
- [ ] **Step 2: Run** `npx vitest run --project dom`. Expected: FAIL.
- [ ] **Step 3: Implement** the renderer changes and styles.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build && npm run test:e2e`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: show chains, sources, triage, and outdated counts in the app`.

---

### Task 16: End-to-end check and README

**Files:**
- Modify: `test/e2e/app.e2e.test.ts`, `README.md`

- [ ] **Step 1: Extend the end-to-end test**
  - Seed:
    - an OSV-only finding whose chain root and package name are `<img src=x onerror=alert(1)>`
    - a not-shipped finding
    - a lockfile with `status: 'error'` whose path holds a Markdown link
  - New test `lockfile data stays text`. It selects the OSV-only finding and checks:
    - the side panel shows the chain literally, and the page has no `img` element
    - the notice lists the lockfile path literally
  - New test `not-shipped findings sink to the bottom`:
    - Choosing Triage `Not shipped` shows the seeded not-shipped finding with its `Not shipped` tag.
    - Calling `window.vitals.listFindings` from the page with all severities and no other filter returns that finding last. The list only renders visible rows, so the last row can't be checked on screen.
- [ ] **Step 2: Run** `npm run build && npm run test:e2e`. Expected: all end-to-end tests pass.
- [ ] **Step 3: Update `README.md`:**
  - what the Checkup now reads (the file names, the supported formats, and the unsupported ones)
  - what goes to OSV, npm, and RubyGems: package names and versions only
  - how tier 1 decides "not shipped"
  - that `yaml` is the core's one runtime dependency
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build && npm run test:e2e`. Expected: all pass.
- [ ] **Step 5: Commit** with `test: check lockfile data end to end, and document Level 1`.

---

### Task 17: Check against the real account (read-only, nothing committed)

- [ ] **Step 1: Run a full Checkup into a throwaway home**
  - `PACKAGE_VITALS_HOME=$(mktemp -d) node dist/cli/bin.js checkup`
  - Read `gh api rate_limit` before and after, and time the run.
- [ ] **Step 2: Check the lockfiles against the 2026-10-25 survey**
  - Expected `ok` lockfiles: 58 `npm-v3`, 5 `npm-v2`, 6 `npm-v1`, 27 `yarn-v1`, 5 `pnpm-v9`, and 27 `bundler`. Explain any difference.
  - List every `error` and incomplete graph with its reason (unresolved dependency, no `package.json`, or `Gemfile` groups unknown).
- [ ] **Step 3: Check the findings**
  - counts by source
  - five OSV-only findings, checked against `osv.dev` and the repo's Dependabot alerts
  - how many alerts GitHub marks `unknown` or `inconclusive` now have a lockfile relationship
  - three chains, traced by hand in the lockfile
  - the number of upgrades, with one checked against the registry
  - three outdated counts, checked with `npm view <pkg> version` or `gem info -r <gem>`
- [ ] **Step 4: Check tier 1**
  - critical not-shipped count, compared with Dependabot's development-scope criticals (the spec counted 108 of 522)
  - the number of bundler projects
  - two not-shipped findings checked by hand
- [ ] **Step 5: Open the app on the throwaway home** with `PACKAGE_VITALS_HOME=… npm run app`, and look at:
  - the queue with the triage and source filters
  - a chain in the side panel
  - outdated counts on the repo cards
  - the notices
- [ ] **Step 6: Record** in the PR description or hand-off notes:
  - counts, run time, and GitHub requests used
  - OSV batches and records fetched, and registry lookups (from the database)
  - anything wrong

  Don't commit the throwaway home.

---

## Later plans

4. The plain-code check on hardened shallow clones: tier 2, the bundler half of tier 1, and the commit SHA
5. Sandboxed Claude triage, the job queue, verdict validation, caching, overrides, OpenVEX, dismiss and reopen scripts, and dismissal tracking
6. The MCP server, the three skills, and reports with Claude-written narrative
