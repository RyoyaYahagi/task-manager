#!/usr/bin/env node
// tm — CLI for the task board. Designed for AI agents (non-interactive, --json).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENV = process.env;
const HELP = `tm — task board CLI (for AI agents and humans)

USAGE
  tm <command> [args] [options]

READ
  inbox                         tasks waiting for the agent (status=waiting_agent)
  ls [filters]                  list tasks   --status S --project P --assignee A --tag T
                                             --priority 1-4 --overdue --parent ID --archived -q TEXT
  show <id>                     task detail: criteria, subtasks, notes, files, history
  lanes                         lane ids and names
  projects                      projects

CREATE / EDIT
  add <title> [--desc D|-] [--status S] [--assignee human|agent|both] [--project P]
              [--parent ID] [--priority 1-4] [--due YYYY-MM-DD] [--tags a,b]
              [--criteria "text"]... [--needs-review]
  edit <id> [--title T] [--desc D|-] [--assignee A] [--project P] [--parent ID|none]
            [--priority N] [--due DATE|none] [--tags a,b] [--needs-review|--no-needs-review]
  project add <name> [--color #rrggbb]

PROGRESS
  start <id> [--force]          -> in_progress, records you as worker (409 if someone else is)
  ask <id> <question>           -> waiting_human (question)  + note
  criteria add <id> <text>      propose an acceptance criterion
  check <id> <n[,n..]|all>      check criteria by number (as shown in 'show'); uncheck likewise
  done <id> <result note> [--partial]
                                -> done (or waiting_human when --partial / needs_review).
                                   Fails with exit 3 unless every criterion is checked.
  handoff <id> [note]           -> waiting_agent
  hold <id> [note]              -> on_hold
  mv <id> <status> [--index N]  move to any lane
  approve <id>                  (human) accept a report -> done
  archive <id> / unarchive <id>
  rm <id>                       soft delete (humans only by default)

REFINE (AI深掘り)
  refine request <task_id>      human: start a refinement session
  refine show <session_id>      show questions, answers, and the current task organization
  refine ask <session_id> <JSON|->
                                agent: submit [{"question":"...","blocking":true,"options":["A","B"],"recommended_option":"A","recommendation_reason":"..."}]
  refine answer <session_id> <JSON|->
                                human: submit [{"id":1,"kind":"answered","selected_option":"A","answer":"補足"}]
  refine propose <session_id> <JSON|->
                                agent: submit the structured task organization
  refine edit <brief_id> <JSON|->
                                human: edit the draft task organization
  refine accept <brief_id>       human: accept the draft and import its criteria
  refine cancel <session_id> / retry <session_id>
  refine fail <session_id> <message>

AI USAGE / COST
  usage show                    show total JEV/Codex usage and cost
  usage task <task_id>          show usage records for one task
  usage record <task_id> <JSON> agent: record one AI call's usage/cost

NOTES / FILES
  note <id> <text|->            add a note (max 300 chars, "-" reads stdin)
  notes <id>
  attach <id> <path> [--as NAME] attach a file (.html shows in the HTML tab)
  files <id>

LOG
  history <id>
  activity [--by agent|human] [--who NAME] [--since 1h|24h|7d|DATE] [--task ID] [--limit N]
  revert <history_id> [--force] undo one history entry (agents: only their own)
  export                        dump everything as JSON

EVENTS
  watch                         stream server events as JSON lines (SSE)

OPTIONS
  --json            machine-readable output
  --url URL         server (default $TM_URL or http://127.0.0.1:3000)
  --actor KIND      human|agent (default $TM_ACTOR or agent)
  --name NAME       actor display name (default $TM_ACTOR_NAME or the actor kind)
  --token T         bearer token ($TM_TOKEN)
  -h, --help

EXIT CODES  0 ok · 1 error · 2 forbidden by policy · 3 acceptance criteria unmet · 4 conflict
`;

