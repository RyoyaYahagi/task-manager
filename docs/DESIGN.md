# 設計書: 人間 × AI エージェント共同タスクボード

## 1. コンセプト

- **人間と AI エージェントが同じカンバンを共同管理する**ためのツール。
- 人間はブラウザ GUI（PC / スマホ）、AI エージェントは CLI (`tm`) で操作する。
- レーン（列）は「作業の段階」ではなく **「いまボールを持っているのは誰か」** を軸にする。
  これにより、人間は「あなたの判断待ち」レーンだけ見ればよく、AI は「エージェント待ち」レーンだけ拾えばよい。
- ローカル / 自宅 LAN で 1 人 + 数エージェントが使う規模を想定（マルチテナントや認証基盤は対象外）。

## 2. 技術選定

| 項目 | 選定 | 理由 |
| --- | --- | --- |
| 形態 | **ブラウザベース** | スマホ対応が自動的に付いてくる。インストール不要。GUI と CLI が同じサーバーを共有できる |
| サーバー | Node.js 22 + `node:sqlite` | **依存パッケージゼロ**。`git clone && npm start` で動く。SQLite なのでバックアップはファイルコピー |
| フロント | 素の HTML / CSS / JS（ビルドなし） | 規模に対してフレームワーク + ビルドは過剰。1 ファイル構成で読める・直せる |
| CLI | Node スクリプト（`bin/tm.js`）→ HTTP API | DB を直接触らず API 経由にすることで、GUI へのリアルタイム反映と整合性を保証 |
| リアルタイム | SSE (Server-Sent Events) | WebSocket より単純。一方向通知で十分。自動再接続あり |
| 同時編集 | `version` による楽観ロック | AI と人間が同時に同じタスクを触っても上書き事故を防ぐ |

### 検討して採用しなかった案

- **Electron / ネイティブアプリ**: スマホから使えない。
- **React + Vite**: ビルド工程が増える。必要になったら後から載せ替え可能（API は変わらない）。
- **CLI が SQLite を直接叩く**: GUI に変更を通知できず、ロック処理も二重になる。

## 3. アーキテクチャ

```
  人間 (PC / スマホ)                        AI エージェント (Claude Code など)
    ブラウザ GUI  public/                       tm CLI  bin/tm.js
        │  REST + SSE                              │  REST
        └───────────────────┬──────────────────────┘
                     Node サーバー  src/server.js
                     ・REST API  /api/*
                     ・SSE      /api/events
                     ・静的配信  /  (public/)
                            │
                     src/store.js  (バリデーション・履歴・ロック)
                            │
                     SQLite  data/tasks.db
```

- 1 プロセス、1 ポート（既定 3000）。
- 全ての変更は `store.js` を通り、**履歴の記録**と **SSE 通知**が必ず行われる。
- 操作者（actor）は HTTP ヘッダ `X-Actor: human|agent` と `X-Actor-Name` で識別。GUI は `human`、CLI は既定で `agent`。

## 4. データモデル

```sql
tasks
  id           INTEGER PK      -- 表示は #12 のような通番
  title        TEXT (≤200)
  description  TEXT
  status       TEXT            -- レーン id
  assignee     TEXT            -- human | agent | both
  project      TEXT
  tags         TEXT (JSON配列)
  position     REAL            -- レーン内の並び順
  version      INTEGER         -- 楽観ロック用。更新ごとに +1
  created_by   TEXT            -- human | agent
  created_at / updated_at  TEXT (ISO8601)

notes  (付箋)
  id, task_id (FK, CASCADE), author (human|agent), author_name,
  body TEXT (≤300), created_at, updated_at

history  (履歴)
  id, task_id (FK, CASCADE), actor, actor_name,
  action TEXT,               -- create / update / move / delete / note.add / note.edit / note.delete
  detail TEXT (JSON),        -- 変更差分 {field: [old, new]} や from/to
  created_at
```

- 付箋は「1 枚ずつ独立して追加・編集・削除」する設計。長文の description を共同編集するより競合しにくい。
- 履歴は自動記録のみ（手動編集不可）。誰が（人間 / AI）いつ何をしたかの監査ログ。

## 5. レーンとワークフロー

既定のレーン（`config/lanes.json` で変更可能）:

