# タスクボード — 人間 × AI エージェント共同カンバン

人間はブラウザ（PC / スマホ）、AI エージェントは CLI (`tm`) で **同じカンバン**を操作するタスク管理ツールです。
依存パッケージゼロ（Node.js 22 + `node:sqlite`）、1 プロセス、ビルド不要。

- レーンは「**誰にボールがあるか**」: 未着手 / 進行中 / **あなたの判断待ち** / **エージェント待ち** / 保留 / 完了
- **完了条件**（受け入れ条件）をチェックリストで持ち、AI の `tm done` は全条件チェック済みでないと拒否
- **AI深掘り**機能。問題または目的・成果物・完了条件を中心に、必要な補足だけを質問 → 人間の回答 → 提案 → 承認の順で構造化
- 付箋（300 文字）・ファイル添付・HTML プレビュー・サブタスク（1 階層）・プロジェクト・優先度・期限
- **全操作を「誰が・いつ・何を」で記録**し、どの操作も「元に戻す」で取り消し可能（削除はソフトデリート）
- JEV による **高確信度のみの自動プロジェクト分け / タグ付け**（既定はオフ。候補は `config/classification.json` で定義）
- **エージェント権限ポリシー**: AI はタスク削除・人間の記述の改変・他人の操作の取り消しができない（設定で変更可）
- SSE でライブ更新、楽観ロックで同時編集を保護、ダーク / ライト、PWA（ホーム画面に追加）

設計の詳細は [docs/DESIGN.md](docs/DESIGN.md)、エージェントに渡す運用手順は [docs/AGENT.md](docs/AGENT.md)。

## セットアップ

```bash
git clone <this repo> && cd task-manager
npm start                 # http://127.0.0.1:3000
npm run seed              # 別ターミナルで。デモデータを投入（空のときだけ）
npm test                  # node:test
```

CLI をどこからでも使えるようにする:

```bash
npm link                  # `tm` コマンドが使えるようになる
tm --help
```

### スマホから使う（自宅 LAN）

```bash
TM_HOST=0.0.0.0 TM_TOKEN=何か長い文字列 npm start
```

スマホのブラウザで `http://<PC の IP>:3000/` を開き、初回にトークンを入力（端末に保存されます）。
共有メニューから「ホーム画面に追加」するとアプリのように開けます。

Tailscale Serve で HTTPS を公開すると、サービスワーカーが有効になり、アプリシェルをオフラインでも開けます（タスクデータとライブ更新はオンライン時に取得）。Tailscale のアドレス、常時起動用の systemd 定義、端末固有の運用手順は各端末で管理し、公開リポジトリには追加しないでください。

### 環境変数

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `TM_PORT` | `3000` | ポート |
| `TM_HOST` | `127.0.0.1` | バインド先。LAN 公開は `0.0.0.0` |
| `TM_TOKEN` | なし | 設定すると API に Bearer トークンが必要になる |
| `TM_DATA_DIR` | `リポジトリ/data` | SQLite と添付ファイルの保存先。リポジトリ内の独自パスを指定する場合は個別に除外する |
| `TM_DB` | `$TM_DATA_DIR/tasks.db` | DB ファイル |
| `TM_LANES` / `TM_POLICY` | `config/*.json` | レーン定義 / エージェント権限 |
| `TM_CLASSIFICATION_CONFIG` | `config/classification.json` | JEV のプロジェクト / タグ候補と確信度閾値 |
| `JEV_GATEWAY_URL` | `http://127.0.0.1:4789/v1/systemone` | ローカル Jev Gateway のエンドポイント |
| `JEV_GATEWAY_TOKEN` | なし | Gateway に設定した場合だけ使うローカルアクセス用トークン。TypeSafe の上流 API キーではない |
| `TM_JEV_MODEL` | `jev-latest` | JEV モデル |
| `TM_JEV_TIMEOUT_MS` | `10000` | 自動分類リクエストのタイムアウト（ミリ秒） |
| `TM_JEV_REFINE_ENABLED` | `true` | 外部ランナーでJEVの選択肢再評価・タスク整理案検証を使うか |
| `TM_JEV_REFINE_THRESHOLD` | `0.85` | AI深掘りでJEVの判定を採用する確信度の閾値 |
| `TM_JEV_INPUT_USD_PER_MILLION` など | 公開単価 | JEVの契約単価を使う場合の入力 / キャッシュ入力 / 出力単価（USD / 1M tokens） |
| `CODEX_INPUT_USD_PER_MILLION` など | モデル既定値 | CodexのAPI換算に使う入力 / キャッシュ入力 / 出力単価（USD / 1M tokens） |
| `TM_WEBHOOK_URL` | なし | 判断待ちに入った時などに JSON を POST（Slack / Discord の Incoming Webhook 互換） |

