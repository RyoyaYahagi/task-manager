# 設計書 v2: 人間 × AI エージェント共同タスクボード

> v2 からの変更: AI深掘り（構造化質問・ブリーフ・人間承認）を追加。v1 からの変更: レーン 6 本確定、UI 日本語のみ、ファイル / HTML タブ追加（Project Hub は除外）、
> 期限・優先度、プロジェクト、サブタスク、完了条件の構造化、監査ログとロールバック、エージェント権限ポリシーを追加。
> 決定: AI は完了を確定してよい（ロールバック可能にする）。付箋上限はとりあえず 300 文字。優先度 4 段階、期限は日付のみ。

## 1. コンセプト

- **人間と AI エージェントが同じカンバンを共同管理する**ためのツール。
- 人間はブラウザ GUI（PC / スマホ）、AI エージェントは CLI (`tm`) で操作する。
- レーンは「作業の段階」ではなく **「いまボールを持っているのは誰か」** を軸にする。
- **人間が最終決定権を持つ**。AI は「完了」まで進められるが、タスクの削除や人間の記述の改変はできない（ポリシーで変更可）。AI の操作はすべて取り消せる。
- **すべての変更は記録され、元に戻せる**。AI の誤操作を追跡・ロールバックできる。
- ローカル / 自宅 LAN で 1 人 + 数エージェントが使う規模を想定。

## 2. 技術選定

| 項目 | 選定 | 理由 |
| --- | --- | --- |
| 形態 | **ブラウザベース** | スマホ対応が付いてくる。インストール不要。GUI と CLI が同じサーバーを共有 |
| サーバー | Node.js 22 + `node:sqlite` | **依存パッケージゼロ**。`git clone && npm start` で動く。バックアップはファイルコピー |
| フロント | 素の HTML / CSS / JS（ビルドなし）+ PWA マニフェスト | ビルド不要。スマホのホーム画面に追加してアプリ風に使える |
| CLI | `bin/tm.js` → HTTP API | DB を直接触らず API 経由にして、GUI へのリアルタイム反映と権限チェックを一元化 |
| リアルタイム | SSE | 一方向通知で十分。自動再接続あり |
| 同時編集 | `version` による楽観ロック | AI と人間が同時に同じタスクを触っても上書き事故を防ぐ |
| 添付ファイル | ローカルディスク `data/files/` | SQLite にはメタデータのみ。20MB / ファイル上限 |

## 3. アーキテクチャ

```
  人間 (PC / スマホ)                    外部 AI ランナー (Codex CLI など)
    ブラウザ GUI  public/                    tm CLI  bin/tm.js
        │  REST + SSE + ファイル upload         │  REST
        └───────────────────┬──────────────────────┘
                     Node サーバー  src/server.js
                     ・REST API  /api/*
                     ・SSE      /api/events
                     ・静的配信  /  (public/)
                            │
                     src/policy.js  (エージェント権限チェック)
                     src/store.js   (バリデーション・履歴・ロック・ロールバック)
                            │
                     SQLite  data/tasks.db      ファイル  data/files/
```

- 操作者（actor）は HTTP ヘッダ `X-Actor: human|agent` と `X-Actor-Name`（例: `claude-code`）で識別。GUI は `human`、CLI は既定で `agent`。
- 全ての変更は `store.js` を通り、**履歴記録**・**SSE 通知**・**権限チェック**が必ず行われる。

## 4. データモデル

