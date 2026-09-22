// Data layer: SQLite (node:sqlite), validation, audit history, revert, soft delete.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { normalizePolicy, assertAllowed, PolicyError } from './policy.js';
import {
  normalizeQuestionItems,
  normalizeAnswers,
  OTHER_OPTION,
  normalizeBrief,
  normalizeProvenance,
  assessBrief,
  briefDiff,
  summarizeQuestions,
  summarizeBrief,
} from './refinement.js';
import { normalizeUsageRecord } from './usage.js';

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
  agent_mode TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS refinement_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  base_task_version INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS refinement_sessions_task ON refinement_sessions(task_id, id);
CREATE INDEX IF NOT EXISTS refinement_sessions_status ON refinement_sessions(status, id);
CREATE TABLE IF NOT EXISTS refinement_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES refinement_sessions(id),
  round_no INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  question TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 1,
  options TEXT NOT NULL DEFAULT '[]',
  recommended_option TEXT NOT NULL DEFAULT '',
  recommendation_reason TEXT NOT NULL DEFAULT '',
  answer TEXT,
  selected_option TEXT NOT NULL DEFAULT '',
  answer_kind TEXT,
  answered_by TEXT,
  answered_by_name TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refinement_questions_session ON refinement_questions(session_id, round_no, position, id);
