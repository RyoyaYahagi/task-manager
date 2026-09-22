// AI usage normalization and USD estimates.
//
// JEV reports token usage in its response. Codex CLI currently runs with a
// ChatGPT/Codex model, so its amount is deliberately labelled as an API-rate
// estimate rather than an invoice amount.

export const JEV_PRICING = Object.freeze({
  input_usd_per_million: 0.042,
  cached_input_usd_per_million: 0,
  output_usd_per_million: 0,
  source: 'TypeSafe AI public Jev price ($42 per billion input tokens)',
});

const OPENAI_PRICING = Object.freeze({
  'gpt-5.6-luna': Object.freeze({
    input_usd_per_million: 0.2,
    cached_input_usd_per_million: 0.02,
    output_usd_per_million: 1.2,
    long_context: true,
    source: 'OpenAI GPT-5.6 Luna API pricing',
  }),
  'gpt-5.6-terra': Object.freeze({
    input_usd_per_million: 2,
    cached_input_usd_per_million: 0.2,
    output_usd_per_million: 12,
    long_context: true,
    source: 'OpenAI GPT-5.6 Terra API pricing',
  }),
  'gpt-5.6-sol': Object.freeze({
    input_usd_per_million: 4,
    cached_input_usd_per_million: 0.4,
    output_usd_per_million: 20,
    long_context: true,
    source: 'OpenAI GPT-5.6 Sol API pricing',
  }),
  'gpt-5-codex': Object.freeze({
    input_usd_per_million: 1.25,
    cached_input_usd_per_million: 0.125,
    output_usd_per_million: 10,
    long_context: false,
    source: 'OpenAI GPT-5-Codex API pricing',
  }),
  'gpt-5.2-codex': Object.freeze({
    input_usd_per_million: 1.75,
    cached_input_usd_per_million: 0.175,
    output_usd_per_million: 14,
    long_context: false,
    source: 'OpenAI GPT-5.2-Codex API pricing',
  }),
});

export const COST_KINDS = Object.freeze(['actual', 'estimated', 'unavailable']);
export const USAGE_PROVIDERS = Object.freeze(['jev', 'codex']);

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nonnegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function integerOrNull(value) {
  const number = nonnegativeNumber(value);
  return number == null ? null : Math.floor(number);
}

function firstNumber(...values) {
  for (const value of values) {
    const number = nonnegativeNumber(value);
    if (number != null) return number;
  }
  return null;
}