```
projects
  id, name (一意), color (#hex), description, archived_at, created_at

tasks
  id                INTEGER PK          -- 表示は #12
  title             TEXT (≤200)
  description       TEXT (Markdown)
  status            TEXT                -- レーン id
  waiting_reason    TEXT                -- waiting_human のとき: question | review | ''  (質問 / 完了報告)
  assignee          TEXT                -- human | agent | both
  priority          INTEGER             -- 1 低 / 2 中 / 3 高 / 4 緊急  (既定 2)
  due               TEXT                -- YYYY-MM-DD または NULL
  project_id        INTEGER FK NULL
  parent_id         INTEGER FK NULL     -- サブタスク（1 階層のみ）
  tags              TEXT (JSON 配列)
  worker            TEXT                -- 現在作業中のエージェント名（tm start で設定）
  needs_review      INTEGER (0/1)       -- AI の完了報告に人間の承認が必要か (既定 0)
  position          REAL                -- レーン内の並び順
  version           INTEGER             -- 楽観ロック
  agent_mode          TEXT                -- '' | refine | execute（サーバー管理）
  created_by, created_at, updated_at
  archived_at       TEXT NULL           -- アーカイブ（ボードから消えるが検索可能）
  deleted_at        TEXT NULL           -- ソフトデリート（ロールバック可能）

criteria  (完了条件)
  id, task_id FK, text, position,
  author (human|agent), author_name,
  done (0/1), checked_by, checked_by_name, checked_at,
  created_at, updated_at

notes  (付箋)
  id, task_id FK, author (human|agent), author_name,
  body TEXT (≤300, Markdown 可), kind (note | question | report),
  created_at, updated_at, deleted_at

files  (添付)
  id, task_id FK, name, mime, size, path (data/files/ 以下),
  uploaded_by, uploaded_by_name, created_at, deleted_at

history  (監査ログ)
  id, task_id FK NULL, actor, actor_name,
  action TEXT,        -- task.create / task.update / task.move / task.archive / task.delete / task.restore
                      --  criteria.add / criteria.edit / criteria.check / criteria.delete
                      --  note.add / note.edit / note.delete / file.add / file.delete
                      --  task.refine_* / refinement.brief_edit / project.* / revert
  detail TEXT (JSON), -- 差分 {field: [old, new]} または復元に必要なスナップショット
  reverted_by INTEGER NULL,  -- この操作を取り消した history.id
  reverts INTEGER NULL,      -- この操作が取り消した history.id
  created_at

refinement_sessions  (AI深掘りの試行)
  id, task_id FK, attempt, status,
  base_task_version, error,
  created_by, created_by_name, created_at, updated_at, completed_at

refinement_questions  (ラウンドごとの構造化質問と回答)
  id, session_id FK, round_no, position, question, blocking,
  answer, answer_kind (answered | unknown | delegate),
  answered_by, answered_by_name, answered_at, created_at

task_briefs  (AI 案 / 人間編集 / 承認済みの版)
  id, task_id FK, session_id FK, revision,
  status (draft | accepted | superseded),
  content JSON, provenance JSON,
  created_by, created_by_name, created_at, updated_at,
  accepted_by, accepted_by_name, accepted_at
```

設計上のポイント:

- **削除はすべてソフトデリート**（tasks / notes / files）。物理削除は `tm purge`（人間のみ）で明示的に行う。
- **履歴は差分 + スナップショット**を持ち、どの操作も単体で逆適用できる（§8）。
- 付箋は追記型・300 文字上限。本文（description）の共同編集より競合しにくい。

## 5. レーンとワークフロー

レーン（`config/lanes.json`）:

| id | 表示名 | 意味 |
| --- | --- | --- |
| `todo` | 未着手 | まだ誰も着手していない |
| `in_progress` | 進行中 | 誰か（人間 or AI）が作業中。`worker` に作業中エージェント名 |
| `waiting_human` | あなたの判断待ち | **AI が人間を待っている**。`waiting_reason` で「質問」か「完了報告」かを表示 |
| `waiting_agent` | エージェント待ち | **人間が AI に依頼している**（AI の受信箱） |
| `on_hold` | 保留 | いったん止めている |
| `done` | 完了 | 終わった（人間の承認済み） |

### 5.1 基本フロー

```
人間 (GUI)                                       AI (CLI)
────────────────────────────────────────────────────────────────────────
タスク作成、完了条件を書く
「エージェントに依頼」→ waiting_agent  ────────▶  tm inbox で検出
                                                 tm start <id>  → in_progress, worker=自分
                                                 （完了条件が無ければ tm criteria add で提案し
                                                   tm ask で確認を求める）
                                                 tm note <id> "進捗"
                                                 判断が必要:
waiting_human [質問] ◀──────────────────────────  tm ask <id> "AかBどちらにしますか"
付箋で回答 →「エージェントに依頼」 ────────────▶  tm inbox → 続行
                                                 tm check <id> 1,2,3  （完了条件にチェック）
done  ◀────────────────────────────────────────  tm done <id> "何をどう検証したか"
（needs_review のタスクは waiting_human [完了報告] に入り
 「承認して完了」→ done / 「差し戻す」→ waiting_agent）
誤りがあれば履歴から「元に戻す」
```

