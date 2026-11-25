# WP-9 Consumer Migration Runbook (2026-11-25)

Per-consumer protocol, distilled from the warpgogol-verbund canary execution. Each migration is one flow session in the consumer repo, ~15 minutes mostly automated.

## Consumers (recon 2026-11-25)

| repo | current pin | profile | corpus | notes |
| --- | --- | --- | --- | --- |
| warpgogol-verbund | ^10.1.0 ✅ | CLI-only | 1+1 templates | DONE — the canary |
| pipelines | ^9.7.1 | CLI + turbo monorepo, stack typescript | 9 RFCs | prime candidate — can adopt forge-typescript plugin |
| dater | ^9.7.1 | CLI-only | 1 RFC + 2 ADRs | tracked skills twin present; corpus trivial — no baseline needed |
| dialogue-steward | ^9.7.1 | CLI-only | 4 RFCs + 1 ADR | tracked skills twin present; corpus trivial |
| lagebild | ^9.7.1 | CLI-only | 1 RFC + 2 ADRs | tracked skills twin present; corpus trivial |
| metads | ^9.7.1 | CLI-only | 1 RFC + 1 ADR | tracked skills twin present; corpus trivial |
| hdri-frozen-v3 | ^9.0.0 | frozen | — | ABSENT locally 2026-11-25 — skip, frozen artifact repo |

### pipelines baseline (captured pre-migration 2026-11-25, v9.7.1, durable in /tmp)

- rfc.validate: **fail / 175 violations** — sha256 529edf144b73d91a (`/tmp/pipelines-baseline-v9-rfc-ALL.json`)
- adr.validate: **fail / 54 violations** (`/tmp/pipelines-baseline-v9-adr.json`)
- spec.validate: **fail / 3 specs** (`/tmp/pipelines-baseline-v9-spec.json`)
- invocation form: whole-corpus in one run — `forge rfc.validate --json` (no id); per-id uses `--id RFC-NNNN`, positional ids are refused (KERNEL-ARG-01)
- dark-run parity criterion: v10 verdict+count+violation signatures must exactly match these baselines
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

## Execution wave 1 (2026-11-25, forge 10.1.1)

Kernel-compat de-risk: all 11 `os/*` export surfaces consumed by consumer `tools/kernel.config.ts` loaders are preserved in v10 (`./os/core`, `./os/rfc-module`, `./os/adr-module`, `./os/plan-module`, `./os/audit-module`, `./os/compass`, `./os/naming-module`, `./os/workflow-module`, `./os/queue-module`, `./os/notes`, `./os/plugin`) — the kernel path survives migration intact.

| consumer | baseline (v9.7.1) | v10 dark-run | parity | upgrade | commit |
| --- | --- | --- | --- | --- | --- |
| pipelines | rfc fail/175 (exact sigs), adr fail/54, spec fail/3-specs | identical | **exact — 1396/1396 rfc sigs, adr 54=54, spec exact** | pass 9.7.1→10.1.1 | 42cb245 + forge-typescript adopted (4 pass / 2 fail — new governance visibility) |
| dialogue-steward | rfc fail/40 | fail/40 | **exact — 33/33 sigs** | pass | eec8f10 |
| lagebild | rfc fail/27 | fail/27 | **exact** | pass | 3d008f7 |
| metads | rfc pass/1 | pass/1 | **exact (green stays green)** | pass | 347f0bc |
| dater | rfc pass/143 | pass/143 | **exact** | pass | d99ee35 |

Hazards earned this wave:
- `flow.open --kind` accepts only `session|task` — `chore` refuses FLOW-OPEN-10.
- flow.open under a `timeout` wrapper still completes the worktree+branch but the CLI output is lost — verify via `git worktree list`, never re-run blindly (creates duplicate sessions).
- Session worktrees carry `.gitignore` files mode 444 — the upgrade's gitignore self-ensurance needs a documented intentional `chmod u+w` first; the edit is auditable in the migration commit diff.
- `pnpm exec forge` inside the worktree triggers pnpm implicit-install noise that corrupts `--json` capture — direct dist invocation only.
- dater pre-commit enforces prettier — run `prettier --write` on the touched yaml before committing.
- dialogue-steward/lagebild/metads/dater migrations are parity-only (no plugin adoption) — plugins are a deliberate later adoption per consumer; pipelines adopted forge-typescript because it is a pure typescript turbo monorepo.

## Wave-1 integration results (2026-11-25)

| consumer | verdict | notes |
| --- | --- | --- |
| lagebild | **INTEGRATED** | develop at 3d008f7, worktree cleaned |
| dialogue-steward | **INTEGRATED** | develop at eec8f10 |
| metads | **INTEGRATED** | after prettier-normalize fix — forge/pnpm yaml writers do not emit prettier-canonical bytes; consumer gates running `prettier --check .` refuse. Wave-1 protocol addition: always `prettier --write forge.yaml pnpm-workspace.yaml` before committing the migration |
| dater | **INTEGRATED** | the largest consumer (11 workspaces, chrome-extension+cloudflare+astro stack) — pass/143 corpus preserved exact |
| pipelines | in flight | first attempt refused CORR-GATE-02: the new top-level `plugins` key was not declared in `policy.mutable` — fixed by declaring `plugins` mutable (operator-controlled config, same class as `project`); re-integrating |

wave-1 scoreboard: **5/5 INTEGRATED.** pipelines completed parity-only (e4b0436ec) — CORR-GATE-02 correctly refused session self-amendment of policy twice (plugins key, then policy-decl change); plugin adoption in policy-gated consumers must land through the verbund queue path, filed as follow-up. All primaries post-merge `pnpm install`-refreshed and resolving forge 10.1.1.

## Plugin dependency design fix (same wave)

Published plugins 1.0.1 carried exact-pinned forge dependencies (workspace rewrite artifact) — nested copies and version-lock cascades in adopters. Fixed: `@warpgogol/forge` moved to `peerDependencies: ^10.1.0` in all four plugins, republished as **1.0.2**; e2e re-verified — zero nested copies, validators pass. Consumers adopting plugins should pin `^1.0.2`.

## Post-wave notes

- **werkstatt evidence-mirror integration hits the inert-ignore phantom** — v9-line machinery in werkstatt counts `node_modules/.pnpm/*/node_modules/*/.gitignore` as session dirt (CX-142 over-broadness fixed in v10 forge but not in the werkstatt v9-line). Workaround: delete the phantom file before flow.integrate; permanent fix arrives with WP-8 (werkstatt itself moving to v10 machinery).
- **hdri-frozen-v3**: absent as a standalone clone locally (exists only as a pipelines-attached worktree `hdri-frozen-v3-20261104`, detached) — confirmed skip, frozen artifact repo.
- plugin manifest-version sync + cli-bridge + first-party e2e tests re-verified green (10/10) after the 1.0.2 peerDependency republish.

## Follow-up execution: T-0023 filed (2026-11-25)

pipelines plugin adoption filed as verbund-queue task **T-0023** (kind: adoption, state: proposed) with a complete brief: the CORR-GATE-02 context, explicit-version pinning rule (^1.0.2 for the peerDependencies fix), policy.mutable sanctioning instructions, acceptance checks. Integrated into warpgogol-verbund develop (commit eaf8233). The verbund dispatch loop (`fo-system-dispatch`) owns execution from here.
