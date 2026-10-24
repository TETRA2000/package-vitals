# package-vitals

A local desktop app and CLI that collect the Dependabot alerts across your GitHub repos and write Markdown health reports.

## Requirements

- Node.js 24 or later
- The GitHub CLI (`gh`), logged in with `gh auth login`. Package Vitals reads its token from `gh`.

Install the dependencies with `npm install`.

## The app

```sh
npm run app
```

This builds the app and opens it. The database and reports live in the app's data folder:
`~/Library/Application Support/package-vitals` on macOS, `%APPDATA%\package-vitals` on Windows, and
`$XDG_CONFIG_HOME/package-vitals` (`~/.config/package-vitals` by default) on Linux. To use another folder, set
`PACKAGE_VITALS_HOME`:

```sh
PACKAGE_VITALS_HOME=/tmp/vitals npm run app
```

## The CLI

Build once with `npm run build`, then:

```sh
node dist/cli/bin.js checkup [--include-forks] [--include-archived] [--concurrency N]
node dist/cli/bin.js report account [--snapshot N]
node dist/cli/bin.js report repo <owner/name> [--snapshot N]
```

- `checkup` reads the alerts of every repo the signed-in `gh` user owns and saves them as a snapshot. Forks and
  archived repos are left out unless you include them. `--concurrency` (1 to 32, default 8) sets how many repos are
  read at once.
- `report account` writes the account health report and prints its path.
- `report repo` writes the chart for one repo and prints its path.

Reports use the latest completed snapshot unless you pass `--snapshot`. The CLI and the app share the data folder,
and `PACKAGE_VITALS_HOME` works for both.

## Tests

```sh
npm run typecheck
npm test              # unit tests
npm run build         # the end-to-end test runs the built app
npm run test:e2e      # launches the app with Playwright and checks its security settings
```

The end-to-end test needs Electron's binary, which Electron downloads the first time it runs
(`npx --no install-electron` fetches it ahead of time; `--no` stops npx from downloading a registry package of that
name). On Linux it needs a display, so run it as `xvfb-run -a npm run test:e2e`. Where AppArmor restricts unprivileged
user namespaces, as on Ubuntu 24.04, Chromium's sandbox can't start until you allow them with
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.
