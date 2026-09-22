// JEV-backed task classification. The workflow is deliberately kept here so
// the store remains the single authority for validation, locking, and audit.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUsageRecord } from './usage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLASSIFICATION_FILE = path.join(here, '..', 'config', 'classification.json');
export const DEFAULT_JEV_GATEWAY_URL = 'http://127.0.0.1:4789/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const DEFAULT_JEV_TIMEOUT_MS = 10000;
export const DEFAULT_CLASSIFICATION_THRESHOLD = 0.85;
export const AUTO_CLASSIFIER_ACTOR = { kind: 'agent', name: 'jev-auto-classifier' };
const MAX_TAGS = 20;

export class JevResponseError extends Error {
  constructor(message, { status = 'invalid_response', response = null, jsonValid = false } = {}) {
    super(message);
    this.name = 'JevResponseError';
    this.responseStatus = status;
    this.response = response;
    this.jsonValid = jsonValid;
  }
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function definition(item, kind, index) {
  if (typeof item === 'string') item = { name: item };
  if (!item || typeof item !== 'object') throw new Error(`${kind}[${index}] must be an object or string`);
  const name = String(item.name || '').trim();
  if (!name || name.length > 60) throw new Error(`${kind}[${index}].name is required (max 60)`);
  const key = String(item.key || `${kind}_${index}`).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/.test(key)) throw new Error(`${kind}[${index}].key is invalid`);
  return { key, name, description: String(item.description || '').trim().slice(0, 500) };
}

function definitions(items, kind) {
  if (items == null) return [];
  if (!Array.isArray(items)) throw new Error(`${kind} must be an array`);
  const out = items.map((item, index) => definition(item, kind, index));
  const keys = new Set();
  for (const item of out) {
    if (keys.has(item.key)) throw new Error(`duplicate ${kind} key: ${item.key}`);
    keys.add(item.key);
  }
  return out;
}

