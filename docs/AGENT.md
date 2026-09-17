# Task board — instructions for AI agents

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
