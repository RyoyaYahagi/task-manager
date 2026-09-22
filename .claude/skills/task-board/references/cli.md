# `tm` コマンド詳細リファレンス

`SKILL.md` で足りないとき（オプションの正確な指定、JSON の形、エラーの原因切り分け）に読む。

## 目次

- [共通オプションと環境変数](#共通オプションと環境変数)
- [読む](#読む)
- [作る・直す](#作るなおす)
- [進める](#進める)
- [付箋とファイル](#付箋とファイル)
- [ログと取り消し](#ログと取り消し)
- [イベント購読](#イベント購読)
- [JSON の形](#json-の形)
- [エラーと対処](#エラーと対処)

## 共通オプションと環境変数

すべてのコマンドで使える:

| オプション | 環境変数 | 既定 | 意味 |
| --- | --- | --- | --- |
| `--json` | `TM_FORMAT=json` | オフ | 完全な JSON を標準出力に。エラーも JSON で標準エラーに出る |
| `--url URL` | `TM_URL` | `http://127.0.0.1:3000` | サーバー |
| `--actor KIND` | `TM_ACTOR` | `agent` | `human` / `agent` |
| `--name NAME` | `TM_ACTOR_NAME` | actor と同じ | 履歴・付箋に残る名前 |
| `--token T` | `TM_TOKEN` | なし | Bearer トークン |

`--name` は「誰がやったか」の記録になる。複数エージェントが同じボードを触るなら必ず個別の名前にする。

## 読む

```
tm inbox
```
`status=waiting_agent` のタスク。自分の受信箱。

```
tm ls [--status S] [--project P] [--assignee human|agent|both] [--tag T]
      [--priority 1-4] [--overdue] [--parent ID] [--archived] [-q TEXT]
```
`-q` はタイトル・説明・タグ・プロジェクト名・付箋本文を横断検索する。
`--overdue` は期限切れかつ未完了のみ。`--archived` はアーカイブ済みも含める。

```
tm show <id>
```
1 画面に詰め込んだ詳細。完了条件は **1 始まりの番号付き**で出るので、`tm check` にはこの番号を使う。
付箋は古い順、履歴は新しい順に最新 10 件。

```
tm lanes        # レーン id と表示名。疎通確認にも使える
tm projects     # プロジェクト一覧（id・色・名前）
```

## 作る・直す

```
tm add <title> [--desc D|-] [--status S] [--assignee human|agent|both] [--project P]
               [--parent ID] [--priority 1-4] [--due YYYY-MM-DD] [--tags a,b]
               [--criteria "text"]... [--needs-review]
```

- `--desc -` で標準入力から本文を読む。長い説明はこれが楽: `echo "$BODY" | tm add "題" --desc -`
- `--project` は名前で指定する。存在しなければ自動で作られる。
- `--criteria` は複数回指定できる。作成時に完了条件を入れておくのが最も事故が少ない。
- `--parent ID` でサブタスクになる。**サブタスクは 1 階層のみ**（孫は作れない）。
- `--needs-review` を付けると、AI の `tm done` が完了に直行せず人間の承認待ちになる。
- 既定の状態は `todo`、担当は `both`、優先度は 2（中）。

```
tm edit <id> [--title T] [--desc D|-] [--assignee A] [--project P|none] [--parent ID|none]
             [--priority N] [--due DATE|none] [--tags a,b] [--needs-review|--no-needs-review]
```
`none` を渡すとその項目を空にする（`--due none` で期限解除）。
`tm edit` は内部で現在の `version` を読んでから送るので、他人と同時に編集すると exit 4 になることがある。その場合は `tm show` で最新を読み直してからやり直す。

```
tm project add <name> [--color #rrggbb]
```

## 進める

```
tm start <id> [--force]
```
`in_progress` にして自分を `worker` に記録する。
他のエージェントが作業中なら exit 4。`--force` で奪えるが、奪う前に理由を付箋に書くこと。

```
tm ask <id> <question>
```
`waiting_human`（理由: 質問）に移し、質問を付箋として残す。**質問したらそのタスクの作業は止める。**
良い質問は選択肢と、それぞれを選んだ場合の結果まで書いてある。

```
tm criteria add <id> <text>      # 完了条件を提案（最大 300 文字）
tm check <id> <n[,n..]|all>      # 番号でチェック。all で全部
tm uncheck <id> <n[,n..]|all>
```

```
tm done <id> <result note> [--partial]
```
全条件チェック済みなら `done`。未達があると **exit 3** で拒否され、未達の条件が標準エラーに列挙される。
`--partial` を付けると未達でも「完了報告」として `waiting_human` に入る。
タスクに `needs_review` が立っている場合も `waiting_human`（人間が承認して初めて完了）。
結果メモは必須。空だと exit 1。

```
tm handoff <id> [note]     # waiting_agent へ（人間に作業を戻す/別エージェントに渡す）
tm hold <id> [note]        # on_hold へ。止める理由を書く
tm mv <id> <status> [--index N]   # 任意のレーンへ。--index はレーン内の位置
tm approve <id>            # 人間のみ。完了報告を承認して done にする
tm archive <id> / tm unarchive <id>
tm rm <id>                 # ソフトデリート。既定では人間のみ（agent は exit 2）
```

## AI にタスク詳細を詰める

通常の実装依頼の前に、問題・目的・成果物・制約・完了条件を構造化するためのフロー。人間が開始し、AI が質問と案を出し、人間が編集・承認する。

```bash
tm --actor human refine request <task_id>
tm refine show <session_id>
tm refine ask <session_id> '[{"question":"目的は？","blocking":true}]'
tm --actor human refine answer <session_id> '[{"id":1,"kind":"answered","answer":"手戻りを減らす"}]'
tm refine propose <session_id> '{"problem":"要件が曖昧","deliverables":["実装"],"criteria":["テストが通る"],"next_action":"仕様を確認する"}'
tm --actor human refine edit <brief_id> '{"purpose":"実行可能にする"}'
tm --actor human refine accept <brief_id>
tm refine fail <session_id> "runner timeout"
tm --actor human refine retry <session_id>
```

`refine ask` / `answer` / `propose` の JSON は配列またはオブジェクトを標準入力 (`-`) からも渡せる。質問は最大 3 ラウンド。回答の `kind` は `answered`（通常回答）、`unknown`（不明）、`delegate`（AI に委任）。

ブリーフの必須判定は「問題または目的」「成果物」「完了条件 1 件以上」「次の一手」。blocking な `open_questions` が残る案は 422 で拒否される。`provenance` は AI の提案元を `inference` / `assumption` / `unresolved` として保持し、人間の編集は `human_edited` になる。

精緻化中 (`mode:refine`) は、通常の `tm ask` / `tm handoff` / `tm done` でレビューを迂回できない。承認後にタスクが `todo` に戻るので、通常の `tm handoff` で実装依頼を開始する。

`note` を取るコマンドは `-` で標準入力から読める。

## 付箋とファイル

```
tm note <id> <text|->      # 300 文字まで。超えると exit 1
tm notes <id>
```

```
tm attach <id> <path> [--as NAME]
tm files <id>
```
20MB まで。拡張子から MIME を推定する。`.html` はボードの HTML タブで sandbox プレビューされるので、
モックアップやレポートを人間に見せたいときに有効。`--as` で表示名を変えられる。

## ログと取り消し

```
tm history <id>
tm activity [--by agent|human] [--who NAME] [--since 1h|24h|7d|YYYY-MM-DD] [--task ID] [--limit N]
```
`--by` は actor の種別、`--who` は名前でのフィルタ。`--since` は相対指定（`1h` / `24h` / `7d`）か日付。
自分の直近の操作を確認するなら `tm activity --by agent --who "$TM_ACTOR_NAME" --since 1h`。

```
tm revert <history_id> [--force]
```
履歴 1 件を逆適用する。`tm history` / `tm activity` の行頭 `h12` の数字部分が history_id。

- エージェントは**自分の操作のみ**取り消せる（他人のものは exit 2）。
- 取り消し後に対象が変更されていると exit 4。意図が明確なら `--force`。
- 取り消し済みの履歴を再度取り消そうとすると exit 4。
- 取り消し自体も履歴に残るので、取り消しの取り消しもできる。

```
tm export > backup.json     # 全データを JSON でダンプ
```

## イベント購読

```
tm watch
```
サーバーの Server-Sent Events を JSON Lines で流す。1 行 1 イベント。
人間の操作を待ち受けて自動で動くループを書くときに使う。接続直後に `{"type":"hello",...}` が来る。

主な `type`: `task.created` / `task.updated` / `task.deleted` / `refinement.updated` / `note.created` / `note.updated` /
`criteria.created` / `criteria.updated` / `file.created` / `project.created` など。
`task.updated` には `action`（`task.ask`・`task.done` など）と `task` 全体が入る。

受信箱に入ったものを拾う例:

```bash
tm watch | while read -r line; do
  echo "$line" | jq -e 'select(.task.status == "waiting_agent")' > /dev/null && echo "新しい依頼"
done
```

## JSON の形

`tm --json inbox` / `ls` はタスクの配列。1 タスクの主なフィールド:

```
id title description status waiting_reason assignee priority due
project_id parent_id tags agent_mode worker needs_review position version
created_by created_at updated_at archived_at deleted_at
note_count file_count sub_total sub_done crit_total crit_done
last_note   # {body, author, author_name, kind, created_at} または null
project     # {id, name, color} または null
```

`tm --json show <id>` は上記に加えて `criteria` / `notes` / `files` / `subtasks` / `parent` / `history` / `refinement` / `brief` を含む。

`refinement` は現在のセッション（`id`, `attempt`, `status`, `questions[]`, `brief`）または失敗・キャンセルされた直近セッション、`brief` は承認済みブリーフ。ブリーフの `content` は `problem`, `purpose`, `background`, `deliverables`, `constraints`, `out_of_scope`, `assumptions`, `open_questions`, `next_action`, `criteria` を持つ。

- `criteria[]`: `{id, task_id, text, position, author, author_name, done, checked_by, checked_by_name, checked_at}`
- `notes[]`: `{id, task_id, author, author_name, body, kind, created_at, updated_at}` — `kind` は `note` / `question` / `report`
- `history[]`: `{id, task_id, actor, actor_name, action, entity, entity_id, detail, reverted_by, reverts, created_at}`
  - `detail.changes` は `{フィールド: [変更前, 変更後]}`

`--json` 時のエラーは標準エラーに `{"error": "...", "code": "...", ...}` で出る。
`code` の例: `criteria_unmet`（`unchecked[]` 付き）・`worker_conflict`（`current` 付き）・`version_conflict`・`forbidden`・`revert_conflict`。

## エラーと対処

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| `cannot reach http://...` (exit 1) | サーバー未起動、`TM_URL` 違い | ボードのリポジトリで `npm start`。`TM_URL` を確認 |
| `unauthorized` (exit 1) | サーバーが `TM_TOKEN` 付きで起動 | `TM_TOKEN` を設定する |
| `agents cannot ...` (exit 2) | ポリシーによる禁止 | 回避せず、必要なら人間に `tm ask` で依頼する |
| `has N unmet criteria` (exit 3) | 完了条件が未達 | 満たして `tm check`、または `--partial` で正直に報告 |
| `already being worked on by "X"` (exit 4) | 他のエージェントが作業中 | 別タスクを拾う。引き取るなら理由を書いて `--force` |
| `was modified by someone else` (exit 4) | 楽観ロック衝突 | `tm show` で最新を読み直してやり直す |
| `note too long (max 300...)` (exit 1) | 付箋が長すぎる | 要点に絞る。長文は `tm attach` でファイルにする |
| `criterion number N out of range` (exit 1) | チェック番号が違う | `tm show` で現在の番号を確認（条件の追加・削除で番号は変わる） |
