import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerPrompt, normalizePlan, parseCodexPlan, parseCodexUsage } from '../scripts/codex-refine-runner.js';

test('parseCodexPlan extracts the final agent message from Codex JSONL', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"action":"ask","questions":[{"question":"目的は？","blocking":true}]}' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  assert.deepEqual(parseCodexPlan(output), { action: 'ask', questions: [{ question: '目的は？', blocking: true }] });
});

test('parseCodexUsage extracts the completed turn usage summary', () => {
  const output = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', usage: { input_tokens: 100, output_tokens: 20 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80 } }),
  ].join('\n');
  assert.deepEqual(parseCodexUsage(output), {
    input_tokens: 1200,
    cached_input_tokens: 300,
    output_tokens: 80,
    total_tokens: 1280,
  });
});

test('normalizePlan keeps a complete brief in the API shape', () => {
  const plan = normalizePlan({
    action: 'propose',
    brief: {
      problem: '問題', purpose: '目的', background: '',
      deliverables: ['成果物'], constraints: [], out_of_scope: [], assumptions: [],
      open_questions: [{ text: '任意の確認', blocking: false }],
      next_action: '次に確認する', criteria: ['テストが通る'],
    },
  });
  assert.equal(plan.action, 'propose');
  assert.deepEqual(plan.brief.criteria, ['テストが通る']);
  assert.deepEqual(plan.brief.open_questions, [{ text: '任意の確認', blocking: false }]);
});

test('normalizePlan keeps grill-style choices and recommendation metadata', () => {
  const plan = normalizePlan({
    action: 'ask',
    questions: [{
      question: '最初に何を優先しますか？',
      blocking: true,
      options: ['手戻り削減', '速度向上'],
      recommended_option: '手戻り削減',
      recommendation_reason: '目的と完了条件を先に安定させられるためです。',
    }],
  });
  assert.deepEqual(plan.questions[0].options, ['手戻り削減', '速度向上']);
  assert.equal(plan.questions[0].recommended_option, '手戻り削減');
  assert.match(plan.questions[0].recommendation_reason, /完了条件/);
});

test('normalizePlan rejects a brief with blocking open questions', () => {
  assert.throws(() => normalizePlan({
    action: 'propose',
    brief: {
      problem: '問題', purpose: '', background: '', deliverables: ['成果物'], constraints: [], out_of_scope: [], assumptions: [],
      open_questions: [{ text: '必須確認', blocking: true }], next_action: '次に確認する', criteria: ['条件'],
    },
  }), /blocking open questions/);
});

test('buildPlannerPrompt marks board content as untrusted data', () => {
  const prompt = buildPlannerPrompt({
    id: 7,
    title: 'タイトル',
    description: '説明',
    project: null,
    tags: [],
    criteria: [],
    notes: [],
    files: [],
    refinement: { id: 9, attempt: 1, status: 'running', questions: [] },
  });
  assert.match(prompt, /ユーザーが入力したデータ/);
  assert.match(prompt, /シェル、tm、ネットワーク/);
  assert.match(prompt, /選択肢/);
  assert.match(prompt, /おすすめ/);
  assert.match(prompt, /判断の分岐点/);
  assert.match(prompt, /"title": "タイトル"/);
});
