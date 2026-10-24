import type { WebContents, WebPreferences } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, META_CONTENT_SECURITY_POLICY } from '../../src/app/main/security.js';
import type { VitalsApi } from '../../src/app/shared/api.js';
import { openDatabase } from '../../src/core/db/database.js';
import { dataPaths } from '../../src/core/paths.js';
import { seedSnapshot } from '../helpers/seed.js';

// Launches the real built app (run `npm run build` first) on a seeded temp data home and checks that its
// hardening holds together.

// This project has Node's types, not the DOM's. These are the page globals the evaluate callbacks touch;
// the callbacks run in the page, where `window` is the real one.
declare const window: {
  vitals: VitalsApi;
  __pwned?: unknown;
  innerHeight: number;
  location: { href: string };
  open(url: string): unknown;
  document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null };
};

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const APP_URL = 'app://vitals/index.html';
const OUTSIDE_URL = 'https://example.com/';
const HOSTILE_SUMMARY = '<img src=x onerror="window.__pwned = true">';
/** Repo b's read error reaches the account report: a bare URL, Markdown image syntax, and raw HTML. */
const HOSTILE_ERROR = 'Moved to https://example.com/moved ![logo](https://example.com/logo.png) <img src=x>';
/** Enough not monitored repos for a long notice, and enough critical findings to scroll. */
const NOT_MONITORED = Array.from({ length: 10 }, (_, i) => ({ name: `quiet-${i + 1}`, alertsStatus: 'not_monitored' as const }));
const MANY_CRITICALS = Array.from({ length: 60 }, () => ({ severity: 'critical' as const }));
/** Every key the preload may expose. A new one has to be added here on purpose. */
const VITALS_KEYS = [
  'copyFindingMarkdown',
  'generateReport',
  'getFinding',
  'getOverview',
  'getTreatmentPlan',
  'listFindings',
  'listRepoCards',
  'listReports',
  'onCheckupProgress',
  'openFindingOnGitHub',
  'readReport',
  'startCheckup',
] as const satisfies readonly (keyof VitalsApi)[];

let home: string | undefined;
let snapshotId: number;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'package-vitals-e2e-'));
  const db = openDatabase(dataPaths(home).db);
  try {
    snapshotId = seedSnapshot(db, {
      repos: [
        { name: 'a', alerts: [{ severity: 'critical', summary: HOSTILE_SUMMARY }] },
        { name: 'b', alertsStatus: 'error', alertsError: HOSTILE_ERROR },
        { name: 'c', alerts: MANY_CRITICALS },
        ...NOT_MONITORED,
      ],
    });
  } finally {
    db.close();
  }
});

afterAll(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
});

/** Launches the built app on the seeded home and waits for the seeded snapshot's findings. */
async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    args: ['.'],
    cwd: REPO_ROOT,
    // process.env never holds undefined values at runtime; its type just allows them.
    env: { ...process.env, PACKAGE_VITALS_HOME: home } as Record<string, string>,
    // On Linux, Playwright passes --no-sandbox unless this is set. The test runs the app as shipped.
    chromiumSandbox: true,
  });
  const page = await app.firstWindow();
  return { app, page };
}

