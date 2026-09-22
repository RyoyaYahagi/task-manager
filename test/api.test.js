import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, HUMAN, AGENT } from './helpers.js';

describe('http api', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.close(); });

  test('health, lanes, meta, static index', async () => {
    assert.equal((await s.api('GET', '/api/health')).data.ok, true);
    assert.equal((await s.api('GET', '/api/lanes')).data.length, 6);
    assert.equal((await s.api('GET', '/api/meta')).data.note_max, 300);
    const res = await fetch(s.base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const nope = await fetch(s.base + '/../package.json');
    assert.notEqual(nope.status, 200);
  });

  test('classification setting is selectable over HTTP', async () => {
    assert.equal((await s.api('GET', '/api/settings')).data.classification_mode, 'off');
    const changed = await s.api('PATCH', '/api/settings', { classification_mode: 'high_confidence' });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.classification_mode, 'high_confidence');
    assert.equal((await s.api('GET', '/api/meta')).data.classification.mode, 'high_confidence');
    assert.equal((await s.api('PATCH', '/api/settings', { classification_mode: 'invalid' })).status, 400);
    assert.equal((await s.api('PATCH', '/api/settings', { classification_mode: 'off' }, { actor: AGENT })).status, 403);
  });

  test('classification endpoints require a configured classifier and human actor', async () => {
    const task = (await s.api('POST', '/api/tasks', { title: 'classification endpoint' })).data;
    assert.equal((await s.api('POST', `/api/tasks/${task.id}/classify`, {}, { actor: AGENT })).status, 403);
    assert.equal((await s.api('POST', `/api/tasks/${task.id}/classify`, {})).status, 503);
    assert.equal((await s.api('POST', '/api/classification/reclassify', {})).status, 503);
  });

  test('task lifecycle over http with actor headers', async () => {
    const c = await s.api('POST', '/api/tasks', { title: 'api task', criteria: ['ok'], project: 'proj' });
    assert.equal(c.status, 201);
    const id = c.data.id;
    assert.equal(c.data.created_by, 'human');

    assert.equal((await s.api('POST', `/api/tasks/${id}/handoff`, { note: 'go' })).data.task.status, 'waiting_agent');
    assert.equal((await s.api('GET', '/api/tasks?status=waiting_agent')).data.length, 1);
    assert.equal((await s.api('POST', `/api/tasks/${id}/start`, {}, { actor: AGENT })).data.worker, 'claude-code');
    const conflict = await s.api('POST', `/api/tasks/${id}/start`, {}, { actor: { kind: 'agent', name: 'other' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'worker_conflict');

    const unmet = await s.api('POST', `/api/tasks/${id}/done`, { note: 'x' }, { actor: AGENT });
    assert.equal(unmet.status, 422);
    assert.equal(unmet.data.unchecked.length, 1);
    const crit = (await s.api('GET', `/api/tasks/${id}/criteria`)).data;
    await s.api('PATCH', `/api/criteria/${crit[0].id}`, { done: true }, { actor: AGENT });
    const done = await s.api('POST', `/api/tasks/${id}/done`, { note: 'finished' }, { actor: AGENT });
    assert.equal(done.status, 200);
    assert.equal(done.data.task.status, 'done');

    const full = (await s.api('GET', `/api/tasks/${id}`)).data;
    assert.equal(full.notes.length, 2);
    assert.equal(full.history[0].action, 'task.done');
    assert.equal(full.history[0].actor_name, 'claude-code');
  });

  test('version conflict returns 409 with current task', async () => {
    const t = (await s.api('POST', '/api/tasks', { title: 'v' })).data;
    await s.api('PATCH', `/api/tasks/${t.id}`, { title: 'v2', version: 1 });
    const r = await s.api('PATCH', `/api/tasks/${t.id}`, { title: 'v3', version: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'version_conflict');
    assert.equal(r.data.current.title, 'v2');
  });

  test('policy violations are 403 with rule', async () => {
    const t = (await s.api('POST', '/api/tasks', { title: 'p' })).data;
    const r = await s.api('DELETE', `/api/tasks/${t.id}`, undefined, { actor: AGENT });
    assert.equal(r.status, 403);
    assert.equal(r.data.rule, 'can_delete_task');
  });

  test('file upload: raw body and multipart; inline html is sandboxed', async () => {
    const t = (await s.api('POST', '/api/tasks', { title: 'files' })).data;
    const raw = await s.api('POST', `/api/tasks/${t.id}/files`, Buffer.from('<h1>hi</h1>'), { raw: true, actor: AGENT, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('モック.html') } });
    assert.equal(raw.status, 201);
    assert.equal(raw.data.name, 'モック.html');
    assert.equal(raw.data.mime, 'text/html');

    const fd = new FormData();
    fd.append('file', new Blob(['png-bytes'], { type: 'image/png' }), 'a.png');
    fd.append('file', new Blob(['txt'], { type: 'text/plain' }), 'b.txt');
    const res = await fetch(`${s.base}/api/tasks/${t.id}/files`, { method: 'POST', body: fd, headers: { 'x-actor': 'human' } });
    assert.equal(res.status, 201);
    const list = await res.json();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((f) => f.name), ['a.png', 'b.txt']);

    const curlish = await s.api('POST', `/api/tasks/${t.id}/files`, Buffer.from('<h1>hi</h1>'), { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-file-name': 'curl.html' } });
    assert.equal(curlish.data.mime, 'text/html', 'a generic request content type must not override the file extension');

    const get = await fetch(`${s.base}/api/files/${raw.data.id}?inline=1`);
    assert.equal(get.status, 200);
    assert.match(get.headers.get('content-type'), /text\/html/);
    assert.match(get.headers.get('content-security-policy'), /sandbox/);
    assert.equal(await get.text(), '<h1>hi</h1>');
    const dl = await fetch(`${s.base}/api/files/${raw.data.id}`);
    assert.match(dl.headers.get('content-disposition'), /^attachment/);

    const empty = await s.api('POST', `/api/tasks/${t.id}/files`, {});
    assert.equal(empty.status, 400);
  });

  test('activity + revert over http', async () => {
    const t = (await s.api('POST', '/api/tasks', { title: 'r1' })).data;
    await s.api('PATCH', `/api/tasks/${t.id}`, { title: 'r2' }, { actor: AGENT });
    const act = (await s.api('GET', `/api/activity?actor=agent&task=${t.id}&since=1h`)).data;
    assert.equal(act.length, 1);
    const rv = await s.api('POST', `/api/history/${act[0].id}/revert`, {});
    assert.equal(rv.status, 200);
    assert.equal(rv.data.task.title, 'r1');
    assert.equal((await s.api('GET', '/api/activity?since=bogus')).status, 400);
  });

  test('SSE streams events', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${s.base}/api/events`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const readUntil = async (pred) => { while (!pred(buf)) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); } };
    await readUntil((b) => b.includes('event: hello'));
    await s.api('POST', '/api/tasks', { title: 'sse task' });
    await readUntil((b) => b.includes('event: task.created'));
    assert.match(buf, /"title":"sse task"/);
    ctrl.abort();
  });

  test('404 / 405 / bad json', async () => {
    assert.equal((await s.api('GET', '/api/nope')).status, 404);
    assert.equal((await s.api('PUT', '/api/lanes')).status, 405);
    const res = await fetch(`${s.base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
  });
});

describe('token auth', () => {
  let s;
  before(async () => { s = await startServer({ token: 'secret' }); });
  after(async () => { await s.close(); });

  test('api requires bearer token; static does not; SSE accepts ?token', async () => {
    assert.equal((await s.api('GET', '/api/board', undefined, { headers: { authorization: '' } })).status, 401);
    assert.equal((await s.api('GET', '/api/board')).status, 200);
    assert.equal((await fetch(s.base + '/')).status, 200);
    const ctrl = new AbortController();
    const res = await fetch(`${s.base}/api/events?token=secret`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    ctrl.abort();
    assert.equal((await fetch(`${s.base}/api/events`)).status, 401);
  });
});
