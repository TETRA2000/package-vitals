import type { Session, WebContents, WebPreferences, WebRequest } from 'electron';

/** Sent as a response header by the app protocol and repeated in index.html's meta tag. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
  "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const APP_SCHEME = 'app:';
const APP_HOST = 'vitals';

/** The web preferences of every window: sandboxed, isolated, no Node. */
export function webPreferences(preload: string): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    spellcheck: false,
  };
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True only for `app://vitals/…`. A custom scheme's `origin` is `'null'`, so this compares scheme and host. */
export function isAppUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && parsed.protocol === APP_SCHEME && parsed.host === APP_HOST;
}

/** The session lets through only the app itself, DevTools, and inline data URLs. */
export function isAllowedRequestUrl(url: string): boolean {
  if (isAppUrl(url)) return true;
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol === 'devtools:' || parsed.protocol === 'data:');
}

export type WebContentsLike = Pick<WebContents, 'on' | 'setWindowOpenHandler'>;

/** No navigation away from the app, no webviews, and no new windows. */
export function hardenWebContents(c: WebContentsLike): void {
  c.on('will-navigate', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  c.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault();
  });
  c.on('will-attach-webview', (event) => event.preventDefault());
  c.setWindowOpenHandler(() => ({ action: 'deny' }));
}

export type SessionLike = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'> & {
  webRequest: Pick<WebRequest, 'onBeforeRequest'>;
};

/** Every permission is denied, and every request that isn't the app is cancelled. */
export function hardenSession(s: SessionLike): void {
  s.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedRequestUrl(details.url) });
  });
}
