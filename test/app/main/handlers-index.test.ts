import { describe, it, expect } from 'vitest';
import { createAllHandlers } from '../../../src/app/main/handlers/index.js';
import { openDatabase } from '../../../src/core/db/database.js';
import { INVOKE_METHODS } from '../../../src/app/shared/api.js';

describe('createAllHandlers', () => {
  it('every API method has a handler', () => {
    const db = openDatabase(':memory:');
    const handlers = createAllHandlers({
      db,
      controller: { running: () => false, start: async () => ({ ok: false, message: 'x' }) },
      openExternal: async () => {},
      writeClipboard: () => {},
      reportsDir: '/nonexistent',
      now: () => new Date(),
    });
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_METHODS].sort());
    db.close();
  });
});
