// Task board GUI. Vanilla JS, no build step.
import { renderMarkdown, esc } from './markdown.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } } };
const PRI_LABEL = { 1: '低', 2: '中', 3: '高', 4: '緊急' };
const PRI_MARK = { 1: '↓', 3: '!', 4: '‼' };
const ASSIGNEE_LABEL = { human: '人間', agent: 'AI', both: '両方' };
const ACTION_LABEL = {
  'task.create': 'タスクを作成', 'task.update': '更新', 'task.move': 'レーン移動', 'task.reorder': '並び替え', 'task.start': '作業開始', 'task.ask': '質問して判断待ちへ',
  'task.handoff': 'エージェントに依頼', 'task.hold': '保留', 'task.done': '完了報告', 'task.approve': '承認して完了', 'task.archive': 'アーカイブ', 'task.unarchive': 'アーカイブ解除', 'task.auto_classify': 'JEV が自動分類', 'task.classification_apply': 'JEVの分類候補を反映',
  'task.refine_request': 'AIに詰める', 'task.refine_retry': '精緻化を再試行', 'task.refine_questions': '精緻化の質問', 'task.refine_answers': '精緻化の回答', 'task.refine_propose': '精緻化案を作成', 'task.refine_accept': '精緻化案を承認', 'task.refine_cancel': '精緻化をキャンセル', 'task.refine_failed': '精緻化に失敗', 'refinement.brief_edit': '精緻化案を編集',
  'task.delete': '削除', 'task.restore': '復元', 'criteria.add': '完了条件を追加', 'criteria.edit': '完了条件を編集', 'criteria.check': '完了条件をチェック', 'criteria.delete': '完了条件を削除',
  'note.add': '付箋を追加', 'note.edit': '付箋を編集', 'note.delete': '付箋を削除', 'file.add': 'ファイルを添付', 'file.delete': 'ファイルを削除',
  'project.create': 'プロジェクトを作成', 'project.update': 'プロジェクトを更新', revert: '元に戻す', purge: '完全削除',
};
const FIELD_LABEL = { title: 'タイトル', description: '説明', status: '状態', waiting_reason: '理由', assignee: '担当', priority: '優先度', due: '期限', project_id: 'プロジェクト', parent_id: '親タスク', tags: 'タグ', classification_suggestions: '分類候補', agent_mode: 'AIモード', worker: '作業者', needs_review: '要承認', position: '位置', archived_at: 'アーカイブ', deleted_at: '削除', body: '本文', text: '内容', done: 'チェック', kind: '種別', name: '名前' };

const state = {
  meta: null, lanes: [], board: null, tasks: [], projects: [], tags: [],
  filter: { q: '', project: LS.get('tm.project', ''), assignee: '', priority: '', tag: '', overdue: false, archived: false },
  ui: { showTags: LS.get('tm.showTags', false), hideSubtasks: LS.get('tm.hideSubtasks', window.innerWidth < 768), collapsed: LS.get('tm.collapsed', null), tab: 'notes', theme: LS.get('tm.theme', 'auto') },
  selectedId: null, task: null, noteDraft: '', editing: null, htmlFile: null, token: LS.get('tm.token', ''),
  connected: false,
};
const isMobile = () => window.innerWidth < 768;

// ---------- api ----------
async function api(method, path, body, opts = {}) {
  const headers = { 'x-actor': 'human', 'x-actor-name': LS.get('tm.name', 'human'), ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (body instanceof FormData || body instanceof Blob) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { await askToken(); return api(method, path, body, opts); }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
async function askToken() {
  const dlg = $('#tokenDialog');
  return new Promise((resolve) => {
    $('#tokenForm').onsubmit = (e) => { e.preventDefault(); state.token = new FormData(e.target).get('token').trim(); LS.set('tm.token', state.token); dlg.close(); resolve(); };
    if (!dlg.open) dlg.showModal();
  });
}

// ---------- helpers ----------
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function rel(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}日前`;
  return new Date(ts).toLocaleDateString('ja-JP');
}
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const lane = (id) => state.lanes.find((l) => l.id === id) || { id, name: id, color: '#999' };
const actorIcon = (kind) => `<svg class="ic"><use href="#i-${kind === 'agent' ? 'agent' : 'human'}"/></svg>`;
const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}
function handleError(e) {
  if (e.status === 409 && e.data?.code === 'version_conflict') { toast('別の更新と競合しました。最新の状態を読み込みます', 'error'); refreshDetail(); return; }
  toast(e.message || String(e), 'error');
}
function dueClass(t) { if (!t.due || t.status === 'done') return ''; const d = today(); return t.due < d ? 'late' : t.due === d ? 'today' : ''; }

// ---------- theme ----------
function applyTheme() {
  const t = state.ui.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#themeBtn').innerHTML = `<svg class="ic"><use href="#i-${dark ? 'sun' : 'moon'}"/></svg>`;
  $('#themeBtn').title = `テーマ: ${{ auto: '自動', light: 'ライト', dark: 'ダーク' }[t]}`;
}
$('#themeBtn').onclick = () => { state.ui.theme = { auto: 'dark', dark: 'light', light: 'auto' }[state.ui.theme]; LS.set('tm.theme', state.ui.theme); applyTheme(); };

// ---------- board ----------
let boardTimer = null;
function scheduleBoard() { clearTimeout(boardTimer); boardTimer = setTimeout(loadBoard, 120); }
async function loadBoard() {
  const f = state.filter;
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  if (f.project) q.set('project', f.project);
  if (f.assignee) q.set('assignee', f.assignee);
  if (f.priority) q.set('priority', f.priority);
  if (f.tag) q.set('tag', f.tag);
  if (f.overdue) q.set('overdue', '1');
  if (f.archived) q.set('include_archived', '1');
  try {
    const b = await api('GET', `/api/board?${q}`);
    state.board = b; state.lanes = b.lanes; state.tasks = b.tasks; state.projects = b.projects; state.tags = b.tags;
    if (!state.ui.collapsed) state.ui.collapsed = Object.fromEntries(b.lanes.filter((l) => l.collapsed).map((l) => [l.id, true]));
    renderBoard();
    renderChips();
    renderProjectOptions();
    renderTagOptions();
    updateTitle();
  } catch (e) { handleError(e); }
}

function cardHtml(t) {
  const ln = lane(t.status);
  const proj = t.project ? `<span class="m proj" title="${esc(t.project.name)}"><i style="background:${esc(t.project.color)}"></i>${esc(t.project.name)}</span>` : '';
  const dc = dueClass(t);
  const due = t.due ? `<span class="m due ${dc}" title="期限">${icon('cal')}${esc(t.due.slice(5).replace('-', '/'))}</span>` : '';
  const pri = PRI_MARK[t.priority] ? `<span class="pri pri-${t.priority}" title="優先度: ${PRI_LABEL[t.priority]}">${PRI_MARK[t.priority]}</span>` : '';
  const crit = t.crit_total ? `<span class="m progress" title="完了条件 ${t.crit_done}/${t.crit_total}">${icon('check')}${t.crit_done}/${t.crit_total}<span class="bar"><i style="width:${Math.round((t.crit_done / t.crit_total) * 100)}%"></i></span></span>` : '';
  const sub = t.sub_total ? `<span class="m" title="サブタスク ${t.sub_done}/${t.sub_total}">${icon('sub')}${t.sub_done}/${t.sub_total}</span>` : '';
  const notes = t.note_count ? `<span class="m" title="付箋">${icon('note')}${t.note_count}</span>` : '';
  const files = t.file_count ? `<span class="m" title="添付">${icon('clip')}${t.file_count}</span>` : '';
  const worker = t.worker && t.status === 'in_progress' ? `<span class="m worker" title="作業中">${actorIcon(t.worker === 'human' ? 'human' : 'agent')}${esc(t.worker)}</span>` : '';
  let badge = '';
  if (t.status === 'waiting_human' && t.waiting_reason === 'question') badge = `<span class="badge q">${icon('q')}質問</span>`;
  else if (t.status === 'waiting_human' && t.waiting_reason === 'review') badge = `<span class="badge r">${icon('report')}完了報告</span>`;
  let preview = '';
  if ((t.status === 'waiting_human' || t.status === 'waiting_agent') && t.last_note) {
    preview = `<div class="card-preview ${t.last_note.kind === 'report' ? 'report' : ''}" title="${esc(t.last_note.body)}">${actorIcon(t.last_note.author)} ${esc(t.last_note.body)}</div>`;
  }
  const parent = t.parent_id ? `<div class="card-parent" title="親タスク #${t.parent_id}">${icon('sub')}#${t.parent_id} のサブタスク</div>` : '';
  const tags = state.ui.showTags && t.tags.length ? `<div class="card-tags">${t.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</div>` : '';
  return `<article class="card ${t.id === state.selectedId ? 'selected' : ''} ${dc === 'late' ? 'overdue' : ''} ${t.parent_id ? 'subtask' : ''}" draggable="true" data-id="${t.id}" tabindex="0" role="button" aria-label="#${t.id} ${esc(t.title)}">
    <div class="card-top"><span class="card-num">#${t.id}</span>${badge}<span class="spacer"></span>${pri}<span class="m" title="担当: ${ASSIGNEE_LABEL[t.assignee]}">${icon(t.assignee)}</span></div>
    ${parent}<div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">${proj}${due}${worker}${crit}${sub}${notes}${files}</div>${preview}${tags}
    ${t.archived_at ? '<div class="card-tags"><span class="tag">アーカイブ済み</span></div>' : ''}
  </article>`;
}

function visibleTasks() {
  return state.ui.hideSubtasks ? state.tasks.filter((t) => !t.parent_id) : state.tasks;
}

function renderBoard() {
  const tasks = visibleTasks();
  const html = state.lanes.map((ln) => {
    const items = tasks.filter((t) => t.status === ln.id);
    const collapsed = !!state.ui.collapsed?.[ln.id];
    return `<section class="lane ${collapsed ? 'collapsed' : ''} ${ln.attention && items.length ? 'attention' : ''}" data-lane="${ln.id}" id="lane-${ln.id}">
      <header class="lane-head" data-toggle="${ln.id}"><span class="lane-bar" style="background:${esc(ln.color)}"></span><span class="lane-name">${esc(ln.name)}</span><span class="lane-count">${items.length}件</span><svg class="ic chev"><use href="#i-chev"/></svg></header>
      <div class="lane-body" data-lane="${ln.id}">${items.length ? items.map(cardHtml).join('') : '<div class="lane-empty">（なし）</div>'}</div>
    </section>`;
  }).join('');
  $('#board').innerHTML = html;
}

function renderChips() {
  const tasks = visibleTasks();
  $('#chipbar').innerHTML = state.lanes.map((ln) => {
    const n = tasks.filter((t) => t.status === ln.id).length;
    return `<button class="chip ${ln.attention && n ? 'attention' : ''}" data-jump="${ln.id}"><i style="background:${esc(ln.color)}"></i>${esc(ln.short || ln.name)}<b>${n}</b></button>`;
  }).join('');
}
function updateTitle() {
  const n = state.tasks.filter((t) => t.status === 'waiting_human').length;
  document.title = `${n ? `(${n}) ` : ''}タスクボード`;
}
function renderProjectOptions() {
  const sel = $('#projectSelect');
  const cur = state.filter.project;
  sel.innerHTML = '<option value="">すべてのプロジェクト</option>' + state.projects.map((p) => `<option value="${p.id}" ${String(p.id) === String(cur) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const configured = (state.meta?.classification?.projects || []).map((p) => p.name);
  const names = [...new Set([...state.projects.map((p) => p.name), ...configured])];
  const list = $('#projectList');
  if (list) list.innerHTML = names.map((name) => `<option value="${esc(name)}">`).join('');
}
function renderTagOptions() {
  const sel = $('#tagFilter');
  const cur = state.filter.tag;
  sel.innerHTML = '<option value="">タグ: すべて</option>' + state.tags.map((t) => `<option value="${esc(t)}" ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const configured = (state.meta?.classification?.tags || []).map((t) => t.name);
  const names = [...new Set([...state.tags, ...configured])];
  const list = $('#tagList');
  if (list) list.innerHTML = names.map((name) => `<option value="${esc(name)}">`).join('');
}

// board events
$('#board').addEventListener('click', (e) => {
  const head = e.target.closest('[data-toggle]');
  if (head) { const id = head.dataset.toggle; state.ui.collapsed[id] = !state.ui.collapsed[id]; LS.set('tm.collapsed', state.ui.collapsed); head.closest('.lane').classList.toggle('collapsed'); return; }
  const card = e.target.closest('.card');
  if (card) openTask(Number(card.dataset.id));
});
$('#board').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('card')) openTask(Number(e.target.dataset.id)); });
$('#chipbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jump]');
  if (!b) return;
  const laneEl = $(`#lane-${b.dataset.jump}`);
  if (!laneEl) return;
  if (state.ui.collapsed[b.dataset.jump]) { state.ui.collapsed[b.dataset.jump] = false; LS.set('tm.collapsed', state.ui.collapsed); laneEl.classList.remove('collapsed'); }
  const y = laneEl.getBoundingClientRect().top + window.scrollY - ($('.topbar').offsetHeight + $('#chipbar').offsetHeight + 8);
  window.scrollTo({ top: y, behavior: 'smooth' });
});

