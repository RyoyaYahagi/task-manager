# REST API / SSE リファレンス

`tm` を使わずに直接 HTTP で叩く場合に読む。別言語のクライアントを書くとき、ブラウザ拡張から触るとき、
あるいはボード自体を改造するときが対象。通常のエージェント操作は `tm` で足りる。

## 認証と操作者の識別

| ヘッダ | 値 | 意味 |
| --- | --- | --- |
| `X-Actor` | `human` / `agent` | 操作者の種別。省略時は `human` |
| `X-Actor-Name` | 任意の文字列（60 文字まで） | 履歴・付箋に残る名前 |
| `Authorization` | `Bearer <TM_TOKEN>` | サーバーが `TM_TOKEN` 付きで起動している場合のみ必須 |

SSE とファイル取得は `?token=<TM_TOKEN>` でも認証できる（`EventSource` や `<img>` がヘッダを送れないため）。

レスポンスはすべて JSON。エラーは `{ "error": "...", "code": "..." }` と適切なステータス。

## タスク

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/board` | レーン定義 + タスク一覧 + プロジェクト + タグ候補。GUI が使う 1 発取得 |
| GET | `/api/tasks` | タスク一覧 |
| POST | `/api/tasks` | 作成（201） |
| GET | `/api/tasks/:id` | 詳細（完了条件・付箋・ファイル・サブタスク・履歴を含む） |
| PATCH | `/api/tasks/:id` | 更新 |
| DELETE | `/api/tasks/:id` | ソフトデリート |
| POST | `/api/tasks/:id/move` | `{status, index?, waiting_reason?, version?}` |
| POST | `/api/tasks/:id/start` | `{force?, version?}` |
| POST | `/api/tasks/:id/ask` | `{question, version?}` |
| POST | `/api/tasks/:id/handoff` | `{note?, version?}` |
| POST | `/api/tasks/:id/hold` | `{note?, version?}` |
| POST | `/api/tasks/:id/done` | `{note, partial?, version?}` |
| POST | `/api/tasks/:id/approve` | 人間のみ |
| POST | `/api/tasks/:id/archive` `/unarchive` `/restore` | |

`GET /api/board` と `/api/tasks` のクエリ: `q` `status` `assignee` `project` `tag` `priority`
`parent` `top_level` `overdue` `include_archived` `include_deleted`。真偽値は `1` / `true`。

作成・更新のボディで使えるフィールド:
`title` `description` `status` `waiting_reason` `assignee` `priority`(1-4) `due`(YYYY-MM-DD)
`project`(名前) または `project_id` `parent_id` `tags`(配列) `needs_review` `criteria`(作成時のみ、文字列配列)。

## 完了条件・付箋・ファイル・プロジェクト

| Method | Path | 内容 |
| --- | --- | --- |
| GET / POST | `/api/tasks/:id/criteria` | 一覧 / 追加 `{text}` |
| PATCH / DELETE | `/api/criteria/:id` | `{text?, done?}` / 削除 |
| GET / POST | `/api/tasks/:id/notes` | 一覧 / 追加 `{body, kind?}` |
| PATCH / DELETE | `/api/notes/:id` | `{body?, kind?}` / 削除 |
| GET / POST | `/api/tasks/:id/files` | 一覧 / アップロード |
| GET / DELETE | `/api/files/:id` | ダウンロード / 削除 |
| GET / POST | `/api/projects` | 一覧 / 作成 `{name, color?, description?}` |
| PATCH / DELETE | `/api/projects/:id` | 更新 / アーカイブ |

ファイルのアップロードは 2 通り:

```bash
# multipart（ブラウザ向け。複数ファイル可）
curl -F "file=@mockup.html" -H "X-Actor: agent" "$TM_URL/api/tasks/12/files"

# 生ボディ（スクリプト向け。ファイル名はヘッダで渡す。URL エンコードする）
curl --data-binary @mockup.html -H "X-Actor: agent" \
     -H "X-File-Name: mockup.html" "$TM_URL/api/tasks/12/files"
```

ダウンロードは既定で `attachment`。`?inline=1` を付けるとインライン表示になり、
HTML と SVG には `Content-Security-Policy: sandbox` が付く（添付は信用できない前提なので、
`allow-same-origin` は与えられず、API を viewer の権限で叩けない）。

## ログと取り消し

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/tasks/:id/history` | タスクの履歴 |
| GET | `/api/activity` | 全体ログ。`actor` `actor_name` `since` `task` `limit` `before` |
| POST | `/api/history/:id/revert` | `{force?}` で 1 操作を逆適用 |
| GET | `/api/export` | 全データ JSON |
| POST | `/api/purge` | ソフトデリート済みを物理削除（人間のみ） |

`since` は `1h` / `24h` / `7d` の相対指定か ISO 日付。`before` は history id によるページング。

## その他

| Method | Path | 内容 |
| --- | --- | --- |
| GET | `/api/health` | 死活確認 `{ok, time}` |
| GET | `/api/lanes` | レーン定義 |
| GET | `/api/meta` | レーン + ポリシー + `note_max` + `file_max` + 認証の有無 |
| GET | `/api/events` | SSE |

`GET /api/meta` を最初に読むと、付箋の文字数上限やエージェントに許されている操作を実行時に確認できる。
上限をハードコードするより堅い。

## SSE

```javascript
const es = new EventSource(`${TM_URL}/api/events?token=${token}`);
es.addEventListener('task.updated', (e) => {
  const ev = JSON.parse(e.data);   // {type, task_id, task, action, at}
  if (ev.action === 'task.ask') console.log('質問が来た', ev.task.title);
});
```

イベント名は `type` と同じ（`task.created` `task.updated` `task.deleted` `note.created` …）。
25 秒ごとに `: ping` のコメント行が流れる。`EventSource` は切断時に自動再接続する。

## 同時編集の扱い

更新系に `version` を含めると、サーバー側の値と違う場合に **409**（`code: "version_conflict"`）で拒否され、
レスポンスの `current` に最新のタスクが入る。読んでから書くまでの間に他人が変更していないことを保証したいときに使う。
省略すれば最後の書き込みが勝つ。

`POST /api/tasks/:id/start` は別の作業者がいると **409**（`code: "worker_conflict"`）。`{force: true}` で奪える。

## ポリシー

`config/policy.json` の `agent` セクションが、`X-Actor: agent` の操作に対する制限を決める。
違反は **403**（`code: "forbidden"`、`rule` に違反したルール名）。既定値:

```json
{
  "can_delete_task": false,
  "can_purge": false,
  "can_close_directly": true,
  "can_edit_human_notes": false,
  "can_delete_files": false,
  "can_edit_human_criteria": false,
  "can_revert_others": false
}
```

`can_close_directly` を `false` にすると、AI の `done` が完了に直行せず人間の承認待ちに入るようになる。
運用を厳しくしたいときはここを変える（サーバーの再起動が必要）。
