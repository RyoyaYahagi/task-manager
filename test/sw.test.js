import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SERVICE_WORKER = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function loadServiceWorker(cacheKeys) {
  const listeners = new Map();
  const deleted = [];
  const context = {
    caches: {
      keys: async () => cacheKeys,
      delete: async (key) => { deleted.push(key); return true; },
      open: async () => ({ addAll: async () => {} }),
    },
    self: {
      addEventListener: (type, handler) => listeners.set(type, handler),
      clients: { claim: async () => {} },
      location: { origin: 'https://taskboard.test' },
    },
  };
  vm.runInNewContext(SERVICE_WORKER, context);
  return { listeners, deleted };
}

test('service worker removes the previous shell cache after a shell release', async () => {
  const { listeners, deleted } = loadServiceWorker(['taskboard-shell-v4']);
  let activation;
  listeners.get('activate')({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(deleted, ['taskboard-shell-v4']);
});