// drag & drop (desktop)
let dragId = null;
$('#board').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  dragId = Number(card.dataset.id);
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
});
$('#board').addEventListener('dragend', () => { dragId = null; $$('.card.dragging').forEach((c) => c.classList.remove('dragging')); $$('.lane.drop-target').forEach((l) => l.classList.remove('drop-target')); $$('.drop-marker').forEach((m) => m.remove()); });
$('#board').addEventListener('dragover', (e) => {
  const laneEl = e.target.closest('.lane');
  if (!laneEl || dragId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  $$('.lane.drop-target').forEach((l) => l !== laneEl && l.classList.remove('drop-target'));
  laneEl.classList.add('drop-target');
  // insertion marker
  const body = laneEl.querySelector('.lane-body');
  $$('.drop-marker').forEach((m) => m.remove());
  const marker = document.createElement('div'); marker.className = 'drop-marker';
  const cards = $$('.card:not(.dragging)', body);
  const after = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 && e.clientX < r.right; }) || cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.bottom && e.clientX < r.left + r.width / 2; });
  if (after) body.insertBefore(marker, after); else body.appendChild(marker);
});
$('#board').addEventListener('dragleave', (e) => { const laneEl = e.target.closest('.lane'); if (laneEl && !laneEl.contains(e.relatedTarget)) { laneEl.classList.remove('drop-target'); $$('.drop-marker', laneEl).forEach((m) => m.remove()); } });
$('#board').addEventListener('drop', async (e) => {
  const laneEl = e.target.closest('.lane');
  if (!laneEl || dragId == null) return;
  e.preventDefault();
  const status = laneEl.dataset.lane;
  const body = laneEl.querySelector('.lane-body');
  const marker = body.querySelector('.drop-marker');
  const ids = $$('.card:not(.dragging)', body).map((c) => Number(c.dataset.id));
  let index = ids.length;
  if (marker) { let i = 0; for (const el of body.children) { if (el === marker) break; if (el.classList.contains('card') && !el.classList.contains('dragging')) i++; } index = i; }
  const id = dragId;
  try { await api('POST', `/api/tasks/${id}/move`, { status, index }); } catch (err) { handleError(err); }
  loadBoard();
});

// filters
$('#searchInput').addEventListener('input', (e) => { state.filter.q = e.target.value.trim(); scheduleBoard(); });
$('#projectSelect').addEventListener('change', (e) => { state.filter.project = e.target.value; LS.set('tm.project', state.filter.project); loadBoard(); });
$('#assigneeFilter').addEventListener('change', (e) => { state.filter.assignee = e.target.value; loadBoard(); });
$('#priorityFilter').addEventListener('change', (e) => { state.filter.priority = e.target.value; loadBoard(); });
$('#tagFilter').addEventListener('change', (e) => { state.filter.tag = e.target.value; loadBoard(); });
$('#overdueFilter').addEventListener('change', (e) => { state.filter.overdue = e.target.checked; loadBoard(); });
$('#showArchived').addEventListener('change', (e) => { state.filter.archived = e.target.checked; loadBoard(); });
$('#showTags').checked = state.ui.showTags;
$('#showTags').addEventListener('change', (e) => { state.ui.showTags = e.target.checked; LS.set('tm.showTags', state.ui.showTags); renderBoard(); });
$('#hideSubtasks').checked = state.ui.hideSubtasks;
$('#hideSubtasks').addEventListener('change', (e) => { state.ui.hideSubtasks = e.target.checked; LS.set('tm.hideSubtasks', state.ui.hideSubtasks); renderBoard(); renderChips(); });
$('#clearFilters').onclick = () => {
  Object.assign(state.filter, { q: '', assignee: '', priority: '', tag: '', overdue: false, archived: false });
  $('#searchInput').value = ''; $('#assigneeFilter').value = ''; $('#priorityFilter').value = ''; $('#tagFilter').value = ''; $('#overdueFilter').checked = false; $('#showArchived').checked = false;
  loadBoard();
};
$('#filterBtn').onclick = () => document.body.classList.toggle('filters-open');
$('#filtersClose').onclick = () => document.body.classList.remove('filters-open');
document.addEventListener('click', (e) => { if (document.body.classList.contains('filters-open') && !e.target.closest('#filters') && !e.target.closest('#filterBtn')) document.body.classList.remove('filters-open'); });

