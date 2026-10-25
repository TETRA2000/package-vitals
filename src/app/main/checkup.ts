import type { CheckupSummary } from '../../core/types.js';
import type { CheckupProgress, CheckupResult } from '../shared/api.js';

/** Runs one Checkup at a time. A second start while one runs is refused, and a failure becomes its message. */
export function createCheckupController(deps: {
  run: (onProgress: (p: CheckupProgress) => void) => Promise<CheckupSummary>;
  onProgress: (p: CheckupProgress) => void;
}): { running(): boolean; start(): Promise<CheckupResult> } {
  let running = false;
  return {
    running: () => running,
    async start() {
      if (running) return { ok: false, message: 'A Checkup is already running.' };
      running = true;
      try {
        return { ok: true, summary: await deps.run(deps.onProgress) };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      } finally {
        running = false;
      }
    },
  };
}
