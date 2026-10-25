import type { Handlers } from '../../shared/api.js';
import type { createCheckupController } from '../checkup.js';

export function checkupHandlers(controller: ReturnType<typeof createCheckupController>): Pick<Handlers, 'startCheckup'> {
  return { startCheckup: () => controller.start() };
}