### 5.2 AI深掘り

目的は、タイトルや短い依頼をそのまま実装に投げることではなく、**実行可能な依頼へ変換すること**。通常の「エージェントに依頼」とは別の明示操作にする。

```
人間: 「AI深掘り」
  todo/on_hold → waiting_agent, agent_mode=refine, session=pending
AI: tm start
  → in_progress, session=running
AI: refine ask
  → waiting_human(question), session=waiting_user
人間: refine answer
  → waiting_agent, session=running
AI: refine propose
  → waiting_human(review), session=draft
人間: draft を編集 / refine accept
  → todo, agent_mode=''、完了条件を正式チェック項目へ追加
人間: 「エージェントに依頼」
  → waiting_agent, agent_mode=execute（通常の実装フロー）
```

AI深掘りの質問は blocking / non-blocking を持ち、最大 3 ラウンド・1 ラウンド最大 3 問。AI は grill-me 風に設計ツリーを再評価し、未解決の判断分岐（frontier）が残る限り次のラウンドへ進む。ラウンド数を満たすための質問は追加しない。3 ラウンド目でも blocking な分岐が残る場合は、推測でブリーフを作らず失敗として人間に戻す。判断質問には `options`、`recommended_option`、`recommendation_reason` を付ける。画面にはクリック式の選択肢と「その他（自由回答）」を表示し、人間は「回答」「不明」「AI に委任」を明示する。選択した値は `selected_option` として保存し、「その他」の場合は自由回答を必須にする。AI は情報を発明せず、元タスク・ユーザー回答で確認できた項目だけを確定扱いにし、推定・仮定・未解決を項目ごとの `provenance` に残す。任意のブリーフ項目は空欄でもよい。

ブリーフは、必須項目と必要時だけ記載する項目を分ける。必須項目は `problem` または `purpose` のどちらか一つ、`deliverables`、`criteria`。`background`、`constraints`、`out_of_scope`、`assumptions`、`open_questions`、`next_action` は、タスクに根拠や必要性がある場合だけ記載する。`next_action` は実行開始の補助情報であり、承認の最低条件にはしない。`open_questions` は深掘り後にも残った未解決事項だけを示し、blocking な項目は承認できない。non-blocking の未解決事項は警告として残せる。保存時は既存データとの互換性のため従来の項目名を維持する。

AI の案は人間が編集・承認するまで正式なタスク記述ではない。承認時に `criteria` だけを人間名義の正式なチェック項目として追加し、AI はその後も人間の完了条件を改変できない。承認済みブリーフは説明本文とは別に保持する。

AI深掘りの質問・回答・提案・失敗・承認は専用の履歴と SSE `refinement.updated`、および通常の task history に残す。画面の進捗は現在状態だけでなく、この履歴から段階1〜4のタイムラインとして表示する。キャンセル・失敗後は再試行でき、承認の取り消しはブリーフ・セッション・承認時に追加した条件をまとめて戻す。

AI深掘りの実行キューは、`refinement_sessions` とタスクの `waiting_agent` 状態を永続的なキューとして扱う。「AI深掘り」または回答の送信でキューに登録された直後、サーバーは SSE `refinement.updated` を外部ランナーへ通知する。ランナーは通知を受けて `tm inbox` / `tm ls --status in_progress` を確認し、Codex CLIをWebサーバーのリクエスト内では起動しない。SSEの切断・ランナー再起動・サーバー再起動に備え、ランナー起動時に確認し、既定3分ごと（`CODEX_RUNNER_RECONCILE_MS` で変更可能）にも再確認する。通知は起動のきっかけであり、キューの正しさは永続化されたタスク状態で担保する。

