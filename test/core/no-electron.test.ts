import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '../../src');
const ELECTRON_IMPORT = /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)|import\(\s*['"]electron['"]\s*\)/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f));
}

describe('the core and CLI do not depend on Electron', () => {
  it('the guard recognises each way of importing electron', () => {
    for (const line of ["import { app } from 'electron';", 'const e = require("electron");', "await import('electron');"]) {
      expect(ELECTRON_IMPORT.test(line), line).toBe(true);
    }
  });

  it('no file under src/core or src/cli imports electron', () => {
    const files = [...tsFiles(path.join(SRC, 'core')), ...tsFiles(path.join(SRC, 'cli'))];
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => ELECTRON_IMPORT.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
