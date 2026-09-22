// Data layer: SQLite (node:sqlite), validation, audit history, revert, soft delete.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizePolicy, assertAllowed, PolicyError } from './policy.js';

export const ASSIGNEES = ['human', 'agent', 'both'];
export const ACTOR_KINDS = ['human', 'agent'];
export const NOTE_KINDS = ['note', 'question', 'report'];
export const WAITING_REASONS = ['', 'question', 'review'];
export const NOTE_MAX = 300;
export const TITLE_MAX = 200;
export const DESC_MAX = 20000;
export const FILE_MAX = 20 * 1024 * 1024;
export const PRIORITIES = { 1: '低', 2: '中', 3: '高', 4: '緊急' };
export const CLASSIFICATION_MODES = ['off', 'high_confidence'];
export const DEFAULT_SETTINGS = { classification_mode: 'off' };
// Content types that say nothing about the file itself; the file name is more trustworthy.
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-www-form-urlencoded', 'multipart/form-data']);
const PROJECT_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#14b8a6', '#eab308', '#22c55e', '#06b6d4'];

export class StoreError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = extra.code || { 400: 'bad_request', 404: 'not_found', 409: 'conflict', 413: 'too_large', 422: 'unprocessable' }[status] || 'error';
    Object.assign(this, extra);
  }
}
export { PolicyError };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  description TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  waiting_reason TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT 'both',
  priority INTEGER NOT NULL DEFAULT 2,
  due TEXT,
  project_id INTEGER REFERENCES projects(id),
  parent_id INTEGER REFERENCES tasks(id),
  tags TEXT NOT NULL DEFAULT '[]',
  classification_suggestions TEXT NOT NULL DEFAULT '[]',
  worker TEXT NOT NULL DEFAULT '',
  needs_review INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, position);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  text TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  checked_by TEXT,
  checked_by_name TEXT,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS criteria_task ON criteria(task_id);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_task ON notes(task_id);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  path TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS files_task ON files(task_id);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  actor TEXT NOT NULL,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}',
  reverted_by INTEGER,
  reverts INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_task ON history(task_id, id);