AI深掘りのJEV判定は、Codexが作成した質問または深掘り案を入力にする。質問に選択肢がある場合、JEVは候補から推奨を1つ選び、確信度が閾値未満ならCodexの推奨を変更しない。深掘り案では、JEVが「そのまま提示」「人間に確認」「破棄」のいずれかを判定する。目的・成果物・完了条件を確認できない案は追加質問へ戻し、安全性を確認できない案は表示せず失敗として保留する。JEVが返した採否、routeの確信度、各Noulの確率、判定理由、応答JSONの状態（正常・不完全・不正）と欠落・解釈不能な回答キーは、JEV利用明細のメタデータとして保存し、タスク詳細と `tm show` で確認できる。JEVは自由な質問文やブリーフ本文を生成せず、Codexの生成責務と `tm` の状態変更責務は維持する。JEV の HTTP 呼び出しはローカル Gateway の `JEV_GATEWAY_URL` に送り、TypeSafe の上流認証情報は task-manager のプロセスに渡さない。

AI ランナーはサーバーの子プロセスではない。運用では Codex CLI が `gpt-5.6-luna` / reasoning effort `max` で動き、`tm` CLI を通じてこの状態機械を進める。これにより、コード実行やリポジトリ操作の権限境界を task-manager の HTTP サーバーから分離する。JEV は Codex の代替ではなく、外部ランナー内で選択肢の再評価、出力の安全性確認、深掘り案の品質確認を行う。JEV が確認できない場合は、生成・状態遷移の主体である Codex と `tm` の処理を維持する。

### 5.3 完了条件（受け入れ条件）の構造化

AI の「完了」を曖昧にしないため、タスクごとに **完了条件チェックリスト**を持つ。

- 人間が依頼時に書く。書かずに依頼した場合、GUI は「完了条件が未設定です」と注意する（ブロックはしない）。
- 未設定のまま AI が受け取った場合、AI は条件を **提案**（`tm criteria add`）して `tm ask` で確認を求める（AGENT.md で指示）。
- AI は作業に応じて `tm check <id> <n>` でチェックを付ける（誰がいつチェックしたか記録）。
- **`tm done` は全条件がチェック済みでないと拒否**する（未達の条件を列挙して終了コード 1）。
  部分完了として報告したい場合は `tm done --partial "理由"` で、未達条件つきの完了報告になる。
- `tm done` には **結果メモ（必須）** を付ける。「何を変更したか」「どう検証したか」を書く。
- AI の `tm done` は **既定で `done` に直行**する（結果メモが完了報告として付箋に残る）。誤りは履歴から取り消せる。
  タスクの `needs_review = 1`（要承認）を人間が設定した場合は `waiting_human`（完了報告）に入り、人間が「承認して完了」で `done`。
  `--partial`（未達あり）の場合は常に `waiting_human`（完了報告）になる。
- 人間が書いた完了条件を AI は削除・改変できない（追加とチェックのみ）。

### 5.4 サブタスク

- `parent_id` による **1 階層**のサブタスク。サブタスクも通常のタスク（独自のレーン・担当・完了条件を持つ）。
  → 「スキーマ定義は人間の判断待ち、テスト作成は AI が進行中」のような分担が表現できる。
- 親カードに進捗 `3/5` を表示。詳細パネルにサブタスク一覧と「サブタスクを追加」。
- ボードではサブタスクも通常カードとして表示し、`↳ 親タイトル` を小さく添える。
  ヘッダの「サブタスクを畳む」トグルで親だけ表示に切替（スマホでは既定で畳む）。
- 親を `done` にするとき未完了のサブタスクがあれば警告する（ブロックはしない）。

### 5.5 プロジェクト

- `projects` を独立エンティティにする（名前・色・説明）。フリーテキストではなく色付きチップで一目で区別できる。
- ヘッダに **プロジェクト切替**（すべて / 個別）。ボードは 1 枚で、フィルタで絞る。
- CLI: `tm projects`, `tm project add <name> [--color]`, タスクには `--project <name>` で指定。

### 5.6 JEV 自動分類

