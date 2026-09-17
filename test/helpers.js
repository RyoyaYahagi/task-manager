import { createStore } from '../src/store.js';
import { createApp } from '../src/server.js';
import { loadLanes, loadPolicy } from '../src/lanes.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const HUMAN = { kind: 'human', name: 'ryoya' };
export const AGENT = { kind: 'agent', name: 'claude-code' };
export const OTHER_AGENT = { kind: 'agent', name: 'codex' };

export function makeStore(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tm-test-'));
  const store = createStore({ file: ':memory:', lanes: loadLanes(), policy: opts.policy ?? loadPolicy(), filesDir: path.join(dir, 'files'), ...opts });
  const close = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, close, dir };
}

/** Start an HTTP server on a random port. Returns { base, store, close, api }. */
export async function startServer(opts = {}) {
  const { store, close: closeStore } = makeStore(opts);
  const server = createApp({ store, token: opts.token ?? null });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body, { actor = HUMAN, headers = {}, raw = false } = {}) => {
    const h = { 'x-actor': actor.kind, 'x-actor-name': actor.name, ...headers };
    if (opts.token && !('authorization' in headers)) h.authorization = `Bearer ${opts.token}`;
    let payload;
    if (body !== undefined) { if (raw) payload = body; else { h['content-type'] = 'application/json'; payload = JSON.stringify(body); } }
    const res = await fetch(base + p, { method, headers: h, body: payload });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const close = async () => { await new Promise((r) => server.close(r)); closeStore(); };
  return { base, store, api, close, server };
}
