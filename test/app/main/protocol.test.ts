import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appResponseHeaders, registerAppProtocol, resolveAppFile } from '../../../src/app/main/protocol.js';
import { CONTENT_SECURITY_POLICY } from '../../../src/app/main/security.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'pv-protocol-'));
const root = path.join(tmp, 'renderer');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolveAppFile', () => {
  it('maps app://vitals/ paths to files under the root', () => {
    expect(resolveAppFile(root, 'app://vitals/')).toBe(path.join(root, 'index.html'));
    expect(resolveAppFile(root, 'app://vitals/assets/index-abc.js')).toBe(path.join(root, 'assets', 'index-abc.js'));
  });

  it('refuses paths outside the root and URLs that are not the app', () => {
    expect(resolveAppFile(root, 'app://vitals/..%2F..%2Fetc%2Fpasswd')).toBeNull();
    expect(resolveAppFile(root, 'app://evil/index.html')).toBeNull();
    expect(resolveAppFile(root, 'https://vitals/index.html')).toBeNull();
  });
});

describe('appResponseHeaders', () => {
  it('sets the content type by extension', () => {
    expect(appResponseHeaders('/r/index.html')['Content-Type']).toBe('text/html; charset=utf-8');
    expect(appResponseHeaders('/r/a.js')['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(appResponseHeaders('/r/a.css')['Content-Type']).toBe('text/css; charset=utf-8');
    expect(appResponseHeaders('/r/a.bin')['Content-Type']).toBe('application/octet-stream');
  });

  it('sends the CSP and nosniff with every response', () => {
    for (const file of ['/r/index.html', '/r/a.js', '/r/a.css', '/r/a.bin']) {
      expect(appResponseHeaders(file)).toMatchObject({
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      });
    }
  });
});

describe('registerAppProtocol', () => {
  it('serves files under the root and gives 404 for anything else', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
    writeFileSync(path.join(tmp, 'secret.txt'), 'secret');

    let scheme: string | undefined;
    let handler: ((request: Request) => Response | Promise<Response>) | undefined;
    registerAppProtocol({ handle: (s, h) => { scheme = s; handler = h; } }, root);
    expect(scheme).toBe('app');
    const get = async (url: string) => handler!(new Request(url));

    const index = await get('app://vitals/');
    expect(index.status).toBe(200);
    expect(index.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(await index.text()).toBe('<h1>hi</h1>');

    expect((await get('app://vitals/missing.js')).status).toBe(404);
    expect((await get('app://vitals/..%2Fsecret.txt')).status).toBe(404);
    expect((await get('app://evil/index.html')).status).toBe(404);
  });
});
