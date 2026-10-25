import { runAccountCheckup } from '../../core/checkup/account-checkup.js';
import { checkupWarning, formatCheckupSummary } from '../../core/checkup/format.js';
import { openDatabase } from '../../core/db/database.js';
import { dataPaths, resolveDataHome } from '../../core/paths.js';
import type { CliDeps } from '../main.js';

export async function checkupCommand(
  opts: { includeForks: boolean; includeArchived: boolean; concurrency: number },
  deps: CliDeps,
): Promise<number> {
  const db = openDatabase(dataPaths(resolveDataHome(deps.env, deps.platform, deps.homeDir)).db);
  try {
    const s = await runAccountCheckup(
      { db, exec: deps.exec, fetch: deps.fetch, now: deps.now, onProgress: (p) => deps.stderr(`[${p.done}/${p.total}] ${p.repo}`) },
      opts,
    );
    deps.stdout(formatCheckupSummary(s));
    const warning = checkupWarning(s);
    if (warning !== null) deps.stderr(warning);
    return 0;
  } finally {
    db.close();
  }
}
