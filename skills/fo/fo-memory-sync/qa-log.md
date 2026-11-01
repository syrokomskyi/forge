<!-- L0: Append-only Q&A log. Each entry records a question asked and the operator's answer.
     Format: [YYYY-MM-DD] project:<path-or-remote> Q: <question> A: <answer> -->

# Q&A Log

<!-- Entries are appended by the skill during runs. Do not hand-edit. -->

[2026-10-15] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import session records for the two Claude Code onboarding-rethink sessions (4fb22aac, 2c9fbefe) into docs/sessions/? All artifacts already committed. A: one combined record → docs/sessions/2026-10-14-23-41-00-4fb22a.md

[2026-10-15] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Also scan the Claude session from the sibling pipelines repo (possible W1a response context)? A: skip — scope stays on this repository

[2026-10-18] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import which items from Claude Code? A: all sessions + memory — four docs/sessions records (0fc16e30, 8c92b044, fa620bee, 871402ac+e6120a13) and forge-document-first note → .agents/operator-profile.md

[2026-10-18] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: How to handle live session e6120a13 (idle, still running)? A: combine with completed 871402ac into one record marked "in progress" — second time operator chooses combined records for a compaction chain

[2026-10-18] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import the task-handoff chain 5e2a513c → 446544ee (debate/papers analysis → RFC-1330..1334 drafts) as one or two records? A: one combined record → docs/sessions/2026-10-18-12-20-00-5e2a51.md — third time operator chooses combined records for a session chain

[2026-10-18] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Update the stale "still live" marker in 2026-10-16-15-26-00-871402 (e6120a13 since completed, no new content)? A: yes — flipped to "completed"; coverage already reached the file end

[2026-10-19] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Where to import memory note "never-export-git-dir-for-tests" (repo-hygiene rule + 2026-10-18 incident)? A: root AGENTS.md "Agent foot-gun hardening" section — first memory note routed to AGENTS.md instead of operator-profile

[2026-10-19] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: How to cover the new arc of still-live session 5e2a513c (pipeline + major publish + GIT_DIR incident)? A: extend the existing record 2026-10-18-12-20-00-5e2a51.md in place with an "in progress" section — do not create a second file for the same session id

[2026-10-23] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import which items from Claude Code (5 new sessions + 5e2a513c tail)? A: all — new record for ebf9bab8 (2026-10-19-15-11-00-ebf9ba.md); 5e2a51 extended to "completed"; de15db2f+503603ee+8b6dafa1 and 0ad25410 turned out to have SELF-SAVED transcripts (session.save at session end) — annotated existing records 2026-10-18-09-00-00-245a5c.md and 2026-10-21-09-40-00-80a372.md with source/summary instead of creating duplicates

[2026-10-27] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import which items from Claude Code (4 new sessions + 1 new memory note)? A: all three session actions — annotate 06edbb (9f417d7d), extend 0ac736 (19b39511) with the compaction-lost first arc recovered from in-session summaries, new combined record 2026-10-26-11-15-00-a67dda.md (a67ddad8 + spawned 67d135e5). Memory note formal-invariant-verification-batch SKIPPED as stale (claimed "implementation pending" but RFC-1390..1394 all implemented+archived) — verify claimed state against repo before import

[2026-10-27] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Save stale memory note to .agents/memory/daily anyway? A: no — skip entirely; stale pending-state notes mislead

[2026-10-30] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import which items from Claude Code (1 new session 9c753bf4, a67ddad8 retro tail, duplicate self-save 27f385)? A: new record for 9c753bf4 only; a67ddad8 tail update declined (retro artifacts already durable in AGENTS.md/frictions.yaml); self-save 27f385 deleted — reverse K-0006: self-save created after the sync record exists, sync record stays canonical

[2026-10-30] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Re-add forge-document-first note to operator-profile (lost in the 10-30 rewrite)? A: no — knowledge already covered by PREFERENCES.md §Skill invocation tracking + AGENTS.md

[2026-10-30] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Append the 2026-10-29 retro tail to record a67dda (stale "ретро-протокол не выполнялся" line) after initially declining? A: yes — appended tail (F-0020..23, .env rule, 33ce96cbe, K-0009 dedupe note); stale record-state lines get fixed when surfaced

[2026-10-30] project:/home/syrokomskyi/projects/warpgogol/werkstatt Q: Import which items from Claude Code (ddbbfb0c self-save, 9f80dc66, 9c753bf4 tail + cc3673 self-save)? A: all three — annotated 940b47 (source/summary/types/retro tail); 9f80dc66 turned out to have self-saved as d3940c — annotated in place instead of a new record (K-0006 again); cc3673 merged into canonical 9c753b (new arc: switcher fix 00a314a4e/8e324799f, RFC-1453..1455, retro F-0042..44) then deleted with its metrics — K-0009 second confirmation, this time WITH the tail merge (operator declined it earlier only because that tail was already durable elsewhere)