自動分類は画面上部の「JEV自動分類」から **オフ / 高確信度のみ自動反映**を選びます。同じ画面に `config/classification.json` のプロジェクト候補とタグ候補を表示し、未登録プロジェクトは登録できます。候補は新規タスクとタスク詳細の入力補完にも表示されます。高確信度モードでは新しいタスクの作成時とタイトル・説明・完了条件の更新時に JEV を呼び、既定の閾値 0.85 以上の判定だけを反映します。`調査`には文献や仕様だけでなく、外部サイト・サービス・製品・制度の確認も含め、重複する`外部調査`は別タグに分けません。手入力済みのプロジェクトやタグは変更せず、分類候補にない名前も反映しません。Jev は `JEV_GATEWAY_URL` のローカル Gateway 経由で呼び出し、Gateway が利用できない場合は安全側に倒れて何もしません。Gateway は `JEV_PASS_ENTRY`（既定値 `jev-api-key`）で上流の TypeSafe 認証情報を管理します。

プロジェクト候補は設定ファイルに書かれていても、既存のプロジェクトに同名のものがなければ自動作成しません（`create_missing_projects` は `false`）。「JEV自動分類」画面から候補をプロジェクトとして登録できます。未登録のまま再分類した候補はタスク内の「JEVの分類候補」に保存され、タスク詳細の「候補を反映」からプロジェクト作成とタスクへの設定をまとめて実行できます。タグは設定ファイルの候補からのみ追加されます。同画面の「既存タスクを再分類」またはタスク詳細の「JEVで再分類」から、既存タスクにも適用できます。

CLI 側: `TM_URL`（既定 `http://127.0.0.1:3000`）, `TM_ACTOR`（`agent` / `human`）, `TM_ACTOR_NAME`, `TM_TOKEN`, `TM_FORMAT=json`。

AI深掘りの外部ランナーは Codex CLI と `tm` CLI を組み合わせます。現在の運用設定は Codex CLI の `gpt-5.6-luna`、推論 effort `max` です。task-manager サーバー自身は Codex CLI を起動せず、外部ランナーが `tm` 経由で受信・質問・提案を行います。

このPCでは外部ランナーもユーザーsystemdサービス `task-manager-codex-runner` として常駐します。「AI深掘り」でサーバーにキュー登録されたタスクは、`/api/events` のSSE通知を受けて数秒以内に処理を開始します。SSEが切断された場合は自動再接続し、起動時と既定3分ごとの再確認（`CODEX_RUNNER_RECONCILE_MS`）で取りこぼしを回収します。runnerは `agent_mode=refine`（AI深掘り）のタスクだけを取得し、Codex CLIに読み取り専用で案を作らせます。選択肢がある質問はJEVが候補を再評価し、タスク整理案はJEVが目的・成果物・完了条件・安全性を確認します。確認できないタスク整理案は人間への追加質問に戻します。最後に質問・タスク整理案・失敗だけを `tm` へ反映します。通常の実装タスクは自動実行しません。Gateway が未設定または一時的に利用できない場合は、既存のCodex処理を継続します。

AI利用コストはタスク詳細の「AI利用コスト」に表示され、JEVとCodexの利用回数・トークン数・ドル換算を明細として保存します。JEVはAPIレスポンスの使用量と公開単価、CodexはJSONLの完了イベントから取得した使用量とAPI単価で計算します。CodexはChatGPT/Codexの実請求ではなくAPI換算の推定額です。JEVの深掘り判定を使った場合は、採否・各判定確率・routeの確信度・判定理由・応答JSONの欠落項目も同じ明細に保存し、タスク詳細に表示します。CLIでは `tm usage show`、`tm usage task <task_id>` で確認できます。

