import type { Db } from '../../../core/db/database.js';
import type { Handlers } from '../../shared/api.js';
import type { createCheckupController } from '../checkup.js';
import { actionHandlers } from './actions.js';
import { checkupHandlers } from './checkup.js';
import { queueHandlers } from './queue.js';
import { reportHandlers } from './reports.js';

/** Every handler set in one object, so one registration covers the whole API. */
export function createAllHandlers(deps: {
  db: Db;
  controller: ReturnType<typeof createCheckupController>;
  openExternal: (url: string) => Promise<void>;
  writeClipboard: (text: string) => void;
  reportsDir: string;
  now: () => Date;
}): Handlers {
  const { db } = deps;
  return {
    ...queueHandlers({ db, checkupRunning: deps.controller.running }),
    ...actionHandlers({ db, openExternal: deps.openExternal, writeClipboard: deps.writeClipboard }),
    ...reportHandlers({ db, reportsDir: deps.reportsDir, now: deps.now }),
    ...checkupHandlers(deps.controller),
  };
}
