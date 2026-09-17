// Seed demo data through the HTTP API (server must be running): TM_URL=http://127.0.0.1:3000 node scripts/seed.js
const BASE = (process.env.TM_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = process.env.TM_TOKEN || '';
async function call(method, path, body, actor = 'human', name = 'ryoya') {
  const headers = { 'content-type': 'application/json', 'x-actor': actor, 'x-actor-name': name };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error}`);
  return data;
}
const H = (p, b) => call('POST', p, b, 'human', 'ryoya');
const A = (p, b) => call('POST', p, b, 'agent', 'claude-code');
const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

const existing = await call('GET', '/api/tasks');
if (existing.length) { console.log(`board already has ${existing.length} tasks; not seeding`); process.exit(0); }

await H('/api/projects', { name: 'nuko-whiteboard', color: '#3b82f6', description: 'ホワイトボード API とフロント' });
await H('/api/projects', { name: 'irodori-tts', color: '#ec4899', description: '音声合成まわり' });
await H('/api/projects', { name: 'infra', color: '#14b8a6' });

const t1 = await H('/api/tasks', { title: 'whiteboard: whiteboard-api の骨格を作る (Phase 1)', project: 'nuko-whiteboard', tags: ['whiteboard', 'api'], priority: 3, due: d(3), status: 'in_progress', description: '## ゴール\n- `node:sqlite` を使ったネイティブ部品なしの API\n- レーン 6 本 / SSE / 楽観ロック\n\n参考: 既存の設計メモを参照', criteria: ['GET /api/health が 200 を返す', 'タスクの CRUD が動く', 'node:test のテストが通る'] });
await A(`/api/tasks/${t1.id}/start`, {});
await A(`/api/tasks/${t1.id}/notes`, { body: 'X230 の :8086 に新サービス。node:sqlite（ネイティブ部品を使わない）で作る。' });
await A(`/api/tasks/${t1.id}/notes`, { body: 'レーン 6 本 / SSE / 楽観ロックは設計確定。付箋は 1 枚ずつ編集・削除できる形にする。' });
await call('PATCH', `/api/criteria/${t1.criteria?.[0]?.id ?? (await call('GET', `/api/tasks/${t1.id}/criteria`))[0].id}`, { done: true }, 'agent', 'claude-code');
const s1 = await H('/api/tasks', { title: 'スキーマ定義（tasks / notes / history）', parent_id: t1.id, project: 'nuko-whiteboard', status: 'done' });
await H('/api/tasks', { title: 'SSE エンドポイント', parent_id: t1.id, project: 'nuko-whiteboard', status: 'in_progress' });
await H('/api/tasks', { title: 'CLI から API を叩くテスト', parent_id: t1.id, project: 'nuko-whiteboard' });

const t2 = await H('/api/tasks', { title: 'gateway に whiteboard の host 分岐を追加 (Phase 3)', project: 'nuko-whiteboard', tags: ['infra'], priority: 2, status: 'in_progress' });
await H(`/api/tasks/${t2.id}/notes`, { body: 'nginx の server ブロックを分ける。証明書は wildcard を流用。' });

const t3 = await H('/api/tasks', { title: 'モックアップを見て感想を出す', project: 'nuko-whiteboard', tags: ['ui'], status: 'in_progress', assignee: 'human', due: d(0) });

const t4 = await H('/api/tasks', { title: '1Cat-vLLM(24GB) と ninfer(23.7GB) の DL をどちら先にするか', project: 'infra', tags: ['gpu'], priority: 3, criteria: ['どちらを先に落とすか決める', '決定を README に追記'] });
await A(`/api/tasks/${t4.id}/start`, {});
await A(`/api/tasks/${t4.id}/ask`, { question: 'ディスクの空きが 30GB しかありません。1Cat-vLLM を先に落として検証し、その後 ninfer を落とす順でよいですか？ それとも ninfer 優先ですか？' });

const t5 = await H('/api/tasks', { title: 'T-D(V100 で TTS を動かす検証) をやるか、記録だけ残して捨てるか', project: 'irodori-tts', tags: ['tts', 'v100'], priority: 2, criteria: ['V100 で 1 文の合成が動く', 'RTF を計測して記録'] });
await A(`/api/tasks/${t5.id}/start`, {});
await call('PATCH', `/api/tasks/${t5.id}`, { needs_review: true }, 'human', 'ryoya');
const c5 = await call('GET', `/api/tasks/${t5.id}/criteria`);
for (const c of c5) await call('PATCH', `/api/criteria/${c.id}`, { done: true }, 'agent', 'claude-code');
await A(`/api/tasks/${t5.id}/done`, { note: 'V100 で合成できました。RTF 0.42。手順は docs/tts-v100.md に記録済み。捨てる判断はお任せします。' });

const t6 = await H('/api/tasks', { title: 'A-Uta さん向け計画 (topo / P2P 帯域 / x8x8 / TP2 実測)', project: 'infra', tags: ['gpu', 'plan'], priority: 2, due: d(7), criteria: ['計画を Markdown で書く', '必要な実測項目を列挙'] });
await H(`/api/tasks/${t6.id}/handoff`, { note: '計画の叩き台をお願いします。実測はまだしなくてOK。' });
const t7 = await H('/api/tasks', { title: 'V-B1: 1Cat-vLLM の venv(py3.12) + wheel v1.5.0 導入', project: 'infra', tags: ['gpu'], priority: 3, due: d(-1), criteria: ['venv が作れる', 'import vllm が通る'] });
await H(`/api/tasks/${t7.id}/handoff`, {});

for (const [title, tags] of [['grug-27b-v2 の MTP を split tensor で検証 (V-D)', ['gpu']], ['ninfer-v100 の追加 (219 tok/s の再現確認)', ['gpu']], ['TP2 専用の自作テンソル交換カーネル (V-E)', ['gpu', 'kernel']], ['LLKVApprox (nowokay) のメモを 1 ページに (V-F)', ['memo']], ['V100 2 枚の TP=2 で NCCL を外し、1 往復だけの自作テンソル交換カーネルに置き換える設計メモ', ['gpu', 'design']], ['1Cat の NVFP4 モデル DL (V-B2)', ['gpu']]]) {
  const t = await H('/api/tasks', { title, project: 'infra', tags, status: 'on_hold', priority: 1 });
  await H(`/api/tasks/${t.id}/notes`, { body: '優先度が下がったので保留。' });
}
for (const title of ['tduka-api の復旧', 'Irodori-TTS / 音声モデルの整理', 'Project Hub に一覧を追加']) {
  const t = await H('/api/tasks', { title, project: 'irodori-tts', status: 'done', tags: ['done'] });
  await A(`/api/tasks/${t.id}/notes`, { body: '完了。動作確認済み。', kind: 'report' });
}
await H('/api/tasks', { title: 'README にスマホからの使い方を書く', project: 'nuko-whiteboard', tags: ['docs'], priority: 2 });
await H('/api/tasks', { title: '週次バックアップの cron を確認', project: 'infra', priority: 1, due: d(5) });
console.log('seeded demo data');