| id | 表示名 | 意味 |
| --- | --- | --- |
| `todo` | 未着手 | まだ誰も着手していない |
| `in_progress` | 進行中 | 誰か（人間 or AI）が作業中 |
| `waiting_human` | あなたの判断待ち | **AI が人間の判断・回答を待っている** |
| `waiting_agent` | エージェント待ち | **人間が AI に作業を依頼している**（AI の受信箱） |
| `on_hold` | 保留 | いったん止めている |
| `done` | 完了 | 終わった |

典型的なやり取り:

```
人間 (GUI)                                 AI (CLI)
──────────────────────────────────────────────────────────────
タスク作成 →「エージェントに依頼」
   status = waiting_agent  ─────────────▶  tm inbox で検出
                                           tm start <id>      (→ in_progress)
                                           tm note <id> "進捗メモ"
                                           判断が必要になった:
   status = waiting_human  ◀─────────────  tm ask <id> "AかBどちらにしますか"
付箋で回答
「エージェントに依頼」
   status = waiting_agent  ─────────────▶  tm inbox → 続行
                                           tm done <id> "結果メモ"  (→ done)
```

- 人間側の主ボタンは **「エージェントに依頼」**（→ `waiting_agent`）。
- AI 側の主コマンドは **`tm ask`**（→ `waiting_human`）と **`tm done`**。
- それ以外の遷移は GUI の状態セレクト / D&D、CLI の `tm mv` で自由に行える。

## 6. REST API

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/lanes` | レーン定義 |
| GET | `/api/board` | 全レーン + タスク一覧 + プロジェクト / タグの候補。フィルタ `q, assignee, project, tag` |
| GET | `/api/tasks` | タスク一覧。フィルタ `status, assignee, project, tag, q` |
| POST | `/api/tasks` | 作成 |
| GET | `/api/tasks/:id` | 詳細（付箋・履歴を含む） |
| PATCH | `/api/tasks/:id` | 更新。`version` を渡すと不一致で **409** |
| DELETE | `/api/tasks/:id` | 削除 |
| POST | `/api/tasks/:id/move` | `{status, index}` レーン移動と並び替え |
| GET / POST | `/api/tasks/:id/notes` | 付箋一覧 / 追加 |
| PATCH / DELETE | `/api/notes/:id` | 付箋編集 / 削除 |
| GET | `/api/tasks/:id/history` | 履歴 |
| GET | `/api/events` | SSE。`task.created / task.updated / task.deleted / note.*` |
| GET | `/api/health` | 死活確認 |

- 全てのレスポンスは JSON。エラーは `{ "error": "..." }` + 適切なステータス（400 / 404 / 409 / 401）。
- 認証: 環境変数 `TM_TOKEN` を設定した場合のみ、`Authorization: Bearer <token>`（SSE は `?token=`）を要求。

## 7. CLI (`tm`)

AI エージェントが非対話で使う前提。**既定で機械可読な出力**にし、`--json` で完全な JSON を返す。

```
tm ls [--status S] [--assignee A] [--project P] [--tag T] [-q TEXT]
tm inbox                       # status=waiting_agent のタスク（AI の受信箱）
tm show <id>                   # 詳細 + 付箋 + 履歴
tm add <title> [--desc D|-] [--status S] [--assignee A] [--project P] [--tags a,b]
tm edit <id> [--title T] [--desc D|-] [--assignee A] [--project P] [--tags a,b]
tm mv <id> <status>            # 任意レーンへ
tm start <id>                  # → in_progress
tm ask <id> <question>         # → waiting_human + 付箋に質問
tm handoff <id> [note]         # → waiting_agent
tm hold <id> [note]            # → on_hold
tm done <id> [note]            # → done
tm note <id> <text|->          # 付箋追加（≤300 文字、- で stdin）
tm notes <id>
tm history <id>
tm rm <id>
tm lanes
tm watch                       # SSE を JSON Lines で流す（エージェントのループ用）
```

環境変数: `TM_URL`（既定 `http://127.0.0.1:3000`）, `TM_ACTOR`（既定 `agent`）, `TM_ACTOR_NAME`, `TM_TOKEN`。
終了コード: 成功 0 / 失敗 1（stderr にメッセージ、`--json` 時は `{"error":...}`）。

あわせて `docs/AGENT.md` に「エージェント向けの運用手順」（CLAUDE.md / AGENTS.md に貼る想定の短い指示文）を用意する。

