import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskClassifier } from '../src/classifier.js';
import { makeStore, HUMAN } from './helpers.js';

const CONFIG = {
  threshold: 0.85,
  create_missing_projects: false,
  projects: [
    { key: 'research', name: '研究・調査', description: '研究と調査' },
    { key: 'development', name: '開発・実装', description: '開発と実装' },
  ],
  tags: [
    { key: 'research', name: '調査', description: '調べる仕事' },
    { key: 'implementation', name: '実装', description: '作る仕事' },
  ],
};

async function waitFor(fn, timeout = 1000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return fn();
}

function mockFetch({ project = 'research', projectConfidence = 0.96, research = 0.94, implementation = 0.12 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, request: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      answers: {
        project: { type: 'choice', choice: project, confidence: projectConfidence },
        tag_0: { type: 'noul', noul: research },
        tag_1: { type: 'noul', noul: implementation },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

describe('JEV task classifier', () => {
  test('applies only high-confidence allowlisted project and tags', async () => {
    const { store, close } = makeStore();
    const project = store.createProject({ name: '研究・調査' }, HUMAN);
    store.updateSettings({ classification_mode: 'high_confidence' }, HUMAN);
    const { calls, fetchImpl } = mockFetch();
    const classifier = createTaskClassifier({ store, config: CONFIG, apiKey: 'test-key', baseUrl: 'https://jev.test', fetchImpl, logger: { warn() {} } });
    try {
      const created = store.createTask({ title: '文献を調べる', description: '根拠を整理する', criteria: ['結果を記録する'] }, HUMAN);
      const classified = await waitFor(() => {
        const task = store.getTask(created.id);
        return task.tags.includes('調査') ? task : null;
      });
      assert.ok(classified);
      assert.equal(classified.project_id, project.id);
      assert.deepEqual(classified.tags, ['調査']);
      assert.deepEqual(classified.classification_suggestions, []);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://jev.test/v1/systemone');
      assert.equal(calls[0].request.questions.project.type, 'choice');
      assert.equal(calls[0].request.questions.tag_0.type, 'noul');
      assert.equal(classified.history[0].action, 'task.auto_classify');
      assert.equal(classified.history[0].actor_name, 'jev-auto-classifier');
      assert.equal(classified.history[0].detail.classification.threshold, 0.85);
    } finally {
      classifier.close();
      close();
    }
  });

  test('does not call JEV when the mode is off', async () => {
    const { store, close } = makeStore();
    const { calls, fetchImpl } = mockFetch();
    const classifier = createTaskClassifier({ store, config: CONFIG, apiKey: 'test-key', fetchImpl, logger: { warn() {} } });
    try {
      store.createTask({ title: '分類しない' }, HUMAN);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(calls.length, 0);
      assert.equal(store.getSettings().classification_mode, 'off');
    } finally {
      classifier.close();
      close();
    }
  });

  test('does not reflect a low-confidence answer', async () => {
    const { store, close } = makeStore();
    store.createProject({ name: '研究・調査' }, HUMAN);
    store.updateSettings({ classification_mode: 'high_confidence' }, HUMAN);
    const { calls, fetchImpl } = mockFetch({ projectConfidence: 0.84, research: 0.84 });
    const classifier = createTaskClassifier({ store, config: CONFIG, apiKey: 'test-key', fetchImpl, logger: { warn() {} } });
    try {
      const created = store.createTask({ title: '確信度が低い' }, HUMAN);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const task = store.getTask(created.id);
      assert.equal(calls.length, 1);
      assert.equal(task.project_id, null);
      assert.deepEqual(task.tags, []);
      assert.equal(task.history[0].action, 'task.create');
    } finally {
      classifier.close();
      close();
    }
  });

  test('manual reclassification can replace configured classifications and returns missing-project proposals', async () => {
    const { store, close } = makeStore();
    store.createProject({ name: '研究・調査' }, HUMAN);
    const { fetchImpl } = mockFetch({ project: 'development', projectConfidence: 0.97, research: 0.2, implementation: 0.96 });
    const classifier = createTaskClassifier({ store, config: CONFIG, apiKey: 'test-key', fetchImpl, logger: { warn() {} } });
    try {
      const task = store.createTask({ title: '実装へ切り替える', project: '研究・調査', tags: ['調査', '手動'] }, HUMAN);
      const result = await classifier.classifyNow(task.id, { force: true, reclassify: true });
      assert.ok(result.changed);
      assert.equal(result.suggestions.length, 1);
      assert.equal(result.suggestions[0].name, '開発・実装');
      assert.equal(store.getTask(task.id).project.name, '研究・調査');
      assert.deepEqual(store.getTask(task.id).tags, ['手動', '実装']);
      assert.deepEqual(store.getTask(task.id).classification_suggestions, [{ kind: 'project', key: 'development', name: '開発・実装', confidence: 0.97 }]);
      assert.equal(store.listProjects().some((project) => project.name === '開発・実装'), false);
    } finally {
      classifier.close();
      close();
    }
  });

  test('applies stored project and tag suggestions and records a human action', async () => {
    const { store, close } = makeStore();
    const { fetchImpl } = mockFetch({ project: 'development', projectConfidence: 0.97, research: 0.2, implementation: 0.96 });
    const classifier = createTaskClassifier({ store, config: CONFIG, apiKey: 'test-key', fetchImpl, logger: { warn() {} } });
    try {
      const task = store.createTask({ title: '候補を反映する' }, HUMAN);
      const classified = await classifier.classifyNow(task.id, { force: true, reclassify: true });
      assert.deepEqual(classified.suggestions.map((suggestion) => suggestion.name), ['開発・実装']);
      assert.deepEqual(classified.tags.map((tag) => tag.name), ['実装']);

      const applied = classifier.applySuggestions(task.id, HUMAN);
      assert.equal(applied.changed, true);
      assert.equal(applied.remaining.length, 0);
      assert.equal(applied.task.project.name, '開発・実装');
      assert.deepEqual(applied.task.tags, ['実装']);
      assert.deepEqual(applied.task.classification_suggestions, []);
      const appliedTask = store.getTask(task.id);
      assert.equal(appliedTask.history[0].action, 'task.classification_apply');
      assert.equal(appliedTask.history[0].actor_name, 'ryoya');
    } finally {
      classifier.close();
      close();
    }
  });
});