// ---------- detail ----------
let detailTimer = null;
function scheduleDetail() { clearTimeout(detailTimer); detailTimer = setTimeout(refreshDetail, 120); }
async function openTask(id, { tab } = {}) {
  state.selectedId = id;
  if (tab) state.ui.tab = tab;
  state.editing = null;
  $$('.card.selected').forEach((c) => c.classList.remove('selected'));
  $(`.card[data-id="${id}"]`)?.classList.add('selected');
  history.replaceState(null, '', `#${id}`);
  await refreshDetail();
  if (isMobile()) $('#detail').scrollTop = 0;
}
async function refreshDetail() {
  if (!state.selectedId) return;
  try {
    state.task = await api('GET', `/api/tasks/${state.selectedId}?include_deleted=1`);
  } catch (e) { if (e.status === 404) { toast('タスクが見つかりません', 'error'); closeDetail(); } else handleError(e); return; }
  renderDetail();
}
function closeDetail() {
  state.selectedId = null; state.task = null; state.editing = null;
  $('#detail').hidden = true; $('#detail').innerHTML = '';
  $('#layout').classList.remove('with-detail');
  $$('.card.selected').forEach((c) => c.classList.remove('selected'));
  history.replaceState(null, '', location.pathname);
}

const BRIEF_FIELDS = [
  ['problem', '解決したい問題', false], ['purpose', '目的', false], ['background', '背景', true],
  ['deliverables', '成果物', true], ['constraints', '制約', true], ['out_of_scope', '対象外', true],
  ['assumptions', '前提', true], ['open_questions', '未解決事項', true], ['next_action', '次の一手', false], ['criteria', '完了条件', true],
];
const BRIEF_LIST_FIELDS = new Set(BRIEF_FIELDS.filter(([, , list]) => list).map(([field]) => field));
function briefFieldText(content, field) {
  const value = content?.[field];
  if (!Array.isArray(value)) return String(value || '');
  return value.map((item) => {
    if (field !== 'open_questions' || typeof item !== 'object') return String(item ?? '');
    return `${item.blocking === false ? '[任意] ' : ''}${item.text || ''}`;
  }).filter(Boolean).join('\n');
}
function briefFieldValue(form, field) {
  const raw = String(form.querySelector(`[data-brief-field="${field}"]`)?.value || '');
  if (!BRIEF_LIST_FIELDS.has(field)) return raw.trim();
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    if (field !== 'open_questions') return line;
    const optional = line.startsWith('[任意]');
    return { text: (optional ? line.slice('[任意]'.length) : line).trim(), blocking: !optional };
  });
}
function collectBriefForm(form) {
  const content = {};
  for (const [field] of BRIEF_FIELDS) content[field] = briefFieldValue(form, field);
  return content;
}
function provenanceBadge(value) {
  if (!value) return '';
  const labels = { user: '本人', inference: '推定', assumption: '前提', unresolved: '未解決', human_edited: '編集済み' };
  return `<span class="provenance ${esc(value)}">${esc(labels[value] || value)}</span>`;
}
function briefReadOnly(brief, { compact = false } = {}) {
  const content = brief?.content || {};
  return `<div class="brief-readonly ${compact ? 'compact' : ''}">${BRIEF_FIELDS.map(([field, label]) => {
    const value = content[field];
    const values = Array.isArray(value) ? value.map((item) => typeof item === 'object' ? `${item.text || ''}${item.blocking === false ? '（任意）' : ''}` : item).filter(Boolean) : (value ? [value] : []);
    if (!values.length) return '';
    return `<div class="brief-row"><dt>${esc(label)} ${provenanceBadge(brief.provenance?.[field])}</dt><dd>${values.map((item) => `<div>${esc(item)}</div>`).join('')}</dd></div>`;
  }).join('')}</div>`;
}
function renderRefinement(t) {
  const r = t.refinement;
  if (!r && !t.brief) return '';
  let body = '';
  if (r?.status === 'waiting_user') {
    const lastRound = Math.max(...(r.questions || []).map((q) => q.round_no), 0);
    const questions = (r.questions || []).filter((q) => q.round_no === lastRound && !q.answer_kind);
    body = `<form class="refinement-form" id="refineAnswerForm" data-form="refine-answer">
      <p class="muted">AI がタスクを実行可能な形にするための質問です。分からない場合は「不明」、AIに任せる場合は「委任」を選べます。</p>
      ${questions.map((q) => `<div class="refine-question" data-refine-question="${q.id}"><label><span class="question-label">${esc(q.question)}${q.blocking ? ' <b>必須</b>' : ' <span class="muted">任意</span>'}</span><select class="select" data-refine-kind><option value="answered">回答する</option><option value="unknown">不明</option><option value="delegate">AIに委任</option></select><textarea class="input" data-refine-answer rows="2" placeholder="回答を入力…"></textarea></label></div>`).join('')}
      <button class="btn primary sm" type="submit">回答して AI に戻す</button>
    </form>`;
  } else if (r?.status === 'draft' && r.brief) {
    const c = r.brief.content || {};
    body = `<form class="refinement-form brief-draft" id="refineBriefForm" data-form="refine-edit" data-brief-id="${r.brief.id}">
      <p class="muted">AI の提案です。必要な箇所を編集してから承認してください。完了条件は承認時に正式なチェック項目へ追加されます。</p>
      <div class="brief-grid">${BRIEF_FIELDS.map(([field, label]) => `<label class="brief-field ${BRIEF_LIST_FIELDS.has(field) ? 'wide' : ''}"><span>${esc(label)} ${provenanceBadge(r.brief.provenance?.[field])}</span>${BRIEF_LIST_FIELDS.has(field) ? `<textarea class="input" data-brief-field="${field}" rows="${field === 'criteria' || field === 'deliverables' ? 3 : 2}">${esc(briefFieldText(c, field))}</textarea><small class="muted">1項目1行${field === 'open_questions' ? '。任意の項目は「[任意]」で開始' : ''}</small>` : `<textarea class="input" data-brief-field="${field}" rows="${field === 'problem' || field === 'purpose' || field === 'next_action' ? 2 : 3}">${esc(briefFieldText(c, field))}</textarea>`}</label>`).join('')}</div>
      <div class="edit-actions"><button class="btn sm" type="submit">案を保存</button><button class="btn ok sm" type="button" data-act="refine-accept">承認して準備完了</button></div>
    </form>`;
  } else if (r && (r.status === 'failed' || r.status === 'cancelled')) {
    body = `<div class="refinement-status ${r.status}"><p>${r.status === 'failed' ? 'AI による詳細化に失敗しました。' : 'この詳細化セッションはキャンセルされています。'}</p>${r.error ? `<div class="error-text">${esc(r.error)}</div>` : ''}<button class="btn sm" data-act="refine-retry">もう一度試す</button></div>`;
  } else if (r) {
    body = `<div class="refinement-status"><p>${r.status === 'pending' ? 'AI の受信箱に入りました。' : 'AI がタスクの詳細を整理しています。'}</p></div>`;
  }
  if (t.brief && !r?.brief) body += `<div class="accepted-brief"><div class="section-title">採用済みのタスクブリーフ</div>${briefReadOnly(t.brief)}</div>`;
  return `<section class="refinement-panel"><div class="section-title">${icon('agent')}AIに詰める${r ? ` <span class="count">${esc(r.status)}</span>` : ''}</div>${body}</section>`;
}

