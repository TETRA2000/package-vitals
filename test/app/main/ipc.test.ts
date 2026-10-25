import { describe, it, expect, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerIpc } from '../../../src/app/main/ipc.js';
import { isAppUrl } from '../../../src/app/main/security.js';
import type { FindingDetail } from '../../../src/core/types.js';

type Listener = (event: { senderFrame: { url: string } | null }, ...args: unknown[]) => unknown;

/** An ipcMain stand-in that records each handler by channel. */
function fakeIpcMain() {
  const listeners = new Map<string, Listener>();
  const ipc = { handle: (channel: string, listener: Listener) => { listeners.set(channel, listener); } };
  return { ipc: ipc as unknown as Pick<IpcMain, 'handle'>, listeners };
}

const isTrustedSender = (url: string | undefined) => url !== undefined && isAppUrl(url);

describe('registerIpc', () => {
  it('registers one channel per handler', () => {
    const { ipc, listeners } = fakeIpcMain();
    registerIpc(ipc, { getOverview: vi.fn(), listFindings: vi.fn() }, isTrustedSender);
    expect([...listeners.keys()].sort()).toEqual(['vitals:getOverview', 'vitals:listFindings']);
  });

  it('refuses calls from any frame that is not the app', async () => {
    const { ipc, listeners } = fakeIpcMain();
    const result = { marker: 'the handler result' } as unknown as FindingDetail;
    const getFinding = vi.fn(async (_arg: unknown) => result);
    registerIpc(ipc, { getFinding }, isTrustedSender);
    const call = (senderFrame: { url: string } | null, arg: unknown) =>
      listeners.get('vitals:getFinding')!({ senderFrame }, arg);

    await expect(call({ url: 'https://evil.example/' }, 1)).rejects.toThrow('Untrusted sender');
    await expect(call(null, 1)).rejects.toThrow('Untrusted sender');
    expect(getFinding).not.toHaveBeenCalled();

    const key = { snapshotId: 1, repoId: 2, number: 3 };
    await expect(call({ url: 'app://vitals/index.html' }, key)).resolves.toBe(result);
    expect(getFinding).toHaveBeenCalledExactlyOnceWith(key);
  });
});