- `config/classification.json` に、JEV が選べるプロジェクト候補・タグ候補・閾値を定義する。モデルが自由な名前を返しても、候補キーに一致しない値は反映しない。
- JEV の HTTP 呼び出しは `JEV_GATEWAY_URL`（既定 `http://127.0.0.1:4789/v1/systemone`）へ送り、必要な場合だけ `JEV_GATEWAY_TOKEN` をローカルアクセス用の Bearer トークンとして付ける。TypeSafe の上流 API キーは Gateway が管理する。
- GUI の設定は `settings.classification_mode` に保存し、`off`（既定）または `high_confidence` を選べる。
- `high_confidence` のときだけ、新規タスク作成イベントを契機に JEV を呼び、既定の確信度 0.85 以上のプロジェクト / タグを反映する。
- 既存のプロジェクトやタグを上書き・削除せず、同時編集でバージョン競合が起きた場合は反映を中止する。
- 自動反映は `task.auto_classify` と `jev-auto-classifier` として通常のタスク履歴に残る。JEV の入力は初期実装ではタイトル・説明・完了条件などに限定し、付箋本文と添付ファイルは送らない。
- 未作成プロジェクトは自動作成せず、再分類 API の `suggestions` とタスクの `classification_suggestions` に候補として保存する。既存タスクの一括再分類と、個別タスクの明示的な再分類を用意する。候補は次の成功した再分類で置き換え、候補が無ければクリアする。

## 6. 監査ログとロールバック

「誰が・いつ・何を」を全操作で記録し、AI の誤操作を追跡して取り消せるようにする。

- 記録単位: `history` の 1 行 = 1 操作。`actor`（human / agent）、`actor_name`（例 `claude-code`）、`action`、差分 / スナップショット。
- **取り消し (`revert`)**: 各 history 行は単体で逆適用できる。

  | action | 取り消し方法 |
  | --- | --- |
  | task.update / task.move | `{field: [old, new]}` から old を書き戻す（現在値が new と一致しなければ競合として拒否。`--force` で上書き） |
  | task.create | ソフトデリート |
  | task.delete / task.archive | `deleted_at` / `archived_at` をクリア |
  | note.add / note.edit / note.delete | 削除 / 本文を戻す / 復元 |
  | criteria.* / file.* | 同様 |
  | task.refine_accept | task の状態、承認済みブリーフ、セッション、承認時に追加した完了条件を競合確認付きでまとめて元に戻す |

- 取り消し自体も `revert` として記録される（`reverts` / `reverted_by` で相互参照）。取り消しの取り消しも可能。
- **アクティビティビュー**（GUI ヘッダの「アクティビティ」）: 全タスク横断の操作ログ。
  「AI の操作のみ」「今日」「タスク #n」で絞れ、各行に「元に戻す」ボタン。
- CLI: `tm activity [--actor agent] [--since 1h]`, `tm history <id>`, `tm revert <history_id>`。
- 権限: 人間は全操作を取り消せる。エージェントは **自分の操作のみ**取り消せる（自己修正用）。
- `tm export` で全データを JSON にダンプ（バックアップ用）。

## 7. エージェント権限ポリシー

`config/policy.json` で定義。既定値:

```json
{
  "agent": {
    "can_delete_task": false,
    "can_purge": false,
    "can_close_directly": true,
    "can_edit_human_notes": false,
    "can_delete_files": false,
    "can_edit_human_criteria": false,
    "can_revert_others": false
  }
}
```

- 違反は API が **403** で拒否し、CLI は理由を表示する。
- 人間（GUI）は制限なし。
- 複数エージェント運用のため、`tm start` は `worker` を設定し、別名のエージェントが `tm start` すると **409**（`--force` で奪える）。