function renderDetail() {
  const t = state.task;
  if (!t) return;
  if (state.editing === 'description') return; // don't clobber an open editor
  const el = $('#detail');
  const ln = lane(t.status);
  const critDone = t.criteria.filter((c) => c.done).length;
  const noteDraftEl = $('#noteInput');
  if (noteDraftEl) state.noteDraft = noteDraftEl.value;
  const noteHtml = renderNotes(t);
  const tabs = [['notes', '付箋', t.notes.length], ['files', 'ファイル', t.files.length], ['html', 'HTML', t.files.filter((f) => f.mime === 'text/html').length], ['history', '履歴', t.history.length]];
  const body = { notes: noteHtml, files: renderFiles(t), html: renderHtmlTab(t), history: renderHistory(t.history, { compact: true }) }[state.ui.tab];
  const suggestions = t.classification_suggestions || [];
  const suggestionHtml = suggestions.length ? `<div class="classification-suggestion-box">
        <div class="section-title">JEVの分類候補 <span class="count">${suggestions.length}件</span><button class="btn sm primary right" data-act="apply-classification">候補を反映</button></div>
        <div class="classification-suggestion-list">${suggestions.map((s) => `<div class="classification-suggestion"><span class="tag">${esc(s.kind === 'project' ? 'プロジェクト' : 'タグ')}</span><b>${esc(s.name)}</b><span class="muted">確信度 ${Math.round(Number(s.confidence) * 100)}%</span></div>`).join('')}</div>
        <p class="muted classification-suggestion-help">クリックすると未登録プロジェクトを作成し、候補をこのタスクへ反映します。既存のプロジェクトも候補で置き換わります。</p>
      </div>` : '';
  el.innerHTML = `
    <div class="detail-head">
      <button class="btn icon mobile-only" data-act="close" aria-label="戻る">${icon('back')}</button>
      <span class="num">#${t.id}</span>
      <span class="lane-chip" style="background:${esc(ln.color)}">${esc(ln.name)}</span>
      ${t.waiting_reason === 'question' ? `<span class="badge q">${icon('q')}質問</span>` : t.waiting_reason === 'review' ? `<span class="badge r">${icon('report')}完了報告</span>` : ''}
      ${t.deleted_at ? '<span class="tag">削除済み</span>' : t.archived_at ? '<span class="tag">アーカイブ</span>' : ''}
      <span class="grow"></span>
      <button class="btn icon" data-act="close" aria-label="閉じる" title="閉じる (Esc)">${icon('x')}</button>
    </div>
    <div class="detail-body">
      <div>
        ${t.parent ? `<div class="card-parent" style="margin-bottom:4px"><a href="#${t.parent.id}" data-open="${t.parent.id}">${icon('sub')}#${t.parent.id} ${esc(t.parent.title)}</a></div>` : ''}
        <div class="detail-title" data-act="edit-title" title="クリックして編集">${esc(t.title)}</div>
        <div class="title-hint">${t.title.length} / 200 文字 ・ タイトルをクリックして編集</div>
      </div>
      <div class="fields">
        <label class="field"><span>状態</span><select class="select" data-field="status">${state.lanes.map((l) => `<option value="${l.id}" ${l.id === t.status ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field"><span>担当</span><select class="select" data-field="assignee">${Object.entries(ASSIGNEE_LABEL).map(([k, v]) => `<option value="${k}" ${k === t.assignee ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="field"><span>優先度</span><select class="select" data-field="priority">${[4, 3, 2, 1].map((p) => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${PRI_LABEL[p]}</option>`).join('')}</select></label>
        <label class="field"><span>期限</span><input class="input" type="date" data-field="due" value="${esc(t.due || '')}"></label>
        <label class="field"><span>プロジェクト</span><input class="input" list="projectList" data-field="project" value="${esc(t.project?.name || '')}" placeholder="候補から選択"></label>
        <label class="field"><span>タグ</span><input class="input" list="tagList" data-field="tags" value="${esc(t.tags.join(', '))}" placeholder="候補を入力（カンマ区切り）"></label>
        <div class="field"><span>作業者</span><div class="static">${t.worker ? `${actorIcon(t.worker === 'human' ? 'human' : 'agent')} ${esc(t.worker)}` : '<span class="muted">—</span>'}</div></div>
        <div class="field"><span>更新</span><div class="static" title="${esc(t.updated_at)}">${fmtDate(t.updated_at)} <span class="muted">(${rel(t.updated_at)})</span></div></div>
        <label class="field-check"><input type="checkbox" data-field="needs_review" ${t.needs_review ? 'checked' : ''}><span>AI の完了報告に人間の承認を必要とする</span></label>
      </div>
      ${suggestionHtml}
      <div>
        <div class="section-title">説明 <button class="btn sm link right" data-act="edit-desc">${icon('edit')}編集</button></div>
        <div class="desc md" data-act="edit-desc">${t.description ? renderMarkdown(t.description) : ''}</div>
      </div>
      <div>
        <div class="section-title">${icon('check')}完了条件 <span class="count">${critDone}/${t.criteria.length}</span></div>
        ${t.criteria.length ? `<div class="crit-list">${t.criteria.map((c) => `
          <div class="crit ${c.done ? 'done' : ''}" data-crit="${c.id}">
            <input type="checkbox" ${c.done ? 'checked' : ''} data-act="crit-toggle" aria-label="達成">
            <div class="txt"><span class="t">${esc(c.text)}</span><div class="by">${actorIcon(c.author)} ${esc(c.author_name)} が追加${c.done ? ` ・ ${actorIcon(c.checked_by)} ${esc(c.checked_by_name || '')} が ${rel(c.checked_at)} にチェック` : ''}</div></div>
            <button class="btn icon sm" data-act="crit-edit" title="編集">${icon('edit')}</button>
            <button class="btn icon sm danger" data-act="crit-del" title="削除">${icon('x')}</button>
          </div>`).join('')}</div>` : `<div class="warn-box">完了条件が未設定です。AI が「何をもって完了か」を判断できるように、依頼前に条件を書いておくことをおすすめします。</div>`}
        <form class="add-row" data-form="crit"><input class="input" name="text" placeholder="完了条件を追加（Enter）" maxlength="300" autocomplete="off"><button class="btn" type="submit">${icon('plus')}</button></form>
      </div>
      ${renderRefinement(t)}
      ${t.parent ? '' : `<div>
        <div class="section-title">${icon('sub')}サブタスク <span class="count">${t.subtasks.filter((s) => s.status === 'done').length}/${t.subtasks.length}</span></div>
        ${t.subtasks.length ? `<div class="sub-list">${t.subtasks.map((s) => `<div class="sub ${s.status === 'done' ? 'done' : ''}" data-open="${s.id}"><span class="lane-dot" style="background:${esc(lane(s.status).color)}"></span><span class="t">#${s.id} ${esc(s.title)}</span><span class="st">${esc(lane(s.status).name)}</span></div>`).join('')}</div>` : ''}
        <form class="add-row" data-form="sub"><input class="input" name="title" placeholder="サブタスクを追加（Enter）" maxlength="200" autocomplete="off"><button class="btn" type="submit">${icon('plus')}</button></form>
      </div>`}
      <div>
        <div class="tabs">${tabs.map(([k, label, n]) => `<button class="tab ${state.ui.tab === k ? 'active' : ''}" data-tab="${k}">${label}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}</div>
      </div>
      <div class="tab-body" id="tabBody">${body}</div>
    </div>
    <div class="actions-bar">${renderActions(t)}</div>`;
  el.hidden = false;
  $('#layout').classList.add('with-detail');
  const ni = $('#noteInput');
  if (ni) { ni.value = state.noteDraft || ''; updateNoteCount(); }
}

function renderActions(t) {
  if (t.deleted_at) return `<button class="btn primary" data-act="restore">${icon('undo')}復元する</button>`;
  const menu = `<div class="menu"><button class="btn icon" data-act="menu" aria-label="その他">${icon('more')}</button><div class="menu-list">
      <button data-act="hold">保留にする</button>
      <button data-act="todo">未着手に戻す</button>
      ${t.archived_at ? '<button data-act="unarchive">アーカイブを解除</button>' : '<button data-act="archive">アーカイブ</button>'}
      <button data-act="add-sub">サブタスクを作成</button>
      <button data-act="classify">JEVで再分類</button>
      <button data-act="delete" class="danger">削除</button>
    </div></div>`;
  if (t.refinement?.status === 'waiting_user') return `<button class="btn primary" data-act="refine-answer-submit">${icon('send')}回答して AI に戻す</button><button class="btn" data-act="refine-cancel">キャンセル</button>${menu}`;
  if (t.refinement?.status === 'draft') return `<button class="btn ok" data-act="refine-accept">${icon('check')}案を承認</button><button class="btn" data-act="refine-cancel">キャンセル</button>${menu}`;
  if (t.refinement?.status === 'failed' || t.refinement?.status === 'cancelled') return `<button class="btn primary" data-act="refine-retry">${icon('undo')}詳細化を再試行</button>${menu}`;
  if (t.refinement?.status === 'pending' || t.refinement?.status === 'running') return `<button class="btn" data-act="refine-cancel">詳細化をキャンセル</button>${menu}`;
  if (t.status === 'waiting_human' && t.waiting_reason === 'review') {
    return `<button class="btn ok" data-act="approve">${icon('check')}承認して完了</button><button class="btn warn" data-act="reject">${icon('undo')}差し戻す</button>${menu}`;
  }
  if (t.status === 'waiting_human' && t.waiting_reason === 'question') {
    return `<button class="btn primary" data-act="answer">${icon('send')}回答して依頼</button><button class="btn" data-act="done">${icon('check')}完了にする</button>${menu}`;
  }
  if (t.status === 'done') {
    return `<button class="btn" data-act="reopen">${icon('undo')}再開する</button>${menu}`;
  }
  const refine = ['todo', 'on_hold'].includes(t.status) ? `<button class="btn primary" data-act="refine-request">${icon('agent')}${t.brief ? 'AIに詰め直す' : 'AIに詰める'}</button>` : '';
  return `${refine}<button class="btn ${refine ? '' : 'primary'}" data-act="handoff">${icon('agent')}エージェントに依頼</button><button class="btn" data-act="done">${icon('check')}完了にする</button>${menu}`;
}

function renderNotes(t) {
  const items = t.notes.length ? [...t.notes].reverse().map((n) => `
    <div class="note ${n.kind}" data-note="${n.id}">
      <div class="note-head"><span class="who">${actorIcon(n.author)}${esc(n.author_name)}</span>${n.kind === 'question' ? `<span class="badge q">${icon('q')}質問</span>` : n.kind === 'report' ? `<span class="badge r">${icon('report')}完了報告</span>` : ''}<span title="${esc(n.created_at)}">${rel(n.created_at)}${n.updated_at !== n.created_at ? '（編集済み）' : ''}</span>
        <span class="actions"><button class="btn icon sm" data-act="note-edit" title="編集">${icon('edit')}</button><button class="btn icon sm danger" data-act="note-del" title="削除">${icon('x')}</button></span></div>
      <div class="note-body md">${renderMarkdown(n.body)}</div>
    </div>`).join('') : '<div class="empty">まだ付箋はありません</div>';
  return `<form class="note-form" data-form="note">
      <textarea id="noteInput" name="body" maxlength="${state.meta?.note_max || 300}" placeholder="メモを入力…（最大 ${state.meta?.note_max || 300} 文字）" rows="3"></textarea>
      <div class="note-form-foot"><button class="btn primary sm" type="submit">${icon('note')}貼る</button><span class="count" id="noteCount">0 / ${state.meta?.note_max || 300}</span></div>
    </form>${items}`;
}
function updateNoteCount() {
  const ni = $('#noteInput'); const nc = $('#noteCount'); if (!ni || !nc) return;
  const max = state.meta?.note_max || 300;
  nc.textContent = `${ni.value.length} / ${max}`; nc.classList.toggle('over', ni.value.length > max);
}

function renderFiles(t) {
  const tok = state.token ? `&token=${encodeURIComponent(state.token)}` : '';
  const items = t.files.length ? t.files.map((f) => `
    <div class="file" data-file="${f.id}">
      <a class="thumb" href="/api/files/${f.id}?inline=1${tok}" target="_blank" rel="noopener">${f.mime.startsWith('image/') ? `<img src="/api/files/${f.id}?inline=1${tok}" alt="">` : esc(f.name.split('.').pop().slice(0, 4))}</a>
      <div class="info"><div class="name" title="${esc(f.name)}">${esc(f.name)}</div><div class="sub">${fmtSize(f.size)} ・ ${actorIcon(f.uploaded_by)} ${esc(f.uploaded_by_name)} ・ ${rel(f.created_at)}</div></div>
      <a class="btn icon sm" href="/api/files/${f.id}?${tok.slice(1)}" download="${esc(f.name)}" title="ダウンロード">${icon('clip')}</a>
      ${f.mime === 'text/html' ? `<button class="btn sm" data-act="view-html" data-id="${f.id}">HTML</button>` : ''}
      <button class="btn icon sm danger" data-act="file-del" title="削除">${icon('x')}</button>
    </div>`).join('') : '<div class="empty">添付ファイルはありません</div>';
  return `<label class="drop" id="dropZone">${icon('clip')} ファイルをドロップ、またはタップして選択（最大 ${fmtSize(state.meta?.file_max || 20971520)}）<input type="file" id="fileInput" multiple hidden></label>${items}`;
}

function renderHtmlTab(t) {
  const htmls = t.files.filter((f) => f.mime === 'text/html');
  if (!htmls.length) return '<div class="empty">HTML ファイルの添付がありません。<br>AI 側は <code>tm attach &lt;id&gt; mockup.html</code> で添付できます。</div>';
  if (!htmls.some((f) => f.id === state.htmlFile)) state.htmlFile = htmls[htmls.length - 1].id;
  const tok = state.token ? `&token=${encodeURIComponent(state.token)}` : '';
  const src = `/api/files/${state.htmlFile}?inline=1${tok}`;
  return `<div class="html-bar"><select class="select" data-act="html-select">${htmls.map((f) => `<option value="${f.id}" ${f.id === state.htmlFile ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select><a class="btn icon" href="${src}" target="_blank" rel="noopener" title="新しいタブで開く">${icon('expand')}</a></div>
    <iframe class="html-frame" sandbox="allow-scripts allow-modals allow-popups" referrerpolicy="no-referrer" src="${src}" title="HTML プレビュー"></iframe>`;
}

function describeChanges(h) {
  const ch = h.detail?.changes;
  if (ch) {
    return Object.entries(ch).filter(([k]) => k !== 'position' && k !== 'checked_by' && k !== 'checked_by_name' && k !== 'checked_at').map(([k, [a, b]]) => {
      const f = (v) => {
        if (v == null || v === '') return '（なし）';
        if (k === 'status') return lane(v).name;
        if (k === 'priority') return PRI_LABEL[v] || v;
        if (k === 'assignee') return ASSIGNEE_LABEL[v] || v;
        if (k === 'project_id') return state.projects.find((p) => p.id === v)?.name || `#${v}`;
        if (k === 'waiting_reason') return { question: '質問', review: '完了報告' }[v] || v;
        if (k === 'done') return v ? 'チェック' : '未チェック';
        if (k === 'needs_review') return v ? 'はい' : 'いいえ';
        if (k === 'deleted_at' || k === 'archived_at') return v ? 'あり' : 'なし';
        if (k === 'classification_suggestions') return (v || []).map((suggestion) => suggestion.name).join('、') || '（なし）';
        if (Array.isArray(v)) return v.join(', ') || '（なし）';
        const s = String(v); return s.length > 60 ? s.slice(0, 60) + '…' : s;
      };
      return `${FIELD_LABEL[k] || k}: ${esc(f(a))} → <b>${esc(f(b))}</b>`;
    }).join('　');
  }
  const s = h.detail?.snapshot;
  if (s?.body) return `「${esc(s.body.length > 80 ? s.body.slice(0, 80) + '…' : s.body)}」`;
  if (s?.text) return `「${esc(s.text)}」`;
  if (s?.name && h.entity === 'file') return esc(s.name);
  if (s?.title) return `「${esc(s.title)}」`;
  return '';
}
function renderHistory(list, { compact = false } = {}) {
  if (!list.length) return '<div class="empty">履歴はありません</div>';
  return `<div class="history-list">${list.map((h) => {
    const revertable = !h.reverted_by && h.action !== 'purge' && !(h.action === 'project.create');
    const label = h.action === 'revert' ? `元に戻す（${ACTION_LABEL[h.detail?.reverted_action] || h.detail?.reverted_action} を取り消し）` : ACTION_LABEL[h.action] || h.action;
    return `<div class="hist ${h.reverted_by ? 'reverted' : ''}" data-hist="${h.id}">
      <span class="who" title="${esc(h.actor)}">${actorIcon(h.actor)}${esc(h.actor_name)}</span>
      <div class="body"><div class="what">${label}${!compact && h.task_id ? ` <span class="task-ref" data-open="${h.task_id}">#${h.task_id} ${esc(h.task_title || '')}</span>` : ''}</div><div class="diff">${describeChanges(h)}</div><div class="when" title="${esc(h.created_at)}">${fmtDate(h.created_at)}（${rel(h.created_at)}）${h.reverted_by ? ' ・ 取り消し済み' : ''}</div></div>
      ${revertable ? `<button class="btn sm" data-act="revert" data-id="${h.id}" title="この操作を取り消す">${icon('undo')}元に戻す</button>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// ----- detail events -----
async function patchTask(patch) {
  const t = state.task;
  try {
    state.task = { ...state.task, ...(await api('PATCH', `/api/tasks/${t.id}`, { ...patch, version: t.version })), criteria: t.criteria, notes: t.notes, files: t.files, subtasks: t.subtasks, parent: t.parent, history: t.history };
    scheduleDetail();
  } catch (e) { handleError(e); }
}
async function act(name, target) {
  const t = state.task;
  const id = t?.id;
  const ni = $('#noteInput');
  const draft = ni ? ni.value.trim() : '';
  try {
    switch (name) {
      case 'close': closeDetail(); break;
      case 'edit-title': {
        const el = target.closest('.detail-title');
        if (!el || el.querySelector('input')) return;
        const input = document.createElement('input');
        input.className = 'detail-title-input'; input.value = t.title; input.maxLength = 200;
        el.replaceWith(input); input.focus(); input.select();
        let doneFlag = false;
        const commit = async () => { if (doneFlag) return; doneFlag = true; const v = input.value.trim(); if (v && v !== t.title) await patchTask({ title: v }); else renderDetail(); };
        input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { doneFlag = true; renderDetail(); } };
        input.onblur = commit;
        break;
      }
      case 'edit-desc': {
        if (state.editing === 'description') return;
        state.editing = 'description';
        const el = $('.desc', $('#detail'));
        el.outerHTML = `<div class="desc-edit"><textarea class="input" id="descInput" rows="8" placeholder="Markdown で書けます">${esc(t.description)}</textarea><div class="edit-actions"><button class="btn sm" data-act="desc-cancel">キャンセル</button><button class="btn primary sm" data-act="desc-save">保存</button></div></div>`;
        $('#descInput').focus();
        break;
      }
      case 'desc-save': { const v = $('#descInput').value; state.editing = null; if (v !== t.description) await patchTask({ description: v }); else renderDetail(); break; }
      case 'desc-cancel': state.editing = null; renderDetail(); break;
      case 'crit-toggle': { const cid = Number(target.closest('[data-crit]').dataset.crit); await api('PATCH', `/api/criteria/${cid}`, { done: target.checked }); scheduleDetail(); break; }
      case 'crit-edit': { const row = target.closest('[data-crit]'); const cid = Number(row.dataset.crit); const c = t.criteria.find((x) => x.id === cid); const v = prompt('完了条件を編集', c.text); if (v != null && v.trim() && v.trim() !== c.text) { await api('PATCH', `/api/criteria/${cid}`, { text: v.trim() }); scheduleDetail(); } break; }
      case 'crit-del': { const cid = Number(target.closest('[data-crit]').dataset.crit); await api('DELETE', `/api/criteria/${cid}`); scheduleDetail(); break; }
      case 'note-edit': { const nid = Number(target.closest('[data-note]').dataset.note); const n = t.notes.find((x) => x.id === nid); const v = prompt('付箋を編集（最大 300 文字）', n.body); if (v != null && v.trim() && v.trim() !== n.body) { await api('PATCH', `/api/notes/${nid}`, { body: v.trim() }); scheduleDetail(); } break; }
      case 'note-del': { const nid = Number(target.closest('[data-note]').dataset.note); if (!confirm('この付箋を削除しますか？（履歴から元に戻せます）')) return; await api('DELETE', `/api/notes/${nid}`); scheduleDetail(); break; }
      case 'file-del': { const fid = Number(target.closest('[data-file]').dataset.file); if (!confirm('このファイルを削除しますか？')) return; await api('DELETE', `/api/files/${fid}`); scheduleDetail(); break; }
      case 'view-html': state.htmlFile = Number(target.dataset.id); state.ui.tab = 'html'; renderDetail(); break;
      case 'html-select': state.htmlFile = Number(target.value); renderDetail(); break;
      case 'revert': { const hid = Number(target.dataset.id); await api('POST', `/api/history/${hid}/revert`, {}); toast('元に戻しました', 'ok'); scheduleDetail(); loadBoard(); break; }
      case 'menu': target.closest('.menu').classList.toggle('open'); break;
      case 'classify': {
        const result = await api('POST', `/api/tasks/${id}/classify`, {});
        if (result.unavailable) toast('JEV API キーが未設定です', 'error');
        else if (result.suggestions?.length) toast(`分類候補: ${result.suggestions.map((x) => x.name).join('、')}`);
        else if (result.changed) toast('JEVで再分類しました', 'ok');
        else toast('反映する分類はありません');
        scheduleDetail(); loadBoard();
        break;
      }
      case 'apply-classification': {
        const projectSuggestion = (t.classification_suggestions || []).find((suggestion) => suggestion.kind === 'project');
        if (projectSuggestion && t.project?.name && !confirm(`現在のプロジェクト「${t.project.name}」を「${projectSuggestion.name}」に変更して候補を反映しますか？`)) return;
        const result = await api('POST', `/api/tasks/${id}/classification/apply`, {});
        if (result.applied?.length) toast(`候補を反映しました: ${result.applied.map((suggestion) => suggestion.name).join('、')}`, 'ok');
        else toast('反映できる候補はありません');
        scheduleDetail(); loadBoard();
        break;
      }
      case 'refine-request': {
        await api('POST', `/api/tasks/${id}/refinements`, { version: t.version });
        state.noteDraft = ''; toast('AI にタスク詳細化を依頼しました', 'ok'); scheduleDetail(); loadBoard();
        break;
      }
      case 'refine-answer-submit': {
        const form = $('#refineAnswerForm');
        if (!form) return;
        form.requestSubmit();
        break;
      }
      case 'refine-accept': {
        const form = $('#refineBriefForm');
        let version = t.version;
        if (form) {
          const saved = await api('PATCH', `/api/refinement-briefs/${form.dataset.briefId}`, { content: collectBriefForm(form), version });
          version = saved.task.version;
        }
        await api('POST', `/api/refinement-briefs/${t.refinement.brief.id}/accept`, { version });
        toast('タスク詳細案を承認しました', 'ok'); scheduleDetail(); loadBoard();
        break;
      }
      case 'refine-cancel': {
        await api('POST', `/api/refinements/${t.refinement.id}/cancel`, { version: t.version });
        toast('タスク詳細化をキャンセルしました', 'ok'); scheduleDetail(); loadBoard();
        break;
      }
      case 'refine-retry': {
        await api('POST', `/api/refinements/${t.refinement.id}/retry`, { version: t.version });
        toast('タスク詳細化を再試行します', 'ok'); scheduleDetail(); loadBoard();
        break;
      }
      case 'handoff': case 'answer': {
        if (name === 'answer' && !draft) { toast('付箋に回答を書いてから押してください', 'error'); ni?.focus(); return; }
        if (name === 'handoff' && !t.criteria.length && !confirm('完了条件が未設定です。このまま AI に依頼しますか？')) return;
        await api('POST', `/api/tasks/${id}/handoff`, { note: draft || undefined, version: t.version });
        state.noteDraft = ''; toast('エージェントに依頼しました', 'ok'); scheduleDetail(); break;
      }
      case 'approve': await api('POST', `/api/tasks/${id}/approve`, { version: t.version }); toast('完了にしました', 'ok'); scheduleDetail(); break;
      case 'reject': {
        const reason = draft || prompt('差し戻しの理由（付箋として残ります）');
        if (reason == null) return;
        await api('POST', `/api/tasks/${id}/handoff`, { note: reason || undefined, version: t.version });
        state.noteDraft = ''; toast('差し戻しました', 'ok'); scheduleDetail(); break;
      }
      case 'done': {
        const unmet = t.criteria.filter((c) => !c.done).length;
        if (unmet && !confirm(`未達成の完了条件が ${unmet} 件あります。完了にしますか？`)) return;
        const note = draft || prompt('結果メモ（何をしたか・どう確認したか）', '完了');
        if (note == null) return;
        await api('POST', `/api/tasks/${id}/move`, { status: 'done', version: t.version });
        if (note.trim()) await api('POST', `/api/tasks/${id}/notes`, { body: note.trim(), kind: 'report' });
        state.noteDraft = ''; toast('完了にしました', 'ok'); scheduleDetail(); break;
      }
      case 'reopen': await api('POST', `/api/tasks/${id}/move`, { status: 'todo', version: t.version }); scheduleDetail(); break;
      case 'todo': await api('POST', `/api/tasks/${id}/move`, { status: 'todo', version: t.version }); scheduleDetail(); break;
      case 'hold': await api('POST', `/api/tasks/${id}/hold`, { note: draft || undefined, version: t.version }); state.noteDraft = ''; scheduleDetail(); break;
      case 'archive': await api('POST', `/api/tasks/${id}/archive`, {}); toast('アーカイブしました', 'ok'); scheduleDetail(); break;
      case 'unarchive': await api('POST', `/api/tasks/${id}/unarchive`, {}); scheduleDetail(); break;
      case 'restore': await api('POST', `/api/tasks/${id}/restore`, {}); toast('復元しました', 'ok'); scheduleDetail(); break;
      case 'delete': { if (!confirm(`#${id} を削除しますか？（履歴から復元できます）`)) return; await api('DELETE', `/api/tasks/${id}`); toast('削除しました（履歴から復元可能）', 'ok'); closeDetail(); break; }
      case 'add-sub': openNewTask({ parent_id: id, project: t.project?.name || '' }); break;
      default: break;
    }
  } catch (e) { handleError(e); }
  if (name !== 'menu') $$('.menu.open').forEach((m) => m.classList.remove('open'));
}
$('#detail').addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { e.preventDefault(); openTask(Number(open.dataset.open)); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab) { state.ui.tab = tab.dataset.tab; renderDetail(); return; }
  const a = e.target.closest('[data-act]');
  if (!a) { $$('.menu.open').forEach((m) => m.classList.remove('open')); return; }
  if (a.tagName === 'INPUT' || a.tagName === 'SELECT') return; // handled on change
  act(a.dataset.act, a);
});
$('#detail').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'crit-toggle' || el.dataset.act === 'html-select') return act(el.dataset.act, el);
  const field = el.dataset.field;
  if (!field) return;
  if (field === 'status') {
    if (el.value === state.task.status) return;
    try { await api('POST', `/api/tasks/${state.task.id}/move`, { status: el.value, version: state.task.version }); scheduleDetail(); } catch (err) { handleError(err); refreshDetail(); }
    return;
  }
  const patch = {};
  if (field === 'tags') patch.tags = el.value.split(',').map((s) => s.trim()).filter(Boolean);
  else if (field === 'needs_review') patch.needs_review = el.checked;
  else if (field === 'priority') patch.priority = Number(el.value);
  else if (field === 'due') patch.due = el.value || null;
  else patch[field] = el.value;
  await patchTask(patch);
});
$('#detail').addEventListener('input', (e) => { if (e.target.id === 'noteInput') { state.noteDraft = e.target.value; updateNoteCount(); } });
$('#detail').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const t = state.task;
  try {
    if (form.dataset.form === 'note') {
      const body = form.body.value.trim();
      if (!body) return;
      await api('POST', `/api/tasks/${t.id}/notes`, { body });
      state.noteDraft = ''; form.body.value = ''; updateNoteCount(); scheduleDetail();
    } else if (form.dataset.form === 'crit') {
      const text = form.text.value.trim(); if (!text) return;
      await api('POST', `/api/tasks/${t.id}/criteria`, { text }); form.text.value = ''; scheduleDetail();
    } else if (form.dataset.form === 'sub') {
      const title = form.title.value.trim(); if (!title) return;
      await api('POST', '/api/tasks', { title, parent_id: t.id, project: t.project?.name || null, status: 'todo' }); form.title.value = ''; scheduleDetail();
    } else if (form.dataset.form === 'refine-answer') {
      const answers = $$('.refine-question', form).map((row) => ({
        id: Number(row.dataset.refineQuestion), kind: $('[data-refine-kind]', row).value, answer: $('[data-refine-answer]', row).value.trim(),
      }));
      await api('POST', `/api/refinements/${t.refinement.id}/answers`, { answers, version: t.version });
      toast('回答を AI に戻しました', 'ok'); scheduleDetail(); loadBoard();
    } else if (form.dataset.form === 'refine-edit') {
      await api('PATCH', `/api/refinement-briefs/${form.dataset.briefId}`, { content: collectBriefForm(form), version: t.version });
      toast('タスク詳細案を保存しました', 'ok'); scheduleDetail();
    }
  } catch (err) { handleError(err); }
});
$('#detail').addEventListener('keydown', (e) => {
  if (e.target.id === 'noteInput' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.target.form.requestSubmit(); }
});
// file drop / select
$('#detail').addEventListener('dragover', (e) => { const z = e.target.closest('#dropZone'); if (z) { e.preventDefault(); z.classList.add('over'); } });
$('#detail').addEventListener('dragleave', (e) => { const z = e.target.closest('#dropZone'); if (z) z.classList.remove('over'); });
$('#detail').addEventListener('drop', (e) => { const z = e.target.closest('#dropZone'); if (!z) return; e.preventDefault(); z.classList.remove('over'); uploadFiles([...e.dataTransfer.files]); });
$('#detail').addEventListener('change', (e) => { if (e.target.id === 'fileInput') { uploadFiles([...e.target.files]); e.target.value = ''; } });
async function uploadFiles(files) {
  const t = state.task;
  if (!files?.length || !t) return;
  const fd = new FormData();
  for (const f of files) fd.append('file', f, f.name);
  try { await api('POST', `/api/tasks/${t.id}/files`, fd); toast(`${files.length} 件を添付しました`, 'ok'); scheduleDetail(); } catch (e) { handleError(e); }
}

