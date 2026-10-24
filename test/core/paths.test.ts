import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveDataHome, dataPaths } from '../../src/core/paths.js';

describe('resolveDataHome', () => {
  it('prefers PACKAGE_VITALS_HOME', () => {
    expect(resolveDataHome({ PACKAGE_VITALS_HOME: '/tmp/pv' }, 'darwin', '/Users/t')).toBe('/tmp/pv');
  });
  it('uses Application Support on macOS', () => {
    expect(resolveDataHome({}, 'darwin', '/Users/t')).toBe('/Users/t/Library/Application Support/package-vitals');
  });
  it('uses XDG_CONFIG_HOME, then ~/.config, on Linux', () => {
    expect(resolveDataHome({ XDG_CONFIG_HOME: '/x/cfg' }, 'linux', '/home/t')).toBe('/x/cfg/package-vitals');
    expect(resolveDataHome({}, 'linux', '/home/t')).toBe('/home/t/.config/package-vitals');
  });
  it('uses APPDATA on Windows', () => {
    expect(resolveDataHome({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' }, 'win32', 'C:\\Users\\t'))
      .toBe('C:\\Users\\t\\AppData\\Roaming\\package-vitals');
  });
});

describe('dataPaths', () => {
  it('puts the database and reports under the home', () => {
    expect(dataPaths('/tmp/pv')).toEqual({ db: path.join('/tmp/pv', 'vitals.db'), reports: path.join('/tmp/pv', 'reports') });
  });
});
