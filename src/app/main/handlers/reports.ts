import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../../../core/db/database.js';
import { snapshotRepos } from '../../../core/queries/findings.js';
import { getReportPath, listReports } from '../../../core/queries/reports.js';
import { generateAccountReport, generateRepoChart } from '../../../core/reports/generate.js';
import type { ReportEntry } from '../../../core/types.js';
import type { Handlers } from '../../shared/api.js';
import { IpcInputError, parseReportId, parseReportRequest } from '../validate.js';
import { requireCompleteSnapshot } from './common.js';

const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const NOT_FOUND = 'Report not found.';

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Report files hold text from untrusted repos, so main reads only a file that the reports table records
 * and that, after symlinks, sits inside the reports folder. Errors never carry a path.
 */
export function reportHandlers(
  deps: { db: Db; reportsDir: string; now: () => Date },
): Pick<Handlers, 'listReports' | 'readReport' | 'generateReport'> {
  const { db } = deps;

  async function readContained(file: string): Promise<string> {
    try {
      const realDir = await realpath(deps.reportsDir);
      const realFile = await realpath(file);
      const rel = path.relative(realDir, realFile);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new IpcInputError(NOT_FOUND);
      if ((await stat(realFile)).size > MAX_REPORT_BYTES) throw new IpcInputError('Report is too large to show.');
      return await readFile(realFile, 'utf8');
    } catch (err) {
      if (err instanceof IpcInputError) throw err;
      // fs errors name absolute paths, so only fixed text goes to the renderer.
      throw new IpcInputError(isMissing(err) ? 'Report file is missing.' : 'Report could not be read.');
    }
  }

  return {
    async listReports() {
      return listReports(db);
    },

    async readReport(arg) {
      const file = getReportPath(db, parseReportId(arg));
      if (file === null) throw new IpcInputError(NOT_FOUND);
      return readContained(file);
    },

    async generateReport(arg) {
      const req = parseReportRequest(arg);
      const snapshot = requireCompleteSnapshot(db, req.snapshotId);
      const createdAt = deps.now().toISOString();
      let created: { id: number } | null;
      try {
        if (req.kind === 'account') {
          created = generateAccountReport(db, deps.reportsDir, snapshot, createdAt);
        } else {
          const repo = snapshotRepos(db, snapshot.id).find((r) => r.id === req.repoId);
          if (repo === undefined) throw new IpcInputError('Repo is not in this snapshot.');
          created = generateRepoChart(db, deps.reportsDir, snapshot, repo.fullName, createdAt);
        }
      } catch (err) {
        if (err instanceof IpcInputError) throw err;
        throw new IpcInputError('Report could not be written.');
      }
      const entry: ReportEntry | undefined = created === null ? undefined : listReports(db).find((e) => e.id === created.id);
      if (entry === undefined) throw new IpcInputError('Repo is not in this snapshot.');
      return entry;
    },
  };
}
