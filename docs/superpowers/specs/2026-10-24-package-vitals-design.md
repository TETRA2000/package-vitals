# Package Vitals: Design

- **Date:** 2026-10-24
- **Owner:** Takahiko Inayama
- **Background:** [package-vitals-design.md](../../../package-vitals-design.md), the original brainstorm, and [the tech stack decision](../../decisions/0001-tech-stack.md). Where they differ from this document, this document wins.

Decisions marked **[Claude's call]** were made by Claude during design, not by the owner. Most were reviewed with the owner, and they stand unless the owner changes them. Everything unmarked was decided by the owner, except the security requirements, which follow from the threat model. Section 12 lists what is left to the builder.

---

## 1. Why this exists

The owner has too many repositories and dependencies to work through Dependabot alerts one by one. Their personal GitHub account (`TETRA2000`) has 454 repos. 355 of them are active, meaning not forks and not archived. Together they have **10,007 open Dependabot alerts: 522 critical, 4,439 high, 4,018 medium, and 1,028 low**, spread over 126 repos. The critical alerts are in 87 repos.

Package Vitals produces a **prioritized list**. At the top are **critical vulnerabilities that are actually reachable in production code**. Everything else sinks: packages that are only used in development, packages the code never imports, and vulnerable functions that are never called.

The owner and other devs fix what it finds. The owner also wants to consult Claude about the stored data, for example "which upgrade fixes the most repos?"

### Success

After one Checkup and one triage pass, the top of the queue is a short list of critical alerts that really are reachable, each with evidence the owner trusts enough to act on. Most of the rest can be cleared with one generated dismiss script.

### The worst failure (anti-goal)

**A confident "not reachable" verdict that turns out to be wrong.** That is worse than no triage at all. Every rule below leans toward keeping a finding in the queue when there is doubt:

- Plain-code filters must be conservative.
- A Claude verdict that rules a finding out with less than high confidence is shown as **uncertain**, not ruled out.
- A "not reachable" verdict without valid evidence is rejected.

### Other anti-goals

- **The app never writes to GitHub itself.** It creates no pull requests or issues and never dismisses alerts. It can generate `gh` commands for the owner to run (Section 8).
- **Triage never runs unsandboxed**, on any platform.
- **The GitHub token never enters a sandbox.**

---

## 2. Scope of the first version

**In:**

- Checkup for the owner's personal GitHub account: Dependabot alerts and SBOMs (Level 0), plus lockfile scans for **npm and RubyGems** (Level 1)
- A comparison of OSV results against Dependabot's
- Plain-code triage without Claude: tier 1 (not shipped) and tier 2 (not imported), for alerts of every severity
- Tracking of alerts after they are dismissed, so a dismissal whose verdict goes stale comes back to the queue (Section 8)
- Claude reachability triage of **critical** alerts, started on demand and run in a sandbox (Level 2)
- Human overrides, **OpenVEX export**, and generated bulk-dismiss scripts
- The desktop app: a priority queue with a side panel, repo cards, a treatment plan, and a Reports view
- Reports the app generates by itself, and reports with a narrative written by Claude
- A CLI, an MCP server, and three Claude skills (`collect`, `triage-reachability`, `write-report`)

**Out for now:**

- Level 3, the microVM (Docker Sandboxes): installing dependencies, running tests, and proof-of-concept code
- Automatic triage of high alerts. The owner can send a single high alert to triage by hand.
- Lockfile scans for pip, Rust, Gradle, Swift, CocoaPods, and others. Dependabot alerts for those ecosystems are still shown at Level 0, since they come for free.
- Work use and GitHub organizations. The collector must still accept an "owner" that is either a user or an org, so this can be added without a rewrite (Section 4).
- A fine-grained GitHub token stored in the Keychain
- Claude triage on Windows (Section 3)
- Telling dormant repos from live ones (deliberately set aside by the owner)
- Scheduled checkups

---

## 3. Platform and stack

- **Stack:** Electron, with a TypeScript core. The UI, core, CLI, and MCP server are all TypeScript. The reasons and trade-offs are in [0001-tech-stack.md](../../decisions/0001-tech-stack.md).
- **Platforms:** macOS, Linux, and Windows. **[Claude's call]** Development and testing happen on macOS first. Linux and Windows must keep building but are polished later.
- **Triage on Windows is off by default** until the sandbox runtime's Windows support leaves alpha. The Checkup, the plain-code check, and reports work fully on Windows, because none of them runs anything from a repo or needs the sandbox (Section 6).

### Architecture

```
            ┌──────────────── core (plain Node/TypeScript, no Electron APIs) ───────────────┐
            │  collector · lockfile parser · plain-code triage · triage job runner ·        │
            │  verdict importer · report generator · VEX exporter · dismiss-script writer   │
            │                          SQLite database (one file)                           │
            └───────────────▲──────────────────────────▲──────────────────────────▲─────────┘
                            │                          │                          │
                  Electron app (UI)          CLI (`package-vitals`)       MCP server (stdio)
                                                                       started by Claude Code
```

- **The core must not depend on Electron.** Claude Code starts the CLI and MCP server on a system Node install without opening the app, so the core can't use Electron-only APIs such as `safeStorage`. Inside the app, Electron's bundled Node runs the same core.
- **The app, CLI, and MCP server share one SQLite file.** It has to work from both Electron's bundled Node and plain Node, and with more than one process open at once. Use WAL mode.
- **Outside tools:**

| Tool | Used for | How |
|---|---|---|
| `gh` | GitHub login | `gh auth token`, read by the host process only |
| OSV API (`api.osv.dev`) | Vulnerability lookup for lockfile packages | Called by the host with package lists from the core's own lockfile parsers (Section 4) |
| `@anthropic-ai/sandbox-runtime` | Sandboxing for Claude triage jobs | Used as a library |
| `claude` | Triage jobs | `claude -p`, run inside the sandbox runtime, under the owner's Claude subscription (Section 6) |
| `git` | Shallow clones for the plain-code check and triage | Run by the host process |

The app checks that each tool is installed and tells the owner which ones are missing. **[Claude's call]** Tools are not bundled, since this is a personal tool.

### Electron UI hardening (required)

Reports and the side panel display advisory text, Claude's output, and code from untrusted repos. A hostile repo must not be able to run script in the app. Required settings:

- `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false` on every window
- A narrow preload API exposed through `contextBridge`, with no general IPC passthrough
- A strict Content Security Policy and no remote content
- Markdown rendered with raw HTML disabled, or sanitized
- Repo-derived text always rendered as text, never as HTML

---

## 4. Data collection (Checkup)

Checkups run **only when the owner starts them**, from the app's Checkup button or from the CLI. There is no scheduler. **[Claude's call]** Each run is saved as a **snapshot**, so reports can show trends and how long alerts have been open.

### Which repos

- An "owner" is a GitHub user or org. The first version handles only the authenticated user's own repos (`GET /user/repos?affiliation=owner`).
- **[Claude's call]** Forks and archived repos are skipped by default, with a setting to include them.
- Empty repos (the tree API returns HTTP 409) are skipped and listed as empty.

### Level 0: GitHub API

- **Authentication:** reuse the `gh` login (`gh auth token`). Its default `repo` scope was confirmed to read Dependabot alerts on both private and public repos. **[Claude's call]** This replaces the original doc's fine-grained Keychain token for now.
- **Alerts:** a personal account has no org-wide endpoint, so the collector calls `GET /repos/{owner}/{repo}/dependabot/alerts?state=open` for each repo, paginated. Keep at least these fields:
  - alert number and state
  - `dependency.package` (ecosystem and name), `dependency.manifest_path`, `dependency.scope`, `dependency.relationship`
  - `security_advisory`: GHSA ID, CVE ID, severity, and summary
  - `security_vulnerability`: vulnerable version range and first patched version
  - `created_at`
- **Dismissed and fixed alerts:** **[Claude's call]** also fetch alerts in `state=dismissed` and `state=fixed`. Dismissed ones are needed for tracking dismissals (Section 8), and fixed ones are needed for trends and alert-age figures in reports.
- **Repos with Dependabot turned off** return HTTP 403 ("Dependabot alerts are disabled for this repository"). Show them as **not monitored**, never as healthy. There are 10 of these today.
- **Inventory:** `GET /repos/{owner}/{repo}/dependency-graph/sbom` for each repo.
- **Measured cost:** a full pass over 355 repos (alerts plus trees) took about one minute with 8 parallel requests and used about 360 of the 5,000 hourly core API requests. The collector should limit how many requests run at once and respect rate-limit headers.

### Level 1: lockfiles (npm and RubyGems)

- **[Claude's call]** Fetch files through the Git Trees API (`git/trees/HEAD?recursive=1`), not a sparse clone: filter for the file names below, then fetch only those blobs. Ignore paths under `node_modules/` and `vendor/`.
- **Files:**
  - npm: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, and `pnpm-lock.yaml`
  - RubyGems: `Gemfile.lock` and `Gemfile`
- **Look up vulnerabilities through the OSV API.** **[Claude's call]** This replaces running OSV-Scanner:
  - The core's own lockfile parsers produce the package list.
  - The host sends it to `POST /v1/querybatch` and fetches the details for each match.

  The reasons: the core has to parse lockfiles anyway to build dependency chains. No third-party binary parses untrusted files. Level 1 needs no sandbox. And it works the same on Windows.
- **Compare with Dependabot.** Each finding records its source: Dependabot, OSV, or both. Show the difference, because it reveals what Dependabot misses or has turned off.
  - Match OSV results to Dependabot alerts by repo, package, version, and advisory ID, including GHSA and CVE aliases.
  - An OSV result that matches a **dismissed** Dependabot alert counts as that alert. It is not shown as a new "OSV only" finding.
- **Direct or transitive:** GitHub reports `relationship: unknown` for about half of the critical alerts, so work it out from the lockfile:
  - npm lockfiles record the dependency tree.
  - The `DEPENDENCIES` section of `Gemfile.lock` lists the direct gems.
  - Store the **dependency chain** from the app down to each vulnerable package, for example `slack-deck → mkdirp 0.5.1 → minimist 0.0.8`.

Background: of the 522 critical alerts, GitHub marks 182 as transitive and 64 as direct, and can't tell for 273. The packages behind the most critical alerts are mostly transitive: `form-data` appears in 23 repos, `tar` in 20, and `minimist` and `proxy-addr` in 19 each.

---

## 5. Triage

### Tiers

| Tier | Meaning | Decided by |
|---|---|---|
| 1. Not shipped | The package is dev-only or test-only. | Plain code |
| 2. Not imported | No direct dependency that pulls the package in is imported by the app's code. | Plain code |
| 3. Not called | The package is loaded, but the vulnerable function is never called on any path from the app. | Claude |
| 4. Not exploitable | The vulnerable function is called, but the input is not attacker-controlled. | Claude |
| 5. Reachable | A path exists from an entry point (HTTP handler, CLI argument, queue consumer) to the vulnerable code. | Claude |

Tier 2 changes the original doc's definition, which was "the code never requires it." That definition is wrong for transitive packages, because app code never requires them directly. A transitive package counts as not imported only if **no direct dependency that pulls it in is imported**.

### Plain-code tiers must be conservative

When in doubt, don't rule the finding out. Leave it for Claude.

- **Tier 1:**
  - Use Dependabot's `scope: development` first. It already marks 27% of all alerts and 108 of the 522 criticals.
  - Then use `"dev": true` in npm lockfiles.
  - For Ruby, `Gemfile.lock` doesn't record groups, so read the `:development` and `:test` groups from the `Gemfile`.
  - A package counts as not shipped only if **every** chain that pulls it in is dev-only.
  - **Repos that use a bundler.** **[Claude's call]** In bundler-based projects, dev dependencies are often compiled into what ships. That includes Vite, webpack, Rollup, esbuild, Parcel, Next.js, Nuxt, SvelteKit, Remix, Astro, and Gatsby, detected from config files, `package.json` dependencies, or scripts. So in these repos, dev scope alone never settles tier 1:
    - A dev-scope package is "not shipped" only if the plain-code check finds that neither it nor the direct dependency that pulls it in is imported from app source. Being used only in build config, tooling, or scripts still counts as not shipped.
    - Otherwise the finding stays open for Claude.
    - The estimate that the dev-only filter takes 522 critical alerts down to about 410 is therefore an upper bound on what tier 1 removes.
- **Tier 2:** this needs the source code, so it runs on a shallow clone as part of the plain-code check (below), still without Claude.
  - **JavaScript:** search for `require()`, `import`, and dynamic `import()` of the package and its subpaths. Packages can also be loaded without a visible import, by config files (Babel, ESLint, bundlers, frameworks) and by `package.json` scripts. A direct dependency that appears in any of those counts as imported.
  - **Ruby:** Rails apps call `Bundler.require`, which loads every gem in the default group. A gem counts as not imported only if it has `require: false` and there is no explicit `require` of it. Without `Bundler.require`, a gem counts as not imported only if nothing requires it.

### The plain-code check

**[Claude's call]** This is a separate step that the owner starts, apart from the Checkup:

- **What it does:** it shallow-clones repos and runs tier 2, and the bundler part of tier 1, on findings of **every severity**. That's how non-critical alerts can be cleared by plain code too.
- **Where it can be started:** from the app or the CLI, for one repo or all repos with open alerts.
- **What the Checkup does instead:** it stays API-only plus lockfiles and never clones.
- **At the start of every triage job,** the check runs again on that repo first if its result is missing or stale.
- **Where it runs:** in the host process, because it only reads text with the core's own code and executes nothing from the repo. Clone hardening:
  - `git clone --depth 1 --no-recurse-submodules -c core.symlinks=false`, with Git LFS downloads skipped
  - the search never follows symlinks
  - clones live in a cache directory the app owns

### Which findings go to Claude

- **Critical npm and RubyGems** findings that plain code didn't rule out. **[Claude's call]** Critical alerts in other ecosystems (11 pip and 4 Rust today) have no dependency chain in this version, so they stay "not triaged" and can't be sent to Claude.
- The owner can send any single npm or RubyGems finding to triage by hand, including high ones.
- Triage runs **only on demand**, from any of these:
  - the app: one finding, one repo, or **Triage all eligible**, covering every eligible critical finding in the account
  - the CLI
  - Claude Code, through the MCP server

  It never starts automatically after a Checkup. Section 6 covers how jobs are queued.

### Verdicts

Each verdict contains:

- the tier
- evidence as `file:line` references
- a confidence level: high, medium, or low
- the commit SHA that was analyzed
- a short explanation of the reasoning

The host validates every verdict before importing it:

- It checks the verdict against a JSON schema.
- It checks that every cited `file:line` exists at that commit. A "not reachable" verdict (tier 3 or 4) without valid evidence is rejected, and the finding is flagged.
- **[Claude's call]** A tier 3 or 4 verdict with medium or low confidence is stored, but the finding is shown as **uncertain** and treated as not ruled out.

### Caching

- Each verdict is stored with the commit SHA it was based on and the hash of the lockfile it used.
- **[Claude's call]** When either one changes in a later snapshot, the verdict is marked **stale**. It stays visible with a flag, and the owner can re-run triage. It is not deleted.

### Overrides

- The owner can override any verdict as **accepted risk** or **not affected**, with a reason.
- Overrides are kept across snapshots.
- **[Claude's call]** An override recorded through the MCP server, meaning Claude acting on the owner's request in their own session, is stored as **proposed**. It doesn't count until the owner confirms it in the app. This keeps a prompt-injected interactive session from quietly ruling findings out.

---

## 6. Triage jobs and sandboxing

### Isolation levels in this version

| Level | What runs | Isolation |
|---|---|---|
| 0. Checkup (API) | Nothing from repos | None needed |
| 1. Lockfile scan | The core's own parsers read fetched lockfiles, and the host queries the OSV API | None needed: nothing from the repo is executed |
| 2a. Plain-code check | The core's own code searches a hardened shallow clone | None needed: nothing from the repo is executed (Section 5) |
| 2b. Claude triage | `claude -p` reads code | Sandbox runtime: read-only inputs, network limited to what `claude` needs to reach the Claude API |

**[Claude's call]** This moves Levels 1 and 2a out of the sandbox, which the original doc had used for them. The reason is that the only thing reading untrusted files there is the core's own TypeScript, which executes nothing. The sandbox stays where it matters: around Claude, which can be prompt-injected.

### How a triage job runs

**[Claude's call]** There is **one job per repo**, covering all the critical findings for that repo that are queued for triage. Claude reads the codebase once instead of once per alert. For the owner's account today, that is at most 87 jobs.

1. **The host prepares the workspace.** This happens outside the sandbox, using the GitHub token:
   - Copy the plain-code check's hardened clone, at its recorded commit, into a job directory.
   - **Strip any files Claude Code would treat as instructions or configuration:** `.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, and `AGENTS.md`, at any depth. Keep a list of what was removed.
   - For each finding, download from the registry **only the packages on its dependency chain**. Unpack them with no install and no scripts.
   - Put everything into the job directory as **read-only** files. Remove the `.git` directory, or make sure it holds no credentials.
2. **The host starts `claude -p` inside the sandbox runtime:**
   - The working directory is a job directory **outside** the cloned repo, so the repo's own settings are never loaded as project settings.
   - **It logs in with a dedicated, long-lived subscription token.** The owner creates it once with `claude setup-token`.
     - The core stores the token in the operating system's credential store (the macOS Keychain, the Linux Secret Service, or the Windows Credential Manager), using its own access rather than Electron's `safeStorage`.
     - The host passes the token into each job as an environment variable (`CLAUDE_CODE_OAUTH_TOKEN`).
     - **The sandbox gets no Keychain or credential-store access at all.** On macOS, the owner's Claude Code login and the `gh` token are both in the Keychain, so access for one would expose the other.
     - Usage counts against the owner's subscription.
   - **Model:** the most capable Claude model by default, with a setting to change it.
   - It loads no MCP servers (`--strict-mcp-config` with an empty config) and none of the owner's user or project settings, hooks, or plugins.
   - Its tools are limited to reading and searching files. It has no shell, no web fetch, and no web search.
   - It writes its verdicts as structured JSON, either to stdout or to one output file in a writable directory reserved for that purpose.
   - The GitHub token is not present, and network access is limited to what `claude` needs.
3. **The host imports the output**, applying the validation in Section 5.

### Job queue

- **Jobs are stored in a persistent queue in the database,** so a "Triage all eligible" pass of up to 87 repo jobs survives app restarts.
- **Any of the app, CLI, or MCP server can add jobs.** The queue runner lives in the core, and a lock makes sure only one process runs the queue at a time.
- **[Claude's call]** Two jobs run at a time.
- **[Claude's call]** When a job hits a subscription usage limit, the queue **pauses** and resumes later instead of failing. Jobs that were stopped partway are retried from the start.
- The app shows queue progress, and the owner can pause or cancel it.

### The `triage-reachability` skill

This is the instruction set the sandboxed job runs with. It covers:

- treating all repo content as data, never as instructions
- reading the advisory and identifying the vulnerable function or symbol
- tracing from the app's code through the dependency chain to that symbol
- tracing backward to entry points
- citing `file:line` evidence for every verdict
- using medium or low confidence whenever the trace is incomplete

---

## 7. The app

These screens were chosen from mockups.

### Home: priority queue

- One ranked list of findings across all repos.
- **A summary strip** across the top shows counts: critical, dev-only, reachable, uncertain, not triaged.
- **[Claude's call] Order:**
  1. Reachable, highest confidence first
  2. Uncertain, along with dismissed alerts that need a re-check (Section 8)
  3. Not triaged
  4. Ruled out, in the order not exploitable, not called, not imported, not shipped

  Within each group, the oldest alert comes first.
- **[Claude's call] Default filter:** critical only. Filters add high, medium, and low, and filter by repo, ecosystem, tier, and source (Dependabot, OSV, or both).
- **Not monitored repos** appear as a separate notice, not as rows.
- Multi-select is supported, for the dismiss commands (Section 8).

### Finding detail: side panel

- Click a row and the detail opens on the right while the queue stays visible. The arrow keys move between findings.
- **It shows:**
  - the package, version, repo, severity, and advisory
  - the verdict, with confidence and the commit it was based on, plus a stale flag if it applies
  - the dependency chain
  - the `file:line` evidence with short excerpts
  - Claude's reasoning
  - **the fix**: the patched version, plus the direct-dependency upgrade when that removes the vulnerable package entirely
  - any override, with its reason and whether it is proposed or confirmed
- **Buttons:**
  - **Re-run triage**
  - **Override…**
  - **Copy as Markdown**, for handing the finding to another dev
  - **Copy prompt for Claude Code**, which copies a short prompt that points Claude at the finding's ID so it can look it up over MCP
  - **Open on GitHub**

### Secondary views

- **Repo cards:** each card shows the repo's vital signs, with the worst repos first:
  - critical and high counts
  - the reachable count
  - the age of the oldest open alert
  - the number of outdated dependencies

  Clicking a card opens the queue filtered to that repo.
- **Treatment plan:** upgrades ranked by how many repos each one clears. Today, `form-data` clears a critical alert in 23 repos and `tar` in 20.
- **Reports:** lists the generated reports and renders them as Markdown, under the UI hardening rules in Section 3.

### Other controls

- The **Checkup** button runs a scan and creates a snapshot.
- Triage can be started from a single finding or from a whole repo.

---

## 8. Bulk dismissal (generated, never run by the app)

### Tracking dismissed alerts

**[Claude's call]** Dismissing an alert must not hide a verdict that later goes stale, because that is the worst failure in Section 1.

- **How dismissals are recognized:** the collector fetches dismissed alerts (Section 4). Alerts dismissed through Package Vitals are recognized in two ways: their dismissal comment starts with `Package Vitals:`, and the app stores a record of every dismiss script it generates.
- **They keep being checked:** stale checks continue on dismissed findings in every snapshot, looking for a changed commit, lockfile, or dependency chain.
- **When a dismissal goes stale:** the finding comes back to the queue as **dismissed, needs re-check**, ranked with "uncertain". The app offers a generated **reopen** command (`-f state=open`), which it never runs itself.
- **Alerts dismissed outside Package Vitals** are shown as dismissed, with GitHub's reason. They are not re-checked.
- **Reports** count dismissed alerts separately from fixed ones, so dismissing alerts never looks like fixing them.

- **Where:** select findings in the queue, then choose **Copy dismiss commands** or **Save dismiss script**. The CLI has the same feature, for example `package-vitals dismiss-script --tier not-called`. **The app and CLI only print the commands. They never execute them.**
- **What qualifies:**
  - plain-code verdicts (tiers 1 and 2)
  - high-confidence Claude verdicts with valid evidence
  - confirmed human overrides

  Findings that are reachable, uncertain, stale, not triaged, or covered only by a proposed override are never included.
- **Mapping to GitHub's `dismissed_reason`:**

| Verdict | `dismissed_reason` |
|---|---|
| Not shipped (dev only) | `tolerable_risk` |
| Not imported, Not called | `not_used` |
| Not exploitable | `tolerable_risk` |
| Override: "accepted risk" | `tolerable_risk` |
| Override: "not affected" | `not_used` |

- **Command per alert:**
  `gh api -X PATCH repos/{owner}/{repo}/dependabot/alerts/{number} -f state=dismissed -f dismissed_reason=… -f dismissed_comment="…"`
  The comment is limited to 280 characters and cites the verdict, the snapshot, and the commit.
- **Header and undo:** the script header gives the generation time, the snapshot, and the number of alerts. It warns about any verdict older than the latest Checkup. Every script comes with an **undo script** that reopens the same alerts with `-f state=open`.
- Findings that come only from OSV, with no Dependabot alert, can't be dismissed on GitHub and are left out.
- **[Claude's call]** Scripts are POSIX `sh`. A PowerShell version waits for Windows polish.

---

## 9. OpenVEX export

OpenVEX export is in the first version. It writes one document per repo, or one for the whole account.

- **Product:** the repo at the analyzed commit.
- **Subcomponent:** the package, identified by its purl, for example `pkg:npm/minimist@0.0.8`.
- **Vulnerability:** the GHSA ID, with the CVE ID as an alias when there is one.

| Package Vitals state | VEX status | Justification or statement |
|---|---|---|
| Not shipped | `not_affected` | `component_not_present` |
| Not imported, Not called | `not_affected` | `vulnerable_code_not_in_execute_path` |
| Not exploitable | `not_affected` | `vulnerable_code_cannot_be_controlled_by_adversary` |
| Reachable | `affected` | `action_statement`: the fix |
| Uncertain, Not triaged, Stale | `under_investigation` | |
| Override: "not affected" | `not_affected` | `impact_statement`: the owner's reason |
| Override: "accepted risk" | `affected` | `action_statement`: "accepted risk" plus the reason |

Only confirmed overrides are exported. Proposed overrides are exported using the underlying verdict.

---

## 10. Reports

There are two kinds:

- **Account health report**, for the whole account:
  - a headline such as "522 critical → N reachable"
  - severity counts before and after triage
  - the repos with the worst vitals
  - not monitored repos
  - the treatment plan
  - trends between snapshots
  - how long alerts have been open
  - **[Claude's call]** SLA targets, off by default because this is a hobby setup
- **Repo chart**, for one repo:
  - its vital signs
  - each finding with its tier, evidence, fix, and upgrade path
  - any overrides and their reasons

How they are produced:

- **Without Claude:** the app generates complete reports from the database using templates.
- **With Claude:** the owner asks Claude Code, and the `write-report` skill writes a cleaner narrative using data from the MCP server.
- **The deterministic-numbers rule:** every figure comes from the database. **[Claude's call]** Claude's narrative uses placeholders such as `{{critical_total}}`, which the app fills in. If Claude's text contains a bare number, the app flags it.
- Reports are saved as `.md` files in a reports folder and viewed in the app.

---

## 11. Claude integration

### MCP server

Claude Code starts the MCP server over stdio. It works whether or not the app is open.

- **Read tools:** repos, snapshots, findings with their verdicts, evidence, and chains, the treatment plan, and report data.
- **Write tools,** kept to a minimum:
  - **start triage** for a finding or a repo. This launches the sandboxed job from Section 6. It does not run triage in the interactive session.
  - **propose override**. The override is stored as proposed until the owner confirms it in the app (Section 5).
- **No tool can change scan data.**
- Repo-derived text in tool output (advisory text, evidence excerpts, Claude's reasoning) is clearly marked as untrusted data.

### Skills shipped in the repo

| Skill | Purpose |
|---|---|
| `collect` | Drives the Checkup through the CLI and reports what changed since the last snapshot. |
| `triage-reachability` | The instructions for sandboxed triage jobs (Section 6). It also tells the interactive session how to start jobs and read their results. |
| `write-report` | Writes report narrative from MCP data, using placeholders for every number. |

---

## 12. Left to the builder

- The database schema. The data model needs at least: snapshots, repos, alerts, lockfiles, dependency chains, findings (with source), verdicts, overrides (with proposed or confirmed state), triage jobs, and reports.
- The repo and package layout, such as a monorepo containing core, CLI, MCP server, app, and skills. Also the monorepo tooling.
- The UI framework inside Electron, such as React, and the component, table, Markdown, code-view, and chart libraries.
- Electron packaging (Forge or electron-builder). Signing and notarization aren't needed for personal use.
- Lockfile parsers for each format (npm lockfile v1 to v3, yarn classic and berry, pnpm, and Bundler).
- How OSV API requests are batched and cached.
- How "outdated dependencies" is computed, for example from registry metadata.
- MCP tool names and shapes, the verdict JSON schema, and report templates.
- Testing strategy and build order. A suggested order, where each step is usable on its own:
  1. Core, CLI, and the Level 0 Checkup, with SQLite snapshots and a basic app-generated report
  2. The Electron app: queue, side panel, repo cards, treatment plan, and Reports view
  3. Level 1 lockfiles, the OSV comparison, chains, and tier 1
  4. The plain-code check (tier 2 and the bundler rule) on hardened shallow clones
  5. Sandboxed Claude triage, verdict validation, caching, overrides, OpenVEX, and dismiss scripts
  6. The MCP server's write tools, the three skills, and Claude-written reports

---

## 13. Verify before building on it

- **SQLite:** whether `node:sqlite` works in both the current Electron and plain Node, or whether to use `better-sqlite3` with a rebuild for Electron.
- **Sandbox runtime:** whether the library works from Electron's main process or needs a utility process. Its current Windows status.
- **`claude -p` inside the sandbox runtime:**
  - that it logs in using only the `claude setup-token` token passed in the environment, with no access to the Keychain or the owner's `~/.claude` directory
  - the smallest network allowlist it needs
  - the exact flags for limiting tools, skipping user and project settings, loading no MCP servers, choosing the model, and producing structured output
  - how a usage-limit error shows up, so the queue can recognize it and pause
- **The sandbox blocks credentials.** Confirm that the sandbox runtime can deny Keychain and credential-store access on macOS and Linux, and that a sandboxed process can't read the `gh` token (Keychain, `~/.config/gh`, or environment variables). If it can't, Level 2 must not ship until this is solved.
- **The current `gh` token can dismiss alerts.** The commands are run by the owner, but the generated script should state the scope it needs.
