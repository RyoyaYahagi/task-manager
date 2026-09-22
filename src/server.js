// HTTP server: REST API, SSE, static files, multipart upload. Zero dependencies.
import http from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore, StoreError, guessMime, FILE_MAX, NOTE_MAX } from './store.js';
import { loadLanes, loadPolicy } from './lanes.js';
import { createTaskClassifier, loadClassification } from './classifier.js';
import { loadLocalEnv } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, '..', 'public');
const BODY_MAX = FILE_MAX + 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/** Build an http.Server (not listening). */
export function createApp({ store, token = null, publicDir = PUBLIC_DIR, webhookUrl = null, logger = console, classifier = null } = {}) {
  const clients = new Set();

  function classificationMeta() {
    if (classifier?.info) return classifier.info();
    return {
      provider: 'jev', model: null, mode: store.getSettings().classification_mode, threshold: null, available: false,
      create_missing_projects: false, projects: [], tags: [],
    };
  }

  function broadcast(ev) {
    const line = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(line);
    if (webhookUrl) maybeWebhook(ev);
  }
  store.on(broadcast);

  function maybeWebhook(ev) {
    const t = ev.task;
    if (!t || ev.type !== 'task.updated') return;
    let text = null;
    if (ev.action === 'task.ask') text = `❓ #${t.id} ${t.title} — AI からの質問があります`;
    else if (ev.action === 'task.refine_questions') text = `❓ #${t.id} ${t.title} — AI がタスク詳細について質問しています`;
    else if (ev.action === 'task.refine_propose') text = `📝 #${t.id} ${t.title} — AI がタスク詳細案を作成しました`;
    else if (ev.action === 'task.refine_failed') text = `⚠️ #${t.id} ${t.title} — AI深掘りに失敗しました`;
    else if (ev.action === 'task.done' && t.status === 'waiting_human') text = `📝 #${t.id} ${t.title} — 完了報告の確認をお願いします`;
    else if (ev.action === 'task.done') text = `✅ #${t.id} ${t.title} — AI が完了しました`;
    else if (t.status === 'waiting_human' && ev.action === 'task.move') text = `🔔 #${t.id} ${t.title} — あなたの判断待ちに入りました`;
    if (!text) return;
    fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text, event: ev.type, action: ev.action, task: t }) })
      .catch((e) => logger.warn('webhook failed:', e.message));
  }

  // ---- routing ----
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler });
  const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'invalid id'); return n; };
  const bool = (v) => v === '1' || v === 'true' || v === true;

  route('GET', '/api/health', () => ({ ok: true, time: new Date().toISOString() }));
  route('GET', '/api/lanes', () => store.lanes);
  route('GET', '/api/meta', () => ({ lanes: store.lanes, policy: store.policy, note_max: NOTE_MAX, file_max: FILE_MAX, auth: !!token, classification: classificationMeta() }));
  route('GET', '/api/settings', () => store.getSettings());
  route('PATCH', '/api/settings', (c) => store.updateSettings(c.body, c.actor));
  route('GET', '/api/board', (c) => store.board(taskFilter(c.query)));
  route('GET', '/api/usage', () => store.summarizeAiUsage());
  route('GET', '/api/tasks', (c) => store.listTasks(taskFilter(c.query)));
  route('POST', '/api/tasks', (c) => [201, store.createTask(c.body, c.actor)]);
  route('GET', '/api/tasks/:id', (c) => store.getTask(idOf(c.params.id), { includeDeleted: bool(c.query.include_deleted) }));
  route('GET', '/api/tasks/:id/usage', (c) => store.listAiUsage(idOf(c.params.id)));
  route('POST', '/api/tasks/:id/usage', (c) => {
    requireAgent(c.actor);
    return store.recordAiUsage(idOf(c.params.id), c.body, c.actor);
  });
  route('PATCH', '/api/tasks/:id', (c) => store.updateTask(idOf(c.params.id), c.body, c.actor));
  route('POST', '/api/tasks/:id/classification/apply', (c) => {
    requireHuman(c.actor);
    if (!classifier?.applySuggestions) throw new HttpError(503, 'JEV classifier is not configured', { code: 'classifier_unavailable' });
    return classifier.applySuggestions(idOf(c.params.id), c.actor);
  });
  route('POST', '/api/tasks/:id/classify', async (c) => {
    requireHuman(c.actor);
    if (!classifier) throw new HttpError(503, 'JEV classifier is not configured', { code: 'classifier_unavailable' });
    return (await classifier.classifyNow(idOf(c.params.id), { force: true, reclassify: true })) || { task: store.getTask(idOf(c.params.id)), changed: false };
  });
  route('DELETE', '/api/tasks/:id', (c) => store.deleteTask(idOf(c.params.id), c.actor));
  route('POST', '/api/tasks/:id/move', (c) => store.moveTask(idOf(c.params.id), c.body, c.actor));
  route('POST', '/api/tasks/:id/start', (c) => store.startTask(idOf(c.params.id), c.actor, { force: bool(c.body.force), version: c.body.version }));
  route('POST', '/api/tasks/:id/refinements', (c) => store.requestRefinement(idOf(c.params.id), c.actor, { version: c.body.version }));
  route('GET', '/api/tasks/:id/refinements', (c) => store.listRefinements(idOf(c.params.id)));
  route('GET', '/api/refinements/:id', (c) => store.getRefinement(idOf(c.params.id)));
  route('POST', '/api/refinements/:id/questions', (c) => store.submitRefinementQuestions(idOf(c.params.id), c.body.questions, c.actor, { version: c.body.version }));
  route('POST', '/api/refinements/:id/answers', (c) => store.answerRefinement(idOf(c.params.id), c.body.answers, c.actor, { version: c.body.version }));
  route('POST', '/api/refinements/:id/brief', (c) => store.saveRefinementBrief(idOf(c.params.id), c.body.content ?? c.body, c.actor, { version: c.body.version }));
  route('POST', '/api/refinements/:id/cancel', (c) => store.cancelRefinement(idOf(c.params.id), c.actor, { version: c.body.version }));
  route('POST', '/api/refinements/:id/retry', (c) => store.retryRefinement(idOf(c.params.id), c.actor, { version: c.body.version }));
  route('POST', '/api/refinements/:id/fail', (c) => store.failRefinement(idOf(c.params.id), c.body.error, c.actor, { version: c.body.version }));
  route('PATCH', '/api/refinement-briefs/:id', (c) => store.editRefinementBrief(idOf(c.params.id), c.body.content ?? c.body, c.actor, { version: c.body.version }));
  route('POST', '/api/refinement-briefs/:id/accept', (c) => store.acceptRefinementBrief(idOf(c.params.id), c.actor, { version: c.body.version }));
  route('POST', '/api/tasks/:id/ask', (c) => store.askTask(idOf(c.params.id), c.body.question ?? c.body.note, c.actor, { version: c.body.version }));
  route('POST', '/api/tasks/:id/handoff', (c) => store.handoffTask(idOf(c.params.id), c.body.note, c.actor, { version: c.body.version }));
  route('POST', '/api/tasks/:id/hold', (c) => store.holdTask(idOf(c.params.id), c.body.note, c.actor, { version: c.body.version }));
  route('POST', '/api/tasks/:id/done', (c) => store.doneTask(idOf(c.params.id), { note: c.body.note, partial: bool(c.body.partial), version: c.body.version }, c.actor));
  route('POST', '/api/tasks/:id/approve', (c) => store.approveTask(idOf(c.params.id), c.actor, { version: c.body.version }));
  route('POST', '/api/tasks/:id/archive', (c) => store.archiveTask(idOf(c.params.id), c.actor, true));
  route('POST', '/api/tasks/:id/unarchive', (c) => store.archiveTask(idOf(c.params.id), c.actor, false));
  route('POST', '/api/tasks/:id/restore', (c) => store.restoreTask(idOf(c.params.id), c.actor));
  route('GET', '/api/tasks/:id/criteria', (c) => store.listCriteria(idOf(c.params.id)));
  route('POST', '/api/tasks/:id/criteria', (c) => [201, store.addCriterion(idOf(c.params.id), c.body.text, c.actor)]);
  route('PATCH', '/api/criteria/:id', (c) => store.updateCriterion(idOf(c.params.id), c.body, c.actor));
  route('DELETE', '/api/criteria/:id', (c) => store.deleteCriterion(idOf(c.params.id), c.actor));
  route('GET', '/api/tasks/:id/notes', (c) => store.listNotes(idOf(c.params.id)));
  route('POST', '/api/tasks/:id/notes', (c) => [201, store.addNote(idOf(c.params.id), c.body.body, c.actor, c.body.kind || 'note')]);
  route('PATCH', '/api/notes/:id', (c) => store.updateNote(idOf(c.params.id), c.body, c.actor));
  route('DELETE', '/api/notes/:id', (c) => store.deleteNote(idOf(c.params.id), c.actor));
  route('GET', '/api/tasks/:id/files', (c) => store.listFiles(idOf(c.params.id)));
  route('POST', '/api/tasks/:id/files', (c) => {
    const files = c.files || [];
    if (!files.length) throw new HttpError(400, 'no file in request (multipart field "file" or raw body with X-File-Name)');
    const out = files.map((f) => store.addFile(idOf(c.params.id), f, c.actor));
    return [201, out.length === 1 ? out[0] : out];
  });
  route('DELETE', '/api/files/:id', (c) => store.deleteFile(idOf(c.params.id), c.actor));
  route('GET', '/api/files/:id', (c) => {
    const f = store.getFile(idOf(c.params.id));
    const p = store.filePath(f);
    if (!p || !existsSync(p)) throw new HttpError(404, 'file content missing');
    const inline = bool(c.query.inline);
    const headers = {
      'content-type': f.mime,
      'content-length': String(statSync(p).size),
      'x-content-type-options': 'nosniff',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'cache-control': 'private, max-age=3600',
    };
    // Attached HTML is untrusted: sandbox it so it cannot reach the API with the viewer's session.
    if (inline && (f.mime === 'text/html' || f.mime === 'image/svg+xml')) headers['content-security-policy'] = "sandbox allow-scripts allow-modals allow-popups; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'";
    c.res.writeHead(200, headers);
    createReadStream(p).pipe(c.res);
    return null;
  });
  route('GET', '/api/projects', (c) => store.listProjects({ includeArchived: bool(c.query.include_archived) }));
  route('POST', '/api/projects', (c) => [201, store.createProject(c.body, c.actor)]);
  route('PATCH', '/api/projects/:id', (c) => store.updateProject(idOf(c.params.id), c.body, c.actor));
  route('DELETE', '/api/projects/:id', (c) => store.updateProject(idOf(c.params.id), { archived: true }, c.actor));
  route('POST', '/api/classification/reclassify', async (c) => {
    requireHuman(c.actor);
    if (!classifier) throw new HttpError(503, 'JEV classifier is not configured', { code: 'classifier_unavailable' });
    return classifier.reclassifyAll({ includeArchived: bool(c.body.include_archived) });
  });
  route('GET', '/api/tasks/:id/history', (c) => store.listHistory(idOf(c.params.id), { limit: Number(c.query.limit) || 200 }));
  route('GET', '/api/activity', (c) => store.activity({ actor: c.query.actor, actor_name: c.query.actor_name, since: parseSince(c.query.since), task: c.query.task, limit: c.query.limit, before: c.query.before }));
  route('POST', '/api/history/:id/revert', (c) => store.revert(idOf(c.params.id), c.actor, { force: bool(c.body.force) }));
  route('POST', '/api/purge', (c) => store.purge(c.actor));
  route('GET', '/api/export', () => store.exportAll());
  route('GET', '/api/events', (c) => {
    const { res } = c;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    c.req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return null;
  });

  function taskFilter(q) {
    return {
      q: q.q, status: q.status, assignee: q.assignee, project: q.project, tag: q.tag, priority: q.priority,
      parent: q.parent, topLevel: bool(q.top_level), overdue: bool(q.overdue),
      includeArchived: bool(q.include_archived), includeDeleted: bool(q.include_deleted),
    };
  }

  function requireHuman(actor) {
    if (actor.kind !== 'human') throw new HttpError(403, 'only humans can request classification', { code: 'human_only' });
  }

  function requireAgent(actor) {
    if (actor.kind !== 'agent') throw new HttpError(403, 'only agents can record AI usage', { code: 'agent_only' });
  }

  function parseSince(v) {
    if (!v) return undefined;
    const m = /^(\d+)([mhd])$/.exec(v);
    if (m) {
      const ms = Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3 }[m[2]];
      return new Date(Date.now() - ms).toISOString();
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'since must be like 1h, 24h, 7d or an ISO date');
    return d.toISOString();
  }

  // ---- request handling ----
  function actorOf(req) {
    const kind = (req.headers['x-actor'] || 'human').toString().toLowerCase();
    const name = (req.headers['x-actor-name'] || '').toString();
    return { kind: kind === 'agent' ? 'agent' : 'human', name };
  }

  function checkToken(req, url) {
    if (!token) return true;
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ') && safeEq(auth.slice(7).trim(), token)) return true;
    if (req.headers['x-token'] && safeEq(String(req.headers['x-token']), token)) return true;
    if (url.searchParams.get('token') && safeEq(url.searchParams.get('token'), token)) return true;
    return false;
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > BODY_MAX) throw new HttpError(413, 'request body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function parseMultipart(buf, contentType) {
    const m = /boundary="?([^";]+)"?/i.exec(contentType);
    if (!m) throw new HttpError(400, 'multipart boundary missing');
    const boundary = Buffer.from('--' + m[1]);
    const files = [];
    const fields = {};
    let pos = buf.indexOf(boundary);
    while (pos !== -1) {
      pos += boundary.length;
      if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing --
      pos += 2; // CRLF
      const headEnd = buf.indexOf('\r\n\r\n', pos);
      if (headEnd === -1) break;
      const head = buf.subarray(pos, headEnd).toString('utf8');
      const next = buf.indexOf(boundary, headEnd + 4);
      if (next === -1) break;
      const body = buf.subarray(headEnd + 4, next - 2); // strip CRLF before boundary
      const disp = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(head) || [];
      const fname = disp[2];
      const ctype = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1];
      if (fname !== undefined) files.push({ name: decodeURIComponent(fname.replace(/%(?![0-9a-f]{2})/gi, '%25')), mime: ctype, data: Buffer.from(body) });
      else if (disp[1]) fields[disp[1]] = body.toString('utf8');
      pos = next;
    }
    return { files, fields };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const method = req.method.toUpperCase();
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    res.setHeader('cache-control', 'no-store');
    if (!checkToken(req, url)) return sendJson(res, 401, { error: 'unauthorized: set Authorization: Bearer <TM_TOKEN>', code: 'unauthorized' });
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const ctx = { req, res, params: m.groups || {}, query: Object.fromEntries(url.searchParams), actor: actorOf(req), body: {}, files: null };
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        const ct = String(req.headers['content-type'] || '');
        const raw = await readBody(req);
        if (ct.startsWith('multipart/form-data')) {
          const { files, fields } = parseMultipart(raw, ct);
          ctx.files = files; ctx.body = fields;
        } else if (ct.startsWith('application/json') || (!ct && raw.length)) {
          try { ctx.body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'invalid JSON body'); }
          if (ctx.body === null || typeof ctx.body !== 'object') throw new HttpError(400, 'JSON body must be an object');
        } else if (raw.length) {
          // raw upload: X-File-Name header
          ctx.files = [{ name: decodeURIComponent(String(req.headers['x-file-name'] || 'file')), mime: ct, data: raw }];
        }
      }
      const out = await r.handler(ctx);
      if (out === null) return; // handler streamed its own response
      if (Array.isArray(out) && typeof out[0] === 'number') return sendJson(res, out[0], out[1]);
      return sendJson(res, 200, out);
    }
    const known = routes.some((r) => r.re.test(url.pathname));
    sendJson(res, known ? 405 : 404, { error: known ? 'method not allowed' : 'not found', code: known ? 'method_not_allowed' : 'not_found' });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(publicDir, rel));
    if (!file.startsWith(publicDir + path.sep) && file !== publicDir) { res.writeHead(403); return res.end('forbidden'); }
    let st;
    try { st = statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
    if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': guessMime(file) + (/\.(html|js|css|svg|json|webmanifest)$/.test(file) ? '; charset=utf-8' : ''), 'content-length': String(st.size), 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status >= 500) logger.error(e);
      const body = { error: e.message || 'internal error', code: e.code || 'error' };
      for (const k of ['current', 'unchecked', 'rule', 'field', 'missing', 'blocking', 'warnings', 'question_ids']) if (e[k] !== undefined) body[k] = e[k];
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    });
  });
  server.on('close', () => { for (const c of clients) c.end(); clients.clear(); });
  server.broadcast = broadcast;
  return server;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(data)) });
  res.end(data);
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

