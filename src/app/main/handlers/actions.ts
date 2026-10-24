import type { Db } from '../../../core/db/database.js';
import { dependabotAlertUrl } from '../../../core/github/urls.js';
import { getFinding } from '../../../core/queries/findings.js';
import { renderFindingMarkdown } from '../../../core/reports/finding-markdown.js';
import type { FindingDetail } from '../../../core/types.js';
import type { Handlers } from '../../shared/api.js';
import { IpcInputError, parseFindingKey } from '../validate.js';
import { requireCompleteSnapshot } from './common.js';

/**
 * Copy and open for one finding. The renderer sends only a key: the text and the URL are built here from
 * the database, so repo-derived content never decides what reaches the clipboard or the browser.
 */
export function actionHandlers(
  deps: { db: Db; openExternal: (url: string) => Promise<void>; writeClipboard: (text: string) => void },
): Pick<Handlers, 'copyFindingMarkdown' | 'openFindingOnGitHub'> {
  const { db } = deps;

  function lookup(arg: unknown): FindingDetail {
    const key = parseFindingKey(arg);
    requireCompleteSnapshot(db, key.snapshotId);
    const finding = getFinding(db, key);
    if (finding === null) throw new IpcInputError('Finding not found.');
    return finding;
  }

  return {
    async copyFindingMarkdown(arg) {
      deps.writeClipboard(renderFindingMarkdown(lookup(arg)));
    },

    async openFindingOnGitHub(arg) {
      const finding = lookup(arg);
      await deps.openExternal(dependabotAlertUrl(finding.fullName, finding.number));
    },
  };
}
