import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, HUMAN, AGENT, OTHER_AGENT } from './helpers.js';

describe('store', () => {
  let store, close, events;
  beforeEach(() => { events = []; ({ store, close } = makeStore({ onChange: (e) => events.push(e) })); });
  afterEach(() => close());

  test('creates a task with defaults, project auto-created, criteria', () => {
    const t = store.createTask({ title: '  hello ', project: 'demo', criteria: ['a', 'b'], tags: ['x', 'x', ' y '] }, HUMAN);
    assert.equal(t.title, 'hello');
    assert.equal(t.status, 'todo');
    assert.equal(t.assignee, 'both');
    assert.equal(t.priority, 2);
    assert.equal(t.project.name, 'demo');
    assert.deepEqual(t.tags, ['x', 'y']);
    assert.equal(t.crit_total, 2);
    assert.equal(t.version, 1);
    assert.equal(store.listProjects().length, 1);
    assert.ok(events.some((e) => e.type === 'task.created'));
  });

  test('validates fields', () => {
    assert.throws(() => store.createTask({ title: '' }, HUMAN), /title is required/);
    assert.throws(() => store.createTask({ title: 'x', status: 'nope' }, HUMAN), /unknown status/);
    assert.throws(() => store.createTask({ title: 'x', priority: 9 }, HUMAN), /priority/);
    assert.throws(() => store.createTask({ title: 'x', due: '2026-02-30' }, HUMAN), /due/);
    assert.throws(() => store.createTask({ title: 'x', assignee: 'cat' }, HUMAN), /assignee/);
    const t = store.createTask({ title: 'x' }, HUMAN);
    assert.throws(() => store.addNote(t.id, 'a'.repeat(301), HUMAN), /max 300/);
  });

  test('classification mode defaults off, persists in the store, and emits an event', () => {
    assert.deepEqual(store.getSettings(), { classification_mode: 'off' });
    assert.deepEqual(store.updateSettings({ classification_mode: 'high_confidence' }, HUMAN), { classification_mode: 'high_confidence' });
    assert.equal(store.getSettings().classification_mode, 'high_confidence');
    assert.ok(events.some((e) => e.type === 'settings.updated' && e.settings.classification_mode === 'high_confidence'));
    assert.throws(() => store.updateSettings({ classification_mode: 'always' }, HUMAN), /classification_mode/);
  });

  test('classification suggestions are stored on the task and are revertable', () => {
    const t = store.createTask({ title: '候補付きタスク' }, HUMAN);
    const suggestions = [{ kind: 'project', key: 'research', name: '研究・調査', confidence: 0.96 }];
    const updated = store.updateTask(t.id, {}, AGENT, {
      version: t.version,
      action: 'task.auto_classify',
      classificationSuggestions: suggestions,
    });
    assert.deepEqual(updated.classification_suggestions, suggestions);
    assert.deepEqual(store.getTask(t.id).classification_suggestions, suggestions);
    const reverted = store.revert(store.getTask(t.id).history[0].id, AGENT);
    assert.deepEqual(reverted.task.classification_suggestions, []);
  });

  test('optimistic locking rejects stale versions', () => {
    const t = store.createTask({ title: 'x' }, HUMAN);
    store.updateTask(t.id, { title: 'y' }, HUMAN, { version: 1 });
    assert.throws(() => store.updateTask(t.id, { title: 'z' }, HUMAN, { version: 1 }), (e) => e.status === 409 && e.code === 'version_conflict');
    assert.equal(store.getTask(t.id).version, 2);
  });

  test('subtasks are limited to one level', () => {
    const p = store.createTask({ title: 'parent' }, HUMAN);
    const c = store.createTask({ title: 'child', parent_id: p.id }, HUMAN);
    assert.throws(() => store.createTask({ title: 'grandchild', parent_id: c.id }, HUMAN), /one level/);
    assert.throws(() => store.updateTask(p.id, { parent_id: c.id }, HUMAN), /one level/);
    const d = store.createTask({ title: 'other top' }, HUMAN);
    assert.throws(() => store.updateTask(p.id, { parent_id: d.id }, HUMAN), /subtasks cannot become/);
    assert.throws(() => store.updateTask(d.id, { parent_id: d.id }, HUMAN), /own parent/);
    const full = store.getTask(p.id);
    assert.equal(full.subtasks.length, 1);
    assert.equal(full.sub_total, 1);
  });

  test('human → agent → human workflow', () => {
    const t = store.createTask({ title: 'job', criteria: ['c1', 'c2'] }, HUMAN);
    store.handoffTask(t.id, 'please', HUMAN);
    assert.equal(store.getTask(t.id).status, 'waiting_agent');
    assert.equal(store.listTasks({ status: 'waiting_agent' }).length, 1);

    const started = store.startTask(t.id, AGENT);
    assert.equal(started.status, 'in_progress');
    assert.equal(started.worker, 'claude-code');
    assert.throws(() => store.startTask(t.id, OTHER_AGENT), (e) => e.code === 'worker_conflict');
    assert.equal(store.startTask(t.id, OTHER_AGENT, { force: true }).worker, 'codex');

    const asked = store.askTask(t.id, 'A or B?', AGENT);
    assert.equal(asked.task.status, 'waiting_human');
    assert.equal(asked.task.waiting_reason, 'question');
    assert.equal(asked.note.kind, 'question');

    store.handoffTask(t.id, 'B', HUMAN);
    const t2 = store.getTask(t.id);
    assert.equal(t2.status, 'waiting_agent');
    assert.equal(t2.waiting_reason, '');
    assert.equal(t2.worker, '');
  });

  test('done requires all criteria checked and a note; agent can close directly by default', () => {
    const t = store.createTask({ title: 'job', criteria: ['c1', 'c2'] }, HUMAN);
    assert.throws(() => store.doneTask(t.id, { note: '' }, AGENT), /result note is required/);
    assert.throws(() => store.doneTask(t.id, { note: 'ok' }, AGENT), (e) => e.status === 422 && e.unchecked.length === 2);
    const crit = store.listCriteria(t.id);
    store.updateCriterion(crit[0].id, { done: true }, AGENT);
    const partial = store.doneTask(t.id, { note: 'half', partial: true }, AGENT);
    assert.equal(partial.task.status, 'waiting_human');
    assert.equal(partial.task.waiting_reason, 'review');
    assert.equal(partial.unchecked.length, 1);
    store.updateCriterion(crit[1].id, { done: true }, AGENT);
    const done = store.doneTask(t.id, { note: 'all done', partial: false }, AGENT);
    assert.equal(done.task.status, 'done');
    assert.equal(done.note.kind, 'report');
    assert.equal(store.listCriteria(t.id)[1].checked_by_name, 'claude-code');
  });

  test('needs_review sends agent done to waiting_human; human approves', () => {
    const t = store.createTask({ title: 'job', needs_review: true }, HUMAN);
    const r = store.doneTask(t.id, { note: 'done' }, AGENT);
    assert.equal(r.task.status, 'waiting_human');
    assert.equal(r.task.waiting_reason, 'review');
    assert.throws(() => store.approveTask(t.id, AGENT), /only humans/);
    assert.equal(store.approveTask(t.id, HUMAN).status, 'done');
  });

  test('policy can_close_directly=false routes agent done to review', () => {
    close();
    ({ store, close } = makeStore({ policy: { agent: { can_close_directly: false } } }));
    const t = store.createTask({ title: 'job' }, HUMAN);
    assert.equal(store.doneTask(t.id, { note: 'x' }, AGENT).task.status, 'waiting_human');
    assert.throws(() => store.moveTask(t.id, { status: 'done' }, AGENT), (e) => e.status === 403);
    assert.equal(store.moveTask(t.id, { status: 'done' }, HUMAN).status, 'done');
  });

  test('agents cannot delete tasks, edit human notes/criteria, or delete files', () => {
    const t = store.createTask({ title: 'job', criteria: ['human crit'] }, HUMAN);
    const n = store.addNote(t.id, 'human note', HUMAN);
    const an = store.addNote(t.id, 'agent note', AGENT);
    const f = store.addFile(t.id, { name: 'a.txt', mime: 'text/plain', data: Buffer.from('hi') }, HUMAN);
    assert.throws(() => store.deleteTask(t.id, AGENT), (e) => e.status === 403);
    assert.throws(() => store.updateNote(n.id, { body: 'x' }, AGENT), (e) => e.status === 403);
    assert.throws(() => store.deleteNote(n.id, AGENT), (e) => e.status === 403);
    assert.equal(store.updateNote(an.id, { body: 'edited' }, AGENT).body, 'edited');
    const c = store.listCriteria(t.id)[0];
    assert.throws(() => store.updateCriterion(c.id, { text: 'x' }, AGENT), (e) => e.status === 403);
    assert.ok(store.updateCriterion(c.id, { done: true }, AGENT).done, 'agent may check human criteria');
    assert.throws(() => store.deleteFile(f.id, AGENT), (e) => e.status === 403);
    assert.throws(() => store.purge(AGENT), (e) => e.status === 403);
    // human is unrestricted
    store.deleteNote(n.id, HUMAN);
    store.deleteFile(f.id, HUMAN);
    store.deleteTask(t.id, HUMAN);
    assert.throws(() => store.getTask(t.id), (e) => e.status === 404);
    assert.ok(store.getTask(t.id, { includeDeleted: true }).deleted_at);
  });

  test('move reorders within a lane', () => {
    const a = store.createTask({ title: 'a' }, HUMAN);
    const b = store.createTask({ title: 'b' }, HUMAN);
    const c = store.createTask({ title: 'c' }, HUMAN);
    store.moveTask(c.id, { status: 'todo', index: 0 }, HUMAN);
    assert.deepEqual(store.listTasks({ status: 'todo' }).map((t) => t.id), [c.id, a.id, b.id]);
    store.moveTask(a.id, { status: 'in_progress' }, HUMAN);
    assert.deepEqual(store.listTasks({ status: 'todo' }).map((t) => t.id), [c.id, b.id]);
    assert.equal(store.listHistory(a.id)[0].action, 'task.move');
  });

  test('history records actor + diff, revert restores previous state and is itself revertable', () => {
    const t = store.createTask({ title: 'v1', priority: 2 }, HUMAN);
    store.updateTask(t.id, { title: 'v2', priority: 4 }, AGENT);
    const h = store.listHistory(t.id)[0];
    assert.equal(h.action, 'task.update');
    assert.equal(h.actor, 'agent');
    assert.equal(h.actor_name, 'claude-code');
    assert.deepEqual(h.detail.changes.title, ['v1', 'v2']);
    assert.deepEqual(h.detail.changes.priority, [2, 4]);

    const r = store.revert(h.id, HUMAN);
    assert.equal(r.task.title, 'v1');
    assert.equal(r.task.priority, 2);
    assert.equal(r.history.action, 'revert');
    assert.equal(r.history.reverts, h.id);
    assert.equal(store.getHistory(h.id).reverted_by, r.history.id);
    assert.throws(() => store.revert(h.id, HUMAN), (e) => e.code === 'already_reverted');

    const r2 = store.revert(r.history.id, HUMAN);
    assert.equal(r2.task.title, 'v2');
  });

  test('revert conflicts when the field changed since, unless forced', () => {
    const t = store.createTask({ title: 'v1' }, HUMAN);
    store.updateTask(t.id, { title: 'v2' }, AGENT);
    const h = store.listHistory(t.id)[0];
    store.updateTask(t.id, { title: 'v3' }, HUMAN);
    assert.throws(() => store.revert(h.id, HUMAN), (e) => e.code === 'revert_conflict');
    assert.equal(store.revert(h.id, HUMAN, { force: true }).task.title, 'v1');
  });

  test('revert of create/add soft-deletes; revert of delete restores', () => {
    const t = store.createTask({ title: 'x' }, HUMAN);
    const n = store.addNote(t.id, 'note', AGENT);
    const addEntry = store.listHistory(t.id).find((h) => h.action === 'note.add');
    store.revert(addEntry.id, AGENT);
    assert.equal(store.listNotes(t.id).length, 0);
    store.deleteTask(t.id, HUMAN);
    const del = store.listHistory(t.id).find((h) => h.action === 'task.delete');
    store.revert(del.id, HUMAN);
    assert.equal(store.getTask(t.id).deleted_at, null);
    assert.ok(n);
  });

  test('agents may only revert their own actions', () => {
    const t = store.createTask({ title: 'x' }, HUMAN);
    store.updateTask(t.id, { title: 'by human' }, HUMAN);
    const hh = store.listHistory(t.id)[0];
    assert.throws(() => store.revert(hh.id, AGENT), (e) => e.status === 403);
    store.updateTask(t.id, { title: 'by agent' }, AGENT);
    const ha = store.listHistory(t.id)[0];
    assert.throws(() => store.revert(ha.id, OTHER_AGENT), (e) => e.status === 403);
    assert.equal(store.revert(ha.id, AGENT).task.title, 'by human');
    // an agent cannot revert its own task creation (that would be a delete)
    const t2 = store.createTask({ title: 'agent made' }, AGENT);
    const created = store.listHistory(t2.id)[0];
    assert.throws(() => store.revert(created.id, AGENT), (e) => e.status === 403);
  });

  test('activity filters by actor and task', () => {
    const t = store.createTask({ title: 'x' }, HUMAN);
    store.addNote(t.id, 'n', AGENT);
    store.createTask({ title: 'y' }, HUMAN);
    assert.equal(store.activity({ actor: 'agent' }).length, 1);
    assert.equal(store.activity({ task: t.id }).length, 2);
    assert.equal(store.activity({ actor_name: 'ryoya' }).length, 2);
    assert.equal(store.activity({ actor: 'agent' })[0].task_title, 'x');
  });

  test('search, filters, archive and board', () => {
    store.createTask({ title: 'alpha', project: 'p1', tags: ['t1'], due: '2000-01-01', priority: 4 }, HUMAN);
    const b = store.createTask({ title: 'beta', project: 'p2', description: 'has alpha inside' }, HUMAN);
    store.addNote(b.id, 'note mentions gamma', HUMAN);
    assert.equal(store.listTasks({ q: 'alpha' }).length, 2);
    assert.equal(store.listTasks({ q: 'gamma' }).length, 1);
    assert.equal(store.listTasks({ project: 'p1' }).length, 1);
    assert.equal(store.listTasks({ tag: 't1' }).length, 1);
    assert.equal(store.listTasks({ overdue: true }).length, 1);
    assert.equal(store.listTasks({ priority: 4 }).length, 1);
    store.archiveTask(b.id, HUMAN);
    assert.equal(store.listTasks().length, 1);
    assert.equal(store.listTasks({ includeArchived: true }).length, 2);
    const board = store.board();
    assert.equal(board.lanes.length, 6);
    assert.deepEqual(board.tags, ['t1']);
    assert.equal(board.projects.length, 2);
    assert.equal(board.tasks[0].last_note, null);
  });

  test('file mime falls back to the file name when the content type is generic', () => {
    const t = store.createTask({ title: 'x' }, HUMAN);
    // curl's default content type for --data-binary says nothing about the file
    assert.equal(store.addFile(t.id, { name: 'mockup.html', mime: 'application/x-www-form-urlencoded', data: Buffer.from('<h1>x</h1>') }, AGENT).mime, 'text/html');
    assert.equal(store.addFile(t.id, { name: 'a.png', mime: 'application/octet-stream', data: Buffer.from('x') }, AGENT).mime, 'image/png');
    assert.equal(store.addFile(t.id, { name: 'no-extension', mime: '', data: Buffer.from('x') }, AGENT).mime, 'application/octet-stream');
    // an explicit, meaningful content type still wins over the extension
    assert.equal(store.addFile(t.id, { name: 'data.txt', mime: 'text/csv; charset=utf-8', data: Buffer.from('a,b') }, AGENT).mime, 'text/csv');
  });

  test('files are stored on disk and soft-deleted', () => {
    const t = store.createTask({ title: 'x' }, HUMAN);
    const f = store.addFile(t.id, { name: '../evil/mock.html', mime: '', data: Buffer.from('<h1>x</h1>') }, AGENT);
    assert.equal(f.name, 'mock.html');
    assert.equal(f.mime, 'text/html');
    assert.ok(store.filePath(f).endsWith('mock.html'));
    assert.equal(store.getTask(t.id).file_count, 1);
    store.deleteFile(f.id, HUMAN);
    assert.equal(store.listFiles(t.id).length, 0);
    assert.throws(() => store.getFile(f.id), (e) => e.status === 404);
  });

  test('export contains everything', () => {
    const t = store.createTask({ title: 'x', criteria: ['c'] }, HUMAN);
    store.addNote(t.id, 'n', AGENT);
    const dump = store.exportAll();
    assert.equal(dump.tasks.length, 1);
    assert.equal(dump.criteria.length, 1);
    assert.equal(dump.notes.length, 1);
    assert.ok(dump.history.length >= 3);
  });
});