// ---------- arg parsing ----------
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  const multi = new Set(['criteria']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (v === undefined) {
        const next = argv[i + 1];
        if (k.startsWith('no-')) { opt[k.slice(3).replace(/-/g, '_')] = false; continue; }
        if (next !== undefined && !next.startsWith('--') && !BOOL_FLAGS.has(k)) { v = next; i++; } else v = true;
      }
      k = k.replace(/-/g, '_');
      if (multi.has(k)) (opt[k] ??= []).push(v); else opt[k] = v;
    } else if (a === '-q') { opt.q = argv[++i]; }
    else if (a === '-h') opt.help = true;
    else pos.push(a);
  }
  return { pos, opt };
}
const BOOL_FLAGS = new Set(['json', 'force', 'partial', 'overdue', 'archived', 'help', 'needs-review', 'no-needs-review', 'all']);

const { pos, opt } = parseArgs(process.argv.slice(2));
const JSON_OUT = !!opt.json || ENV.TM_FORMAT === 'json';
const BASE = String(opt.url || ENV.TM_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const ACTOR = String(opt.actor || ENV.TM_ACTOR || 'agent');
const NAME = String(opt.name || ENV.TM_ACTOR_NAME || ACTOR);
const TOKEN = opt.token || ENV.TM_TOKEN || '';

// ---------- http ----------
async function api(method, p, body, { raw = false, headers = {} } = {}) {
  const h = { 'x-actor': ACTOR, 'x-actor-name': NAME, ...headers };
  if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
  let payload;
  if (body !== undefined) {
    if (raw) payload = body; else { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  let res;
  try {
    res = await fetch(BASE + p, { method, headers: h, body: payload });
  } catch (e) {
    fail(`cannot reach ${BASE} (${e.cause?.code || e.message}). Is the server running? (npm start)`, 1);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const code = res.status === 403 ? 2 : res.status === 422 ? 3 : res.status === 409 ? 4 : 1;
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.data = data; err.exit = code; err.status = res.status;
    throw err;
  }
  return data;
}

function fail(msg, code = 1, data) {
  if (JSON_OUT) console.error(JSON.stringify({ error: msg, ...(data || {}) }));
  else console.error(`error: ${msg}`);
  process.exit(code);
}
function out(data, text) {
  if (JSON_OUT) console.log(JSON.stringify(data, null, 2));
  else console.log(typeof text === 'function' ? text() : text ?? JSON.stringify(data, null, 2));
}
function readStdin() { return readFileSync(0, 'utf8').replace(/\r?\n$/, ''); }
function jsonInput(value, label) {
  const raw = value === '-' ? readStdin() : value;
  if (!raw) fail(`${label} is required`);
  try { return JSON.parse(raw); } catch (e) { fail(`${label} is invalid JSON: ${e.message}`); }
}
const idArg = (v, what = 'id') => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) fail(`${what} must be a positive integer (got "${v}")`); return n; };

// ---------- formatting ----------
const PRI = { 1: 'low', 2: 'mid', 3: 'HIGH', 4: 'URGENT' };
const ASG = { human: 'human', agent: 'agent', both: 'both' };
let laneCache = null;
async function laneName(id) {
  laneCache ??= await api('GET', '/api/lanes');
  return laneCache.find((l) => l.id === id)?.name || id;
}
function rel(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function pad(s, n) { s = String(s ?? ''); const w = width(s); return w >= n ? s : s + ' '.repeat(n - w); }
function width(s) { let w = 0; for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1; return w; }
function truncate(s, n) { s = String(s ?? '').replace(/\s+/g, ' '); let w = 0, o = ''; for (const ch of s) { const cw = width(ch); if (w + cw > n - 1) return o + '…'; o += ch; w += cw; } return o; }

function taskLine(t) {
  const flags = [];
  if (t.waiting_reason === 'question') flags.push('[question]');
  if (t.waiting_reason === 'review') flags.push('[report]');
  if (t.priority >= 3) flags.push(`[${PRI[t.priority]}]`);
  if (t.due) flags.push(`due:${t.due}${t.due < today() && t.status !== 'done' ? '!' : ''}`);
  if (t.worker) flags.push(`worker:${t.worker}`);
  if (t.crit_total) flags.push(`criteria:${t.crit_done}/${t.crit_total}`);
  if (t.sub_total) flags.push(`sub:${t.sub_done}/${t.sub_total}`);
  if (t.note_count) flags.push(`notes:${t.note_count}`);
  if (t.agent_mode) flags.push(`mode:${t.agent_mode}`);
  if (t.parent_id) flags.push(`parent:#${t.parent_id}`);
  const proj = t.project ? `(${t.project.name}) ` : '';
  return `#${pad(t.id, 4)} ${pad(t.status, 14)} ${pad(ASG[t.assignee], 6)} ${proj}${t.title}${t.tags.length ? '  ' + t.tags.map((x) => '#' + x).join(' ') : ''}${flags.length ? '  ' + flags.join(' ') : ''}`;
}
const today = () => new Date().toISOString().slice(0, 10);

function showTask(t) {
  const L = [];
  L.push(`#${t.id}  ${t.title}`);
  L.push(`status: ${t.status}${t.waiting_reason ? ` (${t.waiting_reason})` : ''}   assignee: ${t.assignee}   priority: ${PRI[t.priority]}   due: ${t.due || '-'}`);
  L.push(`project: ${t.project?.name || '-'}   tags: ${t.tags.map((x) => '#' + x).join(' ') || '-'}   worker: ${t.worker || '-'}   mode: ${t.agent_mode || '-'}   needs_review: ${t.needs_review ? 'yes' : 'no'}`);
  if (t.parent) L.push(`parent: #${t.parent.id} ${t.parent.title} [${t.parent.status}]`);
  L.push(`created: ${t.created_at} by ${t.created_by}   updated: ${t.updated_at} (${rel(t.updated_at)})   version: ${t.version}${t.archived_at ? '   ARCHIVED' : ''}${t.deleted_at ? '   DELETED' : ''}`);
  if (t.description) { L.push('', 'DESCRIPTION', ...t.description.split('\n').map((x) => '  ' + x)); }
  L.push('', `CRITERIA (${t.criteria.filter((c) => c.done).length}/${t.criteria.length})`);
  if (!t.criteria.length) L.push('  (none — propose some with: tm criteria add <id> "<text>")');
  t.criteria.forEach((c, i) => L.push(`  ${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}   (by ${c.author_name}${c.done ? `, checked by ${c.checked_by_name} ${rel(c.checked_at)}` : ''})`));
  if (t.brief) L.push('', 'ACCEPTED TASK ORGANIZATION', ...briefLines(t.brief));
  if (t.refinement) {
    L.push('', `REFINEMENT #${t.refinement.id} attempt ${t.refinement.attempt} (${t.refinement.status})`);
    for (const q of t.refinement.questions || []) {
      L.push(`  Q${q.id} [round ${q.round_no}${q.blocking ? ', blocking' : ''}] ${q.question}`);
      if (q.options?.length) L.push(`      options: ${q.options.map((option) => `${option}${option === q.recommended_option ? ' (recommended)' : ''}`).join(' / ')}`);
      if (q.recommendation_reason) L.push(`      recommendation: ${q.recommendation_reason}`);
      L.push(`      ${q.answer_kind ? `${q.answer_kind}${q.selected_option ? ` [${q.selected_option}]` : ''}: ${q.answer || '(空)'}` : '(unanswered)'}`);
    }
    if (t.refinement.brief) L.push(...briefLines(t.refinement.brief).map((line) => '  ' + line));
    if (t.refinement.error) L.push(`  error: ${t.refinement.error}`);
  }
  if (t.ai_cost?.total?.calls) {
    L.push('', 'AI USAGE / COST');
    for (const provider of ['jev', 'codex']) {
      const bucket = t.ai_cost.by_provider?.[provider];
      if (bucket?.calls) L.push(`  ${provider}: ${bucket.calls} calls, input ${bucket.input_tokens} / output ${bucket.output_tokens}, ${fmtUsd(bucket.cost_usd)} (${bucket.cost_kind})`);
    }
  }
  const judgment = [...(t.ai_usage || [])].find((usage) => usage.provider === 'jev' && usage.metadata?.refinement_judgment)?.metadata?.refinement_judgment;
  if (judgment) {
    L.push('', 'JEV JUDGMENT');
    L.push(`  disposition: ${judgment.disposition || '-'}   threshold: ${judgment.threshold == null ? '-' : `${Math.round(judgment.threshold * 100)}%`}`);
    if (judgment.route) L.push(`  route: ${judgment.route.raw || judgment.route.choice || '-'}   confidence: ${judgment.route.confidence == null ? '-' : `${Math.round(judgment.route.confidence * 100)}%`}`);
    for (const [key, value] of Object.entries(judgment.checks || {})) L.push(`  check ${key}: ${value == null ? '-' : `${Math.round(value * 100)}%`}`);
    for (const item of judgment.findings || []) L.push(`  reason: ${item.label || item.kind || '-'} — ${item.detail || '-'}`);
    if (judgment.response) {
      const response = judgment.response;
      L.push(`  response JSON: ${response.status || '-'}${response.missing_keys?.length ? `; missing=${response.missing_keys.join(',')}` : ''}${response.invalid_keys?.length ? `; invalid=${response.invalid_keys.join(',')}` : ''}`);
    }
  }
  if (t.subtasks.length) { L.push('', `SUBTASKS (${t.subtasks.filter((s) => s.status === 'done').length}/${t.subtasks.length})`); t.subtasks.forEach((s) => L.push(`  #${s.id} [${s.status}] ${s.title}`)); }
  L.push('', `NOTES (${t.notes.length})`);
  t.notes.forEach((n) => L.push(`  [${n.id}] ${n.author === 'agent' ? '🤖' : '👤'} ${n.author_name} ${n.kind !== 'note' ? `(${n.kind}) ` : ''}${rel(n.created_at)}`, ...n.body.split('\n').map((x) => '      ' + x)));
  if (t.files.length) { L.push('', `FILES (${t.files.length})`); t.files.forEach((f) => L.push(`  [${f.id}] ${f.name}  ${f.mime}  ${fmtSize(f.size)}  by ${f.uploaded_by_name}  ${BASE}/api/files/${f.id}`)); }
  L.push('', `HISTORY (latest ${Math.min(10, t.history.length)} of ${t.history.length})`);
  t.history.slice(0, 10).forEach((h) => L.push('  ' + histLine(h)));
  return L.join('\n');
}
function briefLines(brief) {
  const c = brief?.content || {};
  const labels = [['problem', 'problem'], ['purpose', 'purpose'], ['deliverables', 'deliverables'], ['criteria', 'criteria'], ['background', 'background'], ['constraints', 'constraints'], ['out_of_scope', 'out of scope'], ['assumptions', 'assumptions'], ['open_questions', 'open questions'], ['next_action', 'next action']];
  const lines = [];
  for (const [field, label] of labels) {
    const value = c[field];
    const values = Array.isArray(value) ? value.map((item) => typeof item === 'object' ? `${item.text}${item.blocking === false ? ' (non-blocking)' : ''}` : item) : [value];
    const present = values.filter((item) => String(item ?? '').trim());
    if (present.length) lines.push(`${label}: ${present.join(' / ')}`);
  }
  if (brief.provenance && Object.keys(brief.provenance).length) lines.push(`provenance: ${Object.entries(brief.provenance).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return lines;
}
function showRefinement(refinement) {
  const L = [`refinement #${refinement.id}  task #${refinement.task.id} ${refinement.task.title}`, `status: ${refinement.status}   attempt: ${refinement.attempt}   base version: ${refinement.base_task_version}`];
  if (refinement.error) L.push(`error: ${refinement.error}`);
  for (const q of refinement.questions || []) {
    L.push('', `Q${q.id} [round ${q.round_no}${q.blocking ? ', blocking' : ''}] ${q.question}`);
    if (q.options?.length) L.push(`options: ${q.options.map((option) => `${option}${option === q.recommended_option ? ' (recommended)' : ''}`).join(' / ')}`);
    if (q.recommendation_reason) L.push(`recommendation: ${q.recommendation_reason}`);
    L.push(`A: ${q.answer_kind ? `${q.answer_kind}${q.selected_option ? ` [${q.selected_option}]` : ''}${q.answer ? ` — ${q.answer}` : ''}` : '(unanswered)'}`);
  }
  if (refinement.brief) L.push('', 'TASK ORGANIZATION', ...briefLines(refinement.brief));
  return L.join('\n');
}
function fmtSize(n) { return n < 1024 ? `${n}B` : n < 1048576 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1048576).toFixed(1)}MB`; }
function histLine(h) {
  const who = `${h.actor === 'agent' ? '🤖' : '👤'} ${h.actor_name}`;
  let what = h.action;
  const ch = h.detail?.changes;
  if (ch) what += ' ' + Object.entries(ch).map(([k, [a, b]]) => `${k}: ${fmtVal(a)} → ${fmtVal(b)}`).join(', ');
  else if (h.detail?.snapshot?.body) what += ` "${truncate(h.detail.snapshot.body, 60)}"`;
  else if (h.detail?.snapshot?.text) what += ` "${truncate(h.detail.snapshot.text, 60)}"`;
  else if (h.detail?.snapshot?.title) what += ` "${truncate(h.detail.snapshot.title, 60)}"`;
  const task = h.task_title !== undefined ? ` #${h.task_id} ${truncate(h.task_title || '', 30)}` : '';
  return `${pad('h' + h.id, 5)} ${pad(rel(h.created_at), 9)} ${who}${task}: ${what}${h.reverted_by ? `  (reverted by h${h.reverted_by})` : ''}${h.reverts ? `  (reverts h${h.reverts})` : ''}`;
}
function fmtVal(v) { if (v == null || v === '') return '∅'; if (Array.isArray(v)) return '[' + v.join(',') + ']'; return truncate(String(v), 40); }
function fmtUsd(value) { return value == null ? 'unknown' : `$${Number(value).toFixed(6)}`; }
function formatUsageLine(u) {
  return `#${u.id} ${u.provider} ${u.model} input=${u.input_tokens ?? '-'} output=${u.output_tokens ?? '-'} cost=${fmtUsd(u.cost_usd)} (${u.cost_kind}) ${u.created_at}`;
}
function formatUsageSummary(summary) {
  const lines = [];
  if (summary.total?.calls) {
    lines.push(`total: ${summary.total.calls} calls, input=${summary.total.input_tokens}, output=${summary.total.output_tokens}, cost=${fmtUsd(summary.total.cost_usd)} (${summary.total.cost_kind})`);
  }
  for (const provider of ['jev', 'codex']) {
    const bucket = summary.by_provider?.[provider];
    if (!bucket?.calls) continue;
    lines.push(`${provider}: ${bucket.calls} calls, input=${bucket.input_tokens}, output=${bucket.output_tokens}, cost=${fmtUsd(bucket.cost_usd)} (${bucket.cost_kind})`);
  }
  return lines.join('\n') || 'no AI usage';
}

// ---------- commands ----------
const commands = {
  async inbox() {
    const tasks = await api('GET', '/api/tasks?status=waiting_agent');
    out(tasks, () => (tasks.length ? tasks.map(taskLine).join('\n') : 'inbox is empty'));
  },
  async ls() {
    const q = new URLSearchParams();
    for (const k of ['status', 'project', 'assignee', 'tag', 'priority', 'parent', 'q']) if (opt[k] !== undefined) q.set(k, String(opt[k]));
    if (opt.overdue) q.set('overdue', '1');
    if (opt.archived) q.set('include_archived', '1');
    const tasks = await api('GET', `/api/tasks?${q}`);
    out(tasks, () => (tasks.length ? tasks.map(taskLine).join('\n') : 'no tasks'));
  },
  async show() {
    const t = await api('GET', `/api/tasks/${idArg(pos[1])}`);
    out(t, () => showTask(t));
  },
  async refine() {
    const sub = pos[1];
    if (!sub) fail('usage: tm refine request|show|ask|answer|propose|edit|accept|cancel|retry|fail ...');
    if (sub === 'request') {
      const id = idArg(pos[2]);
      const task = await api('GET', `/api/tasks/${id}`);
      const r = await api('POST', `/api/tasks/${id}/refinements`, { version: task.version });
      out(r, () => `refinement requested; ${taskLine(r.task)} (session #${r.refinement.id})`);
      return;
    }
    if (sub === 'show') {
      const r = await api('GET', `/api/refinements/${idArg(pos[2], 'session id')}`);
      out(r, () => showRefinement(r));
      return;
    }
    if (sub === 'ask' || sub === 'answer' || sub === 'propose') {
      const sessionId = idArg(pos[2], 'session id');
      const value = jsonInput(pos[3], `${sub} JSON`);
      const endpoint = sub === 'ask' ? 'questions' : sub === 'answer' ? 'answers' : 'brief';
      const body = sub === 'ask' ? { questions: value } : sub === 'answer' ? { answers: value } : { content: value };
      const r = await api('POST', `/api/refinements/${sessionId}/${endpoint}`, body);
      out(r, () => `${sub} submitted; ${taskLine(r.task)}`);
      return;
    }
    if (sub === 'edit') {
      const r = await api('PATCH', `/api/refinement-briefs/${idArg(pos[2], 'brief id')}`, { content: jsonInput(pos[3], 'brief JSON') });
      out(r, () => `task organization edited; ${taskLine(r.task)}`);
      return;
    }
    if (sub === 'accept') {
      const r = await api('POST', `/api/refinement-briefs/${idArg(pos[2], 'brief id')}/accept`, {});
      out(r, () => `task organization accepted; ${taskLine(r.task)}${r.added_criteria?.length ? `; added ${r.added_criteria.length} criteria` : ''}`);
      return;
    }
    if (sub === 'cancel' || sub === 'retry') {
      const r = await api('POST', `/api/refinements/${idArg(pos[2], 'session id')}/${sub}`, {});
      out(r, () => `refinement ${sub}ed; ${taskLine(r.task)}`);
      return;
    }
    if (sub === 'fail') {
      const r = await api('POST', `/api/refinements/${idArg(pos[2], 'session id')}/fail`, { error: pos.slice(3).join(' ') });
      out(r, () => `refinement failed; ${taskLine(r.task)}`);
      return;
    }
    fail(`unknown refine subcommand "${sub}"`);
  },
  async usage() {
    const sub = pos[1] || 'show';
    if (sub === 'show') {
      const summary = await api('GET', '/api/usage');
      out(summary, () => formatUsageSummary(summary));
      return;
    }
    if (sub === 'task') {
      const id = idArg(pos[2], 'task id');
      const usage = await api('GET', `/api/tasks/${id}/usage`);
      out(usage, () => usage.map(formatUsageLine).join('\n') || 'no AI usage');
      return;
    }
    if (sub === 'record') {
      const id = idArg(pos[2], 'task id');
      const record = jsonInput(pos[3], 'usage JSON');
      const usage = await api('POST', `/api/tasks/${id}/usage`, record);
      out(usage, () => `recorded ${usage.provider} usage for #${id}`);
      return;
    }
    fail(`unknown usage subcommand "${sub}"`);
  },
  async lanes() {
    const lanes = await api('GET', '/api/lanes');
    out(lanes, () => lanes.map((l) => `${pad(l.id, 15)} ${l.name}`).join('\n'));
  },
  async projects() {
    const ps = await api('GET', '/api/projects');
    out(ps, () => (ps.length ? ps.map((p) => `${pad(p.id, 4)} ${p.color}  ${p.name}${p.description ? '  — ' + p.description : ''}`).join('\n') : 'no projects'));
  },
  async project() {
    if (pos[1] !== 'add') fail('usage: tm project add <name> [--color #rrggbb]');
    const p = await api('POST', '/api/projects', { name: pos[2], color: opt.color });
    out(p, `created project ${p.id} ${p.name} (${p.color})`);
  },
  async add() {
    const title = pos.slice(1).join(' ');
    if (!title) fail('usage: tm add <title> [options]');
    const body = { title, ...taskFieldsFromOpts() };
    if (opt.status) body.status = opt.status;
    if (opt.criteria) body.criteria = opt.criteria;
    const t = await api('POST', '/api/tasks', body);
    out(t, () => `created ${taskLine(t)}`);
  },
  async edit() {
    const id = idArg(pos[1]);
    const body = taskFieldsFromOpts();
    if (opt.title !== undefined) body.title = opt.title;
    if (!Object.keys(body).length) fail('nothing to change (see tm --help)');
    const cur = await api('GET', `/api/tasks/${id}`);
    body.version = cur.version;
    const t = await api('PATCH', `/api/tasks/${id}`, body);
    out(t, () => `updated ${taskLine(t)}`);
  },
  async start() {
    const t = await api('POST', `/api/tasks/${idArg(pos[1])}/start`, { force: !!opt.force });
    out(t, () => `started ${taskLine(t)}`);
  },
  async ask() {
    const id = idArg(pos[1]);
    const question = pos[2] === '-' ? readStdin() : pos.slice(2).join(' ');
    if (!question) fail('usage: tm ask <id> <question>');
    const r = await api('POST', `/api/tasks/${id}/ask`, { question });
    out(r, () => `asked; ${taskLine(r.task)}`);
  },
  async criteria() {
    if (pos[1] !== 'add') fail('usage: tm criteria add <id> <text>');
    const id = idArg(pos[2]);
    const text = pos.slice(3).join(' ');
    const c = await api('POST', `/api/tasks/${id}/criteria`, { text });
    out(c, `added criterion ${c.id}: ${c.text}`);
  },
  async check() { return toggleCriteria(true); },
  async uncheck() { return toggleCriteria(false); },
  async done() {
    const id = idArg(pos[1]);
    const note = pos[2] === '-' ? readStdin() : pos.slice(2).join(' ');
    if (!note) fail('usage: tm done <id> <result note> [--partial]   (say what changed and how you verified it)');
    const r = await api('POST', `/api/tasks/${id}/done`, { note, partial: !!opt.partial });
    out(r, () => `${r.task.status === 'done' ? 'closed' : 'reported (awaiting human review)'}; ${taskLine(r.task)}`);
  },
  async handoff() {
    const id = idArg(pos[1]);
    const note = pos[2] === '-' ? readStdin() : pos.slice(2).join(' ');
    const r = await api('POST', `/api/tasks/${id}/handoff`, { note: note || undefined });
    out(r, () => `handed off; ${taskLine(r.task)}`);
  },
  async hold() {
    const id = idArg(pos[1]);
    const note = pos[2] === '-' ? readStdin() : pos.slice(2).join(' ');
    const r = await api('POST', `/api/tasks/${id}/hold`, { note: note || undefined });
    out(r, () => `on hold; ${taskLine(r.task)}`);
  },
  async mv() {
    const id = idArg(pos[1]);
    if (!pos[2]) fail('usage: tm mv <id> <status> [--index N]');
    const t = await api('POST', `/api/tasks/${id}/move`, { status: pos[2], index: opt.index !== undefined ? Number(opt.index) : undefined });
    out(t, () => `moved ${taskLine(t)}`);
  },
  async approve() {
    const t = await api('POST', `/api/tasks/${idArg(pos[1])}/approve`, {});
    out(t, () => `approved ${taskLine(t)}`);
  },
  async archive() { const t = await api('POST', `/api/tasks/${idArg(pos[1])}/archive`, {}); out(t, `archived #${t.id}`); },
  async unarchive() { const t = await api('POST', `/api/tasks/${idArg(pos[1])}/unarchive`, {}); out(t, `unarchived #${t.id}`); },
  async rm() {
    const t = await api('DELETE', `/api/tasks/${idArg(pos[1])}`);
    out(t, `deleted #${t.id} (soft; revert via tm history/revert)`);
  },
  async note() {
    const id = idArg(pos[1]);
    const body = pos[2] === '-' ? readStdin() : pos.slice(2).join(' ');
    if (!body) fail('usage: tm note <id> <text|->');
    const n = await api('POST', `/api/tasks/${id}/notes`, { body });
    out(n, `added note ${n.id} to #${id}`);
  },
  async notes() {
    const id = idArg(pos[1]);
    const ns = await api('GET', `/api/tasks/${id}/notes`);
    out(ns, () => (ns.length ? ns.map((n) => `[${n.id}] ${n.author === 'agent' ? '🤖' : '👤'} ${n.author_name} ${n.kind !== 'note' ? `(${n.kind}) ` : ''}${rel(n.created_at)}\n${n.body.split('\n').map((x) => '    ' + x).join('\n')}`).join('\n') : 'no notes'));
  },
  async attach() {
    const id = idArg(pos[1]);
    const file = pos[2];
    if (!file) fail('usage: tm attach <id> <path> [--as NAME]');
    let data;
    try { data = readFileSync(file); } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
    const name = String(opt.as || path.basename(file));
    const f = await api('POST', `/api/tasks/${id}/files`, data, { raw: true, headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) } });
    out(f, `attached ${f.name} (${fmtSize(f.size)}, ${f.mime}) as file ${f.id} → ${BASE}/api/files/${f.id}`);
  },
  async files() {
    const fs = await api('GET', `/api/tasks/${idArg(pos[1])}/files`);
    out(fs, () => (fs.length ? fs.map((f) => `[${f.id}] ${f.name}  ${f.mime}  ${fmtSize(f.size)}  by ${f.uploaded_by_name} ${rel(f.created_at)}  ${BASE}/api/files/${f.id}`).join('\n') : 'no files'));
  },
  async history() {
    const hs = await api('GET', `/api/tasks/${idArg(pos[1])}/history`);
    out(hs, () => hs.map(histLine).join('\n') || 'no history');
  },
  async activity() {
    const q = new URLSearchParams();
    if (opt.by) q.set('actor', String(opt.by));
    if (opt.who) q.set('actor_name', String(opt.who));
    if (opt.since) q.set('since', String(opt.since));
    if (opt.task) q.set('task', String(opt.task));
    if (opt.limit) q.set('limit', String(opt.limit));
    const hs = await api('GET', `/api/activity?${q}`);
    out(hs, () => hs.map(histLine).join('\n') || 'no activity');
  },
  async revert() {
    const r = await api('POST', `/api/history/${idArg(pos[1], 'history id')}/revert`, { force: !!opt.force });
    out(r, () => `reverted h${r.history.reverts} → h${r.history.id}${r.task ? `; ${taskLine(r.task)}` : ''}`);
  },
  async export() {
    const d = await api('GET', '/api/export');
    console.log(JSON.stringify(d, null, 2));
  },
  async watch() {
    const h = { 'x-actor': ACTOR, 'x-actor-name': NAME };
    if (TOKEN) h.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`${BASE}/api/events`, { headers: h });
    if (!res.ok) fail(`HTTP ${res.status}`);
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (data) console.log(data);
      }
    }
  },
};