```bash
systemctl --user status task-manager-codex-runner
systemctl --user restart task-manager-codex-runner
journalctl --user -u task-manager-codex-runner -n 50 --no-pager
```

## ローカルデータとGit管理

タスク本文、添付ファイル、SQLite のサイドカーファイル、ログ、エクスポート、バックアップ、`.env`、秘密鍵、Tailscale の端末固有設定は Git に追加しないでください。これらの代表的なファイルやディレクトリは `.gitignore` で除外しています。

`TM_DATA_DIR` や `TM_DB` をリポジトリ内の別の場所に変更した場合は、その保存先も `.gitignore` に追加してください。`.gitignore` はすでに追跡されているファイルや過去のコミットを削除しないため、コミット前に `git status` と `git diff --cached` で確認します。

`npm start` はリポジトリ直下の `.env.local` を Node.js の組み込み dotenv ローダーで読み込みます。シェルで明示した環境変数が優先されます。`.env.local` は `.gitignore` 対象なので、API キーはそこに保存して問題ありません。共有・コミットする場合は [.env.example](.env.example) の空欄だけを使ってください。

## 使い方（人間）

1. 「タスクを追加」でタイトル・完了条件を書き、「作成後すぐ AI に依頼する」にチェック → **エージェント待ち**へ。
2. AI が作業し、迷うと **あなたの判断待ち**に「質問」バッジ付きで戻ってきます。カードに質問文がプレビューされます。
3. 付箋に回答を書いて **「回答して依頼」**。AI が続きをやります。
4. AI は完了条件をすべて満たすと完了にします（「承認を必要とする」を付けたタスクは「完了報告」として判断待ちに入り、「承認して完了」/「差し戻す」で判断）。
5. おかしな操作は、詳細の **履歴** タブか上部の **アクティビティ**（「AI の操作のみ」で絞れる）から「元に戻す」。

### AI深掘り

タイトルだけで目的・成果物・完了条件が曖昧なときは、通常の「エージェントに依頼」の前に **「AI深掘り」**を使います。

1. タスク詳細で「AI深掘り」を押す。タスクは「エージェント待ち」に移り、外部ランナー待ち・AI深掘り中・回答待ち・タスク整理案の確認待ちを進捗として表示する。
2. AI が現在の判断の分岐点だけを最大 3 ラウンドまでまとめて出す。判断が必要な質問にはクリック式の選択肢と AI のおすすめ・理由が表示され、最後に「その他（自由回答）」も選べる。回答・不明・AI への委任も選択できる。
3. AI がタスク詳細案を作る。人間は必須の問題または目的、成果物、完了条件を確認し、必要な場合だけ背景、制約、対象外、前提、未解決事項、次の一手を編集できる。
4. **「タスク整理案を承認して準備完了」**を押すと、タスク整理案の完了条件が正式なチェック項目として人間名義で追加され、タスクは未着手に戻る。
5. その後に「エージェントに依頼」を押すと、通常の実装フローが始まる。AI深掘りをキャンセルした場合は、タスクを未着手に戻して通常のタスクとして扱える。

AI の推定・仮定・未解決事項には出所ラベルが付きます。問題または目的、成果物、完了条件が揃わない案や、blocking の未解決事項が残る案は承認できません。既存のタスク説明本文はこの機能から変更しません。

キーボード: `/` 検索、`n` 新規、`Esc` 閉じる。PC ではカードをドラッグ＆ドロップで移動できます。スマホでは詳細の「状態」で移動します。

## 使い方（AI エージェント）

Claude Code なら **`.claude/skills/task-board/`** がスキルとして読み込まれ、`tm` の使い方・作法・エラー対処を
エージェントが自分で参照します（他プロジェクトで使うにはディレクトリごと `~/.claude/skills/` にコピー）。
スキルの仕組みがないエージェントには [docs/AGENT.md](docs/AGENT.md) を CLAUDE.md / AGENTS.md に貼ってください。要点:

