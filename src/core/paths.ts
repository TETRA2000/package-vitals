import path from 'node:path';

const APP_NAME = 'package-vitals';

/**
 * The folder that holds the database and reports. It matches what Electron's
 * `app.getPath('userData')` returns for an app named `package-vitals`, so the
 * CLI and the app share one data home.
 */
export function resolveDataHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): string {
  if (env.PACKAGE_VITALS_HOME) return env.PACKAGE_VITALS_HOME;
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(homeDir, 'AppData', 'Roaming'), APP_NAME);
  }
  if (platform === 'darwin') {
    return path.posix.join(homeDir, 'Library', 'Application Support', APP_NAME);
  }
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(homeDir, '.config'), APP_NAME);
}

export function dataPaths(home: string): { db: string; reports: string } {
  return { db: path.join(home, 'vitals.db'), reports: path.join(home, 'reports') };
}