export function normalizeClassification(input = {}) {
  const threshold = Number(input.threshold ?? DEFAULT_CLASSIFICATION_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('classification threshold must be between 0 and 1');
  return {
    threshold,
    create_missing_projects: input.create_missing_projects === true,
    projects: definitions(input.projects, 'project'),
    tags: definitions(input.tags, 'tag'),
  };
}

export function loadClassification(file = process.env.TM_CLASSIFICATION_CONFIG || DEFAULT_CLASSIFICATION_FILE) {
  return normalizeClassification(JSON.parse(readFileSync(file, 'utf8')));
}

function endpointFor(gatewayUrl) {
  const base = trimSlash(gatewayUrl || DEFAULT_JEV_GATEWAY_URL);
  if (base.endsWith('/systemone')) return base;
  if (base.endsWith('/v1')) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

export function createJevClient({
  gatewayUrl = process.env.JEV_GATEWAY_URL || DEFAULT_JEV_GATEWAY_URL,
  gatewayToken = process.env.JEV_GATEWAY_TOKEN || '',
  model = DEFAULT_JEV_MODEL,
  timeoutMs = DEFAULT_JEV_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available for JEV');
  const endpoint = endpointFor(gatewayUrl);
  const token = String(gatewayToken || '').trim();

  return {
    endpoint,
    async classify({ state, questions }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_JEV_TIMEOUT_MS));
      try {
        const headers = { 'content-type': 'application/json' };
        if (token) headers.authorization = `Bearer ${token}`;
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, state, questions }),
          signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        let jsonValid = true;
        try { body = text ? JSON.parse(text) : null; } catch { jsonValid = false; }
        if (!response.ok) {
          const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
          throw new Error(`JEV request failed (${response.status})${message ? `: ${message}` : ''}`);
        }
        if (!jsonValid) throw new JevResponseError('JEV response was not valid JSON', { status: 'invalid_json', jsonValid: false });
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new JevResponseError('JEV response was not a JSON object', { status: 'invalid_shape', response: body, jsonValid: true });
        }
        if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) {
          throw new JevResponseError('JEV response did not contain answers', { status: 'incomplete', response: body, jsonValid: true });
        }
        return body;
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('JEV request timed out');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

function projectName(task) {
  return task.project?.name || null;
}

export function buildJevRequest(task, { projects = [], tags = [], model = DEFAULT_JEV_MODEL } = {}) {
  const questions = {};
  if (projects.length) {
    const criteria = Object.fromEntries(projects.map((p) => [p.key, `${p.name}${p.description ? `: ${p.description}` : ''}`]));
    criteria.none = 'どの候補にも明確に該当しない';
    questions.project = {
      type: 'choice',
      instructions: 'タスクの主目的に最も合うプロジェクトを1つ選ぶ。確信が低い場合や複数にまたがる場合は none を選ぶ。',
      criteria,
    };
  }
  tags.forEach((tag, index) => {
    questions[`tag_${index}`] = {
      type: 'noul',
      instructions: `このタスクは「${tag.name}」に該当するか判定する。${tag.description || ''} 該当するときだけ yes 寄りの確率を返す。`,
    };
  });

  return {
    model,
    state: {
      task: {
        title: task.title,
        description: task.description,
        status: task.status,
        assignee: task.assignee,
        priority: task.priority,
        due: task.due,
        project: projectName(task),
        tags: task.tags,
      },
      criteria: (task.criteria || []).map((criterion) => criterion.text),
    },
    questions,
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function answerScore(answer, key = null) {
  if (answer == null) return 0;
  if (typeof answer === 'number') return numberOrNull(answer) ?? 0;
  if (typeof answer === 'boolean') return answer ? 1 : 0;
  if (typeof answer === 'string') return 0;
  for (const field of ['confidence', 'probability', 'score', 'noul', 'yes']) {
    const score = numberOrNull(answer[field]);
    if (score != null) return score;
  }
  if (key && answer.probabilities && typeof answer.probabilities === 'object') {
    return numberOrNull(answer.probabilities[key]) ?? 0;
  }
  return 0;
}

function answerChoice(answer) {
  if (typeof answer === 'string') return answer;
  if (!answer || typeof answer !== 'object') return null;
  return answer.choice ?? answer.answer ?? answer.value ?? null;
}

function candidatesFor(store, config) {
  const existing = new Map(store.listProjects().map((project) => [project.name, project]));
  const projects = config.projects.map((candidate) => ({
    ...candidate,
    id: existing.get(candidate.name)?.id ?? null,
    available: existing.has(candidate.name),
  }));
  return { projects, tags: config.tags };
}

function predictionFrom(body, candidates) {
  const answers = body.answers || {};
  const projectAnswer = answers.project;
  const choice = answerChoice(projectAnswer);
  const project = candidates.projects.find((candidate) => candidate.key === choice || candidate.name === choice) || null;
  const projectConfidence = answerScore(projectAnswer, choice);
  const tags = candidates.tags.map((candidate, index) => ({
    ...candidate,
    confidence: answerScore(answers[`tag_${index}`]),
  }));
  return { project, projectConfidence, tags };
}

function selectedProject(store, candidate, config, { allowCreate = config.create_missing_projects, actor = AUTO_CLASSIFIER_ACTOR } = {}) {
  if (!candidate) return null;
  const current = store.listProjects().find((project) => project.name === candidate.name);
  if (current) return current;
  if (!allowCreate) return null;
  try {
    return store.createProject({ name: candidate.name, description: candidate.description }, actor);
  } catch (error) {
    if (error?.status !== 409) throw error;
    return store.listProjects().find((project) => project.name === candidate.name) || null;
  }
}

export function createTaskClassifier({
  store,
  config = loadClassification(),
  gatewayUrl = process.env.JEV_GATEWAY_URL || DEFAULT_JEV_GATEWAY_URL,
  gatewayToken = process.env.JEV_GATEWAY_TOKEN || '',
  model = process.env.TM_JEV_MODEL || DEFAULT_JEV_MODEL,
  timeoutMs = process.env.TM_JEV_TIMEOUT_MS || DEFAULT_JEV_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (!store) throw new Error('store is required');
  config = normalizeClassification(config);
  const client = createJevClient({ gatewayUrl, gatewayToken, model, timeoutMs, fetchImpl });
  const gatewayConfigured = Boolean(String(gatewayUrl || '').trim());
  const pending = new Set();
  let closed = false;

  async function classifyTask(taskId, { force = false, reclassify = false } = {}) {
    if (closed || pending.has(taskId)) return null;
    if (!force && store.getSettings().classification_mode !== 'high_confidence') return null;
    pending.add(taskId);
    try {
      const initial = store.getTask(taskId);
      const candidates = candidatesFor(store, config);
      if (!gatewayConfigured) return { task: initial, changed: false, unavailable: true, suggestions: [] };
      if (!candidates.projects.length && !candidates.tags.length) return { task: initial, changed: false, suggestions: [] };
      const request = buildJevRequest(initial, { ...candidates, model });
      const response = await client.classify(request);
      try {
        store.recordAiUsage(taskId, buildUsageRecord({ provider: 'jev', model: response.model || model, response, metadata: { purpose: 'classification' } }), AUTO_CLASSIFIER_ACTOR);
      } catch (usageError) {
        logger.warn?.(`JEV usage could not be recorded for task #${taskId}: ${usageError.message}`);
      }
      const prediction = predictionFrom(response, candidates);
      const current = store.getTask(taskId);
      const changes = {};
      const suggestions = [];
      let projectDetail = null;

      if ((reclassify || current.project_id == null) && prediction.project && prediction.projectConfidence >= config.threshold) {
        const project = selectedProject(store, prediction.project, config);
        if (project) {
          if (current.project_id !== project.id) changes.project_id = project.id;
          projectDetail = { key: prediction.project.key, name: project.name, confidence: prediction.projectConfidence };
        } else {
          suggestions.push({ kind: 'project', key: prediction.project.key, name: prediction.project.name, confidence: prediction.projectConfidence });
        }
      }

      const highConfidenceTags = prediction.tags.filter((tag) => tag.confidence >= config.threshold);
      const selectedTags = highConfidenceTags.map((tag) => ({ key: tag.key, name: tag.name, confidence: tag.confidence }));
      let nextTags;
      if (reclassify) {
        const configuredNames = new Set(config.tags.map((tag) => tag.name));
        const customTags = current.tags.filter((tag) => !configuredNames.has(tag));
        nextTags = [...customTags, ...highConfidenceTags.map((tag) => tag.name)].filter((tag, index, list) => list.indexOf(tag) === index).slice(0, MAX_TAGS);
      } else {
        nextTags = [...current.tags];
        for (const tag of highConfidenceTags) {
          if (!nextTags.includes(tag.name) && nextTags.length < MAX_TAGS) nextTags.push(tag.name);
        }
      }
      if (JSON.stringify(nextTags) !== JSON.stringify(current.tags)) changes.tags = nextTags;

      const task = store.updateTask(taskId, changes, AUTO_CLASSIFIER_ACTOR, {
        version: current.version,
        action: 'task.auto_classify',
        classificationSuggestions: suggestions,
        extraDetail: {
          classification: {
            provider: 'jev',
            model,
            threshold: config.threshold,
            reclassify,
            project: projectDetail,
            tags: selectedTags,
            suggestions,
          },
        },
      });
      return { task, changed: task.version !== current.version, project: projectDetail, tags: selectedTags, suggestions };
    } catch (error) {
      logger.warn?.(`JEV auto classification skipped for task #${taskId}: ${error.message}`);
      return null;
    } finally {
      pending.delete(taskId);
    }
  }

  async function reclassifyAll({ includeArchived = false } = {}) {
    const tasks = store.listTasks({ includeArchived });
    const results = [];
    for (const task of tasks) results.push(await classifyTask(task.id, { force: true, reclassify: true }));
    return {
      total: tasks.length,
      changed: results.filter((result) => result?.changed).length,
      suggestions: results.flatMap((result) => result?.suggestions || []).map((suggestion) => ({ ...suggestion })),
      unavailable: results.some((result) => result?.unavailable),
    };
  }

  function applySuggestions(taskId, actor) {
    const current = store.getTask(taskId);
    const suggestions = current.classification_suggestions || [];
    if (!suggestions.length) return { task: current, changed: false, applied: [], remaining: [] };

    const candidates = candidatesFor(store, config);
    const changes = {};
    const applied = [];
    const remaining = [];
    let nextTags = [...current.tags];
    let nextProjectId = current.project_id;
    let projectDetail = null;

    for (const suggestion of suggestions) {
      if (suggestion.kind === 'project') {
        const candidate = candidates.projects.find((item) => item.key === suggestion.key || item.name === suggestion.name);
        const project = selectedProject(store, candidate, config, { allowCreate: true, actor });
        if (!project) {
          remaining.push(suggestion);
          continue;
        }
        nextProjectId = project.id;
        projectDetail = { key: suggestion.key, name: project.name, confidence: suggestion.confidence };
        applied.push(suggestion);
        continue;
      }
      if (suggestion.kind === 'tag') {
        const candidate = candidates.tags.find((item) => item.key === suggestion.key || item.name === suggestion.name);
        if (!candidate || (nextTags.length >= MAX_TAGS && !nextTags.includes(candidate.name))) {
          remaining.push(suggestion);
          continue;
        }
        if (!nextTags.includes(candidate.name)) nextTags.push(candidate.name);
        applied.push(suggestion);
        continue;
      }
      remaining.push(suggestion);
    }

    if (nextProjectId !== current.project_id) changes.project_id = nextProjectId;
    if (JSON.stringify(nextTags) !== JSON.stringify(current.tags)) changes.tags = nextTags;
    const task = store.updateTask(taskId, changes, actor, {
      version: current.version,
      action: 'task.classification_apply',
      classificationSuggestions: remaining,
      extraDetail: {
        classification: {
          provider: 'jev',
          applied,
          remaining,
          project: projectDetail,
        },
      },
    });
    return { task, changed: task.version !== current.version, applied, remaining };
  }

  const unsubscribe = store.on((event) => {
    if (event.task_id == null) return;
    if (event.type === 'task.created') void classifyTask(event.task_id);
    else if (event.type === 'task.updated' && event.action === 'task.update' && (event.changes?.title || event.changes?.description)) void classifyTask(event.task_id);
    else if (['criteria.created', 'criteria.updated', 'criteria.deleted'].includes(event.type)) void classifyTask(event.task_id);
  });

  return {
    classifyNow: classifyTask,
    applySuggestions,
    reclassifyAll,
    info() {
      const projects = candidatesFor(store, config).projects;
      return {
        provider: 'jev',
        model,
        mode: store.getSettings().classification_mode,
        threshold: config.threshold,
        available: gatewayConfigured,
        create_missing_projects: config.create_missing_projects,
        projects: projects.map(({ key, name, description, available }) => ({ key, name, description, available })),
        tags: config.tags.map(({ key, name, description }) => ({ key, name, description })),
      };
    },
    close() {
      closed = true;
      unsubscribe();
    },
  };
}
