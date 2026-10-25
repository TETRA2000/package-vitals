import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Protocol } from 'electron';
import { CONTENT_SECURITY_POLICY, isAppUrl } from './security.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** The file under `rootDir` that an `app://vitals/…` URL names, or null if it names anything else. */
export function resolveAppFile(rootDir: string, requestUrl: string): string | null {
  if (!isAppUrl(requestUrl)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return null;
  }
  const root = path.resolve(rootDir);
  const file = path.resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
  return file.startsWith(root + path.sep) ? file : null;
}

export function appResponseHeaders(file: string): Record<string, string> {
  return {
    'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff',
  };
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Serves the built renderer from `rootDir` on `app://vitals/`. */
export function registerAppProtocol(protocol: Pick<Protocol, 'handle'>, rootDir: string): void {
  protocol.handle('app', async (request) => {
    const file = resolveAppFile(rootDir, request.url);
    if (file === null) return notFound();
    try {
      return new Response(await readFile(file), { headers: appResponseHeaders(file) });
    } catch {
      return notFound();
    }
  });
}
