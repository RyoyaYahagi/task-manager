import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP_SOURCE = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/m, '');

function fakeElement(id = '') {
  const listeners = new Map();
  const children = [];
  return {
    id,
    value: '',
    checked: false,
    hidden: false,
    innerHTML: '',
    dataset: {},
    children,
    listeners,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    appendChild(child) { children.push(child); },
    remove() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
    select() {},
    showModal() {},
    close() {},
    reset() {},
  };
}

function createLegacyShellContext() {
  const missing = new Set(['tagList', 'classificationBtn', 'classificationStatusBadge', 'classificationDialog', 'classificationStatus', 'classificationMode', 'classificationInfo', 'classificationCandidates', 'reclassifyAll']);
  const elements = new Map();
  const getElement = (id) => {
    if (missing.has(id)) return null;
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const lanes = [{ id: 'todo', name: '未着手', short: '未着手', color: '#94a3b8' }];
  const task = {
    id: 1, title: '詳細表示の再現', description: '', status: 'todo', waiting_reason: '', assignee: 'both', priority: 2,
    due: null, project_id: null, parent_id: null, tags: [], classification_suggestions: [], worker: '', needs_review: false,
    position: 1, version: 1, created_by: 'human', created_at: '', updated_at: '', archived_at: null, deleted_at: null,
    note_count: 0, file_count: 0, sub_total: 0, sub_done: 0, crit_total: 0, crit_done: 0, last_note: null,
    project: null, criteria: [], notes: [], files: [], subtasks: [], parent: null, history: [],
  };
  const meta = { lanes, policy: {}, note_max: 300, file_max: 20 * 1024 * 1024, auth: false };
  const board = { lanes, tasks: [task], projects: [], tags: [], generated_at: '' };
  const fetchImpl = async (path) => {
    const data = String(path).includes('/api/meta') ? meta : String(path).includes('/api/board') ? board : task;
    return { status: 200, ok: true, text: async () => JSON.stringify(data) };
  };
  const document = {
    title: '',
    body: getElement('body'),
    documentElement: getElement('documentElement'),
    activeElement: null,
    querySelector(selector) {
      if (selector.startsWith('#')) return getElement(selector.slice(1));
      return null;
    },
    querySelectorAll() { return []; },
    createElement: () => fakeElement(),
    addEventListener() {},
  };
  const context = {
    document,
    window: { innerWidth: 1024, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { serviceWorker: { register: async () => {} } },
    location: { hash: '', pathname: '/' },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: fetchImpl,
    EventSource: class { addEventListener() {} },
    FormData: class {},
    Blob: class {},
    URLSearchParams,
    setInterval: () => 0,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    confirm: () => true,
    console,
    renderMarkdown: () => '',
    esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  return { context, elements, getElement };
}

test('a mixed old shell does not prevent task detail tabs from rendering', async () => {
  const { context, elements } = createLegacyShellContext();
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const board = elements.get('board');
  assert.match(board.innerHTML, /data-id="1"/, `board did not render; toasts=${JSON.stringify(elements.get('toasts')?.children.map((child) => child.textContent) ?? [])}`);
  const card = { dataset: { id: '1' }, classList: { add() {}, remove() {} }, closest(selector) { return selector === '.card' ? this : null; } };
  board.listeners.get('click')({ target: card });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.match(elements.get('detail').innerHTML, /data-tab="notes"/);
  assert.match(elements.get('detail').innerHTML, /data-tab="history"/);
});
