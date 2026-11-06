---
name: fo-doctor
description: Audit the agent session environment — window discipline, watcher excludes, rule-file budget, session DB health, stall metrics. Read-only except an opt-in write offer for missing config.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["check my session environment", "agent turns keep stalling", "session doctor", "environment audit"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-doctor skill — RFC-1522: reusable session-environment audit. Turns the agent-turn-stall investigation (F-0002) into durable checks a session can run at start or on demand. Read-only except the explicit opt-in "write missing config" offer — a doctor must be safe to run anywhere, including a superfolder with no git gates.</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
  <item>Do not fix findings autonomously — report + offer; the operator decides.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1522: initial skill — five checks (windows, watchers, rule budget, DB health, stall metrics) + sessions.db prune runbook.</item>
  <item>RFC-1522: add fo-doctor session-environment audit skill

Five checks (window discipline, watcher/index excludes, rules.budget.check, sessions.db health vs 2 GB, stall metrics via continue-nudge/lazy-load queries) plus the sessions.db prune runbook. Read-only except the opt-in write-missing-config offer. agents-generate golden fixture regenerated for the new skill row.</item>
</CHANGE_SUMMARY>
-->

# fo-doctor

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Audit the environment the session is running in. The failure modes this catches are all observable but were previously checked by hand: agent turns that end silently after file edits, oversized rule files that fail IDE injection, doubled file-event processing, a bloated local session database. Every check is read-only; the single exception is the explicit write offer in check 2 — ask before writing anything.

## Process

Run all five checks, then report one table: `check | status (ok|warn|fail|n/a) | finding | remedy`. `n/a` means the substrate is absent (e.g. no Devin session DB on a non-Devin host) — report it, never fake a pass.

### 1. Window discipline

Determine whether the IDE workspace root is a **superfolder** (contains independent repos plus `*@*` session worktrees) or a single repo, and whether both a superfolder AND a `<repo>@<branch>` worktree are open at once.

- List directories matching `*@*` next to the workspace root: `ls -d <parent>/*@* 2>/dev/null`.
- If the current workspace root itself is a superfolder containing `*@*` dirs → **warn**: "superfolder window is processing every worktree file event; prefer working from the session-worktree window only, or close the superfolder window while a worktree session runs."
- One window total is the rule (superfolder AGENTS.md): the session worktree OR the superfolder, never both.

### 2. Watcher / index excludes

Only meaningful at a superfolder root. Verify:

- `.windsurfignore` exists and excludes `*@*/`, `systems-cache/`, `systems-git/`, `systems-retired/`, frozen/transient snapshot dirs, `.cache/`.
- `.vscode/settings.json` `files.watcherExclude` + `search.exclude` cover the same set plus `**/node_modules/**`, and `git.autoRepositoryDetection` is `openEditors` (limits SCM scanning in multi-repo roots).

Missing or incomplete → **warn** and OFFER to write the missing blocks (show the exact diff first, wait for approval — this is the skill's only write path).

### 3. Rule-file budget

Run the budget gate and list offenders:

```sh
pnpm exec forge rules.budget.check --json
# or, where forge is not on PATH for this repo:
pnpm exec werkstatt run rules.budget.check --json
```

- exit 0 → ok, report the count of scanned files.
- exit 1 → **fail**: list each `RULES-BUDGET-01` file with its byte size; remedy is extraction into `docs/agent-guides/<topic>.md` under a slimmed skeleton, never budget inflation.

### 4. Session DB health

Report the local Devin session store size vs threshold (warn > 2 GB):

```sh
du -sh ~/.local/share/devin/cli/sessions.db*
```

- Missing → `n/a` (non-Devin host).
- Over threshold → **warn** + point at the prune runbook below. Pruning requires Devin Desktop fully quit — never attempt it inside a live session.

### 5. Stall metrics (regression baseline)

When `sessions.db` exists, count the two stall signatures over recent sessions:

```sh
cd ~/.local/share/devin/cli

# `continue` nudges per session (top offenders)
sqlite3 -readonly sessions.db "
SELECT session_id, COUNT(*) FROM message_nodes
WHERE json_extract(chat_message,'\$.role')='user'
  AND json_extract(chat_message,'\$.content')='continue'
GROUP BY session_id ORDER BY 2 DESC LIMIT 10;"

# lazy-load-failure rows per session
sqlite3 -readonly sessions.db "
SELECT session_id, COUNT(*) FROM message_nodes
WHERE chat_message LIKE '%could not be injected due to token limits%'
GROUP BY session_id ORDER BY 2 DESC LIMIT 10;"
```

- `sqlite3` absent → `n/a`.
- Any recent session with `continue` count > 5 or lazy-load rows > 0 → **warn** with the counts; this is the metric the rule-budget work should drive to ~0 over time.

## Report

Close with the five-row table plus a one-line verdict. Only `fail`/`warn` rows need a remedy column; remedies are actions for the OPERATOR or a follow-up session — the doctor does not restructure files, quit the IDE, or prune the DB itself.

## Reference: sessions.db prune runbook (operator-run, Devin quit first)

Session history is local-only; pruning loses old chat history in the Devin panel. Default scope: keep last ~14 days — confirm with the operator.

```sh
# 1. quit Devin Desktop (all windows), verify no processes remain
pgrep -f "devin-desktop|devin acp" || echo "clean"

# 2. checkpoint the WAL back into the main file
sqlite3 ~/.local/share/devin/cli/sessions.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 3. drop sessions older than 14 days across all tables
sqlite3 ~/.local/share/devin/cli/sessions.db "
DELETE FROM message_nodes    WHERE session_id IN (SELECT id FROM sessions WHERE last_activity_at < (strftime('%s','now','-14 days')*1000));
DELETE FROM tool_call_state  WHERE session_id IN (SELECT id FROM sessions WHERE last_activity_at < (strftime('%s','now','-14 days')*1000));
DELETE FROM rendered_commits WHERE session_id IN (SELECT id FROM sessions WHERE last_activity_at < (strftime('%s','now','-14 days')*1000));
DELETE FROM sessions         WHERE last_activity_at < (strftime('%s','now','-14 days')*1000);
VACUUM;"

# 4. stale session locks are safe to drop too
rm -f ~/.local/share/devin/cli/session_locks/*.lock
```

If `message_search` (FTS shadow) rejects `session_id`, inspect `PRAGMA table_info(message_search)` first — delete by rowid or skip and `INSERT INTO message_search(message_search) VALUES('rebuild')`. Nuclear alternative: quit Devin, `mv sessions.db sessions.db.bak-<date>` + remove `-wal`/`-shm` — the DB recreates empty.

## Constraints

- **Read-only by default.** The only permitted write is the check-2 excludes/config offer, and only after showing the operator the exact content.
- **Never prune `sessions.db` inside a live session** — live `devin acp` processes hold the DB; the runbook is for the operator between sessions.
- **Report `n/a` honestly** when a substrate is absent (non-Devin host, no sqlite3, no superfolder) — a skipped check is not a pass.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
