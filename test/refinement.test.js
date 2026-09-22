import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { assessBrief, normalizeBrief, normalizeQuestionItems } from '../src/refinement.js';
import { makeStore, startServer, HUMAN, AGENT } from './helpers.js';

describe('task refinement', () => {
  test('normalizes a brief and keeps readiness rules explicit', () => {
    const brief = normalizeBrief({
      problem: '  手戻り  ',
      deliverables: '仕様書\n実装',
      open_questions: [{ text: '期限', blocking: false }],
      criteria: ['確認できる'],
      next_action: 'レビュー',
    });
    assert.deepEqual(brief.deliverables, ['仕様書', '実装']);
    assert.equal(assessBrief(brief).ready, true);
    assert.equal(assessBrief({ problem: 'x' }).ready, false);
    assert.deepEqual(assessBrief({ problem: 'x' }).missing.map((x) => x.field), ['deliverables', 'criteria', 'next_action']);
    assert.throws(() => normalizeQuestionItems([]), /1\.\.12/);
  });

  describe('store lifecycle', () => {
    let store, close;
    beforeEach(() => ({ store, close } = makeStore()));
    afterEach(() => close());

    test('asks, answers, proposes, edits, accepts, and imports criteria', () => {
      const task = store.createTask({ title: '曖昧な研究タスク' }, HUMAN);
      const requested = store.requestRefinement(task.id, HUMAN, { version: task.version });
      assert.equal(requested.task.status, 'waiting_agent');
      assert.equal(requested.task.agent_mode, 'refine');
      assert.equal(requested.refinement.status, 'pending');
      assert.throws(() => store.requestRefinement(task.id, AGENT), (e) => e.status === 403);

      const started = store.startTask(task.id, AGENT, { version: requested.task.version });
      const questions = store.submitRefinementQuestions(requested.refinement.id, [
        { question: '何を解決しますか？', blocking: true },
        { question: '期限は決まっていますか？', blocking: false },
      ], AGENT, { version: started.version });
      assert.equal(questions.task.waiting_reason, 'question');
      assert.equal(questions.refinement.status, 'waiting_user');
      assert.throws(() => store.askTask(task.id, '自由形式の質問', AGENT), (e) => e.code === 'refinement_use_questions');

      assert.throws(() => store.answerRefinement(requested.refinement.id, [{ id: questions.refinement.questions[0].id, answer: '手戻りを減らす' }], HUMAN, { version: questions.task.version }), (e) => e.code === 'questions_unanswered');
      const answered = store.answerRefinement(requested.refinement.id, [
        { id: questions.refinement.questions[0].id, kind: 'answered', answer: '手戻りを減らす' },
        { id: questions.refinement.questions[1].id, kind: 'unknown', answer: '' },
      ], HUMAN, { version: questions.task.version });
      assert.equal(answered.task.status, 'waiting_agent');
      assert.equal(answered.refinement.status, 'running');

      assert.throws(() => store.saveRefinementBrief(requested.refinement.id, { problem: 'x' }, AGENT, { version: answered.task.version }), (e) => e.code === 'brief_not_ready');
      const proposed = store.saveRefinementBrief(requested.refinement.id, {
        problem: '要件が曖昧で手戻りが起きる',
        purpose: '実行可能な依頼にする',
        deliverables: ['タスクブリーフ'],
        criteria: ['ブリーフを承認できる'],
        next_action: 'ブリーフをレビューする',
        open_questions: [{ text: '期限', blocking: false }],
      }, AGENT, { version: answered.task.version });
      assert.equal(proposed.task.waiting_reason, 'review');
      assert.equal(proposed.refinement.status, 'draft');

      const edited = store.editRefinementBrief(proposed.brief.id, { purpose: '人間がレビューできる依頼にする' }, HUMAN, { version: proposed.task.version });
      assert.equal(edited.brief.provenance.purpose, 'human_edited');
      const editHistory = store.listHistory(task.id).find((h) => h.action === 'refinement.brief_edit');
      const undoneEdit = store.revert(editHistory.id, HUMAN);
      assert.equal(store.getRefinement(requested.refinement.id).brief.content.purpose, '実行可能な依頼にする');
      const editedAgain = store.editRefinementBrief(store.getRefinement(requested.refinement.id).brief.id, { purpose: '人間がレビューできる依頼にする' }, HUMAN, { version: undoneEdit.task.version });
      const accepted = store.acceptRefinementBrief(editedAgain.brief.id, HUMAN, { version: editedAgain.task.version });
      assert.equal(accepted.task.status, 'todo');
      assert.equal(accepted.task.agent_mode, '');
      assert.equal(accepted.added_criteria.length, 1);
      assert.equal(store.getTask(task.id).brief.status, 'accepted');
      assert.equal(store.listCriteria(task.id)[0].author, 'human');

      const acceptanceHistory = store.listHistory(task.id).find((h) => h.action === 'task.refine_accept');
      const reverted = store.revert(acceptanceHistory.id, HUMAN);
      assert.equal(reverted.task.status, 'waiting_human');
      assert.equal(reverted.task.agent_mode, 'refine');
      assert.equal(store.listCriteria(task.id).length, 0);
      assert.equal(store.getRefinement(requested.refinement.id).status, 'draft');
    });

    test('failure can be retried and export includes structured records', () => {
      const task = store.createTask({ title: '再試行対象' }, HUMAN);
      const requested = store.requestRefinement(task.id, HUMAN, { version: task.version });
      const started = store.startTask(task.id, AGENT, { version: requested.task.version });
      const failed = store.failRefinement(requested.refinement.id, 'runner timeout', AGENT, { version: started.version });
      assert.equal(failed.task.status, 'on_hold');
      assert.equal(failed.refinement.status, 'failed');
      const retried = store.retryRefinement(requested.refinement.id, HUMAN, { version: failed.task.version });
      assert.equal(retried.refinement.attempt, 2);
      assert.equal(retried.task.status, 'waiting_agent');
      assert.equal(store.exportAll().refinement_sessions.length, 2);
      assert.equal(store.exportAll().task_briefs.length, 0);
    });
  });
});

