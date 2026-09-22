// Domain rules for turning an ambiguous task into an executable task brief.

export const AGENT_MODES = Object.freeze(['', 'refine', 'execute']);
export const REFINEMENT_STATUSES = Object.freeze(['pending', 'running', 'waiting_user', 'draft', 'accepted', 'cancelled', 'failed']);
export const ANSWER_KINDS = Object.freeze(['answered', 'unknown', 'delegate']);
export const PROVENANCE_KINDS = Object.freeze(['user', 'inference', 'assumption', 'unresolved', 'human_edited']);
export const OTHER_OPTION = 'その他';

export const BRIEF_FIELDS = Object.freeze([
  'problem', 'purpose', 'background', 'deliverables', 'constraints',
  'out_of_scope', 'assumptions', 'open_questions', 'next_action', 'criteria',
]);

const MAX_TEXT = 20000;
const MAX_ITEM = 1000;
const MAX_OPTION = 300;
const MAX_OPTIONS = 6;
const MAX_QUESTIONS = 12;

const text = (value, max = MAX_TEXT) => String(value ?? '').trim().slice(0, max);

function list(value, maxItems = 20) {
  if (value == null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return values.map((item) => text(item, MAX_ITEM)).filter(Boolean).slice(0, maxItems);
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeQuestionItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_QUESTIONS) {
    throw new Error(`questions must contain 1..${MAX_QUESTIONS} items`);
  }
  return input.map((item, position) => {
    const row = plainObject(item);
    const question = text(row.question ?? row.prompt, MAX_ITEM);
    if (!question) throw new Error(`question ${position + 1} is required`);
    const rawOptions = row.options ?? row.choices ?? [];
    if (rawOptions !== undefined && !Array.isArray(rawOptions)) throw new Error(`question ${position + 1} options must be an array`);
    const options = list(rawOptions, MAX_OPTIONS + 1).map((option) => text(option, MAX_OPTION));
    if (options.length === 1 || options.length > MAX_OPTIONS) throw new Error(`question ${position + 1} options must contain 0 or 2..${MAX_OPTIONS} items`);
    if (new Set(options).size !== options.length) throw new Error(`question ${position + 1} options must be unique`);
    const recommendedOption = text(row.recommended_option ?? row.recommended, MAX_OPTION);
    if (options.length && !recommendedOption) throw new Error(`question ${position + 1} recommended_option is required when options are provided`);
    if (recommendedOption && !options.includes(recommendedOption)) throw new Error(`question ${position + 1} recommended_option must match one of the options`);
    const recommendationReason = text(row.recommendation_reason ?? row.recommendation, MAX_ITEM);
    if (options.length && !recommendationReason) throw new Error(`question ${position + 1} recommendation_reason is required when options are provided`);
    return {
      question,
      blocking: row.blocking !== false,
      options,
      recommended_option: recommendedOption,
      recommendation_reason: recommendationReason,
    };
  });
}

export function normalizeAnswers(input) {
  if (!Array.isArray(input)) throw new Error('answers must be an array');
  const seen = new Set();
  return input.map((item, position) => {
    const row = plainObject(item);
    const id = Number(row.id ?? row.question_id);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`answer ${position + 1} has an invalid question id`);
    if (seen.has(id)) throw new Error(`question ${id} was answered more than once`);
    seen.add(id);
    const kind = String(row.kind || 'answered');
    if (!ANSWER_KINDS.includes(kind)) throw new Error(`answer ${id} has an invalid kind`);
    const answer = text(row.answer, MAX_ITEM);
    const selectedOption = kind === 'unknown' ? '' : text(row.selected_option ?? row.option, MAX_OPTION);
    if (selectedOption === OTHER_OPTION && !answer) throw new Error(`answer ${id} needs free text for the other option`);
    if ((kind === 'answered' || kind === 'delegate') && !answer && !selectedOption) throw new Error(`answer ${id} is required`);
    return { id, kind, answer, selected_option: selectedOption };
  });
}

function openQuestions(value) {
  if (value == null || value === '') return [];
  const values = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  return values.map((item) => {
    if (typeof item === 'string') return { text: text(item, MAX_ITEM), blocking: true };
    const row = plainObject(item);
    return { text: text(row.text ?? row.question, MAX_ITEM), blocking: row.blocking !== false };
  }).filter((item) => item.text).slice(0, 20);
}

export function normalizeBrief(input = {}) {
  const src = plainObject(input);
  return {
    problem: text(src.problem),
    purpose: text(src.purpose),
    background: text(src.background),
    deliverables: list(src.deliverables),
    constraints: list(src.constraints),
    out_of_scope: list(src.out_of_scope),
    assumptions: list(src.assumptions),
    open_questions: openQuestions(src.open_questions),
    next_action: text(src.next_action),
    criteria: list(src.criteria),
  };
}

export function normalizeProvenance(input = {}, content = {}) {
  const src = plainObject(input);
  const out = {};
  for (const field of BRIEF_FIELDS) {
    const value = src[field];
    if (typeof value === 'string' && PROVENANCE_KINDS.includes(value)) out[field] = value;
  }
  for (const field of BRIEF_FIELDS) {
    if (out[field]) continue;
    const value = content[field];
    const hasValue = Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (hasValue) out[field] = 'inference';
  }
  return out;
}

export function assessBrief(content) {
  const brief = normalizeBrief(content);
  const missing = [];
  if (!brief.problem && !brief.purpose) missing.push({ field: 'problem', label: '解決したい問題または目的' });
  if (!brief.deliverables.length) missing.push({ field: 'deliverables', label: '成果物' });
  if (!brief.criteria.length) missing.push({ field: 'criteria', label: '完了条件' });
  if (!brief.next_action) missing.push({ field: 'next_action', label: '次の一手' });
  const blocking = brief.open_questions.filter((item) => item.blocking);
  const warnings = brief.open_questions.filter((item) => !item.blocking);
  return { ready: missing.length === 0 && blocking.length === 0, missing, blocking, warnings, content: brief };
}

export function briefDiff(before, after) {
  const a = normalizeBrief(before);
  const b = normalizeBrief(after);
  const changes = {};
  for (const field of BRIEF_FIELDS) {
    if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) changes[field] = [a[field], b[field]];
  }
  return changes;
}

export function summarizeQuestions(items, max = 280) {
  const body = items.map((item, i) => {
    const recommendation = item.recommended_option ? `（おすすめ: ${item.recommended_option}）` : '';
    return `${i + 1}. ${item.question}${recommendation}`;
  }).join(' ');
  return body.length <= max ? body : `${body.slice(0, Math.max(0, max - 1)).trim()}…`;
}

export function summarizeBrief(content, max = 280) {
  const brief = normalizeBrief(content);
  const parts = [brief.problem || brief.purpose, brief.deliverables[0], brief.next_action].filter(Boolean);
  const body = parts.join(' / ');
  return body.length <= max ? body : `${body.slice(0, Math.max(0, max - 1)).trim()}…`;
}
