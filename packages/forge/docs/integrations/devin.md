# Devin integration

Forge's contract is plain files in the repository — `forge.yaml`, `AGENTS.md`, `.agents/skills/<name>/SKILL.md`, RFCs — and Devin reads these formats natively. No adapter, plugin, or hosted service is required.

> **Status:** verified against Devin's published conventions — Devin CLI reads `AGENTS.md` as always-on project rules and discovers `.agents/skills/<name>/SKILL.md` under the agents skills standard. An end-to-end public example is planned; this page marks what is verified and what is not.

## Install Forge for a Devin session

Inside the repository where Devin will work:

```sh
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript
# or, in an existing project: pnpm add -D @warpgogol/forge && pnpm exec forge init
```

This writes `forge.yaml`, generates `AGENTS.md`, and deploys skills to `.agents/skills/`:

- **`AGENTS.md`** — loaded by Devin as always-on project rules. Keep it concise: Devin's guidance pushes heavier instruction sets into skills, which matches Forge's layout (rules in `AGENTS.md`, workflows in `.agents/skills/`).
- **`.agents/skills/<name>/SKILL.md`** — discovered by Devin CLI; no conversion needed.
- **The `forge` CLI** — invoked like any repo command: `pnpm exec forge doctor`, `pnpm exec forge rfc.validate`, etc.

**Devin CLI vs Devin Cloud.** The conventions above are verified for Devin CLI. Devin Cloud sessions run inside a prepared environment: install Forge in the environment setup (e.g. `pnpm install` in the snapshot/blueprint) so the `forge` binary and `.agents/skills/` exist before the session starts. Do not assume identical behavior until verified — Node version and package-manager availability are the usual failure points.

## One task, end to end

Example: ask Devin to change a validator without breaking an architectural contract.

1. **Devin reads** `AGENTS.md` and the relevant skills — learns the contract (which invariants the change must satisfy) and the verification commands (`forge rfc.validate`, `pnpm test`).
2. **Devin implements** the change and opens a PR.
3. **CI runs the repo's checks independently of the agent's self-assessment** — unit tests plus `forge` validators (naming, compass, RFC lifecycle).
4. **Green** → human review. **Red** → the finding names the violated rule; Devin fixes and reruns.

The important property: Forge's checks run outside the agent's reasoning. A PR passes because deterministic validators pass — not because the agent reports done.

## Division of responsibility

| Devin | Forge |
| --- | --- |
| Analyzes the codebase, writes code, opens PRs | Holds the project contract and instructions |
| Uses its own memory and skills | Provides portable, versioned skills and workflows |
| Verifies its own work | Adds independent deterministic checks |
| Decides a session is done | Reports IMPLEMENTED / VERIFIED / ACCEPTED separately — claims never outrun evidence |

## What Forge does not do

- Does not change Devin's reasoning, planning, or model.
- Does not guarantee semantic correctness — validators check declared conditions only.
- Does not enforce anything by itself. A validator that CI does not run is a report, not a gate — wire `forge` checks into CI or hooks for enforcement. See [the verification model](../concepts/verification-model.md).
- Does not require or provide a hosted service — everything is files in the repo.

## Reference experiment (planned)

The claim worth proving is not "Forge works" but "Forge's checks catch what the agent's self-assessment misses." The experiment we intend to publish:

1. **Setup** — a clean TypeScript repo with Forge installed; versions, commit SHA and environment pinned.
2. **Task** — Devin receives a change to an API module with explicit acceptance criteria and one architectural constraint.
3. **Violation** — one candidate change breaks the declared contract; a Forge validator must detect it independently of Devin's self-report.
4. **Correction** — Devin receives the validator output, fixes the code, and CI reruns green.
5. **Evidence** — task text, commits, diffs, validator logs, and run cost are published for independent reproduction.

Success criterion: a third party can repeat the scenario and see which contract prevented the incorrect change from being accepted. A follow-up comparison (same task class, Devin with vs. without Forge) measures accepted-change rate, contract violations, manual rework and cost per accepted task — not impressions.

Status: **planned, not yet run.** This section will link the published artifacts when the experiment lands; until then it describes the protocol, not a result. See also the [grant proposal](../grants/devin-startups.md) where this experiment is a funded milestone.
