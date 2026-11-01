<!-- L2: Concrete principles distilled from past runs, with confirmations counter.
     At confirmations >= 3, the skill auto-applies the principle without asking.
     Rejecting a recommended answer resets confirmations to 0. -->

# Learned Principles

<!-- Format: - principle: <text> | confirmations: N | project: <path-or-remote-or-all> -->

- principle: Sessions forming a compaction/resume/task-handoff chain are imported as one combined docs/sessions record, not one file per session id | confirmations: 5 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: A session that self-saved its transcript (session.save at session end) gets the existing record annotated with source tool/session ids + summary — never a duplicate import record | confirmations: 3 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: Operator imports the full relevant set (all sessions + memory notes) rather than cherry-picking — present everything, let them deselect | confirmations: 5 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: A self-saved record created after the sync record exists for the same session is a duplicate — merge its unique tail into the canonical sync record and delete the self-save (incl. its .metrics.yaml); skip the merge only when the tail is already durable elsewhere | confirmations: 2 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: When an imported record's "in progress" tail session has finished and the record already covers the file end, update the stale marker rather than re-importing | confirmations: 3 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: A memory note of type feedback encoding a repo-hygiene/incident rule routes to AGENTS.md (K-0003); operator-workflow preferences route to .agents/operator-profile.md | confirmations: 1 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: New content in an already-imported live session extends that record in place with an in-progress marker — never a second file for the same session id | confirmations: 2 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: A self-saved record missing its pre-compaction arc gets the missing portion recovered from in-JSONL compaction summaries and inserted before its first transcript entry — never a second record | confirmations: 1 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
- principle: A memory note describing pending work whose artifacts already reached terminal state in the repo is stale — skip it entirely, including the daily-memory fallback | confirmations: 2 | project: /home/syrokomskyi/projects/warpgogol/werkstatt
