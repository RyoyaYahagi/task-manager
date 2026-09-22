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

function createLegacyShellContext(taskOverrides = {}) {
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
    ...taskOverrides,
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
  assert.match(elements.get('detail').innerHTML, /data-act="refine-request"[\s\S]*AI深掘り/);
});

test('task refinement detail shows stage progress while AI is running', async () => {
  const { context, elements } = createLegacyShellContext({
    status: 'waiting_agent',
    agent_mode: 'refine',
    refinement: { id: 1, attempt: 1, status: 'running', questions: [], brief: null, updated_at: '' },
  });
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const board = elements.get('board');
  const card = { dataset: { id: '1' }, classList: { add() {}, remove() {} }, closest(selector) { return selector === '.card' ? this : null; } };
  board.listeners.get('click')({ target: card });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const detail = elements.get('detail').innerHTML;
  assert.match(detail, /role="progressbar"/);
  assert.match(detail, /AIが深掘り中/);
  assert.match(detail, /段階 2\/4/);
});

test('pending AI deep dive explains that it is waiting for the external runner', async () => {
  const { context, elements } = createLegacyShellContext({
    status: 'waiting_agent',
    agent_mode: 'refine',
    refinement: { id: 1, attempt: 1, status: 'pending', questions: [], brief: null, updated_at: '' },
  });
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const board = elements.get('board');
  const card = { dataset: { id: '1' }, classList: { add() {}, remove() {} }, closest(selector) { return selector === '.card' ? this : null; } };
  board.listeners.get('click')({ target: card });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const detail = elements.get('detail').innerHTML;
  assert.match(detail, /AI深掘り/);
  assert.match(detail, /外部ランナー待ち/);
  assert.match(detail, /外部ランナーが受信するまで待っています/);
});

test('AI deep dive questions show choices and the recommended answer', async () => {
  const { context, elements } = createLegacyShellContext({
    status: 'waiting_human',
    waiting_reason: 'question',
    agent_mode: 'refine',
    refinement: {
      id: 1,
      attempt: 1,
      status: 'waiting_user',
      questions: [{
        id: 3,
        round_no: 1,
        question: '最初に何を優先しますか？',
        blocking: true,
        options: ['手戻り削減', '速度向上'],
        recommended_option: '手戻り削減',
        recommendation_reason: '完了条件を先に安定させられるためです。',
        answer_kind: null,
      }],
      brief: null,
      updated_at: '',
    },
  });
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const board = elements.get('board');
  const card = { dataset: { id: '1' }, classList: { add() {}, remove() {} }, closest(selector) { return selector === '.card' ? this : null; } };
  board.listeners.get('click')({ target: card });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const detail = elements.get('detail').innerHTML;
  assert.match(detail, /type="radio"/);
  assert.match(detail, /選択肢（クリックして選択）/);
  assert.match(detail, /その他（自由回答）/);
  assert.match(detail, /手戻り削減（おすすめ）/);
  assert.match(detail, /おすすめの理由/);
  assert.match(detail, /完了条件を先に安定させられるためです/);
});

test('task detail shows JEV and Codex usage costs', async () => {
  const { context, elements } = createLegacyShellContext({
    ai_usage: [{ id: 1, provider: 'codex', model: 'gpt-5.6-luna', cost_usd: 0.005712, cost_kind: 'estimated', created_at: '' }],
    ai_cost: {
      total: { calls: 1, cost_usd: 0.005712, cost_complete: true, cost_kind: 'estimated' },
      by_provider: {
        jev: { calls: 0 },
        codex: { calls: 1, cost_usd: 0.005712, cost_kind: 'estimated', input_tokens: 100, output_tokens: 20 },
      },
    },
  });
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const board = elements.get('board');
  const card = { dataset: { id: '1' }, classList: { add() {}, remove() {} }, closest(selector) { return selector === '.card' ? this : null; } };
  board.listeners.get('click')({ target: card });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const detail = elements.get('detail').innerHTML;
  assert.match(detail, /AI利用コスト/);
  assert.match(detail, /Codex/);
  assert.match(detail, /\$0\.005712/);
});

test('task detail shows the saved JEV judgment reason and confidence', async () => {
  const { context, elements } = createLegacyShellContext({
    status: 'on_hold',
    agent_mode: 'refine',
    refinement: { id: 1, attempt: 1, status: 'failed', error: 'JEVの確認で停止しました。', questions: [], brief: null, updated_at: '' },
    ai_usage: [{
      id: 2,
      provider: 'jev',
      model: 'jev-latest',
      cost_usd: 0.0001,
      cost_kind: 'estimated',
      created_at: '',
      metadata: {
        refinement_judgment: {
          disposition: 'reject',
          threshold: 0.85,
          route: { choice: 'reject', raw: 'reject', confidence: 0.93 },
          checks: { safe: 0.04 },
          findings: [{ kind: 'safety', label: '安全性', detail: '安全性は4%でした。' }],
          response: { status: 'valid', missing_keys: [], invalid_keys: [] },
        },
      },
    }],
  });
  vm.runInNewContext(APP_SOURCE, context, { filename: 'public/app.js' });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const board = elements.get('board');
  const card = { dataset: { id: '1' }, classList: { add() {}, remove() {} }, closest(selector) { return selector === '.card' ? this : null; } };
  board.listeners.get('click')({ target: card });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const detail = elements.get('detail').innerHTML;
  assert.match(detail, /JEVの判定詳細/);
  assert.match(detail, /93%/);
  assert.match(detail, /4%/);
  assert.match(detail, /安全性は4%でした/);
  assert.match(detail, /JSON形式/);
  assert.match(detail, /正常/);
});