export function startFromEnv(env) {
  if (env === undefined) {
    loadLocalEnv();
    env = process.env;
  }
  const dataDir = env.TM_DATA_DIR || path.join(here, '..', 'data');
  const dbFile = env.TM_DB || path.join(dataDir, 'tasks.db');
  const lanes = loadLanes(env.TM_LANES);
  const policy = loadPolicy(env.TM_POLICY);
  const store = createStore({ file: dbFile, lanes, policy, filesDir: path.join(dataDir, 'files') });
  const classifier = createTaskClassifier({
    store,
    config: loadClassification(env.TM_CLASSIFICATION_CONFIG),
    gatewayUrl: env.JEV_GATEWAY_URL,
    gatewayToken: env.JEV_GATEWAY_TOKEN,
    model: env.TM_JEV_MODEL,
    timeoutMs: env.TM_JEV_TIMEOUT_MS,
  });
  const token = env.TM_TOKEN || null;
  const server = createApp({ store, token, webhookUrl: env.TM_WEBHOOK_URL || null, classifier });
  const port = Number(env.TM_PORT || 3000);
  const host = env.TM_HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`task board  http://${host}:${port}/`);
    console.log(`  db: ${dbFile}`);
    console.log(`  auth: ${token ? 'token required' : 'none (local only)'}${host === '127.0.0.1' ? '   (set TM_HOST=0.0.0.0 to allow phones on your LAN, and TM_TOKEN=... to protect it)' : ''}`);
  });
  const shutdown = () => { classifier.close(); server.close(); store.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, store, classifier };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnv();
}
