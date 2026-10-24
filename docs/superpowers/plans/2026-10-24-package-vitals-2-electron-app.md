# Package Vitals, Plan 2: The Electron App

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locked-down Electron desktop app on top of the Plan 1 core. It has a priority queue of open alerts with a side panel, repo cards, a treatment plan, a Reports view, and a Checkup button. It reads the same SQLite file as the CLI.

**Architecture:**
- The main process runs the core directly: ESM, on Electron's bundled Node 24. It is the only place with the database, the file system, and the `gh` token.
- The renderer is a sandboxed, context-isolated React app. It gets data through a narrow preload API, `window.vitals`. Every call names data: a snapshot, a finding key, or a report ID. Main validates the call, reads the database, and builds any text, file read, or URL itself.
- The renderer is served from a custom `app://vitals/` protocol, with a strict CSP and no network access.
- This is stage 2 of the spec's build order. Until Plans 3–5 add lockfiles and triage, every finding is "Not triaged".

**Tech Stack:**
- Electron `^45.0.0`: Node 24.22.0, Chromium 156.
- React 19, Vite 8, and `@vitejs/plugin-react` for the renderer.
- `@tanstack/react-virtual` for the queue, and `markdown-it` 15 for reports.
- Tests: Vitest with a `node` project and a `jsdom` project, `@testing-library/react`, and Playwright's Electron support for one end-to-end test.

**Spec:** `docs/superpowers/specs/2026-10-24-package-vitals-design.md`. This plan covers:
- the Electron UI hardening in Section 3
- Section 7, apart from the parts that need data from later plans (listed below)
- the Reports view from Section 10
- the Checkup button

It builds on Plan 1 (`docs/superpowers/plans/2026-10-24-package-vitals-1-core-checkup.md`). The stack decision is `docs/decisions/0001-tech-stack.md`.

**Plan decisions.** The spec leaves these to the builder.
- **One npm package, as in Plan 1.** The app lives in `src/app/{main,preload,renderer,shared}`.
  - `tsc` builds main and preload into `dist/app`. Vite builds the renderer into `dist/app/renderer`.
  - The renderer's libraries are bundled by Vite, so they go in `devDependencies`. The core and CLI keep zero runtime dependencies.
- **SQLite stays `node:sqlite`.** Plan 1 verified it in Electron 45.0.0, including WAL mode. Main holds one connection for its whole life.
- **The preload is one CommonJS file, `src/app/preload/preload.cts`, which `tsc` compiles to `preload.cjs`.**
  - Sandboxed preloads can't be ESM and can't `require` local files.
  - So it lists the method names itself, and the compiler checks them against `VitalsApi`. This was confirmed with `tsc` 7.0.2: `import type … with { 'resolution-mode': 'import' }`.
- **The renderer loads from `app://vitals/`, not `file://`.**
  - The CSP is sent as a response header and repeated in a `<meta>` tag.
  - Requests to any other scheme are cancelled at the session.
- **The renderer gets data, never capabilities.** "Copy as Markdown" and "Open on GitHub" pass a finding key. Main builds the text and the `https://github.com/…` URL from the database.
- **Electron's `userData` is set to the data home** (Plan 1's `resolveDataHome`). That is the same folder by default, and it keeps `PACKAGE_VITALS_HOME` runs fully separate.
- **Findings in this plan are the open Dependabot alerts of the latest complete snapshot.** A finding is keyed by `{ snapshotId, repoId, number }`.
- **Queue order: by severity (critical first), then oldest first.** This is a deviation for the owner to confirm.
  - Spec Section 7 ranks by triage state first, then oldest first. Triage states arrive in Plans 3–5, and then the state comes first.
  - Severity is added so that an "all severities" view doesn't bury criticals under older high alerts. With the default critical-only filter, the order is exactly the spec's.
