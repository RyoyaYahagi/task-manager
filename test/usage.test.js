import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageRecord, estimateCostUsd, pricingForProvider } from '../src/usage.js';
import { makeStore, HUMAN, AGENT } from './helpers.js';

test('JEV usage is converted from reported input tokens at the public rate', () => {
  const record = buildUsageRecord({
    provider: 'jev',
    model: 'jev-latest',
    response: { usage: { input_tokens: 296, output_tokens: 20 } },
  });
  assert.equal(record.input_tokens, 296);
  assert.equal(record.output_tokens, 20);
  assert.equal(record.cost_kind, 'estimated');
  assert.equal(record.cost_usd, 0.000012432);
});

test('Codex API estimate separates cached input from ordinary input', () => {
  const pricing = pricingForProvider('codex', 'gpt-5.6-luna', {});
  const cost = estimateCostUsd({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100 }, pricing);
  assert.equal(cost, 0.000248);
});

test('store exposes AI usage records and per-provider cost totals', () => {
  const { store, close } = makeStore();
  try {
    const task = store.createTask({ title: 'コスト表示テスト' }, HUMAN);
    const recorded = store.recordAiUsage(task.id, {
      provider: 'codex', model: 'gpt-5.6-luna', input_tokens: 1000, cached_input_tokens: 100,
      output_tokens: 100, cost_usd: 0.0003, cost_kind: 'estimated', pricing_source: 'test',
      metadata: { purpose: 'test', refinement_judgment: { disposition: 'reject', threshold: 0.85, response: { status: 'incomplete' } } },
    }, AGENT);
    assert.equal(recorded.provider, 'codex');
    const detail = store.getTask(task.id);
    assert.equal(detail.ai_usage.length, 1);
    assert.equal(detail.ai_usage[0].metadata.refinement_judgment.response.status, 'incomplete');
    assert.equal(detail.ai_cost.by_provider.codex.cost_usd, 0.0003);
    assert.equal(detail.ai_cost.total.calls, 1);
    assert.equal(store.exportAll().ai_usage.length, 1);
  } finally {
    close();
  }
});