## 8. GUI

### レイアウト（PC）

参考スクショに準拠:

- 上部バー: ロゴ / 検索 / 担当・プロジェクトフィルタ / タグ表示切替 / ダークモード / 凡例 / タスク追加
- 左: **詳細パネル**（選択中タスク）。未選択時は非表示でボードが全幅
- 右: **ボード**。レーンは横長の帯、帯の中でカードが折り返して並ぶ。帯ヘッダに色バー・レーン名・件数

### レイアウト（スマホ, < 768px）

- レーン帯が縦に積まれ、カードは 1〜2 列に折り返す
- 詳細パネルは **フルスクリーンのシート**としてスライド表示（閉じるボタンあり）
- ドラッグ＆ドロップの代わりに、詳細パネルの **状態セレクト**で移動
- 上部バーはアイコン化して 1 行に収める

### カード

- 通番 `#12`、タイトル、担当アイコン（👤 人間 / 🤖 AI / 👥 両方）、プロジェクト、付箋数
- タグはトグルで表示 / 非表示
- 「あなたの判断待ち」「エージェント待ち」レーンのカードは **最新の付箋を 1 行プレビュー**（AI からの質問がボード上で読める）
- PC ではドラッグ＆ドロップでレーン移動・並び替え

### 詳細パネル

- タイトル（クリックで編集）、状態、担当、プロジェクト、タグ、更新時刻、説明
- タブ: **付箋** / **履歴**
- 付箋入力（最大 300 文字、残り文字数表示）、付箋ごとに作者アイコン・相対時刻・編集・削除
- フッター: **「エージェントに依頼」**（下書き中の付箋があれば投稿してから `waiting_agent` へ）、「削除」

### その他

- SSE で他者（AI）の変更を即時反映。切断時は接続状態インジケータを表示
- 楽観ロック衝突（409）時はトーストで通知して最新を再読込
- ダーク / ライト（OS 設定に追従 + 手動切替）
- UI 文言は日本語 / 英語の辞書切替（既定はブラウザ言語）
- キーボード: `/` で検索、`Esc` でパネルを閉じる

## 9. 整合性・運用

- **楽観ロック**: GUI / CLI とも更新時に `version` を送る。不一致なら 409 で最新を返し、クライアントが再読込。
- **付箋単位の更新**: 本文の共同編集を避け、追記型で競合を最小化。
- **履歴**: 全変更に actor を記録。AI が何をしたか後から追える。
- **バインド先**: 既定は `127.0.0.1`。スマホから使うときは `TM_HOST=0.0.0.0 TM_TOKEN=xxxx` で起動し、GUI 初回にトークンを入力（localStorage に保存）。
- **データ**: `data/tasks.db`（`.gitignore` 済み）。バックアップはファイルコピー。`TM_DB` で場所変更可。
- **サンプル**: `npm run seed` で参考スクショ相当のデモデータを投入。

## 10. ディレクトリ構成

```
task-manager/
├── package.json          # 依存ゼロ。bin: tm
├── bin/tm.js             # CLI
├── src/
│   ├── server.js         # HTTP / SSE / 静的配信 / ルーティング
│   ├── store.js          # SQLite アクセス・バリデーション・履歴
│   └── lanes.js          # 既定レーン定義と設定ファイル読込
├── config/lanes.json     # レーン定義（編集可）
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── scripts/seed.js       # デモデータ
├── test/                 # node:test（API / store / CLI）
├── docs/
│   ├── DESIGN.md         # 本書
│   └── AGENT.md          # エージェントに渡す運用指示
└── README.md             # セットアップ / 使い方
```

## 11. v1 のスコープ外

- ユーザー管理 / 複数ユーザー認証（トークン 1 本のみ）
- 複数ボード
- ファイル添付、HTML プレビュー、Project Hub、ブックマーク（スクショにあるが今回は省略）
- 通知（プッシュ / メール）
- 期限・優先度フィールド（タグで代用。必要なら列追加は容易）

## 12. 実装順序

1. `store.js` + `server.js`（API / SSE）とテスト
2. `bin/tm.js`（CLI）とテスト
3. GUI（PC → スマホ調整 → ダーク / i18n）
4. seed / README / AGENT.md
5. Chromium で PC 幅・スマホ幅のスクリーンショットを撮って確認
