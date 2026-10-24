import { describe, it, expect } from 'vitest';
import { mapLimit } from '../../src/core/concurrency.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapLimit', () => {
  it('preserves order and never exceeds limit', async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await mapLimit(items, 3, async (item, index) => {
      running++;
      peak = Math.max(peak, running);
      await delay(1 + Math.floor(Math.random() * 5));
      running--;
      return `${item}:${index}`;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(results).toEqual(items.map((i) => `${i}:${i}`));
  });

  it('rejects with the first error after in-flight calls settle, and starts no more', async () => {
    const started: number[] = [];
    let settled = 0;
    const err = await mapLimit([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      await delay(item === 0 ? 1 : 5);
      settled++;
      if (item === 0) throw new Error('first');
      return item;
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ message: 'first' });
    expect(started).toEqual([0, 1]);
    expect(settled).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