- **Counts that need later plans show "—", never 0.** "Reachable 0" would read as good news. This covers dev-only, reachable, and uncertain on the summary strip, and reachable on repo cards.
- **Left for later plans:**
  - installed version, dependency chain, dev-only tier, direct-dependency upgrade, and outdated dependencies (Plan 3)
  - tier and source filters (Plans 3–5)
  - verdicts, Re-run triage, Override, and multi-select dismiss commands (Plan 5)
  - Copy prompt for Claude Code (Plan 6)
  - packaging into an installable app: until then `npm run app` launches from the repo, so `gh` is found on the shell's `PATH`, and a packaged app must deal with Finder's `PATH`
  - in-app settings for forks and archived repos (the app uses Plan 1's defaults)
  - a tools panel. In this plan a missing or logged-out `gh` shows up as the Checkup's error message.

## Global Constraints

- The core and CLI need Node.js `>=24`. The app runs on Electron `^45` (bundled Node 24.22.0). SQLite is used only through `node:sqlite`.
- **The core must not depend on Electron:** no `electron` import under `src/core` or `src/cli`, enforced by `test/core/no-electron.test.ts`.
- `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false` on every window.
- A narrow preload API exposed through `contextBridge`, with no general IPC passthrough.
- A strict Content Security Policy and no remote content.
- Markdown rendered with raw HTML disabled.
- Repo-derived text always rendered as text, never as HTML.
- **The app never writes to GitHub itself.** The GitHub token stays in the main process. It never reaches the renderer, logs, or error messages.
- The app and the CLI share one SQLite file at `<data home>/vitals.db`, in WAL mode.
- Views and reports read only **complete** snapshots. A running or failed snapshot never shows.
- Not monitored repos appear as a separate notice, not as rows, and never as healthy.
- The queue's default filter is critical only.
- Every figure comes from the database.
- Development and testing happen on macOS first. Linux and Windows must keep building.

## Review Focus

1. **Hostile repo text reaching the screen.** Advisory summaries, package names, manifest paths, error messages, and report files containing `<img src=x onerror=…>`, `<script>`, Markdown links, or images must appear as literal text. No script runs, nothing loads, and nothing navigates. Tests: Tasks 5, 6, 8, and the end-to-end check in Task 10.
2. **A compromised renderer calling the preload API with crafted input.** Wrong types, extra keys, non-integer IDs, a report ID whose recorded path points outside the reports folder (directly or through a symlink), or a repo name that isn't a GitHub name. Main must reject the call. It reads only recorded report files inside the reports folder and opens only `https://github.com/` alert URLs. Calls from any frame other than `app://vitals` are refused. Tests: Tasks 3, 6, 8, and 10.
3. **The whole account in the queue.** About 10,000 rows when every severity is ticked must stay responsive: the list is virtualized, and the arrow keys move the selection and keep it in view. Tests: Tasks 5 and 6.
4. **A Checkup that is started twice, fails, or races a CLI Checkup.** Causes include `gh` missing, `gh` logged out, or a network error. The app runs one Checkup at a time and shows a plain message that never contains the token. The views keep showing the last complete snapshot. Tests: Tasks 3 and 9.
5. **No data, nothing matching, or repos without data.** This covers an empty database, a filter with no matches, and repos that are not monitored or couldn't be read. Each gets a clear empty state, and nothing crashes. Repo cards show the status, never zero counts that look healthy. Tests: Tasks 4, 5, and 7.

---

## File Structure

```
package.json, tsconfig.json, tsconfig.test.json        modified: app build, scripts, devDependencies
tsconfig.renderer.json, vite.config.ts                  renderer typecheck and build
vitest.config.ts                                        projects: node and dom
vitest.e2e.config.ts                                    end-to-end run
src/core/types.ts                                       + view types (findings, repo cards, reports, checkup summary)
src/core/queries/findings.ts                            queue queries
src/core/queries/account.ts                             + repoCards, treatment plan without a limit
src/core/queries/reports.ts                             report list and paths
src/core/reports/finding-markdown.ts                    "Copy as Markdown" text
src/core/reports/generate.ts                            write an account report or repo chart (shared by CLI and app)
src/core/github/urls.ts                                 Dependabot alert URL
src/core/checkup/account-checkup.ts                     token → owner → runCheckup (shared by CLI and app)
src/core/checkup/format.ts                              summary and warning lines (shared by CLI and app)
src/app/shared/api.ts                                   VitalsApi, DTOs, method list, channels
src/app/main/main.ts                                    Electron entry: wiring only
src/app/main/security.ts                                web preferences, CSP, navigation, permission, and request guards
src/app/main/protocol.ts                                app:// file serving
src/app/main/validate.ts                                IPC input parsing
src/app/main/ipc.ts                                     handler registration with a sender check
src/app/main/checkup.ts                                 one-at-a-time Checkup controller
src/app/main/handlers/{common,queue,actions,reports,checkup,index}.ts
src/app/preload/preload.cts                             contextBridge API
src/app/renderer/index.html, main.tsx, App.tsx, styles.css, format.ts, vitals.d.ts
src/app/renderer/views/{QueueView,RepoCardsView,TreatmentPlanView,ReportsView}.tsx
src/app/renderer/components/{SummaryStrip,Notices,FindingList,SidePanel,Markdown,CheckupButton}.tsx
test/core/**, test/app/main/**                          node project
test/app/renderer/** (*.test.tsx, setup.ts, fake-api.ts) dom project
test/e2e/app.e2e.test.ts                                Playwright + Electron
```

---

### Task 1: View queries for the app

**Files:**
- Modify: `src/core/types.ts`. Add the view types below. Move `MonitoringSummary` and `TreatmentRow` here from `src/core/queries/account.ts`, and `CheckupSummary` here from `src/core/checkup/checkup.ts`, updating the imports. The renderer must be able to import these types without pulling in `node:sqlite`.
- Create: `src/core/queries/findings.ts`, `src/core/queries/reports.ts`
- Modify: `src/core/queries/account.ts`
- Test: `test/core/queries/findings.test.ts`, `test/core/queries/reports.test.ts`, `test/core/queries/account.test.ts`

**Interfaces:**
- Consumes: `seedSnapshot` (test helper), `writeReport`, `Severity`, `SnapshotRow`.
- Produces, in `src/core/types.ts`:
```ts
export interface FindingKey { snapshotId: number; repoId: number; number: number }
export interface FindingFilter { severities: Severity[]; repoId: number | null; ecosystem: string | null }
export type TriageState = 'not_triaged'; // Plans 3–5 add the others
export interface FindingRow extends FindingKey {
  fullName: string; severity: Severity; ecosystem: string; packageName: string; ghsaId: string;
  summary: string; manifestPath: string; createdAt: string; triage: TriageState;
}
export interface FindingDetail extends FindingRow {
  cveId: string | null; scope: 'runtime' | 'development' | null; relationship: string | null;
  vulnerableRange: string | null; firstPatched: string | null;
}
export interface RepoCard {
  repoId: number; fullName: string; status: 'ok' | 'not_monitored' | 'error'; error: string | null;
  critical: number; high: number; open: number; oldestOpenAlert: string | null;
}
export interface ReportEntry {
  id: number; kind: 'account' | 'repo'; snapshotId: number; repoFullName: string | null; fileName: string; createdAt: string;
}
```
- Produces, in `src/core/queries/findings.ts`. Every function reads open alerts only.
  - `listFindings(db, snapshotId, filter): FindingRow[]`. Order: severity (critical first), then `created_at` ascending, then `fullName`, then `number`. Every row has `triage: 'not_triaged'`.
  - `getFinding(db, key): FindingDetail | null`. Returns null when the key isn't an open alert in that snapshot.
  - `countFindings(db, snapshotId, filter): { critical: number; matching: number }`. `critical` counts open critical alerts within the repo and ecosystem filters, ignoring `severities`. `matching` counts the rows that match the whole filter.
  - `findingEcosystems(db, snapshotId): string[]` (distinct, sorted)
  - `snapshotRepos(db, snapshotId): { id: number; fullName: string }[]` (sorted by name)
- Produces, in `src/core/queries/account.ts`:
  - `repoCards(db, snapshotId): RepoCard[]`, covering every repo in the snapshot. Order:
    1. repos with open alerts, worst first (critical, high, then open, all descending, then name)
    2. `error` repos
    3. `not_monitored` repos
    4. `ok` repos with no open alerts, by name
  - `criticalTreatmentPlan(db, snapshotId, limit?: number)` returns every row when `limit` is omitted.
- Produces, in `src/core/queries/reports.ts`:
  - `listReports(db): ReportEntry[]`, newest first (`created_at` descending, then `id` descending). `fileName` is the path's basename.
  - `getReportPath(db, id): string | null`. This is for main only; the renderer never sees a path.

- [ ] **Step 1: Write the failing tests**
  - `findings.test.ts`:
    - `lists open alerts only, critical first, then oldest first`. Seed repo `a` with these alerts: high created `2020-01-01`, critical `2024-01-01`, critical `2022-01-01`, and a dismissed critical. Seed repo `b` with a critical created `2023-01-01`. With all severities, the rows are `[a crit 2022, b crit 2023, a crit 2024, a high 2020]`, and every `triage` is `'not_triaged'`.
    - `filters by severity, repo, and ecosystem`
    - `getFinding returns the detail, or null for a closed or unknown alert`. A null CVE and patch come back as `null`.
    - `countFindings counts criticals regardless of the severity filter`. With `{ severities: ['high'], repoId: a, ecosystem: null }`, `critical` is `a`'s open criticals and `matching` is `a`'s open highs.
    - `findingEcosystems and snapshotRepos list what the filters offer`
  - `account.test.ts`:
    - `repoCards puts the worst repos first, then repos without data, then clean repos`. Seed `a` (1 critical), `b` (2 high), `c` (error `Bad Gateway (HTTP 502)`), `d` (not monitored), and `e` (ok, no alerts). The order is `a, b, c, d, e`, and `c.error` is the message.
    - `criticalTreatmentPlan returns every row without a limit`
  - `reports.test.ts`:
    - `listReports returns newest first with the repo name and file name`. Insert the rows through `writeReport`.
    - `getReportPath returns null for an unknown id`

- [ ] **Step 2: Run** `npx vitest run test/core/queries`. Expected: the new tests fail with "is not a function" or an import error.
- [ ] **Step 3: Implement the types and queries above.**
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: add queue, repo card, and report list queries`.

---

### Task 2: Electron shell: locked-down window, app protocol, CSP

**Files:**
- Modify: `package.json`, `tsconfig.json`, `tsconfig.test.json`
- Create:
  - `tsconfig.renderer.json`, `vite.config.ts`
  - `src/app/main/main.ts`, `src/app/main/security.ts`, `src/app/main/protocol.ts`
  - `src/app/preload/preload.cts` (just `export {};` for now)
  - `src/app/renderer/index.html`, `src/app/renderer/main.tsx`, `src/app/renderer/App.tsx` (a placeholder `<h1>Package Vitals</h1>`), `src/app/renderer/styles.css`
- Test: `test/app/main/security.test.ts`, `test/app/main/protocol.test.ts`, `test/core/no-electron.test.ts`

**Interfaces:**
- Produces, in `security.ts`:
  - `CONTENT_SECURITY_POLICY: string` = `"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"`
  - `webPreferences(preload: string): WebPreferences`
  - `isAppUrl(url: string): boolean` (true only for scheme `app:` with host `vitals`; Node's `URL.origin` is `'null'` for custom schemes, so compare `protocol` and `host`)
  - `isAllowedRequestUrl(url: string): boolean`
  - `hardenWebContents(c: WebContentsLike): void`
  - `hardenSession(s: SessionLike): void`
  - `WebContentsLike` and `SessionLike` are structural `Pick`s of Electron's types, so tests can pass fakes.
- Produces, in `protocol.ts`:
  - `resolveAppFile(rootDir: string, requestUrl: string): string | null`
  - `appResponseHeaders(file: string): Record<string, string>`
  - `registerAppProtocol(protocol: Protocol, rootDir: string): void`

- [ ] **Step 1: Scaffold**
  - **`package.json`:**
    - `"main": "dist/app/main/main.js"`
    - devDependencies: `electron@^45.0.0`, `react@^19.3.1`, `react-dom@^19.3.1`, `@types/react`, `@types/react-dom`, `vite@^8.3.5`, `@vitejs/plugin-react@^6.1.2`
    - scripts:
      - `build`: `tsc -p tsconfig.json && vite build`
      - `app`: `npm run build && electron .`
      - `typecheck`: `tsc -p tsconfig.test.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`
  - **`tsconfig.json`:** add `"exclude": ["src/app/renderer"]`. **`tsconfig.test.json`:** also exclude `src/app/renderer` and `test/app/renderer`, and include `vite.config.ts`.
  - **`tsconfig.renderer.json`:** `strict`, `target` `ES2023`, `lib` `["ES2023", "DOM", "DOM.Iterable"]`, `module` `ESNext`, `moduleResolution` `Bundler`, `jsx` `react-jsx`, `types` `[]`, `noEmit`, `skipLibCheck`, and `include` `["src/app/renderer", "src/app/shared", "test/app/renderer"]`. With `types: []`, renderer code that imports Node-only modules fails to typecheck. That is intended.
  - **`vite.config.ts`:** `root: 'src/app/renderer'`, `base: './'`, `plugins: [react()]`, `build: { outDir: <repo>/dist/app/renderer, emptyOutDir: true }`.
  - **`index.html`:** `<meta http-equiv="Content-Security-Policy" content="…">` with exactly `CONTENT_SECURITY_POLICY`, a `#root` div, and `<script type="module" src="./main.tsx">`.
  - Run `npm install`.
- [ ] **Step 2: Write the failing tests**
  - `security.test.ts`:
    - `locks down every window`: `webPreferences('/p/preload.cjs')` equals `{ preload: '/p/preload.cjs', sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, experimentalFeatures: false, spellcheck: false }`.
    - `has a strict CSP`: it contains `default-src 'none'`, `script-src 'self'`, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`, and does not match `/unsafe-(inline|eval)/`. `src/app/renderer/index.html` contains the same string.
    - `isAppUrl accepts only app://vitals`: true for `app://vitals/index.html`. False for `app://evil/index.html`, `https://vitals/`, `file:///index.html`, and `not a url`.
    - `allows requests only to the app, devtools, and data URLs`: true for `app://vitals/assets/a.js`, `devtools://devtools/bundled/x.html`, and `data:image/png;base64,AA`. False for `https://example.com/`, `http://localhost:5173/`, `file:///etc/passwd`, and `ws://example.com/`.
    - `blocks navigation away from the app and every new window`. Use a fake `EventEmitter` with `setWindowOpenHandler`:
      - `will-navigate` and `will-redirect` to `https://evil.example/` call `preventDefault`.
      - `will-navigate` to `app://vitals/index.html` does not.
      - `will-attach-webview` always calls `preventDefault`.
      - The window-open handler returns `{ action: 'deny' }`.
    - `denies every permission and cancels remote requests`. With a fake session:
      - The request handler calls back `false` for `'media'` and `'clipboard-read'`.
      - The check handler returns `false`.
      - The `onBeforeRequest` listener (filter `{ urls: ['<all_urls>'] }`) calls back `{ cancel: true }` for `https://example.com/` and `{ cancel: false }` for `app://vitals/index.html`.
  - `protocol.test.ts`, with `root = path.join(tmp, 'renderer')`:
    - `app://vitals/` maps to `index.html`, and `app://vitals/assets/index-abc.js` maps to `assets/index-abc.js`.
    - `app://vitals/..%2F..%2Fetc%2Fpasswd` gives `null`. So do `app://evil/index.html` and `https://vitals/index.html`.
    - `appResponseHeaders`:
      - `.html` gives `text/html; charset=utf-8`, `.js` gives `text/javascript; charset=utf-8`, `.css` gives `text/css; charset=utf-8`, and anything else gives `application/octet-stream`.
      - Every response also carries `Content-Security-Policy: CONTENT_SECURITY_POLICY` and `X-Content-Type-Options: nosniff`.
  - `no-electron.test.ts`: no `.ts` file under `src/core` or `src/cli` matches `/from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)|import\(\s*['"]electron['"]\s*\)/`.
- [ ] **Step 3: Run** `npx vitest run test/app/main test/core/no-electron.test.ts`. Expected: the security and protocol tests fail on missing modules, and `no-electron` passes. It is a guard.
- [ ] **Step 4: Implement `security.ts`, `protocol.ts`, and `main.ts`**
  - `resolveAppFile`:
    - Accept only `isAppUrl` URLs.
    - Run `decodeURIComponent` on the pathname, and map `/` to `index.html`.
    - `path.resolve` against `rootDir`, and return `null` unless the result is inside `rootDir`.
  - `registerAppProtocol`: `protocol.handle('app', …)`. Read the file, answer with `appResponseHeaders`, and give a 404 when `resolveAppFile` returns `null` or the file is missing.
  - **`main.ts`, before `ready`:**
    - `protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }])`
    - `app.enableSandbox()`
    - `app.setPath('userData', resolveDataHome(process.env, process.platform, homedir()))`
    - `app.on('web-contents-created', (_e, c) => hardenWebContents(c))`
  - **`main.ts`, on `ready`:**
    - `hardenSession(session.defaultSession)`
    - `registerAppProtocol(protocol, path.join(import.meta.dirname, '../renderer'))`
    - Create a `BrowserWindow` with `{ width: 1280, height: 800, title: 'Package Vitals', show: false, webPreferences: webPreferences(path.join(import.meta.dirname, '../preload/preload.cjs')) }`. Show it on `ready-to-show`, and load `app://vitals/index.html`.
    - `window-all-closed` quits the app.
- [ ] **Step 5: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: everything passes, and these exist: `dist/app/main/main.js`, `dist/app/preload/preload.cjs`, and `dist/app/renderer/index.html`.
- [ ] **Step 6: Smoke check** with `npm run app`. A window titled "Package Vitals" shows the heading. In DevTools, the console has no CSP errors.
  - If the module script fails to load over `app://`, add `corsEnabled: true` to the scheme's privileges (Vite marks module scripts `crossorigin`). Record that as a ruling.
  - Don't loosen the CSP to fix a load error.
- [ ] **Step 7: Commit** with `feat: add locked-down Electron shell with app protocol and CSP`.

---

### Task 3: The preload API and IPC

**Files:**
- Create: `src/app/shared/api.ts`, `src/app/main/validate.ts`, `src/app/main/ipc.ts`, `src/app/main/handlers/common.ts`, `src/app/main/handlers/queue.ts`
- Modify:
  - `src/app/preload/preload.cts`
  - `src/app/main/main.ts`: open the DB with `openDatabase(dataPaths(home).db)`, register the queue handlers, and close the DB on `will-quit`.
- Test: `test/app/main/validate.test.ts`, `test/app/main/queue-handlers.test.ts`, `test/app/main/ipc.test.ts`, `test/app/main/preload.test.ts`

**Interfaces:**
- Consumes: Task 1's queries and types, `latestCompleteSnapshot`, `getSnapshot`, `monitoringSummary`, `isAppUrl`.
- Produces, in `src/app/shared/api.ts`:
```ts
export interface SnapshotInfo { id: number; ownerLogin: string; finishedAt: string; includeForks: boolean; includeArchived: boolean }
export interface Overview {
  snapshot: SnapshotInfo | null; monitoring: MonitoringSummary | null;
  repos: { id: number; fullName: string }[]; ecosystems: string[]; checkupRunning: boolean;
}
/** null means "not computed yet", shown as —. */
export interface QueueCounts { critical: number; notTriaged: number; devOnly: number | null; reachable: number | null; uncertain: number | null }
export interface QueueData { rows: FindingRow[]; counts: QueueCounts }
export type ReportRequest = { kind: 'account'; snapshotId: number } | { kind: 'repo'; snapshotId: number; repoId: number };
export interface CheckupProgress { done: number; total: number; repo: string }
export type CheckupResult = { ok: true; summary: CheckupSummary } | { ok: false; message: string };
export interface VitalsApi {
  getOverview(): Promise<Overview>;
  listFindings(req: { snapshotId: number; filter: FindingFilter }): Promise<QueueData>;
  getFinding(key: FindingKey): Promise<FindingDetail | null>;
  listRepoCards(snapshotId: number): Promise<RepoCard[]>;
  getTreatmentPlan(snapshotId: number): Promise<TreatmentRow[]>;
  copyFindingMarkdown(key: FindingKey): Promise<void>;
  openFindingOnGitHub(key: FindingKey): Promise<void>;
  listReports(): Promise<ReportEntry[]>;
  readReport(id: number): Promise<string>;
  generateReport(req: ReportRequest): Promise<ReportEntry>;
  startCheckup(): Promise<CheckupResult>;
  onCheckupProgress(listener: (p: CheckupProgress) => void): () => void;
}
export type InvokeMethod = Exclude<keyof VitalsApi, 'onCheckupProgress'>;
export const INVOKE_METHODS: readonly InvokeMethod[]; // all 11, with a compile-time check that none is missing
export const CHECKUP_PROGRESS_CHANNEL = 'vitals:checkup-progress';
export function channelFor(m: InvokeMethod): string; // `vitals:${m}`
export type Handlers = { [M in InvokeMethod]: (arg: unknown) => Promise<Awaited<ReturnType<VitalsApi[M]>>> };
```
- Produces, in `validate.ts`:
  - `class IpcInputError extends Error`
  - `parseSnapshotId`, `parseReportId`, `parseFindingKey`, `parseFindingsRequest`, and `parseReportRequest`, each typed `(x: unknown) => T`.
  - The rules:
    - IDs are safe integers `>= 1`.
    - Objects are plain objects with exactly the expected keys.
    - `severities` is a non-empty array of distinct known severities.
    - `repoId` is `null` or an ID.
    - `ecosystem` is `null` or matches `/^[a-z0-9_.-]{1,32}$/`.
    - Anything else throws `IpcInputError` naming the field.
- Produces, in `handlers/common.ts`: `requireCompleteSnapshot(db, id): SnapshotRow`, which throws `IpcInputError('Snapshot N is not complete.')`.
- Produces, in `handlers/queue.ts`: `queueHandlers(deps: { db: Db; checkupRunning: () => boolean }): Pick<Handlers, 'getOverview' | 'listFindings' | 'getFinding' | 'listRepoCards' | 'getTreatmentPlan'>`.
  - `listFindings` returns `counts: { critical, notTriaged: matching, devOnly: null, reachable: null, uncertain: null }`.
  - `getTreatmentPlan` returns the whole critical plan.
- Produces, in `ipc.ts`: `registerIpc(ipc: Pick<IpcMain, 'handle'>, handlers: Partial<Handlers>, isTrustedSender: (frameUrl: string | undefined) => boolean): void`. Each handler goes on `channelFor(m)`. A call from an untrusted frame throws `Error('Untrusted sender')`.
- Produces, in `preload.cts`:
  - `contextBridge.exposeInMainWorld('vitals', api)`. The 11 invoke methods each call `ipcRenderer.invoke(channelFor-equivalent, arg)`.
  - `onCheckupProgress` subscribes a wrapper that drops the event object, and returns an unsubscribe function.
  - The method list is written out in the file, `satisfies readonly InvokeMethod[]`, with an exhaustiveness check.

- [ ] **Step 1: Write the failing tests**
  - `validate.test.ts`:
    - `accepts a well-formed findings request`
    - `rejects malformed findings requests`, as a table. Each case throws `IpcInputError`: `null`, `[]`, `snapshotId: '1'`, `1.5`, `2 ** 53`, a missing `filter`, an extra key `sql`, `severities: []`, `['critical', 'critical']`, `['urgent']`, `repoId: -1`, `ecosystem: '../x'`, and `ecosystem: 'a'.repeat(33)`.
    - `parseReportRequest rejects unknown kinds and stray keys`: `{ kind: 'file' }`, a repo request without `repoId`, and an account request with `repoId`.
    - `parseReportId rejects anything but a positive integer`: `'../../etc/passwd'`, `0`, and `'1'`.
  - `queue-handlers.test.ts`, with an in-memory DB and `seedSnapshot`:
    - `getOverview with no complete snapshot`: the result is `{ snapshot: null, monitoring: null, repos: [], ecosystems: [], checkupRunning: false }`.
    - `getOverview uses the latest complete snapshot, not a later running one`
    - `listFindings refuses a snapshot that is not complete`. A failed snapshot and a running one both reject with `Snapshot N is not complete.`.
    - `listFindings returns rows with counts, leaving later counts null`
    - `getFinding returns null for an unknown key and rejects a malformed one`
  - `ipc.test.ts`, with a fake `ipcMain` that records handlers:
    - `registers one channel per handler`
    - `refuses calls from any frame that is not the app`. A `senderFrame` URL of `https://evil.example/`, or a null `senderFrame`, rejects with `Untrusted sender` and the handler is never called. `app://vitals/index.html` gets the handler's result.
  - `preload.test.ts`. Mock `electron` with `vi.mock` (`contextBridge.exposeInMainWorld`, `ipcRenderer.invoke/on/removeListener`), then `await import` the `.cts` path. To allow that, add `allowImportingTsExtensions: true` to `tsconfig.test.json`, which is already `noEmit`.
    - `exposes exactly the API as window.vitals`: one call, named `'vitals'`, and its keys sorted equal `[...INVOKE_METHODS, 'onCheckupProgress'].sort()`.
    - `forwards each call on its own channel`: `api.getFinding(key)` calls `ipcRenderer.invoke('vitals:getFinding', key)`.
    - `progress listeners never see the IPC event and can unsubscribe`
- [ ] **Step 2: Run** `npx vitest run test/app/main`. Expected: the new tests fail.
- [ ] **Step 3: Implement** `api.ts`, `validate.ts`, `handlers/common.ts`, `handlers/queue.ts`, `ipc.ts`, and `preload.cts`. In `main.ts`, call `registerIpc(ipcMain, queueHandlers({ db, checkupRunning: () => false }), (url) => url !== undefined && isAppUrl(url))`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: add validated preload API and IPC for queue data`.

---

### Task 4: Renderer shell: navigation, overview, and empty states

**Files:**
- Modify: `vitest.config.ts`. Make two `projects`:
  - `node`: `include: ['test/**/*.test.ts']`, `exclude: ['test/e2e/**', 'test/app/renderer/**']`
  - `dom`: `plugins: [react()]`, `environment: 'jsdom'`, `include: ['test/app/renderer/**/*.test.{ts,tsx}']`, `setupFiles: ['test/app/renderer/setup.ts']`
- Modify: `package.json`. Add the devDependencies `jsdom@^30.1.3`, `@testing-library/react@^16.3.3`, `@testing-library/user-event@^14.6.8`, and `@testing-library/jest-dom@^7.0.1`.
- Create:
  - `src/app/renderer/vitals.d.ts`, which declares `window.vitals: VitalsApi`
  - `src/app/renderer/format.ts`
  - `src/app/renderer/views/{QueueView,RepoCardsView,TreatmentPlanView,ReportsView}.tsx`, each a placeholder with its `<h2>`: "Queue", "Repos", "Treatment plan", "Reports"
- Modify: `src/app/renderer/App.tsx`, `main.tsx`, `styles.css`
- Test:
  - `test/app/renderer/setup.ts`: jest-dom matchers, plus `cleanup` after each test
  - `test/app/renderer/fake-api.ts`: `fakeApi(overrides?: Partial<VitalsApi>): VitalsApi`, where every method is a `vi.fn` resolving an empty value, and `OVERVIEW: Overview` is snapshot 7 of `TETRA2000`, finished `2026-10-24T05:07:09.000Z`
  - `test/app/renderer/App.test.tsx`, `test/app/renderer/format.test.ts` (both in the dom project)

**Interfaces:**
- Produces:
  - `App({ api }: { api: VitalsApi })`. Its `view` state is `'queue' | 'repos' | 'treatment' | 'reports'`, and it starts on the queue.
  - `App` passes each view `{ api, overview, snapshotId }`. `RepoCardsView` also gets `onOpenRepo(repoId)`, which sets the queue's repo filter and switches to the queue.
  - `App` reloads the overview on mount, on window `focus`, and when a Checkup finishes.
- Produces, in `format.ts`:
  - `formatAge(fromIso: string, toIso: string): string`. Count whole UTC calendar months between the two dates. Fewer than 1 gives `under a month`; fewer than 12 gives `N month` or `N months`; otherwise `N year` or `N years`, using the floor of months / 12.
  - `formatUtc(iso: string): string`, which is `formatTimestamp(iso) + ' UTC'`. `formatTimestamp` comes from `src/core/reports/markdown.ts`, which is pure and can be imported here.
  - `ipcErrorMessage(err: unknown): string`, which strips Electron's `Error invoking remote method 'vitals:x': ` prefix and a leading `Error: ` or `IpcInputError: `.

- [ ] **Step 1: Write the failing tests**
  - `format.test.ts`:
    - `formatAge`: `('2026-10-01', '2026-10-24')` gives `under a month`, `('2026-08-20', '2026-10-24')` gives `2 months`, `('2025-10-24', '2026-10-24')` gives `1 year`, and `('2023-05-06', '2026-10-24')` gives `3 years`.
    - `ipcErrorMessage`: `new Error("Error invoking remote method 'vitals:readReport': IpcInputError: Report is too large to show.")` gives `Report is too large to show.`.
  - `App.test.tsx`:
    - `says there is no Checkup yet`. When `snapshot` is null, the main area reads `No Checkup yet. Run a Checkup to see your vitals.`.
    - `shows the snapshot it is reading`: `Snapshot 7 · TETRA2000 · completed 2026-10-24 05:07 UTC`.
    - `switches views from the nav`. Clicking "Repos" shows the `Repos` heading.
    - `reloads the overview when the window regains focus`: `getOverview` is called twice.
    - `shows an error when the overview can't load`. When `getOverview` rejects `boom`, an alert reads `Couldn't load data: boom`.
- [ ] **Step 2: Run** `npx vitest run --project dom`. Expected: the tests fail.
- [ ] **Step 3: Implement** `App`, `format.ts`, and the placeholder views. `main.tsx` renders `<App api={window.vitals} />`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: add renderer shell with navigation and empty states`.

---

### Task 5: The queue: filters, summary strip, notices, virtualized list

**Files:**
- Modify: `package.json`. Add `@tanstack/react-virtual@^3.14.22`.
- Create: `src/app/renderer/components/{SummaryStrip,Notices,FindingList}.tsx`
- Modify: `src/app/renderer/views/QueueView.tsx`, `App.tsx` (which holds `repoFilter`)
- Test: `test/app/renderer/QueueView.test.tsx`

**Interfaces:**
- Consumes: `VitalsApi.listFindings`, `Overview`, `formatAge`.
- Produces:
  - `QueueView({ api, overview, snapshotId, repoFilter, onRepoFilterChange })`
  - `FindingList({ rows, selectedIndex, onSelect, now })`:
    - a `role="listbox"` with `aria-label="Findings"`
    - rows are `role="option"` with `aria-selected`
    - it uses `useVirtualizer` with `estimateSize: () => 36`, `overscan: 10`, and `initialRect: { width: 1000, height: 700 }`, and calls `scrollToIndex` when `selectedIndex` changes
  - Each row shows severity, `packageName (ecosystem)`, `fullName`, `ghsaId: summary`, and `formatAge(createdAt, now)`, all as text nodes. `now` is the snapshot's `finishedAt`, so ages are measured at the snapshot.
  - The filters:
    - severity checkboxes Critical, High, Medium, and Low (the last ticked box is disabled)
    - a repo select ("All repos" plus `overview.repos`)
    - an ecosystem select ("All ecosystems" plus `overview.ecosystems`)
  - `Notices({ monitoring })`:
    - Not monitored repos: `N repo(s) isn't/aren't monitored: Dependabot alerts are turned off, so it has/they have no data.`, followed by the names.
    - Error repos: `N repo(s) couldn't be read in this Checkup:`, followed by `name: message` for each.

- [ ] **Step 1: Write the failing tests** (`QueueView.test.tsx`)
  - `asks for critical findings by default`: `listFindings` is called with `{ snapshotId: 7, filter: { severities: ['critical'], repoId: null, ecosystem: null } }`.
  - `adds a severity when its box is ticked, and keeps at least one`
  - `shows the summary strip, with — for counts not computed yet`. With `{ critical: 524, notTriaged: 524, devOnly: null, reachable: null, uncertain: null }`, it shows `Critical 524`, `Not triaged 524`, `Dev-only —`, `Reachable —`, and `Uncertain —`.
  - `renders repo text as text`. A summary of `<img src=x onerror=alert(1)>` and a package name of `<b>x</b>` appear literally, and `container.querySelector('img, b')` is null.
  - `renders only the visible rows of a long list`. With 10,000 rows, the number of `[role="option"]` elements is between 1 and 99.
  - `lists not monitored and unreadable repos as notices, not rows`. One not monitored repo gives the singular sentence plus `TETRA2000/zaim`. One error gives `TETRA2000/c: Bad Gateway (HTTP 502)`.
  - `says when nothing matches`: `No open alerts match these filters.`
  - `filters by the repo it is given`. When `repoFilter` is 3, `filter.repoId` is 3. Changing the select calls `onRepoFilterChange`.
- [ ] **Step 2: Run** `npx vitest run --project dom`. Expected: the new tests fail.
- [ ] **Step 3: Implement** the components above.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: add the priority queue with filters, summary strip, and notices`.

---

### Task 6: Side panel, arrow keys, Copy as Markdown, Open on GitHub

**Files:**
- Create:
  - `src/core/github/urls.ts`, `src/core/reports/finding-markdown.ts`
  - `src/app/main/handlers/actions.ts`
  - `src/app/renderer/components/SidePanel.tsx`
- Modify:
  - `src/app/renderer/views/QueueView.tsx`
  - `src/app/main/main.ts`: register `actionHandlers` with `shell.openExternal` and `clipboard.writeText`
- Test: `test/core/github/urls.test.ts`, `test/core/reports/finding-markdown.test.ts`, `test/app/main/action-handlers.test.ts`, `test/app/renderer/SidePanel.test.tsx`, and additions to `QueueView.test.tsx`

**Interfaces:**
- Produces:
  - `dependabotAlertUrl(fullName: string, number: number): string`. It returns `https://github.com/{fullName}/security/dependabot/{number}`. It throws unless `fullName` matches `/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/` and `number` is a positive integer.
  - `renderFindingMarkdown(d: FindingDetail): string`. Text goes through `escapeCell`, and the manifest goes through `codeSpan`:
```
### {packageName} ({ecosystem}) in {fullName}

- Severity: {Critical|High|Medium|Low}
- Advisory: {ghsaId} ({cveId|No CVE}): {summary}
- Manifest: {codeSpan(manifestPath)}
- Scope: {Runtime|Development|—}
- Vulnerable versions: {vulnerableRange|—}
- Patched in: {firstPatched|No patched version}
- Open since: {YYYY-MM-DD}
- Triage: Not triaged
- Alert: {dependabotAlertUrl}
```
  - `actionHandlers(deps: { db: Db; openExternal: (url: string) => Promise<void>; writeClipboard: (text: string) => void }): Pick<Handlers, 'copyFindingMarkdown' | 'openFindingOnGitHub'>`. Both validate the key, require a complete snapshot, and reject `Finding not found.` for an unknown key.
  - `SidePanel({ api, findingKey, now })`:
    - With no key, it shows `Select a finding to see its details.`.
    - Otherwise it shows the fields above, plus the summary, as text. The buttons are **Copy as Markdown** (which then shows `Copied.`) and **Open on GitHub**.
  - `QueueView`: clicking a row selects it. `ArrowDown` and `ArrowUp` on the listbox move the selection and stop at the ends. The panel follows the selection.

- [ ] **Step 1: Write the failing tests**
  - `urls.test.ts`:
    - `builds the alert URL`: `('TETRA2000/slack-deck', 42)` gives `https://github.com/TETRA2000/slack-deck/security/dependabot/42`.
    - `rejects names that aren't GitHub repo names`: `'TETRA2000/a b'`, `'../x'`, `'TETRA2000/a/b'`, and `'https://evil.example'`, plus number `0`.
  - `finding-markdown.test.ts`:
    - a golden test for a full detail
    - null CVE and null patch give `No CVE` and `No patched version`
    - a summary with `|`, `<`, and `` ` `` is escaped
  - `action-handlers.test.ts`, with a seeded DB:
    - `openFindingOnGitHub opens the alert URL built from the database`
    - `rejects unknown, malformed, and not-complete keys without opening anything`
    - `refuses a repo name that isn't a GitHub name`. Seed `TETRA2000/a b` through `upsertRepo`. The call rejects and `openExternal` is never called.
    - `copyFindingMarkdown writes renderFindingMarkdown(getFinding) to the clipboard`
  - `SidePanel.test.tsx`:
    - `shows the finding`: `minimist`, `npm`, `TETRA2000/a`, `Critical`, `GHSA-xvch-5gv4-984h`, `CVE-2021-44906`, `Patched in 1.2.6`, `Vulnerable versions < 1.2.6`, `Scope Runtime`, `Open since 2022-03-18`, and `Triage Not triaged`.
    - `shows No CVE and No patched version`
    - `renders hostile text as text`: no `img` element.
    - `copies and opens through the API with the finding key`
  - `QueueView.test.tsx`: `moves the selection with the arrow keys`. With three rows, click row 0, and `getFinding` is called with row 0's key. `ArrowDown` calls it with row 1's key and moves `aria-selected`. Pressing `ArrowUp` on row 0 and `ArrowDown` on row 2 changes nothing.
- [ ] **Step 2: Run** `npx vitest run`. Expected: the new tests fail.
- [ ] **Step 3: Implement** the modules above. In the queue layout, the list is on the left and the panel on the right.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: add finding side panel with copy and open on GitHub`.

---

### Task 7: Repo cards and the treatment plan

**Files:**
- Modify: `src/app/renderer/views/RepoCardsView.tsx`, `src/app/renderer/views/TreatmentPlanView.tsx`
- Test: `test/app/renderer/RepoCardsView.test.tsx`, `test/app/renderer/TreatmentPlanView.test.tsx`

**Interfaces:**
- Consumes: `listRepoCards` and `getTreatmentPlan` (handlers from Task 3), `formatAge`, `onOpenRepo`.
- Produces:
  - `RepoCardsView({ api, overview, snapshotId, onOpenRepo })`:
    - A card with alerts shows `Critical N`, `High N`, `Open N`, `Reachable —`, and `Oldest open alert: {formatAge(oldest, snapshot.finishedAt)}`. Clicking it calls `onOpenRepo(repoId)`.
    - A `not_monitored` card shows `Not monitored` and no counts.
    - An `error` card shows `Couldn't be read: {error}` and no counts.
    - A clean `ok` card shows `No open alerts`.
  - `TreatmentPlanView({ api, snapshotId })`:
    - The intro reads `Packages with an open critical alert, by how many repos an upgrade would clear.`.
    - The table columns are Package, Ecosystem, Repos, and Patched in. An empty list of versions shows `No patched version`. When there are no rows, it shows `No open critical alerts.`.

- [ ] **Step 1: Write the failing tests** for each line above. Repo text (repo name, error message, package name) containing `<img src=x>` renders as text.
- [ ] **Step 2: Run** `npx vitest run --project dom`. Expected: they fail.
- [ ] **Step 3: Implement** both views.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run`. Expected: all tests pass.
- [ ] **Step 5: Commit** with `feat: add repo cards and treatment plan views`.

---

### Task 8: Reports view

**Files:**
- Create: `src/core/reports/generate.ts`, `src/app/main/handlers/reports.ts`, `src/app/renderer/components/Markdown.tsx`
- Modify:
  - `src/core/reports/write.ts`: `writeReport` now returns `{ id: number; path: string }`
  - `src/cli/commands/report.ts`: use `generate.ts`, still printing the path
  - `src/app/main/main.ts`: register `reportHandlers({ db, reportsDir: dataPaths(home).reports, now: () => new Date() })`
  - `src/app/renderer/views/ReportsView.tsx`
  - `package.json`: add `markdown-it@^15.0.3` and `@types/markdown-it`
- Test: `test/core/reports/generate.test.ts`, `test/app/main/report-handlers.test.ts`, `test/app/renderer/Markdown.test.tsx`, `test/app/renderer/ReportsView.test.tsx`. The existing CLI tests must keep passing unchanged.

**Interfaces:**
- Produces:
  - `generateAccountReport(db, reportsDir, s: SnapshotRow, createdAt: string): { id: number; path: string }`. Alert ages are measured at `s.finishedAt`, as in Plan 1's ruling.
  - `generateRepoChart(db, reportsDir, s: SnapshotRow, fullName: string, createdAt: string): { id: number; path: string } | null`
  - `reportHandlers(deps: { db: Db; reportsDir: string; now: () => Date }): Pick<Handlers, 'listReports' | 'readReport' | 'generateReport'>`:
    - **`readReport`:** look up `getReportPath`. Reject unless `realpath(file)` is inside `realpath(reportsDir)`. Use `path.relative`, which must not start with `..` and must not be absolute.
    - Reject `Report file is missing.` and `Report is too large to show.` (more than 5 MB).
    - **`generateReport`:** require a complete snapshot. A repo request resolves `repoId` to a name in that snapshot, or rejects `Repo is not in this snapshot.`. Return the new `ReportEntry`.
  - `Markdown({ source }: { source: string })`:
    - Use `markdown-it({ html: false, linkify: false, typographer: false })` with `.disable(['image', 'link', 'autolink', 'reference', 'html_inline', 'html_block'])`.
    - Render it with `dangerouslySetInnerHTML` inside `<article className="report">`. markdown-it escapes all text, and with those rules off, there are no `a`, `img`, or raw HTML elements to produce.
  - `ReportsView({ api, overview, snapshotId })`:
    - The list is newest first. Labels are `Account report · snapshot N · {formatUtc(createdAt)}` and `Repo chart: {repo} · snapshot N · …`.
    - Selecting an entry renders it.
    - **Generate account report**, plus a repo select with **Generate repo chart**, create a report, refresh the list, and select the new one.
    - Errors go to an alert through `ipcErrorMessage`.

- [ ] **Step 1: Write the failing tests**
  - `generate.test.ts`:
    - `generateAccountReport writes the rendered report and records it`
    - `generateRepoChart returns null for a repo outside the snapshot`
  - `report-handlers.test.ts`, using a temp reports dir:
    - `lists and reads a generated report`
    - `refuses a recorded path outside the reports folder`. Insert a row pointing to a file in another temp dir.
    - `refuses a symlink that leads outside the reports folder`
    - `rejects an unknown id, a malformed id, a missing file, and a file over 5 MB`
    - `generates account and repo reports, and refuses an incomplete snapshot or a repo outside it`
  - `Markdown.test.tsx`:
    - `renders headings and tables`
    - `never produces script, images, links, or raw HTML`. The source is `<script>window.x=1</script>`, `<img src=x onerror=alert(1)>`, `![i](https://evil.example/i.png)`, `[click](javascript:alert(1))`, `<https://evil.example>`, and `[r]: https://evil.example`. `container.querySelector('script, img, a, iframe')` is null, and `<img src=x onerror=alert(1)>` and `[click](javascript:alert(1))` show as text.
    - `shows escaped report text literally`: `\_\_proto\_\_` renders as `__proto__`.
  - `ReportsView.test.tsx`:
    - `lists reports newest first and renders the selected one`
    - `generates an account report and selects it`
    - `shows a read error`
- [ ] **Step 2: Run** `npx vitest run`. Expected: the new tests fail.
- [ ] **Step 3: Implement** the modules above, and switch the CLI's `report` command to `generate.ts`.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: all tests pass, the CLI tests included.
- [ ] **Step 5: Commit** with `feat: add Reports view with safe Markdown rendering`.

---

### Task 9: Run a Checkup from the app

**Files:**
- Create:
  - `src/core/checkup/account-checkup.ts`, `src/core/checkup/format.ts`
  - `src/app/main/checkup.ts`, `src/app/main/handlers/checkup.ts`, `src/app/main/handlers/index.ts`
  - `src/app/renderer/components/CheckupButton.tsx`
- Modify:
  - `src/core/github/token.ts`: move the `execFile` wrapper here from `src/cli/bin.ts` as `execFileText: ExecLike`
  - `src/cli/commands/checkup.ts`: use `runAccountCheckup` and `format.ts`, with output unchanged
  - `src/cli/bin.ts`
  - `src/app/main/main.ts`: use `createAllHandlers`, and send progress to the window on `CHECKUP_PROGRESS_CHANNEL`
  - `src/app/renderer/App.tsx`: the header gets the button, and the overview reloads `onDone`
- Test: `test/core/checkup/account-checkup.test.ts`, `test/app/main/checkup.test.ts`, `test/app/main/handlers-index.test.ts`, `test/app/renderer/CheckupButton.test.tsx`. The existing CLI tests must keep passing unchanged.

**Interfaces:**
- Produces:
  - `runAccountCheckup(deps: { db: Db; exec: ExecLike; fetch?: FetchLike; now: () => Date; onProgress?: (p: CheckupProgress) => void }, opts: CheckupScope & { concurrency: number }): Promise<CheckupSummary>`. It calls `getGitHubToken`, then `GitHubClient`, then `getAuthenticatedOwner`, then `runCheckup`.
  - `formatCheckupSummary(s: CheckupSummary): string`. This is exactly the CLI's current line: `Checked N repos: … Snapshot N.`.
  - `checkupWarning(s: CheckupSummary): string | null`. This is the CLI's warning text, or `null` when `errors` is 0.
  - `createCheckupController(deps: { run: (onProgress: (p: CheckupProgress) => void) => Promise<CheckupSummary>; onProgress: (p: CheckupProgress) => void }): { running(): boolean; start(): Promise<CheckupResult> }`
    - A `start()` while a run is in progress resolves `{ ok: false, message: 'A Checkup is already running.' }`.
    - A rejection resolves `{ ok: false, message: err.message }`.
  - `checkupHandlers(controller): Pick<Handlers, 'startCheckup'>`
  - `createAllHandlers(deps): Handlers` merges the queue, actions, reports, and checkup handlers. The queue's `checkupRunning` is `controller.running`.
  - `CheckupButton({ api, running, onDone })`:
    - While a Checkup runs, the button is disabled and shows `Checking… {done} / {total} · {repo}`.
    - On success it shows `formatCheckupSummary`, plus `checkupWarning` when there is one, and calls `onDone`.
    - On failure it shows the message in an alert and enables the button again.
    - When the `running` prop is true, it shows `Checkup running…` and stays disabled.
    - It unsubscribes from progress on unmount.
- The app uses Plan 1's defaults: forks and archived repos are excluded, with concurrency 8.

- [ ] **Step 1: Write the failing tests**
  - `account-checkup.test.ts`:
    - `reads the token, finds the owner, and runs a Checkup`. Use the CLI test's `fakeFetch` routes and an `exec` that returns a token.
    - `reports a missing gh without creating a snapshot`. The call rejects `GitHub CLI (gh) is not installed.`, and no `snapshots` rows exist.
  - `checkup.test.ts`:
    - `runs one Checkup at a time`. Use a pending `run`. The second `start()` resolves the "already running" message, and `running()` is true until the first one settles.
    - `turns a failure into its message`
    - `never puts the token in a result`. Use the real `runAccountCheckup` with `exec` returning `gho_secret` and a fetch that answers 401. The message is `Bad credentials (HTTP 401)`, and `JSON.stringify(result)` doesn't contain `gho_secret`.
    - `forwards progress`
  - `handlers-index.test.ts`: `every API method has a handler`. The sorted keys of `createAllHandlers(…)` equal the sorted `INVOKE_METHODS`.
  - `CheckupButton.test.tsx`:
    - `runs a Checkup and shows progress and the summary`
    - `shows a failure and lets the owner try again`
    - `stays disabled while another Checkup runs`
    - `unsubscribes from progress on unmount`
- [ ] **Step 2: Run** `npx vitest run`. Expected: the new tests fail.
- [ ] **Step 3: Implement** the modules above.
- [ ] **Step 4: Run** `npm run typecheck && npx vitest run && npm run build`. Expected: all tests pass, the CLI tests included.
- [ ] **Step 5: Commit** with `feat: run a Checkup from the app`.

---

### Task 10: End-to-end security check, CI, and README

**Files:**
- Create: `test/e2e/app.e2e.test.ts`, `vitest.e2e.config.ts` (`include: ['test/e2e/**/*.e2e.test.ts']`, `testTimeout: 60_000`)
- Modify:
  - `package.json`: add `playwright@^1.64.1`, and the script `test:e2e`: `vitest run --config vitest.e2e.config.ts`
  - `.github/workflows/test.yml`
  - `README.md`: how to run the app, the CLI, and the tests

**Interfaces:**
- Consumes: the built app (`npm run build`), `seedSnapshot`, `openDatabase`, and `CONTENT_SECURITY_POLICY`.

- [ ] **Step 1: Write the test**
  - Seed a temp `PACKAGE_VITALS_HOME` with one complete snapshot. Repo `a` has a critical alert whose summary is `<img src=x onerror="window.__pwned = true">`.
  - Launch with `_electron.launch({ args: ['.'], cwd: <repo root>, env: { ...process.env, PACKAGE_VITALS_HOME: home } })` and take `firstWindow()`.
  - Assert:
    - `the window is sandboxed and isolated`. Through `app.evaluate`, `getLastWebPreferences()` has `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
    - `the page has no Node and exactly the vitals API`. `typeof require`, `typeof process`, and `typeof module` are all `'undefined'`. The keys of `window.vitals` are the 12 API names.
    - `the CSP is in place`. The meta tag's content equals `CONTENT_SECURITY_POLICY`.
    - `hostile advisory text stays text`. The summary shows literally in the row and in the side panel. `window.__pwned` is undefined, and `page.locator('img')` has count 0.
    - `nothing reaches the network or leaves the app`:
      - `fetch('https://example.com/')` gives `'blocked'`.
      - `window.open('https://example.com/')` returns `null`.
      - After `location.href = 'https://example.com/'`, the URL is still `app://vitals/index.html`.
    - `the API rejects crafted input`: `readReport(999999)`, `readReport('../../etc/passwd')`, and `listFindings` with `severities: []` each reject.
    - `a generated report renders without links or images`. Generate the account report from the Reports view. The rendered article has no `a` or `img` elements.
- [ ] **Step 2: Run** `npm run build && npm run test:e2e`. Expected: it passes on macOS.
- [ ] **Step 3: Update CI.** After `npm run build`, add:
```yaml
      - run: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # lets Chromium's sandbox start on Ubuntu 24.04
      - run: xvfb-run -a npm run test:e2e
```
- [ ] **Step 4: Update `README.md`.** Cover `npm run app`, the CLI commands, `npm test`, and `npm run test:e2e`.
- [ ] **Step 5: Run** `npm run typecheck && npm test && npm run build && npm run test:e2e`. Expected: all pass.
- [ ] **Step 6: Commit** with `test: add end-to-end security check for the app and run it in CI`. After pushing, the GitHub Actions run must pass.

---

### Task 11: Check the app against the real account (read-only, nothing committed)

**Interfaces:**
- Consumes: the built app.

- [ ] **Step 1: Launch on a throwaway home.** Run `PACKAGE_VITALS_HOME="$(mktemp -d)" npm run app`, then click **Checkup**. Expected:
  - Progress counts up to about 355.
  - The summary line matches the CLI's: about 524 critical and 10 not monitored.
- [ ] **Step 2: Check each view.** Drive the app by hand or with a Playwright script, and take a screenshot of each view.
  - **Queue:** about 524 critical rows, oldest first. The not monitored notice lists 10 repos. The strip shows `Reachable —`.
  - **Every severity ticked:** about 9,845 rows, and scrolling and the arrow keys stay smooth.
  - **Side panel:** for a `form-data` alert, **Open on GitHub** opens that alert in the browser. **Copy as Markdown** pastes cleanly.
  - **Repos:** `gatsby-starter-netlify-cms` comes first. Not monitored repos show their status. Clicking a card filters the queue.
  - **Treatment plan:** `form-data` comes first, at 23 repos.
  - **Reports:** generate the account report and a `TETRA2000/slack-deck` chart. Both render with their tables, and `__proto__` and `_.unset` stay literal.
- [ ] **Step 3: Record the result** in the hand-off notes: the counts, any differences from the CLI, and the screenshots. Don't commit the throwaway home.
