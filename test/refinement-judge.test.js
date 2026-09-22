import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJevRecommendations,
  buildJevReviewQuestions,
  buildRefinementJudgeRequest,
  createRefinementJudge,
  evaluateRefinementJudgeResponse,
} from '../src/refinement-judge.js';

const task = {
  id: 12,
  title: '曖昧なタスク',
  description: '何を作るか整理したい',
  project: { name: '開発・実装', description: '作る仕事' },
  tags: ['実装'],
  criteria: [{ text: '人間が確認できる', done: false }],
  notes: [{ body: '期限は未確認', kind: 'note' }],
  refinement: { status: 'running', attempt: 1, questions: [] },
};

test('buildRefinementJudgeRequest asks JEV to route, guard, and select among Codex choices', () => {
  const plan = {
    action: 'ask',
    questions: [{
      question: '最初に何を優先しますか？',
      blocking: true,
      options: ['手戻りを減らす', '速度を上げる'],
      recommended_option: '速度を上げる',
      recommendation_reason: '早く進められるため',
    }],
  };
  const request = buildRefinementJudgeRequest(task, plan, { model: 'jev-test' });
  assert.equal(request.model, 'jev-test');
  assert.equal(request.questions.route.type, 'choice');
  assert.equal(request.questions.safe.type, 'noul');
  assert.equal(request.questions.recommendation_0.type, 'choice');
  assert.deepEqual(request.questions.recommendation_0.criteria.option_0, '手戻りを減らす');
  assert.match(request.state.codex_output.questions[0].question, /優先/);
});

test('JEV can replace Codex recommendation selection when confidence is high', () => {
  const plan = {
    action: 'ask',
    questions: [{
      question: '最初に何を優先しますか？',
      blocking: true,
      options: ['手戻りを減らす', '速度を上げる'],
      recommended_option: '速度を上げる',
      recommendation_reason: '早く進められるため',
    }],
  };
  const judgment = evaluateRefinementJudgeResponse({ answers: {
    route: { choice: 'accept', confidence: 0.96 },
    safe: { noul: 0.99 },
    frontier: { noul: 0.94 },
    recommendation_0: { choice: 'option_0', confidence: 0.92 },
  } }, plan);
  assert.equal(judgment.disposition, 'accept');
  assert.deepEqual(judgment.recommendations[0], { index: 0, option: '手戻りを減らす', confidence: 0.92, accepted: true });

  const updated = applyJevRecommendations(plan, judgment);
  assert.equal(updated.questions[0].recommended_option, '手戻りを減らす');
  assert.match(updated.questions[0].recommendation_reason, /JEV/);
});

test('JEV accepts a complete and safe Codex brief', () => {
  const plan = { action: 'propose', brief: { problem: '問題', deliverables: ['成果物'], criteria: ['確認できる'], next_action: 'レビューする' } };
  const judgment = evaluateRefinementJudgeResponse({ answers: {
    route: { choice: 'accept', confidence: 0.96 },
    safe: { noul: 0.99 },
    brief_ready: { noul: 0.94 },
    criteria_actionable: { noul: 0.93 },
    unsupported_inference: { noul: 0.04 },
  } }, plan);
  assert.equal(judgment.disposition, 'accept');
  assert.deepEqual(judgment.findings, []);
});

test('JEV routes a weak Codex brief back to a human question', () => {
  const plan = { action: 'propose', brief: { problem: '問題', deliverables: ['成果物'], criteria: ['曖昧'], next_action: '進める' } };
  const judgment = evaluateRefinementJudgeResponse({ answers: {
    route: { choice: 'review', confidence: 0.94 },
    safe: { noul: 0.97 },
    brief_ready: { noul: 0.41 },
    criteria_actionable: { noul: 0.32 },
    unsupported_inference: { noul: 0.9 },
  } }, plan);
  assert.equal(judgment.disposition, 'review');
  const questions = buildJevReviewQuestions(judgment);
  assert.equal(questions.length, 1);
  assert.ok(questions[0].options.length >= 2);
  assert.equal(questions[0].recommended_option, '目的・成果物を具体化する');
});

test('JEV rejects an unsafe Codex output instead of displaying it', () => {
  const plan = { action: 'propose', brief: { problem: '問題', deliverables: ['成果物'], criteria: ['条件'], next_action: '進める' } };
  const judgment = evaluateRefinementJudgeResponse({ answers: {
    route: { choice: 'reject', confidence: 0.93 },
    safe: { noul: 0.04 },
    brief_ready: { noul: 0.9 },
    criteria_actionable: { noul: 0.9 },
    unsupported_inference: { noul: 0.02 },
  } }, plan);
  assert.equal(judgment.disposition, 'reject');
  assert.ok(judgment.findings.some((item) => item.kind === 'safety'));
});

test('JEV judgment keeps confidence and explicit reasons for rejection', () => {
  const plan = { action: 'ask', questions: [{ question: '何を優先しますか？', blocking: true, options: ['品質', '速度'] }] };
  const judgment = evaluateRefinementJudgeResponse({ answers: {
    route: { choice: 'reject', confidence: 0.93 },
    safe: { noul: 0.04 },
    frontier: { noul: 0.91 },
    recommendation_0: { choice: 'option_0', confidence: 0.9 },
  } }, plan);

  assert.equal(judgment.disposition, 'reject');
  assert.equal(judgment.response.status, 'valid');
  assert.equal(judgment.route.confidence, 0.93);
  assert.equal(judgment.checks.safe, 0.04);
  assert.ok(judgment.findings.some((item) => item.kind === 'safety' && /4%/.test(item.detail)));
  assert.ok(judgment.findings.some((item) => item.kind === 'route'));
});

test('JEV judgment reports incomplete answer JSON instead of hiding the cause', () => {
  const plan = { action: 'ask', questions: [{ question: '何を優先しますか？', blocking: true, options: ['品質', '速度'] }] };
  const judgment = evaluateRefinementJudgeResponse({ answers: {
    route: { choice: 'accept', confidence: 0.91 },
  } }, plan);

  assert.equal(judgment.disposition, 'reject');
  assert.equal(judgment.response.status, 'incomplete');
  assert.ok(judgment.response.missing_keys.includes('safe'));
  assert.ok(judgment.response.missing_keys.includes('frontier'));
  assert.ok(judgment.findings.some((item) => item.kind === 'response_format'));
});

test('JEV client records invalid JSON as a rejected refinement judgment', async () => {
  const judge = createRefinementJudge({
    gatewayUrl: 'https://jev.test/v1/systemone',
    model: 'jev-test',
    fetchImpl: async () => new Response('{not-json', { status: 200 }),
  });
  const result = await judge.judge(task, { action: 'propose', brief: { problem: '問題' } });

  assert.equal(result.disposition, 'reject');
  assert.equal(result.response.status, 'invalid_json');
  assert.equal(result.usage_record.metadata.refinement_judgment.response.status, 'invalid_json');
});
