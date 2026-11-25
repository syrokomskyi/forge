# WP-9 Consumer Migration Runbook (2026-11-25)

Per-consumer protocol, distilled from the warpgogol-verbund canary execution. Each migration is one flow session in the consumer repo, ~15 minutes mostly automated.

## Consumers (recon 2026-11-25)

| repo | current pin | profile | corpus | notes |
| --- | --- | --- | --- | --- |
| warpgogol-verbund | ^10.1.0 ✅ | CLI-only | 1+1 templates | DONE — the canary |
| pipelines | ^9.7.1 | CLI + turbo monorepo, stack typescript | 9 RFCs | prime candidate — can adopt forge-typescript plugin |
| dater | ^9.7.1 | CLI-only | recon pending | |
| dialogue-steward | ^9.7.1 | CLI-only | recon pending | |
| lagebild | ^9.7.1 | CLI-only | recon pending | |
| metads | ^9.7.1 | CLI-only | recon pending | |
| hdri-frozen-v3 | ^9.0.0 | frozen | — | likely skip — frozen artifact repo, triage |
| werkstatt | workspace:* | WP-8 subject | — | not a WP-9 consumer |

## Per-consumer protocol

1. **Recon**: read `forge.yaml` bindings + corpus size + stack declaration; verify Node >=24 environment.
2. **flow.open** session `--slug forge-v10-migration` in the consumer.
3. In the session worktree: `pnpm add -D "@warpgogol/forge@^10.1.1"` (10.1.1 carries the FLOW inert-ignore fix — required for consumers whose node_modules carries .gitignore files, i.e. all of them).
4. **Smoke-verify every bound command** in forge.yaml against the real corpus (rfc.validate/adr.validate/spec.validate/session.save at minimum); compare blocking verdicts against a pre-migration baseline capture when the corpus is non-trivial (pipelines: yes, others: judge by size).
5. **Skills regeneration**: run `forge upgrade` — `.agents/skills` becomes generated-untracked; `git rm -r --cached .agents/skills` the tracked twin; commit the gitignore + untracking in the same commit.
6. **Commit** in the session worktree (consumer's commit style), **flow.integrate** (blocking, never detached per the session-end rule).
7. **Typescript-stack consumers** (pipelines first): optionally add `forge-typescript` plugin + `plugins:` entry — validators become available as `ts.*` commands. This is the v10 value delivery beyond parity.

## Known hazards (canary-earned)

- bin collision: never invoke shadow installs via `pnpm exec` — the alias loses `.bin` to last-install. Direct dist paths only.
- pnpm `minimumReleaseAgeExclude` may need the new version appended (pnpm handles it on `pnpm add` — verify the diff).
- `flow.open` refuses when the primary carries uncommitted changes — migrate inside the worktree from the start, never in the primary.
- npm propagation: verify install at the version-document endpoint, not dist-tag.