describe('task refinement http api', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(async () => { await server.close(); });

  test('exposes the human review loop and structured brief', async () => {
    const created = await server.api('POST', '/api/tasks', { title: 'HTTP 精緻化' });
    const requested = await server.api('POST', `/api/tasks/${created.data.id}/refinements`, { version: created.data.version });
    assert.equal(requested.status, 200);
    const sid = requested.data.refinement.id;
    const started = await server.api('POST', `/api/tasks/${created.data.id}/start`, {}, { actor: AGENT });
    const asked = await server.api('POST', `/api/refinements/${sid}/questions`, { questions: [{ question: '目的は？' }] }, { actor: AGENT, headers: {} });
    assert.equal(asked.status, 200);
    const qid = asked.data.refinement.questions[0].id;
    const answered = await server.api('POST', `/api/refinements/${sid}/answers`, { answers: [{ id: qid, kind: 'answered', answer: '手戻りを減らす' }], version: asked.data.task.version });
    assert.equal(answered.status, 200);
    const proposed = await server.api('POST', `/api/refinements/${sid}/brief`, {
      content: { problem: '要件が曖昧', deliverables: ['ブリーフ'], criteria: ['レビュー可能'], next_action: '確認する' },
      version: answered.data.task.version,
    }, { actor: AGENT });
    assert.equal(proposed.status, 200);
    const edited = await server.api('PATCH', `/api/refinement-briefs/${proposed.data.brief.id}`, { content: { purpose: '実行可能にする' }, version: proposed.data.task.version });
    const accepted = await server.api('POST', `/api/refinement-briefs/${edited.data.brief.id}/accept`, { version: edited.data.task.version });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.task.status, 'todo');
    const full = (await server.api('GET', `/api/tasks/${created.data.id}`)).data;
    assert.equal(full.brief.content.purpose, '実行可能にする');
    assert.equal(full.criteria[0].text, 'レビュー可能');
    assert.equal((await server.api('GET', `/api/tasks/${created.data.id}/refinements`)).data.length, 1);
    assert.equal((await server.api('GET', `/api/refinements/${sid}`)).data.status, 'accepted');
    assert.equal(started.data.agent_mode, 'refine');
  });
});
