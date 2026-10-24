import { homedir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { openDatabase, type Db } from '../../core/db/database.js';
import { dataPaths, resolveDataHome } from '../../core/paths.js';
import { queueHandlers } from './handlers/queue.js';
import { registerIpc } from './ipc.js';
import { registerAppProtocol } from './protocol.js';
import { hardenSession, hardenWebContents, isAppUrl, webPreferences } from './security.js';

// The Electron entry point: wiring only. It is the one module that imports electron at runtime.

const home = resolveDataHome(process.env, process.platform, homedir());
let db: Db | undefined;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
app.enableSandbox();
app.setPath('userData', home);
app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  registerAppProtocol(protocol, path.join(import.meta.dirname, '../renderer'));

  const database = openDatabase(dataPaths(home).db);
  db = database;
  registerIpc(ipcMain, queueHandlers({ db: database, checkupRunning: () => false }),
    (url) => url !== undefined && isAppUrl(url));

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Package Vitals',
    show: false,
    webPreferences: webPreferences(path.join(import.meta.dirname, '../preload/preload.cjs')),
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL('app://vitals/index.html');
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  db?.close();
  db = undefined;
});