CREATE TABLE IF NOT EXISTS task_briefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  session_id INTEGER NOT NULL REFERENCES refinement_sessions(id),
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '{}',
  provenance TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  accepted_by TEXT,
  accepted_by_name TEXT,
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS task_briefs_task ON task_briefs(task_id, id);
CREATE INDEX IF NOT EXISTS task_briefs_session ON task_briefs(session_id, revision);
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
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  refinement_session_id INTEGER REFERENCES refinement_sessions(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  cost_kind TEXT NOT NULL DEFAULT 'unavailable',
  pricing_source TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_usage_task ON ai_usage(task_id, id);
CREATE INDEX IF NOT EXISTS ai_usage_provider ON ai_usage(provider, id);
`;

const TABLE = { task: 'tasks', criteria: 'criteria', note: 'notes', file: 'files', project: 'projects' };
const JSON_FIELDS = new Set(['tags', 'classification_suggestions']);
// Fields a revert may write back, per entity.
const REVERTABLE = {
  task: new Set(['title', 'description', 'status', 'waiting_reason', 'assignee', 'priority', 'due', 'project_id', 'parent_id', 'tags', 'classification_suggestions', 'agent_mode', 'worker', 'needs_review', 'position', 'archived_at', 'deleted_at']),
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
  if (!taskColumns.includes('agent_mode')) {
    db.exec("ALTER TABLE tasks ADD COLUMN agent_mode TEXT NOT NULL DEFAULT ''");
  }
  const refinementQuestionColumns = db.prepare('PRAGMA table_info(refinement_questions)').all().map((column) => column.name);
  if (!refinementQuestionColumns.includes('options')) {
    db.exec("ALTER TABLE refinement_questions ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
  }
  if (!refinementQuestionColumns.includes('recommended_option')) {
    db.exec("ALTER TABLE refinement_questions ADD COLUMN recommended_option TEXT NOT NULL DEFAULT ''");
  }
  if (!refinementQuestionColumns.includes('recommendation_reason')) {
    db.exec("ALTER TABLE refinement_questions ADD COLUMN recommendation_reason TEXT NOT NULL DEFAULT ''");
  }
  if (!refinementQuestionColumns.includes('selected_option')) {
    db.exec("ALTER TABLE refinement_questions ADD COLUMN selected_option TEXT NOT NULL DEFAULT ''");
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

  // Some structured refinement changes live outside the task row. Bump the task
  // version anyway so a brief edit participates in the same optimistic lock as
  // ordinary task edits.
  function touchTaskVersion(before, actor, action, detail = {}) {
    run('UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?', now(), before.id);
    const t = getTaskRow(before.id, { includeDeleted: true });
    log(actor, action, 'task', before.id, before.id, { changes: {}, ...detail });
    emit('task.updated', { task_id: before.id, task: t, action, changes: {} });
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
      if (patch.agent_mode !== undefined) throw new StoreError(400, 'agent_mode is managed by refinement and execution actions');
      const f = validateTaskFields(patch, actor, { partial: true, existing: before });
      if (classificationSuggestions !== undefined) f.classification_suggestions = cleanClassificationSuggestions(classificationSuggestions);
      if (f.status !== undefined && f.status !== before.status) {
        if (before.agent_mode === 'refine') throw new StoreError(409, 'use the structured refinement action while a task is being refined', { code: 'refinement_use_structured' });
        if (f.status === 'done') assertAllowed(policy, actor, 'can_close_directly', 'agents cannot close tasks directly');
        f.position = nextPosition(f.status);
        if (f.status !== 'waiting_human' && f.waiting_reason === undefined) f.waiting_reason = '';
        if ((f.status === 'done' || f.status === 'waiting_agent') && f.worker === undefined) f.worker = '';
        if (f.status === 'waiting_agent') f.agent_mode = 'execute';
        else if (f.status === 'todo' || f.status === 'on_hold' || f.status === 'done') f.agent_mode = '';
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
      if (before.agent_mode === 'refine' && ['in_progress', 'waiting_agent', 'done'].includes(status)) {
        throw new StoreError(409, 'use the structured refinement action while a task is being refined', { code: 'refinement_use_structured' });
      }
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
      if (before.agent_mode === 'refine') f.agent_mode = 'refine';
      else if (status === 'waiting_agent') f.agent_mode = 'execute';
      else if (status === 'todo' || status === 'on_hold' || status === 'done') f.agent_mode = '';
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
      if (before.agent_mode === '' && actor.kind === 'agent') f.agent_mode = 'execute';
      const t = commitTaskChanges(before, diffTask(before, f), actor, 'task.start');
      if (t.agent_mode === 'refine') {
        const session = currentRefinementSessionRow(t.id);
        if (session && (session.status === 'pending' || session.status === 'running')) {
          updateRefinementSessionRaw(session.id, { status: 'running', base_task_version: t.version, updated_at: now() });
        }
      }
      return t;
    });
  }

  function transition(id, actor, { version, status, waiting_reason, note, kind, action, clearWorker }) {
    return mutate(() => {
      const before = getTaskRow(id);
      assertVersion(before, version);
      const noteRow = note ? addNoteRaw(id, note, actor, kind) : null;
      const f = { status, waiting_reason, position: before.status === status ? before.position : nextPosition(status) };
      if (clearWorker) f.worker = '';
      if (before.agent_mode === 'refine') f.agent_mode = 'refine';
      else if (status === 'waiting_agent') f.agent_mode = 'execute';
      else if (status === 'todo' || status === 'on_hold' || status === 'done') f.agent_mode = '';
      const t = commitTaskChanges(before, diffTask(before, f), actor, action);
      return { task: t, note: noteRow };
    });
  }

  function askTask(id, question, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (!String(question || '').trim()) throw new StoreError(400, 'a question is required');
    const before = getTaskRow(id);
    if (before.agent_mode === 'refine') {
      throw new StoreError(409, 'refinement questions must use the structured refinement endpoint', { code: 'refinement_use_questions' });
    }
    return transition(id, actor, { version, status: 'waiting_human', waiting_reason: 'question', note: question, kind: 'question', action: 'task.ask' });
  }
  function handoffTask(id, noteBody, actor, { version } = {}) {
    actor = normalizeActor(actor);
    const before = getTaskRow(id);
    if (before.agent_mode === 'refine') {
      throw new StoreError(409, 'refinement responses must use the structured refinement endpoint', { code: 'refinement_use_answers' });
    }
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
      if (before.agent_mode === 'refine') {
        throw new StoreError(409, 'a refinement must be accepted before the task can be completed', { code: 'refinement_only' });
      }
      const unchecked = all('SELECT id, text FROM criteria WHERE task_id = ? AND deleted_at IS NULL AND done = 0 ORDER BY position, id', id).map((r) => ({ id: num(r.id), text: r.text }));
      if (unchecked.length && !partial) {
        throw new StoreError(422, `task ${id} has ${unchecked.length} unmet criteria; check them (tm check) or report --partial`, { code: 'criteria_unmet', unchecked });
      }
      let target = 'done';
      if (partial || before.needs_review) target = 'waiting_human';
      else if (actor.kind === 'agent' && !policy.agent.can_close_directly) target = 'waiting_human';
      const noteRow = addNoteRaw(id, body, actor, 'report');
      const f = { status: target, waiting_reason: target === 'waiting_human' ? 'review' : '', worker: '', position: nextPosition(target), agent_mode: target === 'done' ? '' : before.agent_mode };
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
      if (before.agent_mode === 'refine') {
        throw new StoreError(409, 'accept the refinement brief before approving the task', { code: 'refinement_use_accept' });
      }
      const f = { status: 'done', waiting_reason: '', worker: '', agent_mode: '', position: nextPosition('done') };
      return commitTaskChanges(before, diffTask(before, f), actor, 'task.approve');
    });
  }

  // ---------- AI task refinement ----------
  const ACTIVE_REFINEMENT_STATUSES = ['pending', 'running', 'waiting_user', 'draft'];
  const BRIEF_STATUSES = ['draft', 'accepted', 'superseded'];

  function domainValue(fn) {
    try { return fn(); } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(400, e.message || 'invalid refinement data');
    }
  }

  function parseJson(value, fallback) {
    try { return JSON.parse(value || '{}'); } catch { return fallback; }
  }

  function rowToRefinementSession(r) {
    if (!r) return null;
    return {
      ...r,
      id: num(r.id), task_id: num(r.task_id), attempt: num(r.attempt), base_task_version: num(r.base_task_version),
    };
  }

  function rowToRefinementQuestion(r) {
    if (!r) return null;
    const parsedOptions = parseJson(r.options, []);
    return {
      ...r,
      id: num(r.id), session_id: num(r.session_id), round_no: num(r.round_no), position: num(r.position), blocking: !!num(r.blocking),
      options: Array.isArray(parsedOptions) ? parsedOptions : [],
      recommended_option: String(r.recommended_option || ''),
      recommendation_reason: String(r.recommendation_reason || ''),
      selected_option: String(r.selected_option || ''),
    };
  }

  function rowToBrief(r) {
    if (!r) return null;
    return {
      ...r,
      id: num(r.id), task_id: num(r.task_id), session_id: num(r.session_id), revision: num(r.revision),
      content: parseJson(r.content, {}), provenance: parseJson(r.provenance, {}),
    };
  }

  function getRefinementSessionRow(id) {
    const row = rowToRefinementSession(get('SELECT * FROM refinement_sessions WHERE id = ?', id));
    if (!row) throw new StoreError(404, `refinement ${id} not found`);
    return row;
  }

  function currentRefinementSessionRow(taskId) {
    return rowToRefinementSession(get(`SELECT * FROM refinement_sessions WHERE task_id = ? AND status IN (${ACTIVE_REFINEMENT_STATUSES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, taskId, ...ACTIVE_REFINEMENT_STATUSES));
  }

  function latestRefinementSessionRow(taskId) {
    return rowToRefinementSession(get('SELECT * FROM refinement_sessions WHERE task_id = ? ORDER BY id DESC LIMIT 1', taskId));
  }

  function listRefinementQuestionRows(sessionId) {
    return all('SELECT * FROM refinement_questions WHERE session_id = ? ORDER BY round_no, position, id', sessionId).map(rowToRefinementQuestion);
  }

  function listBriefRows(sessionId) {
    return all(`SELECT * FROM task_briefs WHERE session_id = ? AND status IN (${BRIEF_STATUSES.map(() => '?').join(',')}) ORDER BY revision, id`, sessionId, ...BRIEF_STATUSES).map(rowToBrief);
  }

  function currentBriefRow(sessionId) {
    return rowToBrief(get(`SELECT * FROM task_briefs WHERE session_id = ? AND status IN ('draft', 'accepted') ORDER BY revision DESC, id DESC LIMIT 1`, sessionId));
  }

  function refinementView(session) {
    if (!session) return null;
    return { ...session, questions: listRefinementQuestionRows(session.id), brief: currentBriefRow(session.id), briefs: listBriefRows(session.id) };
  }

  function getRefinement(id) {
    const session = getRefinementSessionRow(id);
    const task = getTaskRow(session.task_id, { includeDeleted: true });
    return { ...refinementView(session), task: { id: task.id, title: task.title, status: task.status, version: task.version, agent_mode: task.agent_mode } };
  }

  function listRefinements(taskId) {
    getTaskRow(taskId, { includeDeleted: true });
    return all('SELECT * FROM refinement_sessions WHERE task_id = ? ORDER BY id DESC', taskId).map(rowToRefinementSession).map(refinementView);
  }

  function getAcceptedBrief(taskId) {
    getTaskRow(taskId, { includeDeleted: true });
    return rowToBrief(get("SELECT * FROM task_briefs WHERE task_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", taskId));
  }

  function updateRefinementSessionRaw(id, patch) {
    const allowed = new Set(['status', 'base_task_version', 'error', 'updated_at', 'completed_at']);
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!allowed.has(key)) continue;
      sets.push(`${key} = ?`); params.push(value);
    }
    if (!sets.length) return getRefinementSessionRow(id);
    if (!Object.prototype.hasOwnProperty.call(patch, 'updated_at')) { sets.push('updated_at = ?'); params.push(now()); }
    params.push(id);
    run(`UPDATE refinement_sessions SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return getRefinementSessionRow(id);
  }

  function createRefinementSessionRaw(task, actor, action = 'task.refine_request') {
    const attempt = num(get('SELECT COALESCE(MAX(attempt), 0) AS m FROM refinement_sessions WHERE task_id = ?', task.id).m) + 1;
    const ts = now();
    const r = run(
      'INSERT INTO refinement_sessions (task_id, attempt, status, base_task_version, created_by, created_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      task.id, attempt, 'pending', task.version, actor.kind, actor.name, ts, ts,
    );
    const sessionId = num(r.lastInsertRowid);
    const f = {
      status: 'waiting_agent', waiting_reason: '', worker: '', agent_mode: 'refine',
      position: task.status === 'waiting_agent' ? task.position : nextPosition('waiting_agent'),
    };
    const t = commitTaskChanges(task, diffTask(task, f), actor, action, { refinement: { session_id: sessionId, attempt } });
    updateRefinementSessionRaw(sessionId, { base_task_version: t.version });
    const session = getRefinementSessionRow(sessionId);
    emit('refinement.updated', { task_id: task.id, task: t, refinement: refinementView(session) });
    return { task: t, refinement: refinementView(session) };
  }

  function requestRefinement(taskId, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can request task refinement');
    return mutate(() => {
      const task = getTaskRow(taskId);
      assertVersion(task, version);
      if (task.archived_at) throw new StoreError(409, 'archived tasks cannot be refined', { code: 'task_archived' });
      if (task.status === 'done') throw new StoreError(409, 'completed tasks cannot be refined', { code: 'task_done' });
      if (!['todo', 'on_hold'].includes(task.status)) throw new StoreError(409, `task ${task.id} must be in todo or on_hold before refinement`, { code: 'invalid_refinement_status', current: task });
      const active = currentRefinementSessionRow(task.id);
      if (active) throw new StoreError(409, `task ${task.id} already has an active refinement`, { code: 'refinement_active', current: refinementView(active) });
      return createRefinementSessionRaw(task, actor);
    });
  }

  function submitRefinementQuestions(sessionId, questions, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'agent') throw new PolicyError('only agents can submit refinement questions');
    return mutate(() => {
      const session = getRefinementSessionRow(sessionId);
      if (session.status !== 'running') throw new StoreError(409, `refinement ${sessionId} is not running`, { code: 'refinement_not_running', current: refinementView(session) });
      const task = getTaskRow(session.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const previousRound = num(get('SELECT COALESCE(MAX(round_no), 0) AS m FROM refinement_questions WHERE session_id = ?', sessionId).m);
      if (previousRound >= 3) throw new StoreError(422, 'refinement question rounds are limited to 3', { code: 'refinement_round_limit' });
      const items = domainValue(() => normalizeQuestionItems(questions));
      const round = previousRound + 1;
      const ts = now();
      for (const [i, item] of items.entries()) {
        run('INSERT INTO refinement_questions (session_id, round_no, position, question, blocking, options, recommended_option, recommendation_reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)', sessionId, round, i + 1, item.question, item.blocking ? 1 : 0, JSON.stringify(item.options), item.recommended_option, item.recommendation_reason, ts);
      }
      addNoteRaw(task.id, summarizeQuestions(items), actor, 'question');
      const f = { status: 'waiting_human', waiting_reason: 'question', worker: '', agent_mode: 'refine', position: nextPosition('waiting_human') };
      const t = commitTaskChanges(task, diffTask(task, f), actor, 'task.refine_questions', { refinement: { session_id: sessionId, round } });
      updateRefinementSessionRaw(sessionId, { status: 'waiting_user', base_task_version: t.version });
      const updated = getRefinementSessionRow(sessionId);
      const view = refinementView(updated);
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view };
    });
  }

  function answerRefinement(sessionId, answers, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can answer refinement questions');
    return mutate(() => {
      const session = getRefinementSessionRow(sessionId);
      if (session.status !== 'waiting_user') throw new StoreError(409, `refinement ${sessionId} is not waiting for answers`, { code: 'refinement_not_waiting_user', current: refinementView(session) });
      const task = getTaskRow(session.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const rows = listRefinementQuestionRows(sessionId);
      const lastRound = Math.max(...rows.map((row) => row.round_no), 0);
      const pending = rows.filter((row) => row.round_no === lastRound && !row.answer_kind);
      const values = domainValue(() => normalizeAnswers(answers));
      const pendingIds = new Set(pending.map((row) => row.id));
      for (const value of values) {
        if (!pendingIds.has(value.id)) throw new StoreError(400, `question ${value.id} is not an unanswered question in the latest round`);
        const question = pending.find((row) => row.id === value.id);
        if (value.selected_option && value.selected_option !== OTHER_OPTION && !question.options.includes(value.selected_option)) {
          throw new StoreError(400, `answer ${value.id} selected an invalid option`);
        }
      }
      const answeredIds = new Set(values.map((value) => value.id));
      const missing = pending.filter((row) => !answeredIds.has(row.id)).map((row) => row.id);
      if (missing.length) throw new StoreError(422, 'all current refinement questions must be answered', { code: 'questions_unanswered', question_ids: missing });
      const ts = now();
      for (const value of values) {
        run('UPDATE refinement_questions SET answer = ?, selected_option = ?, answer_kind = ?, answered_by = ?, answered_by_name = ?, answered_at = ? WHERE id = ?', value.answer || null, value.selected_option || '', value.kind, actor.kind, actor.name, ts, value.id);
      }
      const f = { status: 'waiting_agent', waiting_reason: '', worker: '', agent_mode: 'refine', position: nextPosition('waiting_agent') };
      const t = commitTaskChanges(task, diffTask(task, f), actor, 'task.refine_answers', { refinement: { session_id: sessionId, round: lastRound } });
      updateRefinementSessionRaw(sessionId, { status: 'running', base_task_version: t.version });
      const view = refinementView(getRefinementSessionRow(sessionId));
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view };
    });
  }

  function saveRefinementBrief(sessionId, content, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'agent') throw new PolicyError('only agents can propose refinement briefs');
    return mutate(() => {
      const session = getRefinementSessionRow(sessionId);
      if (session.status !== 'running') throw new StoreError(409, `refinement ${sessionId} is not running`, { code: 'refinement_not_running', current: refinementView(session) });
      const task = getTaskRow(session.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const rawContent = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
      const brief = domainValue(() => normalizeBrief(rawContent));
      const assessment = assessBrief(brief);
      if (!assessment.ready) throw new StoreError(422, 'refinement brief is not ready for human review', { code: 'brief_not_ready', missing: assessment.missing, blocking: assessment.blocking, warnings: assessment.warnings });
      const provenance = normalizeProvenance(rawContent.provenance, brief);
      const revision = num(get('SELECT COALESCE(MAX(revision), 0) AS m FROM task_briefs WHERE session_id = ?', sessionId).m) + 1;
      run("UPDATE task_briefs SET status = 'superseded', updated_at = ? WHERE session_id = ? AND status = 'draft'", now(), sessionId);
      const ts = now();
      const r = run('INSERT INTO task_briefs (task_id, session_id, revision, status, content, provenance, created_by, created_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', task.id, sessionId, revision, 'draft', JSON.stringify(brief), JSON.stringify(provenance), actor.kind, actor.name, ts, ts);
      const briefId = num(r.lastInsertRowid);
      const f = { status: 'waiting_human', waiting_reason: 'review', worker: '', agent_mode: 'refine', position: nextPosition('waiting_human') };
      const t = commitTaskChanges(task, diffTask(task, f), actor, 'task.refine_propose', { refinement: { session_id: sessionId, brief_id: briefId, revision }, summary: summarizeBrief(brief) });
      updateRefinementSessionRaw(sessionId, { status: 'draft', base_task_version: t.version });
      const view = refinementView(getRefinementSessionRow(sessionId));
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view, brief: rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', briefId)) };
    });
  }

  function editRefinementBrief(briefId, content, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can edit refinement briefs');
    return mutate(() => {
      const beforeBrief = rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', briefId));
      if (!beforeBrief) throw new StoreError(404, `brief ${briefId} not found`);
      if (beforeBrief.status !== 'draft') throw new StoreError(409, `brief ${briefId} is not a current draft`, { code: 'brief_not_draft' });
      const session = getRefinementSessionRow(beforeBrief.session_id);
      if (session.status !== 'draft') throw new StoreError(409, `refinement ${session.id} is not awaiting brief review`, { code: 'refinement_not_draft' });
      const task = getTaskRow(beforeBrief.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const patch = content && typeof content === 'object' ? content : {};
      const merged = { ...beforeBrief.content, ...patch };
      const nextContent = domainValue(() => normalizeBrief(merged));
      const changes = briefDiff(beforeBrief.content, nextContent);
      if (!Object.keys(changes).length) return { task, refinement: refinementView(session), brief: beforeBrief };
      const provenance = { ...beforeBrief.provenance };
      for (const field of Object.keys(changes)) provenance[field] = 'human_edited';
      const revision = num(get('SELECT COALESCE(MAX(revision), 0) AS m FROM task_briefs WHERE session_id = ?', session.id).m) + 1;
      run("UPDATE task_briefs SET status = 'superseded', updated_at = ? WHERE id = ?", now(), briefId);
      const ts = now();
      const r = run('INSERT INTO task_briefs (task_id, session_id, revision, status, content, provenance, created_by, created_by_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', task.id, session.id, revision, 'draft', JSON.stringify(nextContent), JSON.stringify(normalizeProvenance(provenance, nextContent)), actor.kind, actor.name, ts, ts);
      const nextBriefId = num(r.lastInsertRowid);
      const t = touchTaskVersion(task, actor, 'refinement.brief_edit', { refinement: { session_id: session.id, brief_id: nextBriefId, previous_brief_id: briefId }, brief_changes: changes });
      updateRefinementSessionRaw(session.id, { base_task_version: t.version });
      const view = refinementView(getRefinementSessionRow(session.id));
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view, brief: rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', nextBriefId)) };
    });
  }

  function acceptRefinementBrief(briefId, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can accept refinement briefs');
    return mutate(() => {
      const brief = rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', briefId));
      if (!brief) throw new StoreError(404, `brief ${briefId} not found`);
      if (brief.status !== 'draft') throw new StoreError(409, `brief ${briefId} is not a current draft`, { code: 'brief_not_draft' });
      const session = getRefinementSessionRow(brief.session_id);
      if (session.status !== 'draft') throw new StoreError(409, `refinement ${session.id} is not awaiting brief review`, { code: 'refinement_not_draft' });
      const task = getTaskRow(brief.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const assessment = assessBrief(brief.content);
      if (!assessment.ready) throw new StoreError(422, 'refinement brief is not ready for acceptance', { code: 'brief_not_ready', missing: assessment.missing, blocking: assessment.blocking, warnings: assessment.warnings });
      const previousAccepted = rowToBrief(get("SELECT * FROM task_briefs WHERE task_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", task.id));
      const addedCriteria = [];
      const currentCriteria = listCriteria(task.id);
      const knownCriteria = new Set(currentCriteria.filter((criterion) => !criterion.deleted_at).map((criterion) => criterion.text));
      for (const text of assessment.content.criteria) {
        if (!knownCriteria.has(text)) {
          addedCriteria.push(addCriterionRaw(task.id, text, actor));
          knownCriteria.add(text);
        }
      }
      run("UPDATE task_briefs SET status = 'superseded', updated_at = ? WHERE task_id = ? AND status = 'accepted'", now(), task.id);
      run("UPDATE task_briefs SET status = 'accepted', accepted_by = ?, accepted_by_name = ?, accepted_at = ?, updated_at = ? WHERE id = ?", actor.kind, actor.name, now(), now(), brief.id);
      const f = { status: 'todo', waiting_reason: '', worker: '', agent_mode: '', position: nextPosition('todo') };
      const detail = {
        refinement_accept: {
          session_id: session.id, brief_id: brief.id, previous_accepted_brief_id: previousAccepted?.id || null,
          added_criteria: addedCriteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
        },
      };
      const t = commitTaskChanges(task, diffTask(task, f), actor, 'task.refine_accept', detail);
      updateRefinementSessionRaw(session.id, { status: 'accepted', base_task_version: t.version, completed_at: now() });
      const view = refinementView(getRefinementSessionRow(session.id));
      const accepted = rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', brief.id));
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view, brief: accepted, added_criteria: addedCriteria };
    });
  }

  function cancelRefinement(sessionId, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can cancel refinements');
    return mutate(() => {
      const session = getRefinementSessionRow(sessionId);
      if (!ACTIVE_REFINEMENT_STATUSES.includes(session.status)) throw new StoreError(409, `refinement ${sessionId} is already ${session.status}`, { code: 'refinement_not_active', current: refinementView(session) });
      const task = getTaskRow(session.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const f = { status: 'todo', waiting_reason: '', worker: '', agent_mode: '', position: nextPosition('todo') };
      const t = commitTaskChanges(task, diffTask(task, f), actor, 'task.refine_cancel', { refinement: { session_id: sessionId } });
      updateRefinementSessionRaw(sessionId, { status: 'cancelled', base_task_version: t.version, completed_at: now() });
      const view = refinementView(getRefinementSessionRow(sessionId));
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view };
    });
  }

  function failRefinement(sessionId, error, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'agent') throw new PolicyError('only agents can report refinement failures');
    return mutate(() => {
      const session = getRefinementSessionRow(sessionId);
      if (!ACTIVE_REFINEMENT_STATUSES.includes(session.status)) throw new StoreError(409, `refinement ${sessionId} is not active`, { code: 'refinement_not_active', current: refinementView(session) });
      const task = getTaskRow(session.task_id);
      assertVersion(task, version ?? session.base_task_version);
      const message = String(error || 'agent failed to refine this task').trim().slice(0, 1000);
      const f = { status: 'on_hold', waiting_reason: '', worker: '', agent_mode: 'refine', position: nextPosition('on_hold') };
      const t = commitTaskChanges(task, diffTask(task, f), actor, 'task.refine_failed', { refinement: { session_id: sessionId }, error: message });
      updateRefinementSessionRaw(sessionId, { status: 'failed', error: message, base_task_version: t.version, completed_at: now() });
      const view = refinementView(getRefinementSessionRow(sessionId));
      emit('refinement.updated', { task_id: task.id, task: t, refinement: view });
      return { task: t, refinement: view };
    });
  }

  function retryRefinement(sessionId, actor, { version } = {}) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'human') throw new PolicyError('only humans can retry refinements');
    return mutate(() => {
      const old = getRefinementSessionRow(sessionId);
      if (!['failed', 'cancelled'].includes(old.status)) throw new StoreError(409, `refinement ${sessionId} cannot be retried from ${old.status}`, { code: 'refinement_not_retryable', current: refinementView(old) });
      const task = getTaskRow(old.task_id);
      assertVersion(task, version ?? task.version);
      return createRefinementSessionRaw(task, actor, 'task.refine_retry');
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
        const sessionIds = all('SELECT id FROM refinement_sessions WHERE task_id = ?', id).map((r) => num(r.id));
        if (sessionIds.length) {
          const marks = sessionIds.map(() => '?').join(',');
          run(`DELETE FROM refinement_questions WHERE session_id IN (${marks})`, ...sessionIds);
          run(`DELETE FROM task_briefs WHERE session_id IN (${marks})`, ...sessionIds);
        }
        run('DELETE FROM ai_usage WHERE task_id = ?', id);
        run('DELETE FROM refinement_sessions WHERE task_id = ?', id);
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

  // ---------- AI usage and cost ----------
  function rowToAiUsage(r) {
    if (!r) return null;
    return {
      ...r,
      id: num(r.id),
      task_id: num(r.task_id),
      refinement_session_id: r.refinement_session_id == null ? null : num(r.refinement_session_id),
      input_tokens: r.input_tokens == null ? null : num(r.input_tokens),
      cached_input_tokens: num(r.cached_input_tokens || 0),
      output_tokens: r.output_tokens == null ? null : num(r.output_tokens),
      total_tokens: r.total_tokens == null ? null : num(r.total_tokens),
      cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
      metadata: parseJson(r.metadata, {}),
    };
  }

  function listAiUsage(taskId) {
    getTaskRow(taskId, { includeDeleted: true });
    return all('SELECT * FROM ai_usage WHERE task_id = ? ORDER BY id DESC', taskId).map(rowToAiUsage);
  }

  function usageBucket() {
    return {
      calls: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      known_cost_calls: 0,
      unknown_cost_calls: 0,
      actual_cost_calls: 0,
      estimated_cost_calls: 0,
      cost_complete: true,
      cost_kind: 'none',
    };
  }

  function summarizeUsageRows(rows) {
    const byProvider = { jev: usageBucket(), codex: usageBucket() };
    for (const row of rows) {
      const bucket = byProvider[row.provider] || (byProvider[row.provider] = usageBucket());
      bucket.calls += 1;
      bucket.input_tokens += row.input_tokens || 0;
      bucket.cached_input_tokens += row.cached_input_tokens || 0;
      bucket.output_tokens += row.output_tokens || 0;
      bucket.total_tokens += row.total_tokens || 0;
      if (row.cost_usd == null) {
        bucket.unknown_cost_calls += 1;
        bucket.cost_complete = false;
      } else {
        bucket.known_cost_calls += 1;
        bucket.cost_usd += Number(row.cost_usd);
        if (row.cost_kind === 'actual') bucket.actual_cost_calls += 1;
        else bucket.estimated_cost_calls += 1;
      }
    }
    for (const bucket of Object.values(byProvider)) {
      if (!bucket.calls) continue;
      bucket.cost_usd = bucket.known_cost_calls ? Number(bucket.cost_usd.toFixed(12)) : null;
      bucket.cost_kind = bucket.unknown_cost_calls
        ? (bucket.known_cost_calls ? 'mixed' : 'unavailable')
        : (bucket.actual_cost_calls === bucket.known_cost_calls ? 'actual' : 'estimated');
    }
    const total = usageBucket();
    for (const bucket of Object.values(byProvider)) {
      total.calls += bucket.calls;
      total.input_tokens += bucket.input_tokens;
      total.cached_input_tokens += bucket.cached_input_tokens;
      total.output_tokens += bucket.output_tokens;
      total.total_tokens += bucket.total_tokens;
      total.known_cost_calls += bucket.known_cost_calls;
      total.unknown_cost_calls += bucket.unknown_cost_calls;
      total.actual_cost_calls += bucket.actual_cost_calls;
      total.estimated_cost_calls += bucket.estimated_cost_calls;
      if (bucket.cost_usd != null) total.cost_usd += bucket.cost_usd;
    }
    total.cost_complete = total.unknown_cost_calls === 0;
    if (total.calls) {
      total.cost_usd = total.known_cost_calls ? Number(total.cost_usd.toFixed(12)) : null;
      total.cost_kind = total.unknown_cost_calls
        ? (total.known_cost_calls ? 'mixed' : 'unavailable')
        : (total.actual_cost_calls === total.known_cost_calls ? 'actual' : 'estimated');
    }
    return { total, by_provider: byProvider };
  }

  function summarizeAiUsage(taskId = null) {
    if (taskId != null) getTaskRow(taskId, { includeDeleted: true });
    const rows = taskId == null
      ? all('SELECT * FROM ai_usage ORDER BY id').map(rowToAiUsage)
      : all('SELECT * FROM ai_usage WHERE task_id = ? ORDER BY id', taskId).map(rowToAiUsage);
    return summarizeUsageRows(rows);
  }

  function recordAiUsage(taskId, input, actor) {
    actor = normalizeActor(actor);
    if (actor.kind !== 'agent') throw new PolicyError('only agents can record AI usage');
    return mutate(() => {
      getTaskRow(taskId, { includeDeleted: true });
      let record;
      try { record = normalizeUsageRecord(input); } catch (error) { throw new StoreError(400, error.message || 'invalid AI usage'); }
      if (record.refinement_session_id != null) {
        const session = getRefinementSessionRow(record.refinement_session_id);
        if (session.task_id !== Number(taskId)) throw new StoreError(400, 'refinement session does not belong to task');
      }
      let metadata;
      try { metadata = JSON.stringify(record.metadata); } catch { throw new StoreError(400, 'usage metadata must be JSON serializable'); }
      const result = run(
        `INSERT INTO ai_usage (task_id, refinement_session_id, provider, model, input_tokens, cached_input_tokens, output_tokens, total_tokens, cost_usd, cost_kind, pricing_source, metadata, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        taskId, record.refinement_session_id, record.provider, record.model,
        record.input_tokens, record.cached_input_tokens, record.output_tokens, record.total_tokens,
        record.cost_usd, record.cost_kind, record.pricing_source, metadata, now(),
      );
      const usage = rowToAiUsage(get('SELECT * FROM ai_usage WHERE id = ?', num(result.lastInsertRowid)));
      emit('ai_usage.recorded', { task_id: Number(taskId), usage, ai_cost: summarizeAiUsage(taskId) });
      return usage;
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

  function revertRefinementBriefEdit(h, actor, { force = false } = {}) {
    const detail = h.detail.refinement || {};
    const currentBrief = rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', detail.brief_id));
    const previousBrief = rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', detail.previous_brief_id));
    if (!force && (!currentBrief || currentBrief.status !== 'draft')) throw new StoreError(409, 'cannot revert: the current brief has changed since; use force', { code: 'revert_conflict', field: 'brief' });
    if (!force && (!previousBrief || previousBrief.status !== 'superseded')) throw new StoreError(409, 'cannot revert: the previous brief has changed since; use force', { code: 'revert_conflict', field: 'previous_brief' });
    if (!currentBrief && !previousBrief) throw new StoreError(404, 'brief history no longer exists');
    if (currentBrief) run("UPDATE task_briefs SET status = 'superseded', updated_at = ? WHERE id = ?", now(), currentBrief.id);
    if (previousBrief) run("UPDATE task_briefs SET status = 'draft', updated_at = ? WHERE id = ?", now(), previousBrief.id);
    const beforeTask = getTaskRow(h.task_id);
    run('UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ?', now(), h.task_id);
    const task = getTaskRow(h.task_id, { includeDeleted: true });
    run('UPDATE refinement_sessions SET base_task_version = ?, updated_at = ? WHERE id = ?', task.version, now(), detail.session_id);
    const newId = log(actor, 'revert', 'task', h.task_id, h.task_id, {
      changes: {}, reverted_action: h.action, reverted_actor: h.actor, reverted_actor_name: h.actor_name,
      refinement_revert: { brief_id: currentBrief?.id || detail.brief_id, restored_previous_brief_id: previousBrief?.id || detail.previous_brief_id },
    }, h.id);
    run('UPDATE history SET reverted_by = ? WHERE id = ?', newId, h.id);
    emit('task.updated', { task_id: h.task_id, task, action: 'revert', changes: {} });
    emit('refinement.updated', { task_id: h.task_id, task, refinement: refinementView(getRefinementSessionRow(detail.session_id)) });
    return { history: getHistory(newId), task, previous_task: beforeTask };
  }

  function revertRefinementAcceptance(h, actor, { force = false } = {}) {
    const cur = currentEntity('task', h.entity_id);
    if (!cur) throw new StoreError(404, `task ${h.entity_id} no longer exists`);
    const changes = {};
    for (const [k, [oldV, newV]] of Object.entries(h.detail.changes || {})) {
      if (!REVERTABLE.task.has(k)) continue;
      if (!force && !eq(cur[k], newV)) {
        throw new StoreError(409, `cannot revert: task.${k} has changed since (now ${JSON.stringify(cur[k])}, expected ${JSON.stringify(newV)}); use force`, { code: 'revert_conflict', field: k });
      }
      if (!eq(cur[k], oldV)) changes[k] = [cur[k], oldV];
    }
    const accepted = rowToBrief(get('SELECT * FROM task_briefs WHERE id = ?', h.detail.refinement_accept?.brief_id));
    if (!force && (!accepted || accepted.status !== 'accepted')) throw new StoreError(409, 'cannot revert: the accepted brief has changed since; use force', { code: 'revert_conflict', field: 'brief' });
    const addedCriteria = h.detail.refinement_accept?.added_criteria || [];
    const criteriaToDelete = [];
    for (const item of addedCriteria) {
      const criterion = rowToCriterion(get('SELECT * FROM criteria WHERE id = ?', item.id));
      if (!criterion || criterion.deleted_at) {
        if (!force) throw new StoreError(409, `cannot revert: criterion ${item.id} has changed since; use force`, { code: 'revert_conflict', field: `criterion:${item.id}` });
        continue;
      }
      if (!force && (criterion.text !== item.text || criterion.done)) throw new StoreError(409, `cannot revert: criterion ${item.id} has changed since; use force`, { code: 'revert_conflict', field: `criterion:${item.id}` });
      criteriaToDelete.push(criterion);
    }
    if (!Object.keys(changes).length && !criteriaToDelete.length && !accepted) throw new StoreError(409, 'nothing to revert', { code: 'noop' });
    if (Object.keys(changes).length) applyChanges('task', h.entity_id, changes);
    for (const criterion of criteriaToDelete) run('UPDATE criteria SET deleted_at = ?, updated_at = ? WHERE id = ?', now(), now(), criterion.id);
    if (accepted) run("UPDATE task_briefs SET status = 'draft', accepted_by = NULL, accepted_by_name = NULL, accepted_at = NULL, updated_at = ? WHERE id = ?", now(), accepted.id);
    const previousId = h.detail.refinement_accept?.previous_accepted_brief_id;
    if (previousId) run("UPDATE task_briefs SET status = 'accepted', updated_at = ? WHERE id = ?", now(), previousId);
    run("UPDATE refinement_sessions SET status = 'draft', completed_at = NULL, updated_at = ?, base_task_version = ? WHERE id = ?", now(), cur.version + (Object.keys(changes).length ? 1 : 0), h.detail.refinement_accept?.session_id);
    const newId = log(actor, 'revert', 'task', h.entity_id, h.task_id, {
      changes, reverted_action: h.action, reverted_actor: h.actor, reverted_actor_name: h.actor_name,
      refinement_revert: { brief_id: accepted?.id || h.detail.refinement_accept?.brief_id, deleted_criteria: criteriaToDelete.map((criterion) => criterion.id), restored_previous_brief_id: previousId || null },
    }, h.id);
    run('UPDATE history SET reverted_by = ? WHERE id = ?', newId, h.id);
    for (const criterion of criteriaToDelete) run("UPDATE history SET reverted_by = ? WHERE entity = 'criteria' AND entity_id = ? AND action = 'criteria.add' AND reverted_by IS NULL", newId, criterion.id);
    const task = getTaskRow(h.task_id, { includeDeleted: true });
    emit('task.updated', { task_id: h.task_id, task, action: 'revert', changes });
    emit('refinement.updated', { task_id: h.task_id, task, refinement: refinementView(getRefinementSessionRow(h.detail.refinement_accept?.session_id)) });
    return { history: getHistory(newId), task };
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
      if (h.action === 'task.refine_accept' && h.detail.refinement_accept) return revertRefinementAcceptance(h, actor, { force });
      if (h.action === 'refinement.brief_edit') return revertRefinementBriefEdit(h, actor, { force });
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
    const current = currentRefinementSessionRow(id);
    const latest = latestRefinementSessionRow(id);
    t.refinement = refinementView(current || (latest && ['accepted', 'failed', 'cancelled'].includes(latest.status) ? latest : null));
    t.brief = rowToBrief(get("SELECT * FROM task_briefs WHERE task_id = ? AND status = 'accepted' ORDER BY id DESC LIMIT 1", id));
    t.ai_usage = listAiUsage(id);
    t.ai_cost = summarizeAiUsage(id);
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
      refinement_sessions: all('SELECT * FROM refinement_sessions ORDER BY id').map(rowToRefinementSession),
      refinement_questions: all('SELECT * FROM refinement_questions ORDER BY id').map(rowToRefinementQuestion),
      task_briefs: all('SELECT * FROM task_briefs ORDER BY id').map(rowToBrief),
      ai_usage: all('SELECT * FROM ai_usage ORDER BY id').map(rowToAiUsage),
      history: all('SELECT * FROM history ORDER BY id').map(rowToHistory),
    };
  }

  function close() { db.close(); }

  return {
    lanes, laneIds, policy, db, filesDir, on,
    listProjects, getProject, createProject, updateProject,
    getSettings, updateSettings,
    listTasks, getTask, createTask, updateTask, moveTask, startTask, askTask, handoffTask, holdTask, doneTask, approveTask, archiveTask, deleteTask, restoreTask, purge,
    requestRefinement, listRefinements, getRefinement, getAcceptedBrief, submitRefinementQuestions, answerRefinement, saveRefinementBrief, editRefinementBrief, acceptRefinementBrief, cancelRefinement, failRefinement, retryRefinement,
    listCriteria, addCriterion, updateCriterion, deleteCriterion,
    listNotes, addNote, updateNote, deleteNote,
    listFiles, getFile, filePath, addFile, deleteFile,
    listAiUsage, summarizeAiUsage, recordAiUsage,
    listHistory, activity, getHistory, revert,
    board, exportAll, close,
  };
}