// ---------- new task ----------
function openNewTask(preset = {}) {
  const form = $('#newTaskForm');
  form.reset();
  $('#newStatus').innerHTML = state.lanes.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  form.parent_id.value = preset.parent_id || '';
  form.project.value = preset.project ?? (state.filter.project ? (state.projects.find((p) => String(p.id) === String(state.filter.project))?.name || '') : '');
  $('h2', form).textContent = preset.parent_id ? `#${preset.parent_id} のサブタスク` : '新しいタスク';
  $('#newTaskDialog').showModal();
  form.title.focus();
}
$('#addBtn').onclick = () => openNewTask();
$('#newTaskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    title: fd.get('title').trim(), description: fd.get('description'), status: fd.get('status'), assignee: fd.get('assignee'), priority: Number(fd.get('priority')),
    due: fd.get('due') || null, project: fd.get('project').trim() || null, tags: String(fd.get('tags')).split(',').map((s) => s.trim()).filter(Boolean),
    criteria: String(fd.get('criteria')).split('\n').map((s) => s.trim()).filter(Boolean), needs_review: !!fd.get('needs_review'),
  };
  if (fd.get('parent_id')) body.parent_id = Number(fd.get('parent_id'));
  try {
    const t = await api('POST', '/api/tasks', body);
    if (fd.get('handoff')) await api('POST', `/api/tasks/${t.id}/handoff`, {});
    $('#newTaskDialog').close();
    toast(`#${t.id} を作成しました`, 'ok');
    if (body.parent_id && state.selectedId === body.parent_id) scheduleDetail(); else openTask(t.id);
  } catch (err) { handleError(err); }
});
$$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });

// ---------- legend ----------
const LANE_HELP = { todo: 'まだ誰も着手していない', in_progress: '人間または AI が作業中', waiting_human: 'AI があなたの回答・確認を待っている', waiting_agent: 'AI に依頼済み。AI の受信箱', on_hold: 'いったん止めている', done: '終わった' };
function renderClassificationSettings() {
  const hasClassificationMeta = Object.prototype.hasOwnProperty.call(state.meta || {}, 'classification');
  const classification = state.meta?.classification || {};
  const mode = classification.mode || 'off';
  const threshold = classification.threshold == null ? null : Math.round(classification.threshold * 100);
  const status = $('#classificationStatus');
  const badge = $('#classificationStatusBadge');
  const button = $('#classificationBtn');
  const select = $('#classificationMode');
  const info = $('#classificationInfo');
  const candidates = $('#classificationCandidates');

  let statusText = 'サーバー未対応';
  if (hasClassificationMeta) statusText = classification.available ? (mode === 'high_confidence' ? '自動分類オン' : '自動分類オフ') : 'APIキー未設定';
  if (status) status.textContent = statusText;
  if (badge) badge.textContent = hasClassificationMeta ? (classification.available ? (mode === 'high_confidence' ? 'オン' : 'オフ') : 'キー未設定') : '未対応';
  if (button) button.title = `JEV自動分類の設定（${statusText}）`;

  if (select) {
    select.value = mode;
    select.disabled = !hasClassificationMeta;
  }
  if (info) {
    if (!hasClassificationMeta) info.textContent = 'このサーバーは JEV の設定情報を返していません。サーバーを再起動してから再読み込みしてください。';
    else if (!classification.available) info.textContent = 'JEV の API キーが未設定です。候補は確認できますが、自動分類を実行するにはキーの設定が必要です。';
    else if (mode === 'high_confidence') info.textContent = `設定ファイルの候補を使い、新規作成時とタイトル・説明・完了条件の更新時に、確信度 ${threshold ?? 85}% 以上の判定だけ反映します。手動の再分類も実行できます。`;
    else info.textContent = '現在は自動分類オフです。設定ファイルの候補は入力補完と手動の再分類で利用できます。';
  }
  if (!candidates) return;
  if (!hasClassificationMeta) {
    candidates.innerHTML = '<p class="muted">候補を取得できません。サーバーを再起動してから再読み込みしてください。</p>';
    return;
  }

  const projects = Array.isArray(classification.projects) ? classification.projects : [];
  const tags = Array.isArray(classification.tags) ? classification.tags : [];
  const projectRows = projects.length ? projects.map((p) => {
    const action = p.available
      ? '<span class="classification-availability ready">登録済み</span>'
      : classification.create_missing_projects
        ? '<span class="classification-availability">自動作成</span>'
        : `<button type="button" class="btn sm" data-register-project data-key="${esc(p.key)}">プロジェクトを登録</button>`;
    return `<div class="classification-option"><div class="classification-option-main"><b>${esc(p.name)}</b>${p.description ? `<span class="muted">${esc(p.description)}</span>` : ''}</div><div>${action}</div></div>`;
  }).join('') : '<p class="muted">設定ファイルにプロジェクト候補がありません。</p>';
  const tagRows = tags.length
    ? `<div class="classification-tag-list">${tags.map((t) => `<span class="tag classification-tag-option"${t.description ? ` title="${esc(t.description)}"` : ''}>${esc(t.name)}</span>`).join('')}</div>`
    : '<p class="muted">設定ファイルにタグ候補がありません。</p>';
  candidates.innerHTML = `<section class="classification-group"><div class="classification-group-head"><b>プロジェクト候補</b><span class="muted">未登録ならここから作成できます</span></div><div class="classification-option-list">${projectRows}</div></section><section class="classification-group"><div class="classification-group-head"><b>タグ候補</b><span class="muted">新規タスク・タスク詳細の入力補完に表示します</span></div>${tagRows}</section>`;
}
$('#legendBtn').onclick = () => {
  $('#nameInput').value = LS.get('tm.name', '');
  $('#legendLanes').innerHTML = state.lanes.map((l) => `<div class="legend-lane"><span class="lane-bar" style="background:${esc(l.color)}"></span><b>${esc(l.name)}</b><span class="d">${esc(LANE_HELP[l.id] || '')}</span></div>`).join('');
  // Keep a mixed old shell usable until its service-worker cache is replaced.
  if (!$('#classificationDialog')) renderClassificationSettings();
  $('#legendDialog').showModal();
};
$('#classificationBtn')?.addEventListener('click', () => {
  renderClassificationSettings();
  const dialog = $('#classificationDialog');
  if (dialog && !dialog.open) dialog.showModal();
});
$('#classificationMode')?.addEventListener('change', async (e) => {
  const previous = state.meta?.classification?.mode || 'off';
  try {
    const settings = await api('PATCH', '/api/settings', { classification_mode: e.target.value });
    state.meta = state.meta || {};
    state.meta.classification = { ...(state.meta.classification || {}), mode: settings.classification_mode };
    renderClassificationSettings();
    toast(settings.classification_mode === 'high_confidence' ? '高確信度の自動分類をオンにしました' : '自動分類をオフにしました', 'ok');
  } catch (err) {
    e.target.value = previous;
    handleError(err);
  }
});
$('#classificationCandidates')?.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-register-project]');
  if (!button) return;
  const candidate = (state.meta?.classification?.projects || []).find((p) => String(p.key) === String(button.dataset.key));
  if (!candidate || candidate.available) return;
  button.disabled = true;
  button.textContent = '登録中…';
  try {
    await api('POST', '/api/projects', { name: candidate.name, description: candidate.description || '' });
    state.meta = await api('GET', '/api/meta');
    await loadBoard();
    renderClassificationSettings();
    toast(`プロジェクト「${candidate.name}」を登録しました`, 'ok');
  } catch (err) {
    button.disabled = false;
    button.textContent = 'プロジェクトを登録';
    handleError(err);
  }
});
$('#reclassifyAll')?.addEventListener('click', async () => {
  if (!confirm('未アーカイブの既存タスクをすべて JEV で再分類しますか？')) return;
  try {
    const result = await api('POST', '/api/classification/reclassify', {});
    const names = [...new Set((result.suggestions || []).map((x) => x.name))];
    if (result.unavailable) toast('JEV API キーが未設定です', 'error');
    else if (names.length) toast(`${result.changed}件を更新。未作成候補: ${names.join('、')}`);
    else toast(`${result.changed}件を再分類しました`, 'ok');
    loadBoard(); if (state.selectedId) refreshDetail();
  } catch (err) { handleError(err); }
});

