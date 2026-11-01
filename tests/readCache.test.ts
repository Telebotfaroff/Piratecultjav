import test from 'node:test';
import assert from 'node:assert/strict';
import { getCached, invalidateCached } from '../src/services/readCache.ts';

test('deduplicates concurrent loads for the same key', async () => {
  const key = 'test:singleflight';
  invalidateCached(key);
  let loads = 0;
  let release!: (value: string) => void;
  const loader = () => {
    loads++;
    return new Promise<string>((resolve) => { release = resolve; });
  };

  const first = getCached(key, 10_000, loader);
  const second = getCached(key, 10_000, loader);
  assert.equal(loads, 1);
  release('shared');
  assert.equal(await first, 'shared');
  assert.equal(await second, 'shared');
  assert.equal(await getCached(key, 10_000, loader), 'shared');
  assert.equal(loads, 1);
});

test('invalidation prevents an older in-flight load from restoring stale data', async () => {
  const key = 'test:invalidate-inflight';
  invalidateCached(key);
  let release!: (value: string) => void;
  const pending = getCached(key, 10_000, () => new Promise<string>((resolve) => { release = resolve; }));

  invalidateCached(key);
  release('stale');

  assert.equal(await pending, 'stale');
  let freshLoads = 0;
  const fresh = await getCached(key, 10_000, async () => {
    freshLoads++;
    return 'fresh';
  });
  assert.equal(fresh, 'fresh');
  assert.equal(freshLoads, 1);
});

test('does not retain entries with an expired zero-length TTL', async () => {
  const key = 'test:zero-ttl';
  invalidateCached(key);
  let loads = 0;
  const loader = async () => ++loads;
  assert.equal(await getCached(key, 0, loader), 1);
  assert.equal(await getCached(key, 0, loader), 2);
});