CREATE INDEX IF NOT EXISTS history_actor ON history(actor, id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const TABLE = { task: 'tasks', criteria: 'criteria', note: 'notes', file: 'files', project: 'projects' };
const JSON_FIELDS = new Set(['tags', 'classification_suggestions']);
// Fields a revert may write back, per entity.
const REVERTABLE = {
  task: new Set(['title', 'description', 'status', 'waiting_reason', 'assignee', 'priority', 'due', 'project_id', 'parent_id', 'tags', 'classification_suggestions', 'worker', 'needs_review', 'position', 'archived_at', 'deleted_at']),
  criteria: new Set(['text', 'done', 'checked_by', 'checked_by_name', 'checked_at', 'deleted_at', 'position']),
  note: new Set(['body', 'kind', 'deleted_at']),
  file: new Set(['name', 'deleted_at']),
  project: new Set(['name', 'color', 'description', 'archived_at']),
};

const now = () => new Date().toISOString();
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function normalizeActor(a = {}) {
  const kind = ACTOR_KINDS.includes(a.kind) ? a.kind : 'human';
  let name = String(a.name || '').trim().slice(0, 60);
  if (!name) name = kind;
  return { kind, name };
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function cleanTags(tags) {
  if (tags == null) return [];
  if (typeof tags === 'string') tags = tags.split(',');
  if (!Array.isArray(tags)) throw new StoreError(400, 'tags must be an array');
  const out = [];
  for (let t of tags) {
    t = String(t).trim();
    if (!t) continue;
    if (t.length > 30) throw new StoreError(400, 'tag too long (max 30)');
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > 20) throw new StoreError(400, 'too many tags (max 20)');
  return out;
}

function cleanClassificationSuggestions(suggestions) {
  if (suggestions == null) return [];
  if (!Array.isArray(suggestions)) throw new StoreError(400, 'classification_suggestions must be an array');
  return suggestions.slice(0, 20).map((suggestion) => {
    if (!suggestion || typeof suggestion !== 'object') throw new StoreError(400, 'invalid classification suggestion');
    const kind = String(suggestion.kind || '').trim();
    const key = String(suggestion.key || '').trim();
    const name = String(suggestion.name || '').trim();
    const confidence = Number(suggestion.confidence);
    if (!kind || !key || !name || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new StoreError(400, 'invalid classification suggestion');
    }
    return { kind, key, name, confidence };
  });
}

function safeFileName(name) {
  // strip directories and characters that are unsafe in file names
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[<>:"|?*]|[^\P{Cc}]/gu, '_').trim();
  return (base || 'file').slice(0, 150);
}

export function guessMime(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return {
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', zip: 'application/zip', webmanifest: 'application/manifest+json',
    ico: 'image/x-icon', woff2: 'font/woff2', mp4: 'video/mp4', mp3: 'audio/mpeg',
  }[ext] || 'application/octet-stream';
}

export function createStore({ file = ':memory:', lanes, policy = {}, filesDir = null, onChange = () => {} } = {}) {
  if (!lanes || !lanes.length) throw new Error('lanes required');
  const laneIds = lanes.map((l) => l.id);
  policy = normalizePolicy(policy);
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  if (filesDir) mkdirSync(filesDir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA);
  const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((column) => column.name);
  if (!taskColumns.includes('classification_suggestions')) {
    db.exec("ALTER TABLE tasks ADD COLUMN classification_suggestions TEXT NOT NULL DEFAULT '[]'");
  }

  const q = (sql) => db.prepare(sql);
  const get = (sql, ...p) => q(sql).get(...p);
  const all = (sql, ...p) => q(sql).all(...p);
  const run = (sql, ...p) => q(sql).run(...p);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    run('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)', key, value, now());
  }

  function tx(fn) {
    db.exec('BEGIN');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const listeners = new Set();
  if (typeof onChange === 'function') listeners.add(onChange);
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  const pendingEvents = [];
  function emit(type, payload) {
    pendingEvents.push({ type, ...payload, at: now() });
  }
  function flush() {
    while (pendingEvents.length) {
      const ev = pendingEvents.shift();
      for (const fn of listeners) { try { fn(ev); } catch { /* ignore listener errors */ } }
    }
  }
  // Wrap a mutation: run inside a transaction, flush events after commit.
  function mutate(fn) {
    try {
      const r = tx(fn);
      flush();
      return r;
    } catch (e) {
      pendingEvents.length = 0;
      throw e;
    }
  }

  function log(actor, action, entity, entityId, taskId, detail, reverts = null) {
    const r = run(
      'INSERT INTO history (task_id, actor, actor_name, action, entity, entity_id, detail, reverts, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      taskId, actor.kind, actor.name, action, entity, entityId, JSON.stringify(detail), reverts, now(),
    );
    return num(r.lastInsertRowid);
  }

  // ---------- projects ----------
  const rowToProject = (r) => r && { ...r, id: num(r.id) };

  function listProjects({ includeArchived = false } = {}) {
    return all(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY name`).map(rowToProject);
  }
  function getProject(id) {
    const p = rowToProject(get('SELECT * FROM projects WHERE id = ?', id));
    if (!p) throw new StoreError(404, `project ${id} not found`);
    return p;
  }
  function resolveProjectId(ref, actor, { create = true } = {}) {
    if (ref == null || ref === '') return null;
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) return getProject(Number(ref)).id;
    const name = String(ref).trim();
    if (!name) return null;
    const found = rowToProject(get('SELECT * FROM projects WHERE name = ?', name));
    if (found) return found.id;
    if (!create) throw new StoreError(404, `project "${name}" not found`);
    return createProjectRaw({ name }, actor).id;
  }
  function createProjectRaw(input, actor) {
    const name = String(input.name || '').trim();
    if (!name || name.length > 60) throw new StoreError(400, 'project name is required (max 60)');
    if (get('SELECT id FROM projects WHERE name = ?', name)) throw new StoreError(409, `project "${name}" already exists`);
    const color = input.color || PROJECT_COLORS[num(get('SELECT COUNT(*) AS c FROM projects').c) % PROJECT_COLORS.length];
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new StoreError(400, 'color must be #rrggbb');
    const r = run('INSERT INTO projects (name, color, description, created_at) VALUES (?,?,?,?)', name, color, String(input.description || ''), now());
    const p = getProject(num(r.lastInsertRowid));
    log(actor, 'project.create', 'project', p.id, null, { snapshot: p });
    emit('project.created', { project: p });
    return p;
  }
  function createProject(input, actor) {
    actor = normalizeActor(actor);
    return mutate(() => createProjectRaw(input, actor));
  }
  function updateProject(id, patch, actor) {
    actor = normalizeActor(actor);
    const before = getProject(id);
    const changes = {};
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name || name.length > 60) throw new StoreError(400, 'invalid name');
      if (name !== before.name && get('SELECT id FROM projects WHERE name = ?', name)) throw new StoreError(409, 'name already exists');
      if (name !== before.name) changes.name = [before.name, name];
    }
    if (patch.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new StoreError(400, 'color must be #rrggbb');
      if (patch.color !== before.color) changes.color = [before.color, patch.color];
    }
    if (patch.description !== undefined && String(patch.description) !== before.description) changes.description = [before.description, String(patch.description)];
    if (patch.archived !== undefined) {
      const v = patch.archived ? now() : null;
      if (!!v !== !!before.archived_at) changes.archived_at = [before.archived_at, v];
    }
    if (!Object.keys(changes).length) return before;
    return mutate(() => {
      applyChanges('project', id, changes);
      const p = getProject(id);
      log(actor, 'project.update', 'project', id, null, { changes });
      emit('project.updated', { project: p });
      return p;
    });
  }

  // ---------- settings ----------
  function getSettings() {
    const settings = { ...DEFAULT_SETTINGS };
    for (const row of all('SELECT key, value FROM settings')) {
      if (row.key === 'classification_mode' && CLASSIFICATION_MODES.includes(row.value)) settings[row.key] = row.value;
    }
    return settings;
  }

  function updateSettings(patch, actor) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can change settings');
    return mutate(() => {
      if (patch?.classification_mode === undefined) return getSettings();
      const mode = String(patch.classification_mode);
      if (!CLASSIFICATION_MODES.includes(mode)) throw new StoreError(400, `classification_mode must be ${CLASSIFICATION_MODES.join('|')}`);
      const before = getSettings();
      if (before.classification_mode === mode) return before;
      run('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', mode, now(), 'classification_mode');
      const settings = getSettings();
      emit('settings.updated', { settings });
      return settings;
    });
  }

  // ---------- tasks ----------
  function rowToTask(r) {
    if (!r) return null;
    const t = { ...r };
    for (const k of ['id', 'project_id', 'parent_id', 'priority', 'position', 'version', 'needs_review', 'note_count', 'sub_total', 'sub_done', 'crit_total', 'crit_done', 'file_count']) {
      if (t[k] != null) t[k] = num(t[k]);
    }
    t.tags = JSON.parse(t.tags || '[]');
    t.classification_suggestions = JSON.parse(t.classification_suggestions || '[]');
    t.needs_review = !!t.needs_review;
    if ('last_note_body' in t) {
      t.last_note = t.last_note_body == null ? null : { body: t.last_note_body, author: t.last_note_author, author_name: t.last_note_author_name, kind: t.last_note_kind, created_at: t.last_note_at };
      delete t.last_note_body; delete t.last_note_author; delete t.last_note_author_name; delete t.last_note_kind; delete t.last_note_at;
    }
    if ('project_name' in t) {
      t.project = t.project_name == null ? null : { id: t.project_id, name: t.project_name, color: t.project_color };
      delete t.project_name; delete t.project_color;
    }
    return t;
  }

  const TASK_SELECT = `
    SELECT t.*, p.name AS project_name, p.color AS project_color,
      (SELECT COUNT(*) FROM notes n WHERE n.task_id = t.id AND n.deleted_at IS NULL) AS note_count,
      (SELECT COUNT(*) FROM files f WHERE f.task_id = t.id AND f.deleted_at IS NULL) AS file_count,
      (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.archived_at IS NULL) AS sub_total,
      (SELECT COUNT(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.archived_at IS NULL AND s.status = 'done') AS sub_done,
      (SELECT COUNT(*) FROM criteria c WHERE c.task_id = t.id AND c.deleted_at IS NULL) AS crit_total,
      (SELECT COUNT(*) FROM criteria c WHERE c.task_id = t.id AND c.deleted_at IS NULL AND c.done = 1) AS crit_done,
      ln.body AS last_note_body, ln.author AS last_note_author, ln.author_name AS last_note_author_name, ln.kind AS last_note_kind, ln.created_at AS last_note_at
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN notes ln ON ln.id = (SELECT id FROM notes WHERE task_id = t.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)
  `;

  function getTaskRow(id, { includeDeleted = false } = {}) {
    const t = rowToTask(get(`${TASK_SELECT} WHERE t.id = ?`, id));
    if (!t || (!includeDeleted && t.deleted_at)) throw new StoreError(404, `task ${id} not found`);
    return t;
  }

  function listTasks(f = {}) {
    const where = [];
    const params = [];
    if (!f.includeDeleted) where.push('t.deleted_at IS NULL');
    if (!f.includeArchived) where.push('t.archived_at IS NULL');
    if (f.status) { where.push('t.status = ?'); params.push(f.status); }
    if (f.assignee) { where.push('t.assignee = ?'); params.push(f.assignee); }
    if (f.priority) { where.push('t.priority = ?'); params.push(Number(f.priority)); }
    if (f.project) {
      if (/^\d+$/.test(String(f.project))) { where.push('t.project_id = ?'); params.push(Number(f.project)); }
      else { where.push('p.name = ?'); params.push(String(f.project)); }
    }
    if (f.parent !== undefined && f.parent !== null && f.parent !== '') { where.push('t.parent_id = ?'); params.push(Number(f.parent)); }
    if (f.topLevel) where.push('t.parent_id IS NULL');
    if (f.tag) { where.push('t.tags LIKE ?'); params.push(`%${JSON.stringify(String(f.tag))}%`); }
    if (f.overdue) { where.push("t.due IS NOT NULL AND t.due < ? AND t.status != 'done'"); params.push(new Date().toISOString().slice(0, 10)); }
    if (f.q) {
      const like = `%${String(f.q)}%`;
      where.push('(t.title LIKE ? OR t.description LIKE ? OR t.tags LIKE ? OR p.name LIKE ? OR EXISTS (SELECT 1 FROM notes n WHERE n.task_id = t.id AND n.deleted_at IS NULL AND n.body LIKE ?))');
      params.push(like, like, like, like, like);
    }
    const sql = `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.status, t.position, t.id`;
    return all(sql, ...params).map(rowToTask);
  }

  function validateTaskFields(input, actor, { partial = false, existing = null } = {}) {
    const out = {};
    if (input.title !== undefined || !partial) {
      const title = String(input.title ?? '').trim();
      if (!title) throw new StoreError(400, 'title is required');
      if (title.length > TITLE_MAX) throw new StoreError(400, `title too long (max ${TITLE_MAX})`);
      out.title = title;
    }
    if (input.description !== undefined) {
      const d = String(input.description ?? '');
      if (d.length > DESC_MAX) throw new StoreError(400, `description too long (max ${DESC_MAX})`);
      out.description = d;
    }
    if (input.status !== undefined) {
      if (!laneIds.includes(input.status)) throw new StoreError(400, `unknown status "${input.status}" (lanes: ${laneIds.join(', ')})`);
      out.status = input.status;
    }
    if (input.waiting_reason !== undefined) {
      if (!WAITING_REASONS.includes(input.waiting_reason)) throw new StoreError(400, 'waiting_reason must be question|review|""');
      out.waiting_reason = input.waiting_reason;
    }
    if (input.assignee !== undefined) {
      if (!ASSIGNEES.includes(input.assignee)) throw new StoreError(400, 'assignee must be human|agent|both');
      out.assignee = input.assignee;
    }
    if (input.priority !== undefined) {
      const p = Number(input.priority);
      if (!Number.isInteger(p) || p < 1 || p > 4) throw new StoreError(400, 'priority must be 1..4');
      out.priority = p;
    }
    if (input.due !== undefined) {
      if (input.due === null || input.due === '') out.due = null;
      else if (!isValidDate(String(input.due))) throw new StoreError(400, 'due must be YYYY-MM-DD');
      else out.due = String(input.due);
    }
    if (input.project !== undefined || input.project_id !== undefined) {
      out.project_id = resolveProjectId(input.project_id ?? input.project, actor);
    }
    if (input.parent_id !== undefined) {
      if (input.parent_id === null || input.parent_id === '') out.parent_id = null;
      else {
        const pid = Number(input.parent_id);
        const parent = rowToTask(get('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL', pid));
        if (!parent) throw new StoreError(404, `parent task ${pid} not found`);
        if (parent.parent_id) throw new StoreError(400, 'subtasks can only be one level deep');
        if (existing && existing.id === pid) throw new StoreError(400, 'a task cannot be its own parent');
        if (existing && num(get('SELECT COUNT(*) AS c FROM tasks WHERE parent_id = ? AND deleted_at IS NULL', existing.id).c) > 0) {
          throw new StoreError(400, 'a task with subtasks cannot become a subtask');
        }
        out.parent_id = pid;
      }
    }
    if (input.tags !== undefined) out.tags = cleanTags(input.tags);
    if (input.needs_review !== undefined) out.needs_review = input.needs_review ? 1 : 0;
    if (input.worker !== undefined) out.worker = String(input.worker ?? '').slice(0, 60);
    return out;
  }

  function nextPosition(status) {
    const r = get('SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE status = ? AND deleted_at IS NULL', status);
    return num(r.m) + 1;
  }

  function createTask(input, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const f = validateTaskFields(input, actor);
      f.status ??= laneIds[0];
      const ts = now();
      const r = run(
        `INSERT INTO tasks (title, description, status, waiting_reason, assignee, priority, due, project_id, parent_id, tags, worker, needs_review, position, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.title, f.description ?? '', f.status, f.waiting_reason ?? '', f.assignee ?? 'both', f.priority ?? 2, f.due ?? null,
        f.project_id ?? null, f.parent_id ?? null, JSON.stringify(f.tags ?? []), f.worker ?? '', f.needs_review ?? 0,
        nextPosition(f.status), actor.kind, ts, ts,
      );
      const id = num(r.lastInsertRowid);
      if (Array.isArray(input.criteria)) {
        for (const text of input.criteria) addCriterionRaw(id, text, actor);
      }
      const t = getTaskRow(id);
      log(actor, 'task.create', 'task', id, id, { snapshot: t });
      emit('task.created', { task_id: id, task: t });
      return t;
    });
  }

  function diffTask(before, f) {
    const changes = {};
    for (const [k, v] of Object.entries(f)) {
      const oldV = k === 'needs_review' ? (before[k] ? 1 : 0) : before[k];
      if (!eq(oldV, v)) changes[k] = [oldV, v];
    }
    return changes;
  }

  function applyChanges(entity, id, changes) {
    const table = TABLE[entity];
    const sets = [];
    const params = [];
    for (const [k, [, newV]] of Object.entries(changes)) {
      if (!REVERTABLE[entity].has(k)) throw new StoreError(400, `field ${k} is not writable`);
      sets.push(`${k} = ?`);
      params.push(JSON_FIELDS.has(k) ? JSON.stringify(newV) : newV);
    }
    if (!sets.length) return;
    if (entity === 'task') { sets.push('version = version + 1', 'updated_at = ?'); params.push(now()); }
    else if (entity === 'criteria' || entity === 'note') { sets.push('updated_at = ?'); params.push(now()); }
    params.push(id);
    run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, ...params);
  }

  // Core task mutation used by update/move/start/done/etc. Records history + event.
  function commitTaskChanges(before, changes, actor, action, extraDetail = {}) {
    if (!Object.keys(changes).length) return before;
    applyChanges('task', before.id, changes);
    const t = getTaskRow(before.id, { includeDeleted: true });
    log(actor, action, 'task', before.id, before.id, { changes, ...extraDetail });
    emit(changes.deleted_at?.[1] ? 'task.deleted' : 'task.updated', { task_id: before.id, task: t, action, changes });
    return t;
  }

  function assertVersion(task, version) {
    if (version != null && version !== '' && Number(version) !== task.version) {
      throw new StoreError(409, `task ${task.id} was modified by someone else (version is now ${task.version})`, { code: 'version_conflict', current: task });
    }
  }

  function updateTask(id, patch, actor, { version = patch.version, action = null, extraDetail = {}, classificationSuggestions } = {}) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      const f = validateTaskFields(patch, actor, { partial: true, existing: before });
      if (classificationSuggestions !== undefined) f.classification_suggestions = cleanClassificationSuggestions(classificationSuggestions);
      if (f.status !== undefined && f.status !== before.status) {
        if (f.status === 'done') assertAllowed(policy, actor, 'can_close_directly', 'agents cannot close tasks directly');
        f.position = nextPosition(f.status);
        if (f.status !== 'waiting_human' && f.waiting_reason === undefined) f.waiting_reason = '';
        if ((f.status === 'done' || f.status === 'waiting_agent') && f.worker === undefined) f.worker = '';
      }
      const changes = diffTask(before, f);
      const historyAction = action || (changes.status ? 'task.move' : 'task.update');
      return commitTaskChanges(before, changes, actor, historyAction, extraDetail);
    });
  }

  function moveTask(id, { status, index, waiting_reason, version } = {}, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      status ??= before.status;
      if (!laneIds.includes(status)) throw new StoreError(400, `unknown status "${status}"`);
      if (status === 'done' && before.status !== 'done') assertAllowed(policy, actor, 'can_close_directly', 'agents cannot close tasks directly');
      if (waiting_reason !== undefined && !WAITING_REASONS.includes(waiting_reason)) throw new StoreError(400, 'invalid waiting_reason');
      const others = all('SELECT id FROM tasks WHERE status = ? AND deleted_at IS NULL AND archived_at IS NULL AND id != ? ORDER BY position, id', status, id).map((r) => num(r.id));
      const idx = index == null ? others.length : Math.max(0, Math.min(Number(index), others.length));
      others.splice(idx, 0, id);
      others.forEach((tid, i) => { if (tid !== id) run('UPDATE tasks SET position = ? WHERE id = ?', i + 1, tid); });
      const f = { status, position: idx + 1 };
      if (status !== 'waiting_human') f.waiting_reason = '';
      else if (waiting_reason !== undefined) f.waiting_reason = waiting_reason;
      if ((status === 'done' || status === 'waiting_agent') && status !== before.status) f.worker = '';
      const changes = diffTask(before, f);
      const action = changes.status ? 'task.move' : 'task.reorder';
      return commitTaskChanges(before, changes, actor, action);
    });
  }

  function startTask(id, actor, { force = false, version } = {}) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      if (before.worker && before.worker !== actor.name && !force) {
        throw new StoreError(409, `task ${id} is already being worked on by "${before.worker}" (use --force to take over)`, { code: 'worker_conflict', current: before });
      }
      const f = { status: 'in_progress', worker: actor.name, waiting_reason: '' };
      if (before.status !== 'in_progress') f.position = nextPosition('in_progress');
      return commitTaskChanges(before, diffTask(before, f), actor, 'task.start');
    });
  }

  function transition(id, actor, { version, status, waiting_reason, note, kind, action, clearWorker }) {
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      const noteRow = note ? addNoteRaw(id, note, actor, kind) : null;
      const f = { status, waiting_reason, position: before.status === status ? before.position : nextPosition(status) };
      if (clearWorker) f.worker = '';
      const t = commitTaskChanges(before, diffTask(before, f), actor, action);
      return { task: t, note: noteRow };
    });
  }

  function askTask(id, question, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (!String(question || '').trim()) throw new StoreError(400, 'a question is required');
    return transition(id, actor, { version, status: 'waiting_human', waiting_reason: 'question', note: question, kind: 'question', action: 'task.ask' });
  }
  function handoffTask(id, noteBody, actor, { version } = {}) {
    actor = normalizeActor(actor);
    return transition(id, actor, { version, status: 'waiting_agent', waiting_reason: '', note: noteBody, kind: 'note', action: 'task.handoff', clearWorker: true });
  }
  function holdTask(id, noteBody, actor, { version } = {}) {
    actor = normalizeActor(actor);
    return transition(id, actor, { version, status: 'on_hold', waiting_reason: '', note: noteBody, kind: 'note', action: 'task.hold' });
  }

  function doneTask(id, { note, partial = false, version } = {}, actor) {
    actor = normalizeActor(actor);
    const body = String(note || '').trim();
    if (!body) throw new StoreError(400, 'a result note is required (what changed, how it was verified)');
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      const unchecked = all('SELECT id, text FROM criteria WHERE task_id = ? AND deleted_at IS NULL AND done = 0 ORDER BY position, id', id).map((r) => ({ id: num(r.id), text: r.text }));
      if (unchecked.length && !partial) {
        throw new StoreError(422, `task ${id} has ${unchecked.length} unmet criteria; check them (tm check) or report --partial`, { code: 'criteria_unmet', unchecked });
      }
      let target = 'done';
      if (partial || before.needs_review) target = 'waiting_human';
      else if (actor.kind === 'agent' && !policy.agent.can_close_directly) target = 'waiting_human';
      const noteRow = addNoteRaw(id, body, actor, 'report');
      const f = { status: target, waiting_reason: target === 'waiting_human' ? 'review' : '', worker: '', position: nextPosition(target) };
      const t = commitTaskChanges(before, diffTask(before, f), actor, 'task.done', { partial, unchecked });
      return { task: t, note: noteRow, unchecked };
    });
  }

  function approveTask(id, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can approve');
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      const f = { status: 'done', waiting_reason: '', worker: '', position: nextPosition('done') };
      return commitTaskChanges(before, diffTask(before, f), actor, 'task.approve');
    });
  }

  function archiveTask(id, actor, archived = true) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getTaskRow(id);
      const v = archived ? now() : null;
      if (!!before.archived_at === !!v) return before;
      return commitTaskChanges(before, { archived_at: [before.archived_at, v] }, actor, archived ? 'task.archive' : 'task.unarchive');
    });
  }

  function deleteTask(id, actor) {
    actor = normalizeActor(actor);
    assertAllowed(policy, actor, 'can_delete_task', 'agents cannot delete tasks');
    return mutate(() => {
      const before = getTaskRow(id);
      return commitTaskChanges(before, { deleted_at: [null, now()] }, actor, 'task.delete');
    });
  }

  function restoreTask(id, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getTaskRow(id, { includeDeleted: true });
      if (!before.deleted_at) return before;
      return commitTaskChanges(before, { deleted_at: [before.deleted_at, null] }, actor, 'task.restore');
    });
  }

  function purge(actor) {
    actor = normalizeActor(actor);
    assertAllowed(policy, actor, 'can_purge', 'agents cannot purge');
    return mutate(() => {
      const ids = all('SELECT id FROM tasks WHERE deleted_at IS NOT NULL').map((r) => num(r.id));
      for (const id of ids) {
        for (const f of all('SELECT path FROM files WHERE task_id = ?', id)) removeFile(f.path);
        run('DELETE FROM files WHERE task_id = ?', id);
        run('DELETE FROM notes WHERE task_id = ?', id);
        run('DELETE FROM criteria WHERE task_id = ?', id);
        run('DELETE FROM history WHERE task_id = ?', id);
        run('UPDATE tasks SET parent_id = NULL WHERE parent_id = ?', id);
        run('DELETE FROM tasks WHERE id = ?', id);
        emit('task.purged', { task_id: id });
      }
      for (const f of all('SELECT * FROM files WHERE deleted_at IS NOT NULL')) { removeFile(f.path); run('DELETE FROM files WHERE id = ?', f.id); }
      run('DELETE FROM notes WHERE deleted_at IS NOT NULL');
      run('DELETE FROM criteria WHERE deleted_at IS NOT NULL');
      log(actor, 'purge', 'task', null, null, { tasks: ids });
      return { purged: ids };
    });
  }

  // ---------- criteria ----------
  const rowToCriterion = (r) => r && { ...r, id: num(r.id), task_id: num(r.task_id), position: num(r.position), done: !!num(r.done) };
  function listCriteria(taskId, { includeDeleted = false } = {}) {
    return all(`SELECT * FROM criteria WHERE task_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY position, id`, taskId).map(rowToCriterion);
  }
  function getCriterion(id) {
    const c = rowToCriterion(get('SELECT * FROM criteria WHERE id = ?', id));
    if (!c || c.deleted_at) throw new StoreError(404, `criterion ${id} not found`);
    return c;
  }
  function addCriterionRaw(taskId, text, actor) {
    text = String(text || '').trim();
    if (!text) throw new StoreError(400, 'criterion text is required');
    if (text.length > 300) throw new StoreError(400, 'criterion too long (max 300)');
    const ts = now();
    const pos = num(get('SELECT COALESCE(MAX(position),0) AS m FROM criteria WHERE task_id = ?', taskId).m) + 1;
    const r = run('INSERT INTO criteria (task_id, text, position, author, author_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', taskId, text, pos, actor.kind, actor.name, ts, ts);
    const c = getCriterion(num(r.lastInsertRowid));
    log(actor, 'criteria.add', 'criteria', c.id, taskId, { snapshot: c });
    emit('criteria.created', { task_id: taskId, criterion: c });
    return c;
  }
  function addCriterion(taskId, text, actor) {
    actor = normalizeActor(actor);
    return mutate(() => { getTaskRow(taskId); return addCriterionRaw(taskId, text, actor); });
  }
  function updateCriterion(id, patch, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getCriterion(id);
      const changes = {};
      if (patch.text !== undefined) {
        if (before.author === 'human') assertAllowed(policy, actor, 'can_edit_human_criteria', 'agents cannot edit criteria written by humans');
        const text = String(patch.text).trim();
        if (!text || text.length > 300) throw new StoreError(400, 'invalid criterion text');
        if (text !== before.text) changes.text = [before.text, text];
      }
      if (patch.done !== undefined) {
        const d = patch.done ? 1 : 0;
        if (d !== (before.done ? 1 : 0)) {
          changes.done = [before.done ? 1 : 0, d];
          changes.checked_by = [before.checked_by, d ? actor.kind : null];
          changes.checked_by_name = [before.checked_by_name, d ? actor.name : null];
          changes.checked_at = [before.checked_at, d ? now() : null];
        }
      }
      if (!Object.keys(changes).length) return before;
      applyChanges('criteria', id, changes);
      const c = getCriterion(id);
      log(actor, changes.done ? 'criteria.check' : 'criteria.edit', 'criteria', id, before.task_id, { changes });
      emit('criteria.updated', { task_id: before.task_id, criterion: c });
      return c;
    });
  }
  function deleteCriterion(id, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getCriterion(id);
      if (before.author === 'human') assertAllowed(policy, actor, 'can_edit_human_criteria', 'agents cannot delete criteria written by humans');
      const changes = { deleted_at: [null, now()] };
      applyChanges('criteria', id, changes);
      log(actor, 'criteria.delete', 'criteria', id, before.task_id, { changes, snapshot: before });
      emit('criteria.deleted', { task_id: before.task_id, criterion_id: id });
      return { ok: true };
    });
  }

  // ---------- notes ----------
  const rowToNote = (r) => r && { ...r, id: num(r.id), task_id: num(r.task_id) };
  function listNotes(taskId, { includeDeleted = false } = {}) {
    return all(`SELECT * FROM notes WHERE task_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY id`, taskId).map(rowToNote);
  }
  function getNote(id) {
    const n = rowToNote(get('SELECT * FROM notes WHERE id = ?', id));
    if (!n || n.deleted_at) throw new StoreError(404, `note ${id} not found`);
    return n;
  }
  function addNoteRaw(taskId, body, actor, kind = 'note') {
    body = String(body || '').trim();
    if (!body) throw new StoreError(400, 'note body is required');
    if (body.length > NOTE_MAX) throw new StoreError(400, `note too long (max ${NOTE_MAX} chars, got ${body.length})`);
    if (!NOTE_KINDS.includes(kind)) throw new StoreError(400, 'invalid note kind');
    const ts = now();
    const r = run('INSERT INTO notes (task_id, author, author_name, body, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', taskId, actor.kind, actor.name, body, kind, ts, ts);
    const n = getNote(num(r.lastInsertRowid));
    log(actor, 'note.add', 'note', n.id, taskId, { snapshot: n });
    emit('note.created', { task_id: taskId, note: n });
    return n;
  }
  function addNote(taskId, body, actor, kind = 'note') {
    actor = normalizeActor(actor);
    return mutate(() => { getTaskRow(taskId); return addNoteRaw(taskId, body, actor, kind); });
  }
  function updateNote(id, patch, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getNote(id);
      if (before.author === 'human') assertAllowed(policy, actor, 'can_edit_human_notes', 'agents cannot edit notes written by humans');
      const changes = {};
      if (patch.body !== undefined) {
        const body = String(patch.body).trim();
        if (!body) throw new StoreError(400, 'note body is required');
        if (body.length > NOTE_MAX) throw new StoreError(400, `note too long (max ${NOTE_MAX})`);
        if (body !== before.body) changes.body = [before.body, body];
      }
      if (patch.kind !== undefined) {
        if (!NOTE_KINDS.includes(patch.kind)) throw new StoreError(400, 'invalid note kind');
        if (patch.kind !== before.kind) changes.kind = [before.kind, patch.kind];
      }
      if (!Object.keys(changes).length) return before;
      applyChanges('note', id, changes);
      const n = getNote(id);
      log(actor, 'note.edit', 'note', id, before.task_id, { changes });
      emit('note.updated', { task_id: before.task_id, note: n });
      return n;
    });
  }
  function deleteNote(id, actor) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const before = getNote(id);
      if (before.author === 'human') assertAllowed(policy, actor, 'can_edit_human_notes', 'agents cannot delete notes written by humans');
      const changes = { deleted_at: [null, now()] };
      applyChanges('note', id, changes);
      log(actor, 'note.delete', 'note', id, before.task_id, { changes, snapshot: before });
      emit('note.deleted', { task_id: before.task_id, note_id: id });
      return { ok: true };
    });
  }

  // ---------- files ----------
  const rowToFile = (r) => r && { ...r, id: num(r.id), task_id: num(r.task_id), size: num(r.size) };
  function listFiles(taskId, { includeDeleted = false } = {}) {
    return all(`SELECT * FROM files WHERE task_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY id`, taskId).map(rowToFile);
  }
  function getFile(id, { includeDeleted = false } = {}) {
    const f = rowToFile(get('SELECT * FROM files WHERE id = ?', id));
    if (!f || (!includeDeleted && f.deleted_at)) throw new StoreError(404, `file ${id} not found`);
    return f;
  }
  function filePath(f) { return filesDir ? path.join(filesDir, f.path) : null; }
  function removeFile(rel) { if (filesDir) rmSync(path.join(filesDir, rel), { force: true }); }
  function addFile(taskId, { name, mime, data }, actor) {
    actor = normalizeActor(actor);
    if (!filesDir) throw new StoreError(500, 'file storage is not configured');
    if (!data || !data.length) throw new StoreError(400, 'file is empty');
    if (data.length > FILE_MAX) throw new StoreError(413, `file too large (max ${FILE_MAX} bytes)`);
    const safe = safeFileName(name);
    const rel = path.join(String(taskId), `${randomBytes(6).toString('hex')}-${safe}`);
    // A raw upload's Content-Type often describes the request encoding rather than the file
    // (curl defaults to x-www-form-urlencoded), so fall back to the extension in those cases.
    mime = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!mime || GENERIC_TYPES.has(mime)) mime = guessMime(safe);
    return mutate(() => {
      getTaskRow(taskId);
      const ts = now();
      mkdirSync(path.dirname(path.join(filesDir, rel)), { recursive: true });
      writeFileSync(path.join(filesDir, rel), data);
      const r = run('INSERT INTO files (task_id, name, mime, size, path, uploaded_by, uploaded_by_name, created_at) VALUES (?,?,?,?,?,?,?,?)', taskId, safe, mime, data.length, rel, actor.kind, actor.name, ts);
      const f = getFile(num(r.lastInsertRowid));
      log(actor, 'file.add', 'file', f.id, taskId, { snapshot: { ...f } });
      emit('file.created', { task_id: taskId, file: f });
      return f;
    });
  }
  function deleteFile(id, actor) {
    actor = normalizeActor(actor);
    assertAllowed(policy, actor, 'can_delete_files', 'agents cannot delete files');
    return mutate(() => {
      const before = getFile(id);
      const changes = { deleted_at: [null, now()] };
      applyChanges('file', id, changes);
      log(actor, 'file.delete', 'file', id, before.task_id, { changes, snapshot: before });
      emit('file.deleted', { task_id: before.task_id, file_id: id });
      return { ok: true };
    });
  }

  // ---------- history / revert ----------
  const rowToHistory = (r) => r && {
    ...r, id: num(r.id),
    task_id: r.task_id == null ? null : num(r.task_id),
    entity_id: r.entity_id == null ? null : num(r.entity_id),
    reverted_by: r.reverted_by == null ? null : num(r.reverted_by),
    reverts: r.reverts == null ? null : num(r.reverts),
    detail: JSON.parse(r.detail || '{}'),
  };
  function listHistory(taskId, { limit = 200 } = {}) {
    return all('SELECT * FROM history WHERE task_id = ? ORDER BY id DESC LIMIT ?', taskId, limit).map(rowToHistory);
  }
  function activity({ actor, actor_name, since, task, limit = 100, before } = {}) {
    const where = [];
    const params = [];
    if (actor) { where.push('h.actor = ?'); params.push(actor); }
    if (actor_name) { where.push('h.actor_name = ?'); params.push(actor_name); }
    if (task) { where.push('h.task_id = ?'); params.push(Number(task)); }
    if (since) { where.push('h.created_at >= ?'); params.push(since); }
    if (before) { where.push('h.id < ?'); params.push(Number(before)); }
    limit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const sql = `SELECT h.*, t.title AS task_title FROM history h LEFT JOIN tasks t ON t.id = h.task_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY h.id DESC LIMIT ?`;
    return all(sql, ...params, limit).map(rowToHistory);
  }
  function getHistory(id) {
    const h = rowToHistory(get('SELECT * FROM history WHERE id = ?', id));
    if (!h) throw new StoreError(404, `history ${id} not found`);
    return h;
  }

  function currentEntity(entity, id) {
    const table = TABLE[entity];
    if (!table) return null;
    const r = get(`SELECT * FROM ${table} WHERE id = ?`, id);
    if (!r) return null;
    const o = { ...r };
    for (const k of Object.keys(o)) o[k] = num(o[k]);
    for (const field of JSON_FIELDS) {
      if (o[field] != null) o[field] = JSON.parse(o[field]);
    }
    return o;
  }

  /** Revert one history entry. Returns { history: newEntry, task }. */
  function revert(historyId, actor, { force = false } = {}) {
    actor = normalizeActor(actor);
    return mutate(() => {
      const h = getHistory(historyId);
      if (h.reverted_by) throw new StoreError(409, `history ${h.id} was already reverted (by ${h.reverted_by})`, { code: 'already_reverted' });
      if (actor.kind === 'agent' && !(h.actor === 'agent' && h.actor_name === actor.name)) {
        assertAllowed(policy, actor, 'can_revert_others', 'agents can only revert their own actions');
      }
      if (h.action === 'purge') throw new StoreError(400, 'purge cannot be reverted');
      const cur = currentEntity(h.entity, h.entity_id);
      if (!cur) throw new StoreError(404, `${h.entity} ${h.entity_id} no longer exists`);
      let changes;
      if (h.detail.changes) {
        changes = {};
        for (const [k, [oldV, newV]] of Object.entries(h.detail.changes)) {
          if (!REVERTABLE[h.entity].has(k)) continue;
          if (!force && !eq(cur[k], newV)) {
            throw new StoreError(409, `cannot revert: ${h.entity}.${k} has changed since (now ${JSON.stringify(cur[k])}, expected ${JSON.stringify(newV)}); use force`, { code: 'revert_conflict', field: k });
          }
          if (!eq(cur[k], oldV)) changes[k] = [cur[k], oldV];
        }
        if (h.entity === 'task' && changes.status && changes.status[1] === 'done') assertAllowed(policy, actor, 'can_close_directly', 'agents cannot close tasks directly');
        if (h.entity === 'task' && changes.deleted_at && changes.deleted_at[1]) assertAllowed(policy, actor, 'can_delete_task', 'agents cannot delete tasks');
        if (h.entity === 'task' && changes.deleted_at && !changes.deleted_at[1]) assertAllowed(policy, actor, 'can_delete_task', 'agents cannot restore deleted tasks');
        if (h.entity === 'file' && changes.deleted_at) assertAllowed(policy, actor, 'can_delete_files', 'agents cannot delete or restore files');
      } else if (/\.(create|add)$/.test(h.action)) {
        // reverting a creation = soft delete
        if (h.entity === 'task') assertAllowed(policy, actor, 'can_delete_task', 'agents cannot delete tasks');
        if (h.entity === 'file') assertAllowed(policy, actor, 'can_delete_files', 'agents cannot delete files');
        if (h.entity === 'project') throw new StoreError(400, 'project creation cannot be reverted; archive it instead');
        if (cur.deleted_at) throw new StoreError(409, `${h.entity} ${h.entity_id} is already deleted`, { code: 'already_deleted' });
        changes = { deleted_at: [null, now()] };
      } else {
        throw new StoreError(400, `history action ${h.action} cannot be reverted`);
      }
      if (!Object.keys(changes).length) throw new StoreError(409, 'nothing to revert (already at the previous state)', { code: 'noop' });
      applyChanges(h.entity, h.entity_id, changes);
      const newId = log(actor, 'revert', h.entity, h.entity_id, h.task_id, { changes, reverted_action: h.action, reverted_actor: h.actor, reverted_actor_name: h.actor_name }, h.id);
      run('UPDATE history SET reverted_by = ? WHERE id = ?', newId, h.id);
      const task = h.task_id ? getTaskRow(h.task_id, { includeDeleted: true }) : null;
      if (h.entity === 'task') emit(task?.deleted_at ? 'task.deleted' : 'task.updated', { task_id: h.task_id, task, action: 'revert' });
      else if (h.entity === 'project') emit('project.updated', { project: getProject(h.entity_id), action: 'revert' });
      else emit(`${h.entity}.updated`, { task_id: h.task_id, action: 'revert' });
      return { history: getHistory(newId), task };
    });
  }

  // ---------- aggregate views ----------
  function getTask(id, { includeDeleted = false } = {}) {
    const t = getTaskRow(id, { includeDeleted });
    t.criteria = listCriteria(id);
    t.notes = listNotes(id);
    t.files = listFiles(id);
    t.subtasks = all(`${TASK_SELECT} WHERE t.parent_id = ? AND t.deleted_at IS NULL ORDER BY t.status, t.position, t.id`, id).map(rowToTask);
    t.parent = t.parent_id ? rowToTask(get(`${TASK_SELECT} WHERE t.id = ?`, t.parent_id)) : null;
    t.history = listHistory(id, { limit: 100 });
    return t;
  }

  function board(filter = {}) {
    const tasks = listTasks(filter);
    const tags = new Set();
    for (const t of tasks) t.tags.forEach((x) => tags.add(x));
    return { lanes, tasks, projects: listProjects(), tags: [...tags].sort(), generated_at: now() };
  }

  function exportAll() {
    return {
      exported_at: now(),
      settings: getSettings(),
      lanes,
      projects: listProjects({ includeArchived: true }),
      tasks: all('SELECT * FROM tasks ORDER BY id').map(rowToTask),
      criteria: all('SELECT * FROM criteria ORDER BY id').map(rowToCriterion),
      notes: all('SELECT * FROM notes ORDER BY id').map(rowToNote),
      files: all('SELECT * FROM files ORDER BY id').map(rowToFile),
      history: all('SELECT * FROM history ORDER BY id').map(rowToHistory),
    };
  }

  function close() { db.close(); }

  return {
    lanes, laneIds, policy, db, filesDir, on,
    listProjects, getProject, createProject, updateProject,
    getSettings, updateSettings,
    listTasks, getTask, createTask, updateTask, moveTask, startTask, askTask, handoffTask, holdTask, doneTask, approveTask, archiveTask, deleteTask, restoreTask, purge,
    listCriteria, addCriterion, updateCriterion, deleteCriterion,
    listNotes, addNote, updateNote, deleteNote,
    listFiles, getFile, filePath, addFile, deleteFile,
    listHistory, activity, getHistory, revert,
    board, exportAll, close,
  };
}