function taskFieldsFromOpts() {
  const body = {};
  if (opt.desc !== undefined) body.description = opt.desc === '-' ? readStdin() : String(opt.desc);
  if (opt.assignee !== undefined) body.assignee = opt.assignee;
  if (opt.project !== undefined) body.project = opt.project === 'none' ? null : opt.project;
  if (opt.parent !== undefined) body.parent_id = opt.parent === 'none' ? null : Number(opt.parent);
  if (opt.priority !== undefined) body.priority = Number(opt.priority);
  if (opt.due !== undefined) body.due = opt.due === 'none' ? null : opt.due;
  if (opt.tags !== undefined) body.tags = String(opt.tags).split(',');
  if (opt.needs_review !== undefined) body.needs_review = !!opt.needs_review;
  return body;
}

async function toggleCriteria(done) {
  const id = idArg(pos[1]);
  const spec = pos[2];
  if (!spec) fail(`usage: tm ${done ? 'check' : 'uncheck'} <id> <n[,n..]|all>`);
  const list = await api('GET', `/api/tasks/${id}/criteria`);
  let targets;
  if (spec === 'all') targets = list;
  else {
    targets = spec.split(',').map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > list.length) fail(`criterion number ${s} out of range 1..${list.length}`);
      return list[n - 1];
    });
  }
  const results = [];
  for (const c of targets) results.push(await api('PATCH', `/api/criteria/${c.id}`, { done }));
  const all = await api('GET', `/api/tasks/${id}/criteria`);
  out({ updated: results, criteria: all }, () => all.map((c, i) => `${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}`).join('\n'));
}

(async () => {
  if (opt.help || !pos[0] || pos[0] === 'help') { console.log(HELP); return; }
  const cmd = commands[pos[0]];
  if (!cmd) fail(`unknown command "${pos[0]}" (see tm --help)`);
  try {
    await cmd();
  } catch (e) {
    if (e.exit !== undefined) {
      const d = e.data || {};
      let msg = e.message;
      if (d.unchecked?.length) msg += '\n  unmet criteria:\n' + d.unchecked.map((c) => `    - ${c.text}`).join('\n');
      if (d.current) msg += `\n  current: ${taskLine(d.current)}`;
      if (d.missing?.length) msg += '\n  missing task organization fields: ' + d.missing.map((x) => x.label || x.field).join(', ');
      if (d.question_ids?.length) msg += `\n  unanswered question ids: ${d.question_ids.join(', ')}`;
      fail(msg, e.exit, { code: d.code, unchecked: d.unchecked, current: d.current, missing: d.missing, blocking: d.blocking, warnings: d.warnings, question_ids: d.question_ids });
    }
    fail(e.message, 1);
  }
})();