// ---------- activity ----------
async function loadActivity() {
  const q = new URLSearchParams();
  if ($('#actActor').value) q.set('actor', $('#actActor').value);
  if ($('#actSince').value) q.set('since', $('#actSince').value);
  q.set('limit', '200');
  try { const list = await api('GET', `/api/activity?${q}`); $('#activityList').innerHTML = renderHistory(list); } catch (e) { handleError(e); }
}
$('#activityBtn').onclick = () => { $('#activityDialog').showModal(); loadActivity(); };
$('#actReload').onclick = loadActivity;
$('#nameInput').addEventListener('change', (e) => { const v = e.target.value.trim(); if (v) LS.set('tm.name', v); else { try { localStorage.removeItem('tm.name'); } catch { /* ignore */ } } toast('表示名を保存しました', 'ok'); });
$('#actActor').onchange = loadActivity; $('#actSince').onchange = loadActivity;
$('#activityList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  if (open) { $('#activityDialog').close(); openTask(Number(open.dataset.open), { tab: 'history' }); return; }
  const b = e.target.closest('[data-act="revert"]');
  if (!b) return;
  try { await api('POST', `/api/history/${b.dataset.id}/revert`, {}); toast('元に戻しました', 'ok'); loadActivity(); loadBoard(); if (state.selectedId) refreshDetail(); } catch (err) { handleError(err); }
});

