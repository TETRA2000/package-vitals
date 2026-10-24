# Decision: Tech stack for Package Vitals

- **Status:** Decided: Electron with a TypeScript core
- **Date:** 2026-10-24
- **Owner:** Takahiko Inayama

## The question

Which language and UI framework should Package Vitals be built with?

## Decision

**Electron, with a TypeScript core.** The UI, core, CLI, and MCP server are all written in TypeScript.

Why:

- It behaves the same on macOS, Linux, and Windows because it ships its own Chromium. That meets the Linux and Windows priority while avoiding Tauri's weakest spot, the Linux webview.
- It has mature libraries for everything the UI needs: virtualized tables (such as TanStack Table), Markdown (such as markdown-it), code views (such as Shiki or CodeMirror), and charts.
- It uses one language from end to end. The TypeScript MCP SDK is the reference implementation, and TypeScript is what Claude Code builds in most reliably.
- The sandbox runtime (`@anthropic-ai/sandbox-runtime`) can be used directly as a library instead of through its CLI.
- The same core carries over to work use later.

What we give up:

- **Rust.** For this app, that costs less than it seems. TypeScript is memory-safe too, the security boundary is the sandbox rather than the language, and the heavy work happens in `osv-scanner` and in Claude. The real losses are Rust's stricter type system and its lower memory use.
- **Size and feel.** The app is around 200 MB, uses a few hundred MB of RAM, and doesn't feel like a native Mac app. Both are acceptable for a personal tool.

### Consequences

These requirements follow from the decision:

- **Lock down the UI window.** Reports and evidence views show advisory text, Claude's output, and code from untrusted repos, so a hostile repo must not be able to run script in the app. Required: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, a strict Content Security Policy, no remote content, and Markdown rendered with raw HTML disabled or sanitized. This is the prompt-injection threat from the design doc, showing up in the UI.
- **Keep the core independent of Electron.** Claude Code starts the CLI and MCP server on plain Node without opening the app, so the core can't depend on Electron-only APIs such as `safeStorage`. The MCP server only reads the database, and the CLI gets the GitHub token from `gh auth token`. This means the CLI and MCP server need a system Node install. Inside the app, Electron's bundled Node is used.
- **Keep Electron up to date.** Chromium security fixes ship every few weeks.
- **Choose the SQLite library carefully.** `better-sqlite3` has to be rebuilt for Electron's bundled Node. Node's built-in `node:sqlite` might avoid that. The same database file has to work from both Electron and plain Node.
- **Leave Claude triage off by default on Windows** until the sandbox runtime's Windows support leaves alpha. This would be true for any stack.

## Background

Package Vitals is a local desktop app that checks dependency health across many GitHub repositories and prioritizes their vulnerabilities. The full design brainstorm is in [package-vitals-design.md](../../package-vitals-design.md).

The problem it solves: there are too many repositories and dependencies to review Dependabot alerts one by one. The top of its list is **critical vulnerabilities that are actually reachable in production code**.

### Already decided

- **Hobby use first.** The first target is repos under a personal GitHub account. Work use (a GitHub organization, where other devs also fix findings) comes later, and nothing should rule it out.
- **Used side by side with Claude Code.** The app does most inspection on its own: it lists repos, pulls Dependabot alerts and SBOMs, scans lockfiles, filters out dev-only and test-only packages, and checks whether a package is imported at all.
- **Reachability needs Claude.** Deciding whether the vulnerable function is called, and from which entry point, is Claude's job.
- **Triage runs in separate, sandboxed Claude jobs**, never in the user's interactive Claude Code session. That session can reach the whole machine and the GitHub login, and triage means reading untrusted code that might contain prompt injection. Each job gets a read-only copy of the repo, no GitHub token, and no network access except the Claude API. It writes its verdict back to the database.
- **Claude Code can read the app's stored data**, so the user can consult Claude about it ("which upgrade fixes the most repos?").
- **Reports work with or without Claude.** The app writes complete Markdown reports on its own. Claude can write a cleaner, more detailed version on request. Either way, every number comes from the database.

