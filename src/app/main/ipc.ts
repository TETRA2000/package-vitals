import type { IpcMain } from 'electron';
import { channelFor, INVOKE_METHODS, type Handlers } from '../shared/api.js';

/**
 * Puts each handler on its own channel. Only the known methods are registered, and a call from any
 * frame `isTrustedSender` rejects, or whose frame is gone, fails before the handler runs.
 */
export function registerIpc(
  ipc: Pick<IpcMain, 'handle'>,
  handlers: Partial<Handlers>,
  isTrustedSender: (frameUrl: string | undefined) => boolean,
): void {
  for (const method of INVOKE_METHODS) {
    const handler = handlers[method];
    if (handler === undefined) continue;
    ipc.handle(channelFor(method), async (event, arg: unknown) => {
      if (!isTrustedSender(event.senderFrame?.url)) throw new Error('Untrusted sender');
      return handler(arg);
    });
  }
}
