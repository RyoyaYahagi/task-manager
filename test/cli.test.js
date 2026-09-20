import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tm.js');

describe('tm cli', () => {
  let s;
  before(async () => { s = await startServer(); });
  after(async () => { await s.close(); });

  const tm = (args, { actor = 'agent', name = 'claude-code', input } = {}) => new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { env: { ...process.env, TM_URL: s.base, TM_ACTOR: actor, TM_ACTOR_NAME: name, NODE_NO_WARNINGS: '1' } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    if (input != null) child.stdin.end(input);
  });
  const tmj = async (args, opts) => { const r = await tm([...args, '--json'], opts); return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null }; };

  test('help and unknown command', async () => {
    const h = await tm(['--help']);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /tm inbox|inbox/);
    const u = await tm(['frobnicate']);
    assert.equal(u.code, 1);
    assert.match(u.stderr, /unknown command/);
  });

  test('full agent workflow through the CLI', async () => {
    const add = await tmj(['add', 'CLI task', '--project', 'demo', '--priority', '3', '--due', '2030-01-01', '--tags', 'a,b', '--criteria', 'first', '--criteria', 'second'], { actor: 'human', name: 'ryoya' });
    assert.equal(add.code, 0);
    const id = add.json.id;
    assert.equal(add.json.priority, 3);
    assert.equal(add.json.project.name, 'demo');
    assert.equal(add.json.crit_total, 2);

    assert.equal((await tm(['handoff', String(id), 'please do it'], { actor: 'human', name: 'ryoya' })).code, 0);
    const inbox = await tmj(['inbox']);
    assert.equal(inbox.json.length, 1);
    assert.equal(inbox.json[0].id, id);
    const inboxText = await tm(['inbox']);
    assert.match(inboxText.stdout, /waiting_agent/);

    const start = await tmj(['start', String(id)]);
    assert.equal(start.json.status, 'in_progress');
    assert.equal(start.json.worker, 'claude-code');
    const conflict = await tm(['start', String(id)], { name: 'codex' });
    assert.equal(conflict.code, 4);
    assert.match(conflict.stderr, /already being worked on/);

    const show = await tm(['show', String(id)]);
    assert.match(show.stdout, /CRITERIA \(0\/2\)/);
    assert.match(show.stdout, /1\. \[ \] first/);

    const doneFail = await tm(['done', String(id), 'finished']);
    assert.equal(doneFail.code, 3);
    assert.match(doneFail.stderr, /unmet criteria/);
    assert.match(doneFail.stderr, /- second/);

    assert.equal((await tm(['check', String(id), '1'])).code, 0);
    assert.equal((await tm(['note', String(id), '-'], { input: 'progress from stdin\nline 2' })).code, 0);
    const ask = await tmj(['ask', String(id), 'which option?']);
    assert.equal(ask.json.task.status, 'waiting_human');
    assert.equal(ask.json.task.waiting_reason, 'question');
    assert.equal((await tm(['handoff', String(id), 'option B'], { actor: 'human', name: 'ryoya' })).code, 0);
    assert.equal((await tm(['check', String(id), 'all'])).code, 0);
    const done = await tmj(['done', String(id), 'all good, verified by tests']);
    assert.equal(done.code, 0);
    assert.equal(done.json.task.status, 'done');

    const notes = await tmj(['notes', String(id)]);
    assert.equal(notes.json.length, 5);
    assert.ok(notes.json.some((n) => n.body === 'progress from stdin\nline 2'));

    const rm = await tm(['rm', String(id)]);
    assert.equal(rm.code, 2);
    assert.match(rm.stderr, /agents cannot delete/);
  });

  test('attach, files, history, activity, revert, export', async () => {
    const t = (await tmj(['add', 'files task'], { actor: 'human', name: 'ryoya' })).json;
    const dir = mkdtempSync(path.join(tmpdir(), 'tm-cli-'));
    const p = path.join(dir, 'mock.html');
    writeFileSync(p, '<h1>mock</h1>');
    const att = await tmj(['attach', String(t.id), p, '--as', 'renamed.html']);
    assert.equal(att.code, 0);
    assert.equal(att.json.name, 'renamed.html');
    assert.equal(att.json.mime, 'text/html');
    const files = await tmj(['files', String(t.id)]);
    assert.equal(files.json.length, 1);

    await tm(['edit', String(t.id), '--title', 'renamed task', '--priority', '4']);
    const hist = await tmj(['history', String(t.id)]);
    assert.equal(hist.json[0].action, 'task.update');
    const act = await tmj(['activity', '--by', 'agent', '--since', '1h']);
    assert.ok(act.json.length >= 2);
    const rv = await tmj(['revert', String(hist.json[0].id)]);
    assert.equal(rv.code, 0);
    assert.equal(rv.json.task.title, 'files task');
    const again = await tm(['revert', String(hist.json[0].id)]);
    assert.equal(again.code, 4);

    const exp = await tm(['export']);
    const dump = JSON.parse(exp.stdout);
    assert.ok(dump.tasks.length >= 1);
    assert.ok(dump.files.length >= 1);
  });

  test('ls filters and lanes/projects', async () => {
    const ls = await tmj(['ls', '--project', 'demo']);
    assert.ok(ls.json.every((t) => t.project.name === 'demo'));
    const q = await tmj(['ls', '-q', 'files']);
    assert.ok(q.json.some((t) => t.title === 'files task'));
    assert.equal((await tmj(['lanes'])).json.length, 6);
    assert.ok((await tmj(['projects'])).json.some((p) => p.name === 'demo'));
  });

  test('unreachable server gives a clear error', async () => {
    const r = await new Promise((resolve) => execFile(process.execPath, [BIN, 'inbox'], { env: { ...process.env, TM_URL: 'http://127.0.0.1:1', NODE_NO_WARNINGS: '1' } }, (err, stdout, stderr) => resolve({ code: err?.code, stderr })));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot reach/);
  });
});
