import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CONTENT_SECURITY_POLICY,
  hardenSession,
  hardenWebContents,
  isAllowedRequestUrl,
  isAppUrl,
  webPreferences,
  type SessionLike,
  type WebContentsLike,
} from '../../../src/app/main/security.js';

const INDEX_HTML = path.join(import.meta.dirname, '../../../src/app/renderer/index.html');

describe('security', () => {
  it('locks down every window', () => {
    expect(webPreferences('/p/preload.cjs')).toEqual({
      preload: '/p/preload.cjs',
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
    });
  });

  it('has a strict CSP', () => {
    for (const directive of [
      "default-src 'none'", "script-src 'self'", "connect-src 'none'",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'",
    ]) {
      expect(CONTENT_SECURITY_POLICY).toContain(directive);
    }
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-(inline|eval)/);
    expect(readFileSync(INDEX_HTML, 'utf8')).toContain(`content="${CONTENT_SECURITY_POLICY}"`);
  });

  it('isAppUrl accepts only app://vitals', () => {
    expect(isAppUrl('app://vitals/index.html')).toBe(true);
    for (const url of ['app://evil/index.html', 'https://vitals/', 'file:///index.html', 'not a url']) {
      expect(isAppUrl(url), url).toBe(false);
    }
  });

  it('allows requests only to the app, devtools, and data URLs', () => {
    for (const url of ['app://vitals/assets/a.js', 'devtools://devtools/bundled/x.html', 'data:image/png;base64,AA']) {
      expect(isAllowedRequestUrl(url), url).toBe(true);
    }
    for (const url of ['https://example.com/', 'http://localhost:5173/', 'file:///etc/passwd', 'ws://example.com/']) {
      expect(isAllowedRequestUrl(url), url).toBe(false);
    }
  });

  it('blocks navigation away from the app and every new window', () => {
    let openHandler: ((details: { url: string }) => unknown) | undefined;
    const contents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: (h: (details: { url: string }) => unknown) => { openHandler = h; },
    });
    hardenWebContents(contents as unknown as WebContentsLike);

    const emit = (name: string, url: string) => {
      const event = { url, preventDefault: vi.fn() };
      contents.emit(name, event, url);
      return event.preventDefault;
    };
    expect(emit('will-navigate', 'https://evil.example/')).toHaveBeenCalled();
    expect(emit('will-redirect', 'https://evil.example/')).toHaveBeenCalled();
    expect(emit('will-navigate', 'app://vitals/index.html')).not.toHaveBeenCalled();
    expect(emit('will-attach-webview', 'app://vitals/index.html')).toHaveBeenCalled();
    expect(openHandler?.({ url: 'app://vitals/index.html' })).toEqual({ action: 'deny' });
    expect(openHandler?.({ url: 'https://evil.example/' })).toEqual({ action: 'deny' });
  });

  it('denies every permission and cancels remote requests', () => {
    type RequestHandler = (wc: unknown, permission: string, callback: (granted: boolean) => void) => void;
    type CheckHandler = (wc: unknown, permission: string) => boolean;
    type BeforeRequest = (details: { url: string }, callback: (r: { cancel: boolean }) => void) => void;
    let requestHandler: RequestHandler | undefined;
    let checkHandler: CheckHandler | undefined;
    let filter: unknown;
    let beforeRequest: BeforeRequest | undefined;
    const ses = {
      setPermissionRequestHandler: (h: RequestHandler) => { requestHandler = h; },
      setPermissionCheckHandler: (h: CheckHandler) => { checkHandler = h; },
      webRequest: {
        onBeforeRequest: (f: unknown, l: BeforeRequest) => { filter = f; beforeRequest = l; },
      },
    };
    hardenSession(ses as unknown as SessionLike);

    for (const permission of ['media', 'clipboard-read']) {
      const callback = vi.fn();
      requestHandler?.({}, permission, callback);
      expect(callback, permission).toHaveBeenCalledExactlyOnceWith(false);
    }
    expect(checkHandler?.({}, 'media')).toBe(false);

    expect(filter).toEqual({ urls: ['<all_urls>'] });
    const answer = (url: string) => {
      const callback = vi.fn();
      beforeRequest?.({ url }, callback);
      return callback;
    };
    expect(answer('https://example.com/')).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(answer('app://vitals/index.html')).toHaveBeenCalledExactlyOnceWith({ cancel: false });
  });
});