```bash
tm inbox                                  # 依頼されたタスク
tm show 12                                # 詳細（完了条件・付箋・ファイル・履歴）
tm start 12                               # 作業開始（作業者を記録）
tm refine request 12                      # 人間: AI深掘りを依頼
tm refine ask 3 '[{"question":"何を優先しますか？","blocking":true,"options":["手戻りを減らす","速度を上げる"],"recommended_option":"手戻りを減らす","recommendation_reason":"完了条件を安定させやすいため"}]' # AI: 選択肢つき質問
tm refine answer 3 '[{"id":1,"kind":"answered","selected_option":"手戻りを減らす","answer":"補足"}]' # 人間: 回答
tm refine propose 3 '{"problem":"…","deliverables":["…"],"criteria":["…"]}' # AI: 提案
tm refine accept 1                         # 人間: タスク整理を承認
tm usage show                              # JEV / Codex の利用コスト集計
tm usage task 12                            # タスク単位のAI利用明細
tm note 12 "進捗メモ"                      # 付箋
tm ask 12 "A と B どちらにしますか？"        # → あなたの判断待ち（質問）
tm check 12 1,2                           # 完了条件にチェック
tm done 12 "何をどう検証したか"             # → 完了（条件未達なら拒否, exit 3）
tm attach 12 mockup.html                  # HTML タブでプレビュー可能
tm activity --by agent --since 24h        # 自分の操作ログ
tm revert <history_id>                    # 自分の操作を取り消す
```

出力は `--json` で機械可読。終了コード: 0 成功 / 1 エラー / 2 権限拒否 / 3 完了条件未達 / 4 競合。

## API

`GET /api/board`, `GET|POST /api/tasks`, `GET|PATCH|DELETE /api/tasks/:id`, `POST /api/tasks/:id/{move,start,ask,handoff,hold,done,approve,archive,unarchive,restore}`,
`POST /api/tasks/:id/refinements`, `GET /api/tasks/:id/refinements`, `GET /api/refinements/:id`, `POST /api/refinements/:id/{questions,answers,brief,cancel,retry,fail}`, `PATCH /api/refinement-briefs/:id`, `POST /api/refinement-briefs/:id/accept`,
`POST /api/tasks/:id/classification/apply`,
`/api/tasks/:id/{criteria,notes,files,history}`, `POST /api/tasks/:id/classify`, `PATCH|DELETE /api/{criteria,notes,files}/:id`, `GET|POST /api/projects`, `GET|PATCH /api/settings`, `POST /api/classification/reclassify`,
`GET /api/usage`, `GET /api/tasks/:id/usage`（利用コスト明細）, `POST /api/tasks/:id/usage`（agent 内部記録）`,
`GET /api/activity`, `POST /api/history/:id/revert`, `GET /api/export`, `GET /api/events` (SSE)。

操作者は `X-Actor: human|agent` と `X-Actor-Name` ヘッダで識別します。更新系は `version` を渡すと不一致で 409。全一覧は [docs/DESIGN.md](docs/DESIGN.md) を参照。

## 構成

```
.claude/skills/task-board/   エージェント向けスキル（使い方・CLI / API リファレンス）
bin/tm.js          CLI
src/server.js      HTTP / SSE / 静的配信 / アップロード
src/store.js       SQLite・バリデーション・履歴・ロールバック
src/refinement.js  AI深掘りの正規化・完了判定・出所ルール
src/refinement-judge.js  JEVによる選択肢再評価・タスク整理案検証
src/policy.js      エージェント権限
config/lanes.json  レーン定義（色・名前・既定で畳むか）
config/policy.json エージェント権限の既定値
config/classification.json JEV の分類候補・閾値
public/            GUI（ビルドなし）
scripts/seed.js    デモデータ
test/              node:test
```

## バックアップ

`data/` ディレクトリをコピーするか、`tm export > backup.json`。`backup.json`、`backups/`、`exports/` は `.gitignore` 対象ですが、バックアップ自体はリポジトリ外にも保管してください。
