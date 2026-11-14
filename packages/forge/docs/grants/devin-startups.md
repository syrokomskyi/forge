# Forge × Devin for Startups — proposal brief

Working draft for the [Devin for Startups](https://devin.ai/startups) application. Public so the claims stay checkable against the repository.

| Section | Content |
| --- | --- |
| **Startup** | Warpgogol — operating engineering studio based in Germany. Forge is our open-source infrastructure product (Apache-2.0, [`@warpgogol/forge`](https://www.npmjs.com/package/@warpgogol/forge) on npm). |
| **Problem** | Autonomous agents lose project decisions and self-certify their output. There is no independent check between "the agent says done" and "the change is accepted." |
| **Solution** | Repository-native contracts — `forge.yaml`, generated `AGENTS.md`, portable skills — plus deterministic validators that run in CI outside the agent's reasoning. |
| **Traction** | Published npm package (v9.6.x) with provenance-signed releases, public CI on every release, documented use across our own production fleet of repositories ([fleet measurement](../reference/fleet-measurement.md)). Note: the fleet is internal usage — evidence of a working tool, not of independent market adoption. |
| **Devin use case** | Devin as the implementation agent on Forge-governed projects: Forge holds the contract and skills, Devin writes code, Forge validators gate acceptance independently of the agent's self-assessment. See [the integration guide](../integrations/devin.md). |
| **Milestones** | (1) Reference experiment published — reproducible scenario where a Forge validator catches a contract violation Devin's self-assessment accepted ([protocol](../integrations/devin.md#reference-experiment-planned)). (2) Comparative measurement — same task class, Devin with vs. without Forge. (3) Public results + case study. |
| **Success metrics** | Verified completion rate, contract violations caught pre-merge, cost per accepted task, manual review effort per PR. |
| **Limits** | No completed public Devin experiment yet — the integration is verified against Devin's published conventions, the end-to-end demonstration is a funded milestone, not a finished result. |

## What the grant pays for

- Devin seat/credits for the reference experiment and the comparative study above.
- CI compute for the validation matrix (Devin × task class × contract presence).
- Maintainer time writing the reproducible scenarios and publishing the evidence.

## What we are not asking the grant to fund

- Core Forge development — it is already shipping.
- Marketing claims — results get published as artifacts (tasks, diffs, validator logs, cost data) or not at all.