### Stated priorities for the stack

- Rust's safety and speed.
- Linux and Windows support, not just macOS.

## Shape of the system (proposed, same for every option)

The core runs without a UI. It is a **CLI plus an MCP server**, both working on one local SQLite file. Claude Code starts the MCP server itself, so it can read data even when the app is closed. The desktop app is a viewer and control panel on top of the same core.

Outside tools run as subprocesses, not reimplemented:

| Tool | Used for |
|---|---|
| `gh` | GitHub login (reuses the existing CLI auth) |
| `osv-scanner` | Lockfile scanning |
| `srt` (Anthropic Sandbox Runtime) wrapping `claude -p` | Sandboxed triage jobs |
| `sbx` (Docker Sandboxes) | Later: execution-level checks in a microVM |

All of these are CLIs, so none of them forces a language. The design brainstorm suggested that the sandbox runtime being a Node library might favor Electron or a Node sidecar. Calling its CLI removes that constraint, though `srt` itself still needs Node installed.

The work where safety matters most happens in the core: parsing untrusted lockfiles, managing sandboxes, and serving data to Claude. So the priority on Rust's safety mostly applies to the core, and the UI framework is a separate choice.

## Platform constraints

The two sandboxes don't support every platform equally:

| | Sandbox Runtime (`srt`), analysis levels 1–2 | Docker Sandboxes (`sbx`), execution level 3 |
|---|---|---|
| **macOS** | Supported (Seatbelt) | Apple silicon only. Docs disagree on the minimum version (macOS 14 vs 26). |
| **Linux** | Supported (bubblewrap). Ubuntu 24.04+ may need an AppArmor change. | Ubuntu 24.04+ on x86_64, with KVM |
| **Windows** | Alpha. Needs a one-time admin setup. | Windows 11, with Windows Hypervisor Platform enabled |

**Proposed:** On Windows, the Checkup and reports work fully, and Claude triage is off by default until `srt`'s Windows support matures. Triage never runs unsandboxed. Development and testing happen on macOS first.

## What the UI needs

- Large alert tables across many repos that can be sorted and filtered, with virtual scrolling
- A Markdown view for reports
- A code view for `file:line` evidence
- Trend charts
- macOS, Linux, and Windows support
- Something Claude Code can build in reliably: a stable API and plenty of example code

## Options, round 1: broad survey

These were assessed before the Rust preference came up, assuming a TypeScript core.

| Option | Good | Costs |
|---|---|---|
| **Electron + TypeScript core** | One language for the UI, core, CLI, and MCP server. Can use the sandbox runtime as a library. The TypeScript MCP SDK is the reference implementation. Easiest for Claude Code to build and maintain. Runs on Linux and Windows. | Large (around 200 MB) and memory-heavy. Doesn't feel like a Mac app. Not Rust. |
| **Native SwiftUI, all Swift** | Feels the most like a Mac app. Small. Keychain and notifications are built in. | Mac only, which rules out Linux and Windows. Outside tools run as subprocesses. The Swift MCP SDK is less mature. Less example code, so slower to build. |
| **SwiftUI front end + TypeScript core** | Mac feel in the UI, Node tooling in the core. | Two languages and two builds sharing one database schema. The most work of any option. The UI is Mac only. |
| **Tauri + Node sidecar** | Smaller shell than Electron. | Still ships Node for the core, so most of the size advantage is gone, and Rust becomes a third language. (Dropped here, but it comes back in round 2 without the sidecar.) |
| **Wails (Go)** | Go can use OSV-Scanner and govulncheck as libraries. Ships as one binary. Cross-platform. | The sandbox runtime and Claude run as subprocesses. Web UI, so no native feel. |
| **Local web app in a browser tab** | Least work: the CLI starts a local server. The same UI can be wrapped in a desktop shell later. | Not really a desktop app. |

