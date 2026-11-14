# The verification model

Forge does not prove that code is correct. It carries declared engineering requirements and checks them deterministically. Three levels matter — and they are easy to conflate:

| Level | What Forge does | What it guarantees |
| --- | --- | --- |
| **Instructions** | Delivers project rules to the agent — `AGENTS.md`, skills, `forge.yaml` bindings, the operating model | The agent can read the rules. Not that it followed them. |
| **Validation** | Runs formalized checks — validators, conformance, probes, audits | A declared condition was checked and its verdict recorded. Not that the condition was complete. |
| **Enforcement** | Blocks a transition when a check fails — only where a gate actually wires the check | A violation cannot pass _that gate_. Nothing more. |

## The chain, end to end

A rule only protects the project when the whole chain holds:

1. The requirement is **declared** — RFC, ADR, DNA invariant, binding, contract file.
2. A **validator** exists that can check it — a forge command, a test, a gate step.
3. The validator is **reachable** by whoever must run it — the agent reads `AGENTS.md`; CI runs the gate.
4. A failing verdict **blocks** something real — a commit, a merge, a release.

Break any link and the rule is documentation, not a gate. `forge gate.probe` exists for exactly this reason: it seeds a violation at the real path and proves the gate still fires.

## What Forge does not guarantee

- **Semantic correctness.** Validators check declared conditions; they cannot prove arbitrary code correct.
- **Unwired enforcement.** A validator that nothing invokes is a report, not a gate. Wiring — CI, hooks, commit policy — is the operator's responsibility.
- **Agent honesty.** Session audit detects classes of evasion; it is a detector with known false-positive and false-negative rates, not proof of good faith.
- **Human approval.** Forge complements review; it does not replace it.

The accurate promise: Forge provides versioned project instructions, executable checks, and evidence-producing workflows. When its validators are enforced by CI, violations of declared contracts block the merge. Forge does not replace human approval or guarantee semantic correctness.

See [Verification & evidence — scenario guide](../guides/verification-and-evidence.md) for the per-mechanism input → operation → output → human decision walkthroughs.
