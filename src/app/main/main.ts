import { homedir } from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, protocol, session } from 'electron';
import { resolveDataHome } from '../../core/paths.js';
import { registerAppProtocol } from './protocol.js';
import { hardenSession, hardenWebContents, webPreferences } from './security.js';

// The Electron entry point: wiring only. It is the one module that imports electron at runtime.

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
app.enableSandbox();
app.setPath('userData', resolveDataHome(process.env, process.platform, homedir()));
app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  registerAppProtocol(protocol, path.join(import.meta.dirname, '../renderer'));

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