// ---------- SSE ----------
function setStatus(on) {
  state.connected = on;
  const el = $('#status');
  el.classList.toggle('on', on); el.classList.toggle('off', !on);
  $('.status-text', el).textContent = on ? 'ライブ更新中' : '再接続中…';
}
function connect() {
  const es = new EventSource(`/api/events${state.token ? `?token=${encodeURIComponent(state.token)}` : ''}`);
  es.onopen = () => { setStatus(true); loadBoard(); if (state.selectedId) refreshDetail(); };
  es.onerror = () => setStatus(false);
  const onEvent = (e) => {
    let ev = {};
    try { ev = JSON.parse(e.data); } catch { /* ignore */ }
    if (ev.type === 'settings.updated' && ev.settings) {
      state.meta = state.meta || {};
      state.meta.classification = { ...(state.meta.classification || {}), mode: ev.settings.classification_mode };
      renderClassificationSettings();
    }
    scheduleBoard();
    if (state.selectedId && (ev.task_id === state.selectedId || ev.task?.parent_id === state.selectedId || state.task?.parent_id === ev.task_id)) scheduleDetail();
    if (ev.type === 'task.updated' && ev.action === 'task.ask' && ev.task) toast(`#${ev.task.id} AI から質問があります`);
    if (ev.type === 'task.updated' && ev.action === 'task.refine_questions' && ev.task) toast(`#${ev.task.id} AI がタスク詳細について質問しています`);
    if (ev.type === 'task.updated' && ev.action === 'task.refine_propose' && ev.task) toast(`#${ev.task.id} AI がタスク詳細案を作成しました`, 'ok');
    if (ev.type === 'task.updated' && ev.action === 'task.done' && ev.task) toast(`#${ev.task.id} ${ev.task.status === 'done' ? 'AI が完了しました' : 'AI の完了報告が届きました'}`, 'ok');
  };
  for (const t of ['task.created', 'task.updated', 'task.deleted', 'task.purged', 'refinement.updated', 'note.created', 'note.updated', 'note.deleted', 'criteria.created', 'criteria.updated', 'criteria.deleted', 'file.created', 'file.updated', 'file.deleted', 'project.created', 'project.updated', 'settings.updated']) es.addEventListener(t, onEvent);
}

// The board still needs a live connection for API/SSE data, but the app shell
// can be opened from the home screen while offline. The service worker never
// caches API responses or the event stream.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
    console.warn('service worker registration failed:', err);
  });
}

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (e.key === 'Escape') {
    if ($$('dialog[open]').length) return;
    if (document.body.classList.contains('filters-open')) { document.body.classList.remove('filters-open'); return; }
    if (typing) { document.activeElement.blur(); return; }
    if (state.selectedId) closeDetail();
    return;
  }
  if (typing) return;
  if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
  if (e.key === 'n') { e.preventDefault(); openNewTask(); }
});
window.addEventListener('hashchange', () => { const id = Number(location.hash.slice(1)); if (id && id !== state.selectedId) openTask(id); });

// ---------- init ----------
(async () => {
  registerServiceWorker();
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  try { state.meta = await api('GET', '/api/meta'); renderClassificationSettings(); } catch (e) { handleError(e); }
  await loadBoard();
  connect();
  const id = Number(location.hash.slice(1));
  if (id) openTask(id);
  setInterval(() => { if (!document.hidden && !dragId) { renderBoard(); if (state.task && !state.editing) renderDetail(); } }, 60000);
})();
