import { homedir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, protocol, session, shell } from 'electron';
import { runAccountCheckup } from '../../core/checkup/account-checkup.js';
import { openDatabase, type Db } from '../../core/db/database.js';
import { execFileText } from '../../core/github/token.js';
import { dataPaths, resolveDataHome } from '../../core/paths.js';
import { createCheckupController } from './checkup.js';
import { createAllHandlers } from './handlers/index.js';
import { CHECKUP_PROGRESS_CHANNEL } from '../shared/api.js';
import { registerIpc } from './ipc.js';
import { registerAppProtocol } from './protocol.js';
import { hardenSession, hardenWebContents, isAppUrl, webPreferences } from './security.js';

// The Electron entry point: wiring only. It is the one module that imports electron at runtime.

const home = resolveDataHome(process.env, process.platform, homedir());
let db: Db | undefined;
let mainWindow: BrowserWindow | undefined;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
app.enableSandbox();
// Before the lock: Electron keys the single-instance lock on the userData folder, so this makes it per data home.
app.setPath('userData', home);
app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

// One app per data home, so two app processes can't run two Checkups at once. A second launch quits before it
// opens anything, and the first comes to the front.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
app.on('second-instance', () => {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(() => {
  if (!isFirstInstance) return;
  hardenSession(session.defaultSession);
  registerAppProtocol(protocol, path.join(import.meta.dirname, '../renderer'));

  const database = openDatabase(dataPaths(home).db);
  db = database;
  const isTrustedSender = (url: string | undefined) => url !== undefined && isAppUrl(url);
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Package Vitals',
    show: false,
    webPreferences: webPreferences(path.join(import.meta.dirname, '../preload/preload.cjs')),
  });
  mainWindow = win;
  const controller = createCheckupController({
    run: (onProgress) => runAccountCheckup(
      { db: database, exec: execFileText, now: () => new Date(), onProgress },
      { includeForks: false, includeArchived: false, concurrency: 8 },
    ),
    onProgress: (p) => {
      if (!win.isDestroyed()) win.webContents.send(CHECKUP_PROGRESS_CHANNEL, p);
    },
  });
  registerIpc(ipcMain, createAllHandlers({
    db: database,
    controller,
    openExternal: (url) => shell.openExternal(url),
    writeClipboard: (text) => clipboard.writeText(text),
    reportsDir: dataPaths(home).reports,
    now: () => new Date(),
  }), isTrustedSender);

  win.once('ready-to-show', () => win.show());
  void win.loadURL('app://vitals/index.html');
}).catch((err: unknown) => {
  console.error(err);
  app.quit();
});

/** An error's message and stack, and nothing else it carries. */
function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

// Crashes go to stderr: only reasons, exit codes, and error messages and stacks (core errors never hold the
// token). None of these listeners changes what Electron does next.
app.on('render-process-gone', (_event, _contents, details) => {
  console.error(`Renderer process gone: ${details.reason} (exit code ${details.exitCode})`);
});
app.on('child-process-gone', (_event, details) => {
  console.error(`Child process gone: ${details.reason} (exit code ${details.exitCode})`);
});
// An unhandled rejection doesn't stop Electron's main process. This logs it in place of Node's warning.
process.on('unhandledRejection', (reason) => console.error(`Unhandled rejection: ${errorText(reason)}`));
// The monitor, not an 'uncaughtException' listener: Electron shows its error box only while its own listener
// is the only one.
process.on('uncaughtExceptionMonitor', (err) => console.error(`Uncaught exception: ${errorText(err)}`));

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  db?.close();
  db = undefined;
});