**Suggestion at the time:** Electron with a TypeScript core, as the shortest path that fits the sandbox runtime and MCP best. The Rust preference set it aside for round 2, but it was the option chosen in the end.

## Options, round 2: Rust core

The core is Rust in every option below. MCP uses the official Rust SDK (`rmcp`), and SQLite uses a crate such as `rusqlite`.

| UI option | Good | Costs |
|---|---|---|
| **GPUI Kit** (Longbridge, built on Zed's GPUI) | The best built-in fit: data tables, virtual lists, Markdown and basic HTML rendering, charts, and a code editor. GPU-rendered, fast, polished. Apache-2.0. | Pre-1.0 (v0.8), and GPUI itself changes often, so upgrades break things. Little example code, so Claude Code makes more mistakes. It looks like Zed, not like a native Mac app. |
| **Tauri 2** (Rust core, web UI) | Stable 2.x. Small, because it uses the system's webview. Writing the UI in TypeScript gives the widest choice of table, Markdown, and chart libraries, and web UIs are what Claude Code builds most reliably. | Two languages. The webview differs by platform (WKWebView, WebView2, WebKitGTK), and Linux's is the weakest. Not natively rendered. |
| **egui** | Pure Rust and the quickest to build. Widely used, so Claude Code knows it well. Add-on crates provide tables (`egui_extras`), Markdown (`egui_commonmark`), and charts (`egui_plot`). | Looks like a developer tool. Complex layouts get awkward. |
| **Iced** | Pure Rust with a very predictable state model (Elm-style). Used for System76's COSMIC desktop. Has a Markdown widget. Latest release is 0.14 (December 2025). | Pre-1.0, and every release has breaking changes. More of the data-table side would need to be built by hand. |
| **Slint** | The most stable API of the Rust options (1.x, with regular releases). Native-looking styles, including a macOS-like one. Has a table view and good live-preview tools. | No built-in Markdown or charts found, so those would need to be built. Licensed GPLv3, royalty-free, or commercial, which is fine for a hobby app. |
| **Dioxus** | A React-style UI written in Rust, so no TypeScript. | On desktop it still renders in a webview. Its native renderer is experimental, and the API changes often. |

**Dropped:**

- Freya, Floem, Xilem, and Makepad are too young.
- GTK4 (gtk-rs, Relm4) is weak on macOS and Windows.
- Avalonia (C#), Flutter (Dart), and Compose Multiplatform (Kotlin) are also safe and cross-platform, but they would move the core out of Rust.

## Earlier leaning

After round 2, Claude suggested Tauri 2 with a Rust core, or GPUI Kit or egui if the UI also had to be Rust. Electron was chosen instead, for the reasons under Decision above.

## Questions for reviewers

1. Is it acceptable for Claude triage to be off on Windows at first?
2. Do you have experience locking down Electron windows, or using SQLite in Electron (`better-sqlite3` vs `node:sqlite`)?

## To verify before building

- SQLite: whether `node:sqlite` works in both the current Electron and plain Node, or whether to use `better-sqlite3` with a rebuild.
- Sandbox runtime: whether the library works from Electron's main process or needs a separate utility process.
- Sandbox runtime: current status of Windows support.
- `sbx`: the actual minimum macOS version.

## Sources

- [GPUI Kit](https://gpui-kit.com/)
- [gpui-kit on docs.rs](https://docs.rs/gpui-kit/)
- [GPUI Component README](https://github.com/longbridge/gpui-component)
- [gpui-component TextView docs](https://docs.rs/gpui-component/0.5.1/gpui_component/text/struct.TextView.html)
- [Iced 0.14 release (Phoronix)](https://www.phoronix.com/news/Iced-0.14-Rust-GUI-LIbrary)
- [Slint blog](https://slint.dev/blog)
- [Slint 1.0 announcement and licensing](https://old.slint.dev/blog/announcing-slint-1.0.html)
- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Docker Sandboxes: get started](https://docs.docker.com/ai/sandboxes/get-started.md)
