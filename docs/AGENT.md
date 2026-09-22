# Task board — instructions for AI agents

Claude Code を使っているなら、このリポジトリの `.claude/skills/task-board/` がそのままスキルとして読み込まれる
（他のプロジェクトで使うならディレクトリごと `~/.claude/skills/` にコピーする）。
その場合この文書は不要。下記は、スキルの仕組みがないエージェントに同じ内容を渡すための貼り付け用。

Paste the section below into your agent's instructions (`CLAUDE.md`, `AGENTS.md`, a system prompt, …).
The `tm` CLI talks to the board server (`npm start` in this repo). Set `TM_URL` if it is not on `http://127.0.0.1:3000`, and `TM_ACTOR_NAME` to identify yourself (e.g. `claude-code`). `TM_TOKEN` is needed when the server runs with a token.

---

## Working with the shared task board (`tm`)

A human and I share a kanban board. Lanes mean **who holds the ball**:

| status | meaning |
| --- | --- |
| `waiting_agent` | the human asked me to work on it — **my inbox** |
| `in_progress` | someone (me or the human) is working on it |
| `waiting_human` | I am waiting for the human (a *question* or a *completion report*) |
| `todo` / `on_hold` / `done` | not started / paused / finished |

### Loop

1. `tm inbox` — list tasks handed to me. Pick one (highest priority / earliest due first).
2. `tm show <id>` — read the description, **acceptance criteria**, subtasks, notes and files.
   - If there are **no criteria**, propose them: `tm criteria add <id> "<criterion>"` (one per call), then `tm ask <id> "Proposed criteria above — OK to proceed?"` and stop.
3. `tm start <id>` — marks me as the worker (fails with exit 4 if another agent is on it).
4. Work. Leave short progress notes: `tm note <id> "<what I did / found>"` (≤300 chars; use `-` to read stdin).
   Attach artifacts the human should look at: `tm attach <id> path/to/mockup.html` (HTML shows in the board's HTML tab).
5. If I need a decision or information: `tm ask <id> "<clear question with options>"` and **stop working on that task**. The human answers with a note and hands it back; it reappears in `tm inbox`.
6. Tick criteria as they are met: `tm check <id> 1,3` (numbers as shown by `tm show`).
7. Finish: `tm done <id> "<result: what changed, how it was verified>"`.
   - Refused with exit 3 while any criterion is unchecked. Either meet it and `tm check`, or report partial progress with `tm done <id> "<what is left and why>" --partial` (goes to the human for review).
   - If the task requires review (`needs_review`), it goes to `waiting_human` as a completion report instead of `done`.

### AI深掘りで曖昧なタスクを実行可能な詳細案にする

Use this flow when the title / description does not yet make the problem, deliverable, or completion conditions clear. It is separate from the ordinary execution handoff.

The external runner for this flow is Codex CLI with the current setting `gpt-5.6-luna`, reasoning effort `max`. This repository does not spawn Codex CLI; the runner uses `tm` to read and update the board.

1. A human starts the session with `tm --actor human refine request <id>`.
2. Run `tm inbox`, then `tm start <id>` as usual. The task will have `mode:refine`.
3. Read the task context with `tm show <id>`. Use only the task title, description, existing criteria, notes, and explicitly attached files. Do not invent missing facts.
4. Ask only the current decision-frontier questions, grouped into one batch (up to three rounds). For decision questions, provide mutually exclusive `options` and one `recommended_option` with its `recommendation_reason`:

   ```bash
   tm refine ask <session_id> '[{"question":"何を優先しますか？","blocking":true,"options":["手戻りを減らす","速度を上げる"],"recommended_option":"手戻りを減らす","recommendation_reason":"完了条件を安定させやすいため"}]'
   ```

   The task moves to `waiting_human`. Stop work until the human answers.
5. After the human hands the task back, inspect the structured answers with `tm refine show <session_id>`. For every question, accept an explicit `answered`, `unknown`, or `delegate` result; use `selected_option` when a choice was made; do not reinterpret silence as agreement.
6. Propose a complete brief. It must include a problem or purpose, deliverables, and at least one completion criterion. Add background, constraints, out-of-scope items, assumptions, unresolved questions, or a next action only when the task provides a concrete reason for them. Keep unresolved non-blocking items explicit:

   ```bash
   tm refine propose <session_id> '{"problem":"…","deliverables":["…"],"criteria":["…"],"provenance":{"problem":"user","deliverables":"user","criteria":"user"}}'
   ```

   The task moves to `waiting_human` with a review draft. Never treat a draft as accepted work.
7. The human may edit the draft and then run `tm --actor human refine accept <brief_id>`. Only after acceptance do the criteria become formal checklist items and the task return to `todo`.
8. To execute the accepted task, the human uses the ordinary handoff. The execution runner then uses `tm start`, work outside the board, `tm check`, and `tm done`.

If the runner cannot continue, report it with `tm refine fail <session_id> "reason"`; do not silently move a refinement task to ordinary execution. A human can retry with `tm --actor human refine retry <session_id>`.

### Refinement safety rules

- `agent_mode=refine` prevents generic `tm ask`, `tm handoff`, `tm done`, and moving to `done` from bypassing the human review step.
- Existing human-written criteria remain protected. Criteria imported at acceptance are written as human-owned criteria so later agents cannot edit or delete them.
- Every structured mutation should use the task version returned by the previous command. A 409 means the task changed; re-read with `tm show` and do not overwrite blindly.
- A brief is a separate structured record; do not replace the task's freeform description with the generated text.

### Rules

- Never leave a task in `in_progress` when I stop; use `tm ask`, `tm done`, `tm hold <id> "<reason>"` or `tm handoff`.
- I cannot delete tasks, edit/delete notes or criteria written by the human, or delete files (403). I can revert **my own** mistakes: `tm history <id>` → `tm revert <history_id>`.
- Prefer `tm --json <cmd>` when I need to parse output. Exit codes: 0 ok, 1 error, 2 forbidden, 3 criteria unmet, 4 conflict.
- Keep notes concrete: file paths, commands run, numbers measured. The human reads them on a phone.

### Cheat sheet

```
tm inbox                        tm show <id>
tm start <id> [--force]         tm note <id> "<text>"
tm ask <id> "<question>"        tm check <id> 1,2 | all
tm criteria add <id> "<text>"   tm done <id> "<result>" [--partial]
tm attach <id> <file>           tm hold <id> "<why>"
tm ls --status in_progress      tm activity --by agent --since 24h
tm history <id>                 tm revert <history_id>
tm add "<title>" --project P --priority 1-4 --due YYYY-MM-DD --parent <id> --criteria "<c>"
```