## 8. REST API

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/lanes` | レーン定義 |
| GET | `/api/board` | レーン + タスク（サブタスク進捗・付箋数・最新付箋を含む）+ プロジェクト / タグ候補。フィルタ `q, assignee, project, tag, priority, overdue, include_archived` |
| GET / POST | `/api/tasks` | 一覧 / 作成 |
| GET / PATCH / DELETE | `/api/tasks/:id` | 詳細（完了条件・付箋・ファイル・サブタスク・履歴を含む）/ 更新（`version` 不一致で 409）/ ソフトデリート |
| POST | `/api/tasks/:id/move` | `{status, index, waiting_reason?}` |
| POST | `/api/tasks/:id/start` | 作業開始（worker 設定、409 制御） |
| POST | `/api/tasks/:id/refinements` | 人間が AI深掘りを依頼（`agent_mode=refine`） |
| GET | `/api/tasks/:id/refinements` | AI深掘りセッション履歴 |
| GET | `/api/refinements/:id` | 質問・回答・ブリーフを含むセッション詳細 |
| POST | `/api/refinements/:id/questions` | AI が質問を提出。`{questions:[{question,blocking?,options?,recommended_option?,recommendation_reason?}], version?}` |
| POST | `/api/refinements/:id/answers` | 人間が回答。`{answers:[{id,kind,selected_option?,answer}], version?}` |
| POST | `/api/refinements/:id/brief` | AI がブリーフ案を提出。問題または目的、成果物、完了条件がない場合は 422。`content.provenance` で項目ごとの根拠（`user` / `inference` / `assumption` / `unresolved`）を保存 |
| PATCH | `/api/refinement-briefs/:id` | 人間がブリーフ案を編集 |
| POST | `/api/refinement-briefs/:id/accept` | 人間が承認し、完了条件を正式化 |
| POST | `/api/refinements/:id/cancel` `/retry` `/fail` | キャンセル / 再試行 / AI の失敗報告 |
| POST | `/api/tasks/:id/done` | 完了報告。`{note, partial?}`。条件未達なら 422 |
| POST | `/api/tasks/:id/approve` | 人間の承認 → done |
| POST | `/api/tasks/:id/archive`, `/restore` | アーカイブ / 復元 |
| GET / POST | `/api/tasks/:id/criteria` | 完了条件一覧 / 追加 |
| PATCH / DELETE | `/api/criteria/:id` | 編集・チェック / 削除 |
| GET / POST | `/api/tasks/:id/notes` | 付箋一覧 / 追加 |
| PATCH / DELETE | `/api/notes/:id` | 付箋編集 / 削除 |
| GET / POST | `/api/tasks/:id/files` | 添付一覧 / アップロード（multipart） |
| GET / DELETE | `/api/files/:id` | ダウンロード（`?inline=1` で HTML プレビュー用）/ 削除 |
| GET / POST | `/api/projects` | プロジェクト一覧 / 作成 |
| PATCH / DELETE | `/api/projects/:id` | 更新 / アーカイブ |
| GET / PATCH | `/api/settings` | 自動分類モードの取得 / 更新 |
| POST | `/api/tasks/:id/classify` | 人間が指定したタスクを JEV で再分類 |
| POST | `/api/classification/reclassify` | 既存タスクを一括再分類 |
| GET | `/api/tasks/:id/history` | タスク履歴 |
| GET | `/api/activity` | 全体ログ。`actor, since, task, limit` |
| POST | `/api/history/:id/revert` | 取り消し |
| GET | `/api/export` | 全データ JSON |
| GET | `/api/events` | SSE |
| GET | `/api/health` | 死活確認 |

- エラー: `{ "error": "...", "code": "..." }` + 400 / 401 / 403 / 404 / 409 / 422。
- 認証: `TM_TOKEN` 設定時のみ `Authorization: Bearer`（SSE / ファイル URL は `?token=`）。

## 9. CLI (`tm`)

AI エージェントが非対話で使う前提。ヘルプ・出力は英語（エージェント向け）。`--json` で完全な JSON。

```
# 見る
tm inbox                          # waiting_agent のタスク（AI の受信箱）
tm ls [--status S] [--project P] [--assignee A] [--tag T] [--priority N] [--overdue] [-q TEXT]
tm show <id>                      # 詳細: 完了条件・サブタスク・付箋・ファイル・履歴
tm lanes / tm projects

# 作る・直す
tm add <title> [--desc D|-] [--status S] [--assignee A] [--project P] [--parent ID]
                [--priority 1-4] [--due YYYY-MM-DD] [--tags a,b] [--criteria "c1" --criteria "c2"]
