import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildPlannerPrompt,
  formatRunnerError,
  normalizePlan,
  parseCodexPlan,
  parseCodexUsage,
  parseSseEventBlock,
  shouldWakeForEvent,
  subscribeToEvents,
  createWakeGate,
} from '../scripts/codex-refine-runner.js';

function assertStrictOutputSchema(schema, location = 'root') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${location} must disable additional properties`);
    const propertyNames = Object.keys(schema.properties || {}).sort();
    const requiredNames = [...(schema.required || [])].sort();
    assert.deepEqual(requiredNames, propertyNames, `${location} must require every property`);
  }
  for (const [index, branch] of (schema.anyOf || []).entries()) {
    assertStrictOutputSchema(branch, `${location}.anyOf[${index}]`);
  }
  for (const [index, branch] of (schema.oneOf || []).entries()) {
    assertStrictOutputSchema(branch, `${location}.oneOf[${index}]`);
  }
  assertStrictOutputSchema(schema.items, `${location}.items`);
  for (const [name, property] of Object.entries(schema.properties || {})) {
    assertStrictOutputSchema(property, `${location}.properties.${name}`);
  }
}

test('parseCodexPlan extracts the final agent message from Codex JSONL', () => {
  const output = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"action":"ask","questions":[{"question":"目的は？","blocking":true}]}' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
  assert.deepEqual(parseCodexPlan(output), { action: 'ask', questions: [{ question: '目的は？', blocking: true }] });
});

test('Codex output schema is compatible with strict structured outputs', () => {
  const schema = JSON.parse(readFileSync(new URL('../config/codex-refine-output.schema.json', import.meta.url), 'utf8'));
  assertStrictOutputSchema(schema);
});

test('formatRunnerError preserves child stderr while redacting credential-shaped values', () => {
  const error = Object.assign(new Error('/home/yappa/.local/bin/codex failed (exit 1)'), {
    stderr: 'invalid_request_error token=secret-value Authorization: Bearer abc123',
  });
  const formatted = formatRunnerError(error);
  assert.match(formatted, /invalid_request_error/);
  assert.match(formatted, /token=<redacted>/);
  assert.match(formatted, /Bearer <redacted>/);
  assert.doesNotMatch(formatted, /secret-value|abc123/);
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

test('normalizePlan accepts the minimal brief without optional fields', () => {
  const plan = normalizePlan({
    action: 'propose',
    brief: {
      purpose: '確認可能な依頼にする',
      deliverables: ['タスクブリーフ'],
      criteria: ['人間が内容を確認できる'],
      provenance: { purpose: 'user', deliverables: 'user', criteria: 'user' },
    },
  });
  assert.equal(plan.brief.next_action, '');
  assert.deepEqual(plan.brief.background, '');
  assert.deepEqual(plan.brief.constraints, []);
  assert.deepEqual(plan.brief.open_questions, []);
});

test('normalizePlan preserves explicit brief provenance without treating it as content', () => {
  const plan = normalizePlan({
    action: 'propose',
    brief: {
      problem: '問題', purpose: '', background: '', deliverables: ['成果物'], constraints: [], out_of_scope: [], assumptions: ['仮置き'],
      open_questions: [], next_action: '次に確認する', criteria: ['条件'],
      provenance: { problem: 'user', deliverables: 'user', assumptions: 'assumption', next_action: 'inference', criteria: 'user' },
    },
  });
  assert.equal(plan.brief.provenance.problem, 'user');
  assert.equal(plan.brief.provenance.assumptions, 'assumption');
  assert.equal(plan.brief.provenance.next_action, 'inference');
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
  assert.match(prompt, /ラウンド数に上限は設けません/);
  assert.match(prompt, /frontierに属する質問は漏れなく同じラウンド/);
  assert.match(prompt, /action=askを返したラウンドでは/);
  assert.match(prompt, /provenance/);
  assert.match(prompt, /推測で提案せずaction=ask/);
  assert.match(prompt, /next_actionが未定でも/);
  assert.match(prompt, /空配列・空文字のまま/);
  assert.match(prompt, /"title": "タイトル"/);
});

test('buildPlannerPrompt applies the high-quality deep-dive protocol', () => {
  const prompt = buildPlannerPrompt({
    id: 42,
    title: '採用済みブリーフの見直し',
    description: '元ブリーフと後から決まった内容を比較する',
    project: null,
    tags: [],
    criteria: [{ text: '成功条件が確認できる', done: false }],
    notes: [],
    files: [],
    brief: {
      id: 7,
      revision: 2,
      status: 'accepted',
      content: {
        problem: '元の問題',
        purpose: '元の目的',
        deliverables: ['元の成果物'],
        constraints: [],
        out_of_scope: [],
        assumptions: [],
        open_questions: [],
        next_action: '元の次の行動',
        criteria: ['元の条件'],
      },
      provenance: { purpose: 'user' },
    },
    refinement: {
      id: 9,
      attempt: 1,
      status: 'running',
      questions: [],
    },
  });

  assert.match(prompt, /accepted_brief/);
  assert.match(prompt, /高品質な深掘りのプロトコル/);
  assert.match(prompt, /正常系だけでなく主要な失敗系/);
  assert.match(prompt, /現在のfrontierだけを質問/);
  assert.match(prompt, /propose前に/);
  assert.match(prompt, /承認なしに整合したことにしない/);
  assert.match(prompt, /frontierが空になり/);
  assert.match(prompt, /人間が確認・編集・acceptするためのドラフト/);
  assert.match(prompt, /元の問題/);
});

test('parseSseEventBlock parses the event name and JSON data', () => {
  assert.deepEqual(parseSseEventBlock([
    'event: refinement.updated',
    'data: {"type":"refinement.updated","task":{"id":7}}',
  ].join('\n')), {
    event: 'refinement.updated',
    type: 'refinement.updated',
    task: { id: 7 },
  });
  assert.equal(parseSseEventBlock(': keep-alive\n\n'), null);
});

test('shouldWakeForEvent only wakes for queued AI deep-dive work', () => {
  const queued = {
    type: 'refinement.updated',
    task: { id: 7, agent_mode: 'refine', status: 'waiting_agent' },
    refinement: { id: 9, status: 'pending' },
  };
  assert.equal(shouldWakeForEvent(queued), true);
  assert.equal(shouldWakeForEvent({ ...queued, refinement: { id: 9, status: 'running' } }), true);
  assert.equal(shouldWakeForEvent({ ...queued, task: { ...queued.task, status: 'waiting_human' } }), false);
  assert.equal(shouldWakeForEvent({ ...queued, task: { ...queued.task, agent_mode: 'execute' } }), false);
  assert.equal(shouldWakeForEvent({ ...queued, type: 'task.updated' }), false);
});

test('createWakeGate runs immediately, then releases on an event before reconciliation', async () => {
  const gate = createWakeGate(60 * 1000);
  await gate.wait();
  assert.equal(gate.hasPending(), false);
  const waiting = gate.wait();
  gate.wake();
  await waiting;
  assert.equal(gate.hasPending(), false);
});

test('subscribeToEvents delivers SSE events until the subscriber is aborted', async () => {
  const controller = new AbortController();
  const received = [];
  async function* body() {
    yield Buffer.from('event: hello\ndata: {"type":"hello"}\n\n');
    yield Buffer.from('event: refinement.updated\ndata: {"type":"refinement.updated","task":{"id":7,"agent_mode":"refine","status":"waiting_agent"},"refinement":{"id":9,"status":"pending"}}\n\n');
  }
  await subscribeToEvents({
    baseUrl: 'http://127.0.0.1:3000',
    signal: controller.signal,
    fetchImpl: async () => ({ ok: true, status: 200, body: body() }),
    logger: () => {},
    onEvent: (event) => {
      received.push(event);
      if (shouldWakeForEvent(event)) controller.abort();
    },
  });
  assert.equal(received.length, 2);
  assert.equal(shouldWakeForEvent(received[1]), true);
});