/** Normalize TypeSafe/OpenAI-ish usage shapes into the fields the board stores. */
export function normalizeTokenUsage(value = {}) {
  const usage = objectOf(value);
  const details = objectOf(usage.input_token_details || usage.inputTokenDetails);
  let inputTokens = integerOrNull(firstNumber(
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.promptTokens,
    usage.total_input_tokens,
    usage.totalInputTokens,
  ));
  let cachedInputTokens = integerOrNull(firstNumber(
    usage.cached_input_tokens,
    usage.cachedInputTokens,
    usage.cached_prompt_tokens,
    usage.cachedPromptTokens,
    details.cached_tokens,
    details.cachedTokens,
  ));
  const outputTokens = integerOrNull(firstNumber(
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.completionTokens,
    usage.total_output_tokens,
    usage.totalOutputTokens,
  ));

  if (inputTokens != null && cachedInputTokens != null) cachedInputTokens = Math.min(inputTokens, cachedInputTokens);
  const totalTokens = integerOrNull(firstNumber(
    usage.total_tokens,
    usage.totalTokens,
  )) ?? (inputTokens == null && outputTokens == null ? null : (inputTokens || 0) + (outputTokens || 0));
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens || 0,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

export function usageFromResponse(response) {
  return normalizeTokenUsage(objectOf(response).usage);
}

function explicitCostFromResponse(response) {
  const body = objectOf(response);
  const usage = objectOf(body.usage);
  return firstNumber(body.cost_usd, body.costUsd, usage.cost_usd, usage.costUsd, body.billing?.cost_usd, body.billing?.costUsd);
}

function overrideNumber(value, fallback) {
  const number = nonnegativeNumber(value);
  return number == null ? fallback : number;
}

function envRate(env, ...names) {
  for (const name of names) {
    if (env?.[name] !== undefined && env?.[name] !== '') return nonnegativeNumber(env[name]);
  }
  return null;
}

export function pricingForProvider(provider, model, env = process.env) {
  const key = String(model || '').trim().toLowerCase();
  if (provider === 'jev') {
    const input = envRate(env, 'TM_JEV_INPUT_USD_PER_MILLION');
    const cached = envRate(env, 'TM_JEV_CACHED_INPUT_USD_PER_MILLION');
    const output = envRate(env, 'TM_JEV_OUTPUT_USD_PER_MILLION');
    return {
      ...JEV_PRICING,
      input_usd_per_million: input == null ? JEV_PRICING.input_usd_per_million : input,
      cached_input_usd_per_million: cached == null ? JEV_PRICING.cached_input_usd_per_million : cached,
      output_usd_per_million: output == null ? JEV_PRICING.output_usd_per_million : output,
      source: input == null && cached == null && output == null ? JEV_PRICING.source : 'TM_JEV_* configured pricing',
    };
  }
  if (provider !== 'codex') return null;
  const base = OPENAI_PRICING[key];
  const input = envRate(env, 'CODEX_INPUT_USD_PER_MILLION');
  const cached = envRate(env, 'CODEX_CACHED_INPUT_USD_PER_MILLION');
  const output = envRate(env, 'CODEX_OUTPUT_USD_PER_MILLION');
  if (!base && input == null && cached == null && output == null) return null;
  return {
    ...(base || { input_usd_per_million: null, cached_input_usd_per_million: 0, output_usd_per_million: null, long_context: false }),
    input_usd_per_million: input == null ? base?.input_usd_per_million ?? null : input,
    cached_input_usd_per_million: cached == null ? base?.cached_input_usd_per_million ?? 0 : cached,
    output_usd_per_million: output == null ? base?.output_usd_per_million ?? null : output,
    source: input == null && cached == null && output == null ? base.source : 'CODEX_* configured pricing',
  };
}

/**
 * Calculate an amount from token counts and per-million-token rates.
 * Returns null when a priced token category is missing or its rate is unknown.
 */
export function estimateCostUsd(usage, pricing) {
  const normalized = normalizeTokenUsage(usage);
  const rates = objectOf(pricing);
  if (normalized.input_tokens == null || rates.input_usd_per_million == null) return null;
  if (rates.output_usd_per_million != null && normalized.output_tokens == null && rates.output_usd_per_million > 0) return null;

  const longContext = rates.long_context === true && normalized.input_tokens > 272000;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const cached = Math.min(normalized.input_tokens, normalized.cached_input_tokens || 0);
  const uncached = normalized.input_tokens - cached;
  const inputRate = Number(rates.input_usd_per_million) * inputMultiplier;
  const cachedRate = Number(rates.cached_input_usd_per_million ?? rates.input_usd_per_million) * inputMultiplier;
  const outputRate = Number(rates.output_usd_per_million || 0) * outputMultiplier;
  const cost = (uncached * inputRate + cached * cachedRate + (normalized.output_tokens || 0) * outputRate) / 1_000_000;
  return Number(cost.toFixed(12));
}

export function buildUsageRecord({ provider, model, response = null, usage = null, pricing = null, metadata = {} } = {}) {
  const normalized = normalizeTokenUsage(usage || usageFromResponse(response));
  const rates = pricing || pricingForProvider(provider, model);
  const explicitCost = explicitCostFromResponse(response);
  const estimated = explicitCost == null && rates ? estimateCostUsd(normalized, rates) : null;
  const costUsd = explicitCost ?? estimated;
  return {
    provider: String(provider || '').trim(),
    model: String(model || response?.model || 'unknown').trim() || 'unknown',
    ...normalized,
    cost_usd: costUsd,
    cost_kind: explicitCost != null ? 'actual' : costUsd == null ? 'unavailable' : 'estimated',
    pricing_source: costUsd == null ? '' : (rates?.source || ''),
    metadata: objectOf(metadata),
  };
}

export function normalizeUsageRecord(input = {}) {
  const value = objectOf(input);
  const provider = String(value.provider || '').trim().toLowerCase();
  if (!USAGE_PROVIDERS.includes(provider)) throw new Error(`usage provider must be ${USAGE_PROVIDERS.join('|')}`);
  const model = String(value.model || 'unknown').trim().slice(0, 100) || 'unknown';
  const usage = normalizeTokenUsage(value.usage || value);
  const cost = nonnegativeNumber(value.cost_usd);
  const costKind = cost == null ? 'unavailable' : (COST_KINDS.includes(value.cost_kind) ? value.cost_kind : 'estimated');
  const metadata = objectOf(value.metadata);
  const sessionNumber = value.refinement_session_id == null || value.refinement_session_id === '' ? null : Number(value.refinement_session_id);
  if (sessionNumber != null && (!Number.isInteger(sessionNumber) || sessionNumber <= 0)) throw new Error('refinement_session_id must be a positive integer');
  return {
    provider,
    model,
    ...usage,
    cost_usd: cost,
    cost_kind: costKind,
    pricing_source: String(value.pricing_source || '').trim().slice(0, 300),
    metadata,
    refinement_session_id: sessionNumber,
  };
}