tm edit <id> [--title ..] [--desc ..|-] [--priority ..] [--due ..] [--project ..] [--tags ..]
tm project add <name> [--color #hex]

# 進める
tm start <id> [--force]           # → in_progress, worker=自分
tm ask <id> <question>            # → waiting_human (質問)
tm refine request <id>             # 人間: AI深掘りを依頼（human actor）
tm refine show <session_id>        # AI深掘りセッションを見る
tm refine ask <session_id> '<JSON>' # AI: 質問を提出
tm refine answer <session_id> '<JSON>' # 人間: 回答 / unknown / delegate
tm refine propose <session_id> '<JSON>' # AI: ブリーフ案を提出
tm refine edit <brief_id> '<JSON>'     # 人間: 案を編集
tm refine accept <brief_id>        # 人間: 承認して完了条件を正式化
tm check <id> <n[,n..]>           # 完了条件にチェック  / tm uncheck
tm criteria add <id> <text>       # 完了条件を提案
tm done <id> <result note> [--partial]   # → waiting_human (完了報告)  ※全条件チェック必須
tm mv <id> <status>               # 任意レーンへ（ポリシーの範囲で）
tm hold <id> [note] / tm handoff <id> [note]

# 付箋・ファイル
tm note <id> <text|->             # ≤300 文字、- で stdin
tm notes <id>
tm attach <id> <path> [--name N]  # 添付（HTML ならブラウザの HTML タブでプレビューされる）
tm files <id>

# ログ
tm history <id>
tm activity [--actor agent|human] [--since 1h|24h|YYYY-MM-DD] [--task ID]
tm revert <history_id> [--force]
tm export > backup.json

# イベント
tm watch                          # SSE を JSON Lines で流す（エージェントのループ用）
```

環境変数: `TM_URL`（既定 `http://127.0.0.1:3000`）, `TM_ACTOR`（既定 `agent`）, `TM_ACTOR_NAME`（既定 `agent`）, `TM_TOKEN`。
終了コード: 0 成功 / 1 エラー / 2 権限拒否 / 3 完了条件未達。

`docs/AGENT.md` にエージェント向け運用手順（CLAUDE.md / AGENTS.md に貼る想定）を用意する。

## 10. GUI（日本語のみ）

### 10.1 PC レイアウト

- 上部バー: ロゴ / プロジェクト切替 / 検索 / フィルタ（担当・優先度・期限切れ）/ タグ表示 / サブタスクを畳む / アクティビティ / 凡例 / テーマ / **タスクを追加**
- 左: **詳細パネル**（選択中タスク）。未選択時は非表示でボードが全幅
- 右: **ボード**。レーンは横長の帯、帯の中でカードが折り返して並ぶ。帯ヘッダに色バー・レーン名・件数。
  完了レーンは既定で畳み（件数のみ表示、クリックで展開）
- ドラッグ＆ドロップでレーン移動・並び替え

### 10.2 スマホレイアウト（< 768px）

見やすさを最優先に、PC の縮小版ではなく専用の配置にする。

- **上部**: 1 行目にロゴ・プロジェクト切替・「＋」。2 行目に検索。フィルタ類は「絞り込み」ボタンからボトムシートで開く
- **レーンチップバー**（sticky）: `判断待ち 2 | 進行中 3 | AI待ち 1 | …` を横スクロール。タップでそのレーンへスクロール。
  「あなたの判断待ち」が 1 件以上あればチップを強調色にして、開いた瞬間に「自分がやること」が分かる
- **レーン**: 縦に積む。各レーンは折りたたみ可（完了・保留は既定で畳む）。ヘッダは sticky
- **カード**: 全幅、最小タップ領域 44px。タイトルは 2 行まで。1 行目にタイトル、2 行目に `優先度アイコン・期限・担当アイコン・付箋数`。
  判断待ちカードは **質問 / 完了報告の付箋を 2 行プレビュー**（ボードを開くだけで AI の質問が読める）。
  タグ・サブタスクは既定で非表示（トグルで表示）
- **詳細**: 画面下からスライドするフルスクリーンシート。上部に「← 戻る」と `#12`、タイトル。
  本文は縦スクロール: 基本情報（状態 / 担当 / 優先度 / 期限 / プロジェクト / タグ を 2 列グリッド）→ 説明 → **完了条件** → タブ（付箋 / ファイル / HTML / 履歴）。
  **下部固定のアクションバー**: 状況に応じて主ボタンが変わる
  - 通常: 「付箋を追加」「エージェントに依頼」
  - 完了報告あり: 「承認して完了」「差し戻す」
  - 質問あり: 「回答して依頼」（付箋入力にフォーカス → 投稿と同時に waiting_agent）
- 入力欄のフォントは 16px 以上（iOS の自動ズーム防止）。safe-area 対応。横スクロールは出さない
- PWA マニフェスト（ホーム画面追加、standalone 表示、アイコン）
- 未読の「判断待ち」件数をタブタイトルに `(2) タスクボード` と表示

### 10.3 詳細パネルのタブ

- **付箋**: 入力（300 文字、残り文字数）、作者アイコン（👤 / 🤖 + 名前）、相対時刻、種別バッジ（質問 / 完了報告）、編集 / 削除（権限に応じて）。Markdown の軽量レンダリング（太字・コード・リスト・リンク）
- **ファイル**: ドラッグ＆ドロップ / ファイル選択でアップロード（スマホはカメラ / 写真も可）。一覧（名前・サイズ・誰が・いつ）、ダウンロード、削除。画像はサムネイル
- **HTML**: 添付の `.html` を選んで **sandbox iframe** でプレビュー（`sandbox="allow-scripts"`、same-origin は与えない）。AI が作ったモックアップをスマホで確認する用途。全画面ボタンあり
- **履歴**: 操作ログ（誰が・いつ・何を・差分）。各行に「元に戻す」

### 10.4 その他

- SSE でライブ更新。切断時はインジケータ表示
- 409（楽観ロック衝突）時はトーストで通知して再読込
- ダーク / ライト（OS 追従 + 手動）
- キーボード: `/` 検索、`n` 新規、`Esc` 閉じる
- 期限: 期限切れは赤、当日は橙で表示。優先度は色付きアイコン（緊急 = 赤 ‼ / 高 = 橙 ! / 中 = 無印 / 低 = 灰 ↓）
- 説明は Markdown を安全にレンダリング（HTML は許可しない）

## 11. 通知（任意）

- `TM_WEBHOOK_URL` を設定すると、「判断待ちに入った」「完了報告が来た」時に JSON を POST する（Slack / Discord の Incoming Webhook 互換の `text` / `content` を含む）。
- ブラウザの Web Push は v1 では対象外（サービスワーカー + 鍵管理が重い）。

## 12. 運用

- 既定は `127.0.0.1:3000`。スマホから使うときは `TM_HOST=0.0.0.0 TM_TOKEN=xxxx npm start`。GUI 初回にトークン入力（localStorage 保存）
- データ: `data/tasks.db` と `data/files/`（`.gitignore` 済み）。`TM_DATA_DIR` で変更可。バックアップはディレクトリコピー or `tm export`
- `npm run seed` でデモデータ投入
- Chromium で PC 幅（1280px）・スマホ幅（390px）のスクリーンショットを撮って確認する

## 13. ディレクトリ構成

```
task-manager/
├── package.json            # 依存ゼロ。bin: tm
├── bin/tm.js               # CLI
├── src/
│   ├── server.js           # HTTP / SSE / 静的配信 / multipart / ルーティング
│   ├── store.js            # SQLite・バリデーション・履歴・revert
│   ├── policy.js           # エージェント権限
│   ├── markdown.js         # 軽量 Markdown（サーバー・GUI 共用）
│   └── lanes.js            # レーン定義の読込
├── config/
│   ├── lanes.json
│   └── policy.json
├── public/
│   ├── index.html / app.js / style.css
│   ├── manifest.webmanifest / icons/
├── scripts/seed.js
├── test/                   # node:test（store / API / policy / revert / CLI）
├── docs/DESIGN.md, docs/AGENT.md
└── README.md
```

## 14. v1 のスコープ外

- 複数ユーザー認証（トークン 1 本のみ）、複数ボード
- Project Hub、ブックマーク
- Web Push 通知（Webhook で代替）
- 2 階層以上のサブタスク、繰り返しタスク、時間計測
- JSON インポート（エクスポートのみ）

## 15. 実装順序

1. store（スキーマ・履歴・revert・ソフトデリート）+ policy + テスト
2. server（API / SSE / multipart / 静的）+ テスト
3. CLI + テスト
4. GUI: PC ボード → 詳細パネル（4 タブ + 完了条件 + サブタスク）→ スマホ専用レイアウト → ダーク → PWA
5. アクティビティビュー・revert UI
6. seed / README / AGENT.md / スクリーンショット確認