// One app and one page for the whole block: the tests are one sequential session, and each starts where the
// last one left off (the selection test, for one, leaves a finding selected).
describe('the built app', () => {
  let app: ElectronApplication;
  let page: Page;
  /** Every error the page logs, such as a CSP violation. */
  const consoleErrors: string[] = [];

  beforeAll(async () => {
    ({ app, page } = await launch());
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.getByRole('listbox', { name: 'Findings' }).waitFor();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the window is sandboxed and isolated', async () => {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      // Electron has this method but leaves it out of its typings.
      const contents = windows[0]?.webContents as (WebContents & { getLastWebPreferences(): WebPreferences | null }) | undefined;
      const p = contents?.getLastWebPreferences();
      return { windows: windows.length, sandbox: p?.sandbox, contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration };
    });
    expect(prefs).toEqual({ windows: 1, sandbox: true, contextIsolation: true, nodeIntegration: false });
  });

  it('the page has no Node and exactly the vitals API', async () => {
    const globals = await page.evaluate(() => ({
      require: typeof require,
      process: typeof process,
      module: typeof module,
      vitals: Object.keys(window.vitals).sort(),
    }));
    expect(globals).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', vitals: [...VITALS_KEYS] });
  });

  it('the CSP is in place', async () => {
    // A meta tag can't carry frame-ancestors, so the page's copy is the policy without it.
    const meta = await page.evaluate(() =>
      window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'));
    expect(meta).toBe(META_CONTENT_SECURITY_POLICY);

    // The response header carries the whole policy. Reloading is the way to see the page's response.
    const response = await page.reload();
    expect(response?.headers()['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    await page.getByRole('listbox', { name: 'Findings' }).waitFor();
  });

  it('hostile advisory text stays text', async () => {
    const row = page.getByRole('option').filter({ hasText: HOSTILE_SUMMARY });
    await row.waitFor();
    expect(await row.textContent()).toContain(HOSTILE_SUMMARY);

    await row.click();
    await page.getByRole('complementary', { name: 'Finding details' }).getByText(HOSTILE_SUMMARY, { exact: true }).waitFor();

    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(await page.locator('img').count()).toBe(0);
  });

  it('the arrow keys keep the selection and its actions in view', async () => {
    const list = page.getByRole('listbox', { name: 'Findings' });
    await list.getByRole('option').first().click();
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowDown');
    // Row 0 is repo a's alert (number 1); rows 1 to 60 are repo c's (numbers 2 to 61).
    const selected = list.locator('[aria-selected="true"]');
    await selected.filter({ hasText: 'GHSA-seed-21:' }).waitFor();
    const open = page.getByRole('complementary', { name: 'Finding details' }).getByRole('button', { name: 'Open on GitHub' });
    await open.waitFor();

    const height = await page.evaluate(() => window.innerHeight);
    for (const box of [await selected.boundingBox(), await open.boundingBox()]) {
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    }
  });

  it('the API rejects crafted input', async () => {
    const outcomes = await page.evaluate(async (id) => {
      const settle = (p: Promise<unknown>) =>
        p.then(() => 'resolved', (err: unknown) => (err instanceof Error ? err.message : String(err)));
      return Promise.all([
        settle(window.vitals.readReport(999999)),
        settle(window.vitals.readReport('../../etc/passwd' as unknown as number)),
        settle(window.vitals.listFindings({ snapshotId: id, filter: { severities: [], repoId: null, ecosystem: null } })),
      ]);
    }, snapshotId);
    expect(outcomes).toEqual([
      expect.stringContaining('Report not found.'),
      expect.stringContaining('reportId must be a positive integer.'),
      expect.stringContaining('request.filter.severities must be a non-empty list of distinct severities.'),
    ]);
  });

  it('the session cancels every request that leaves the app', async () => {
    // The CSP guards the app's page; the session's request filter guards every window, including one with no CSP.
    const outcome = await app.evaluate(async ({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ show: false });
      try {
        await win.loadURL(url);
        return 'loaded';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        win.destroy();
      }
    }, OUTSIDE_URL);
    expect(outcome).toContain('ERR_BLOCKED_BY_CLIENT');
  });

  it('a generated report renders without links or images', async () => {
    await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: 'Reports', exact: true }).click();
    await page.getByRole('button', { name: 'Generate account report' }).click();
    const report = page.locator('article.report');
    await report.waitFor();

    const text = await report.textContent();
    expect(text).toContain('Account health report: TETRA2000');
    expect(text).toContain(HOSTILE_ERROR);
    expect(await report.locator('a').count()).toBe(0);
    expect(await report.locator('img').count()).toBe(0);
    // The report's tables have aligned columns; inline alignment styles would each log a CSP error.
    expect(await report.locator('td.align-right').count()).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
  });
});

// Its own app and page: main cancels the navigation without telling DevTools, so Playwright keeps it pending and
// any later locator action on that page would wait for it to finish.
describe('the built app, asked to leave', () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    ({ app, page } = await launch());
    await page.getByRole('listbox', { name: 'Findings' }).waitFor();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('nothing reaches the network or leaves the app', async () => {
    expect(await page.evaluate((url) => fetch(url).then(() => 'reached', () => 'blocked'), OUTSIDE_URL)).toBe('blocked');

    expect(await page.evaluate((url) => window.open(url), OUTSIDE_URL)).toBeNull();
    expect(app.windows()).toHaveLength(1);

    // Proving a navigation never happens needs a bounded wait. Main records the attempt, so the test knows
    // it reached the guard, and then a navigation gets two seconds to commit. Without the guard, the blocked
    // request commits an error page for the outside URL within milliseconds.
    await app.evaluate(({ BrowserWindow }) => {
      const seen: string[] = [];
      (globalThis as { attemptedNavigations?: string[] }).attemptedNavigations = seen;
      BrowserWindow.getAllWindows()[0]?.webContents.on('will-navigate', (event) => {
        seen.push(event.url);
      });
    });
    const navigated = page.waitForEvent('framenavigated', { timeout: 2_000 }).then(() => true, () => false);
    await page.evaluate((url) => {
      window.location.href = url;
    }, OUTSIDE_URL);
    await expect
      .poll(() => app.evaluate(() => (globalThis as { attemptedNavigations?: string[] }).attemptedNavigations), { timeout: 2_000 })
      .toEqual([OUTSIDE_URL]);
    expect(await navigated).toBe(false);
    expect(page.url()).toBe(APP_URL);
    expect(await page.evaluate(() => window.location.href)).toBe(APP_URL);
  });
});
