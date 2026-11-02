/*
<MODULE_CONTRACT>
<purpose>Register flow.check and flow.install with the forge kernel registry
(RFC-1486) — the fixed branch model's read-only validator (FLOW-01..05) and
the idempotent two-phase repository adoption (FLOW-ADOPT-01..06, -08).</purpose>
<non-goals>
  <item>Do not implement handler logic here — delegate to handlers/flow-check.ts and handlers/flow-install.ts.</item>
  <item>No pipeline wiring — activation is the wave-4 switch-over RFC.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1487: step 6 — register flow.open/integrate/discard/status and flow.check FLOW-06/07</item>
  <item>RFC-1490: step 4 — ordinary flow.cut (release branch, verified versions, gate, main swap, tags, resume)</item>
  <item>RFC-1490: step 5 — flow.backmerge (port branch, fixed merge message, conflict + --redo paths)</item>
  <item>RFC-1490: step 6 — flow.fix + fix-mode cut (patch-only, rebase on moved main, gate target main, trailing back-merge)</item>
  <item>RFC-1490: independent-review pass — lock-held planning, fix-branch verification, spec-shaped data, coverage</item>
  <history>RFC-1486, RFC-1488</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeFlowModule(): Promise<ForgeModule> {
  const { runFlowCheck } = await import("./handlers/flow-check.ts");
  const { runFlowDiscard } = await import("./handlers/flow-discard.ts");
  const { runFlowInstall } = await import("./handlers/flow-install.ts");
  const { runFlowBackmerge } = await import("./handlers/flow-backmerge.ts");
  const { runFlowCut } = await import("./handlers/flow-cut.ts");
  const { runFlowFix } = await import("./handlers/flow-fix.ts");
  const { runFlowIntegrate } = await import("./handlers/flow-integrate.ts");
  const { runFlowOpen } = await import("./handlers/flow-open.ts");
  const { runFlowStatus } = await import("./handlers/flow-status.ts");
  const { runFlowVersion } = await import("./handlers/flow-version.ts");
  return {
    name: "forge-flow",
    version: "0.1.0",
    runtime: "autonomous",
    declarations: [],
    commands: [
      {
        name: "flow.check",
        description:
          "Read-only fixed-branch-model validator (RFC-1486). Reports FLOW-01 " +
          "(local branch outside the model), FLOW-02 (missing develop), " +
          "FLOW-03 (guard not installed: core.hooksPath, managed block or " +
          "byte-exact flow-guard.sh), FLOW-04 (warning — main ahead of " +
          "develop, a back-merge is owed) and FLOW-05 (forge.generated.yaml " +
          "fails the forge/generated@1 schema). Generated repositories return " +
          "an exempt verdict with the parsed marker; ungoverned repositories " +
          "report their kind with no diagnostics. Exit 1 iff an " +
          "error-severity diagnostic exists.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-01", severity: "error" },
          { id: "FLOW-02", severity: "error" },
          { id: "FLOW-03", severity: "error" },
          { id: "FLOW-04", severity: "warning" },
          { id: "FLOW-05", severity: "error" },
          { id: "FLOW-06", severity: "warning" },
          { id: "FLOW-07", severity: "error" },
          { id: "FLOW-08", severity: "error" },
          { id: "FLOW-09", severity: "warning" },
          { id: "FLOW-VER-02", severity: "error" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        coverage: "operator",
        coverageNote:
          "adoption/model check — wired into pipelines by the wave-4 switch-over RFC",
        reads: [
          "forge.yaml",
          "forge.generated.yaml",
          ".git/**",
          "hooks/**",
          "pnpm-workspace.yaml",
          "*/package.json",
          "*/extract.config.yaml",
        ],
        cacheable: false,
        flags: {},
        execute: runFlowCheck,
      },
      {
        name: "flow.install",
        description:
          "Adopt the fixed branch model in this repository (RFC-1486), " +
          "idempotent and two-phase: the plan phase evaluates every " +
          "precondition without mutating (refusals FLOW-ADOPT-01..06, -08 " +
          "exit 1 with nothing changed; --dry-run stops here), then the " +
          "execute phase levels develop with main, points core.hooksPath at " +
          "hooks/, switches the clean primary to develop, installs " +
          "hooks/flow-guard.sh byte-exact plus the managed pre-commit block, " +
          "and lands one adoption commit on develop under " +
          "FORGE_FLOW_OP=install. Step 9 embeds a flow.check report.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-ADOPT-01", severity: "error" },
          { id: "FLOW-ADOPT-02", severity: "error" },
          { id: "FLOW-ADOPT-03", severity: "error" },
          { id: "FLOW-ADOPT-04", severity: "error" },
          { id: "FLOW-ADOPT-05", severity: "error" },
          { id: "FLOW-ADOPT-06", severity: "error" },
          { id: "FLOW-ADOPT-07", severity: "error" },
          { id: "FLOW-ADOPT-08", severity: "error" },
          { id: "FLOW-VER-02", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: ["hooks/pre-commit", "hooks/flow-guard.sh", ".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote:
          "run once per repository at adoption — wired into forge.upgrade by the wave-4 switch-over RFC",
        reads: [
          "forge.yaml",
          "forge.generated.yaml",
          ".git/**",
          "hooks/**",
          "pnpm-workspace.yaml",
          "*/package.json",
          "*/extract.config.yaml",
        ],
        cacheable: false,
        flags: {
          "dry-run": {
            kind: "boolean",
            required: false,
            description:
              "Plan phase only — report the computed steps[] without mutating anything.",
          },
        },
        execute: runFlowInstall,
      },
      {
        name: "flow.version",
        description:
          "Read-only release-line report (RFC-1488). For every discovered " +
          "line (repository `v` line plus each extract.config.yaml package " +
          "line) it reports the last reachable annotated tag, the version " +
          "file's value, commits since the tag, the derived version " +
          "X.Y.Z+N.<head9> (.dirty on tracked modifications) and the " +
          "pending level from X-RFC trailers resolved through the canonical " +
          "RFC reader. Diagnostics: FLOW-VER-01 (no baseline tag), " +
          "FLOW-VER-02 (basename collision), FLOW-VER-03 (unreadable RFC), " +
          "FLOW-VER-04 (unknown --line). Never writes — only flow.install " +
          "and the wave-2 cut create tags.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-VER-01", severity: "warning" },
          { id: "FLOW-VER-02", severity: "error" },
          { id: "FLOW-VER-03", severity: "warning" },
          { id: "FLOW-VER-04", severity: "error" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        coverage: "operator",
        coverageNote: "read-only version report — consumed by flow.cut in wave 2",
        reads: ["pnpm-workspace.yaml", "*/package.json", "*/extract.config.yaml", ".git/**", "docs/rfcs/**"],
        cacheable: false,
        flags: {
          line: {
            kind: "string",
            required: false,
            description:
              "Report only this release line id (e.g. repo, forge). Unknown id → FLOW-VER-04.",
          },
        },
        execute: runFlowVersion,
      },
      {
        name: "flow.open",
        description:
          "Open a session or task in its own worktree beside the repository " +
          "(RFC-1487). Assigns the next free NN for today's UTC date across " +
          "local branches, remote-tracking refs and the registry, creates " +
          "auto/<kind>-<YYMMDD>-<NN>-<slug> from the develop tip at " +
          "<parent>/<repo>@<branch-slug>, records the registry entry under " +
          "the common git dir, journals the open and runs the primary's " +
          "hooks/worktree-setup.sh. Refusals: FLOW-OPEN-01..07. The sibling " +
          "worktree directory lives outside writes[] scope by design.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-OPEN-01", severity: "error" },
          { id: "FLOW-OPEN-02", severity: "error" },
          { id: "FLOW-OPEN-03", severity: "error" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-05", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
          { id: "FLOW-07", severity: "error" },
        ],
        mutatesState: true,
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "session lifecycle — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**"],
        cacheable: false,
        flags: {
          kind: {
            kind: "string",
            required: true,
            description: "Branch kind: session or task.",
          },
          slug: {
            kind: "string",
            required: true,
            description: "Slug for the branch name — ^[a-z0-9]+(-[a-z0-9]+)*$, 3..48 chars.",
          },
          brief: {
            kind: "string",
            required: false,
            description: "One-line brief recorded on the registry entry.",
          },
          owner: {
            kind: "string",
            required: false,
            description: "Owner id — required for --kind task (e.g. T-0007); sessions default to 'unspecified'.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Report the would-be branch/worktree without mutating.",
          },
        },
        execute: runFlowOpen,
      },
      {
        name: "flow.integrate",
        description:
          "Integrate a registered auto branch into develop as a linear " +
          "fast-forward (RFC-1487), idempotent and rerun-safe: under the " +
          "integration lock the clean branch worktree rebases onto develop, " +
          "the primary's hooks/integration-gate.sh gates, the clean primary " +
          "on develop fast-forwards via git -C <primary> merge --ff-only " +
          "(never a merge commit — the primary working tree is rewritten by " +
          "the merge itself), then teardown, worktree removal, branch delete, " +
          "registry drop and journal finish the lifecycle. Refusals: " +
          "FLOW-INT-01..08.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-INT-01", severity: "error" },
          { id: "FLOW-INT-02", severity: "error" },
          { id: "FLOW-INT-03", severity: "error" },
          { id: "FLOW-INT-04", severity: "error" },
          { id: "FLOW-INT-05", severity: "error" },
          { id: "FLOW-INT-06", severity: "error" },
          { id: "FLOW-INT-07", severity: "error" },
          { id: "FLOW-INT-08", severity: "error" },
          { id: "FLOW-INT-09", severity: "error" },
          { id: "FLOW-INT-10", severity: "error" },
          { id: "FLOW-07", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "session lifecycle — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**"],
        cacheable: false,
        flags: {
          branch: {
            kind: "string",
            required: false,
            description:
              "Registered auto branch to integrate; defaults to the branch checked out in the cwd worktree.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate the integration's preconditions without mutating.",
          },
        },
        execute: runFlowIntegrate,
      },
      {
        name: "flow.cut",
        description:
          "Cut a release on the fixed branch model (RFC-1490): plan refusals " +
          "FLOW-CUT-01..07, then under the integration lock — release branch " +
          "through flow.open (owner release), verified version-file writes, " +
          "chore(release) commit, gate + fast-forward into develop, " +
          "release-fingerprints hook, main compare-and-swap, release tags " +
          "(repository line always, package lines via --lines), journal. " +
          "Rerun-safe: resumes at fingerprints after an integrated release " +
          "commit, reports released when every named tag exists.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-CUT-01", severity: "error" },
          { id: "FLOW-CUT-02", severity: "error" },
          { id: "FLOW-CUT-03", severity: "error" },
          { id: "FLOW-CUT-04", severity: "error" },
          { id: "FLOW-CUT-05", severity: "error" },
          { id: "FLOW-CUT-06", severity: "error" },
          { id: "FLOW-CUT-07", severity: "error" },
          { id: "FLOW-CUT-08", severity: "error" },
          { id: "FLOW-CUT-09", severity: "error" },
          { id: "FLOW-CUT-10", severity: "error" },
          { id: "FLOW-CUT-11", severity: "error" },
          { id: "FLOW-INT-02", severity: "error" },
          { id: "FLOW-INT-05", severity: "error" },
          { id: "FLOW-INT-06", severity: "error" },
          { id: "FLOW-INT-08", severity: "error" },
          { id: "FLOW-07", severity: "error" },
          { id: "FLOW-OPEN-02", severity: "error" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
        ],
        envInputs: [{ name: "ALLOW_MAJOR_BUMP", required: false }],
        mutatesState: true,
        idempotency: "rerun-safe",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "release workflow — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**", "pnpm-workspace.yaml", "package.json", "packages/*/package.json"],
        cacheable: false,
        flags: {
          lines: {
            kind: "string",
            required: false,
            description:
              "Comma-separated package release-line ids to cut alongside the repository line.",
          },
          branch: {
            kind: "string",
            required: false,
            description:
              "Registered fix branch to cut a fix release for; defaults to the cwd worktree's branch.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate the cut's preconditions without mutating.",
          },
        },
        execute: runFlowCut,
      },
      {
        name: "flow.backmerge",
        description:
          "Port main into develop through a gated port branch (RFC-1490): " +
          "release tags on develop..main (oldest first) name the merge " +
          "message 'release <tags> → develop', the port worktree merges main " +
          "--no-ff under the integration lock, a clean merge gates and " +
          "fast-forwards the primary, a conflict leaves the merge in " +
          "progress with recovery steps. --redo discards an existing port " +
          "for the same mainSha first. Refusals: FLOW-BM-01/02, FLOW-INT-09/10.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-BM-01", severity: "error" },
          { id: "FLOW-BM-02", severity: "error" },
          { id: "FLOW-INT-05", severity: "error" },
          { id: "FLOW-INT-08", severity: "error" },
          { id: "FLOW-INT-09", severity: "error" },
          { id: "FLOW-INT-10", severity: "error" },
          { id: "FLOW-07", severity: "error" },
          { id: "FLOW-OPEN-02", severity: "error" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        execOnReadOnly: false,
        mutatingFlags: ["redo"],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "release workflow — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**", "pnpm-workspace.yaml", "package.json"],
        cacheable: false,
        flags: {
          redo: {
            kind: "boolean",
            required: false,
            description: "Discard an existing port for the same mainSha and reopen it.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate the back-merge's preconditions without mutating.",
          },
        },
        execute: runFlowBackmerge,
      },
      {
        name: "flow.fix",
        description:
          "Open a release fix on the fixed branch model (RFC-1490): refuses " +
          "when the repository is unadopted (FLOW-FIX-01), when main moved " +
          "past its last release tag (FLOW-FIX-02), on a bad slug " +
          "(FLOW-FIX-03), or while a back-merge is pending (FLOW-FIX-04); " +
          "then opens auto/fix-<YYMMDD>-<NN>-<slug> at the main tip with a " +
          "registered kind:fix entry. flow.cut inside that worktree ships " +
          "the patch into main and back-merges into develop.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-FIX-01", severity: "error" },
          { id: "FLOW-FIX-02", severity: "error" },
          { id: "FLOW-FIX-03", severity: "error" },
          { id: "FLOW-FIX-04", severity: "error" },
          { id: "FLOW-OPEN-01", severity: "error" },
          { id: "FLOW-OPEN-02", severity: "error" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
          { id: "FLOW-07", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "not-idempotent",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "release workflow — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**", "pnpm-workspace.yaml", "package.json"],
        cacheable: false,
        flags: {
          slug: {
            kind: "string",
            required: true,
            description: "Branch slug — ^[a-z0-9]+(-[a-z0-9]+)*$, 3..48 chars.",
          },
          brief: {
            kind: "string",
            required: false,
            description: "One-line brief recorded in the registry and journal.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate the fix's preconditions without mutating.",
          },
        },
        execute: runFlowFix,
      },
      {
        name: "flow.discard",
        description:
          "Discard a registered auto branch without integrating (RFC-1487): " +
          "the primary's hooks/worktree-teardown.sh runs, the worktree is " +
          "removed (--force only with --dirty), the branch is force-deleted, " +
          "the registry entry dropped and the operator's --reason journaled. " +
          "Refusals: FLOW-DIS-01..04.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-DIS-01", severity: "error" },
          { id: "FLOW-DIS-02", severity: "error" },
          { id: "FLOW-DIS-03", severity: "error" },
          { id: "FLOW-DIS-04", severity: "error" },
          { id: "FLOW-07", severity: "error" },
        ],
        mutatesState: true,
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "session lifecycle — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", "forge.generated.yaml", ".git/**", "hooks/**"],
        cacheable: false,
        flags: {
          branch: {
            kind: "string",
            required: false,
            description:
              "Registered auto branch to discard; defaults to the branch checked out in the cwd worktree.",
          },
          reason: {
            kind: "string",
            required: true,
            description: "Why the work is dropped — journaled for the outbound wave.",
          },
          dirty: {
            kind: "boolean",
            required: false,
            description: "Acknowledge discarding uncommitted changes in the worktree.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Report the discard plan without mutating.",
          },
        },
        execute: runFlowDiscard,
      },
      {
        name: "flow.status",
        description:
          "Read-only session-branch report (RFC-1487): every auto branch " +
          "with its registry entry, worktree, uncommitted-change count, " +
          "distance to develop, last commit time, held state and the 72 h " +
          "stale flag. Reports FLOW-07 at error severity when the registry " +
          "fails the forge/flow-registry@1 schema.",
        scope: "workspace",
        contract: "flow",
        rules: [{ id: "FLOW-07", severity: "error" }],
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        coverage: "operator",
        coverageNote: "session lifecycle — activated by the wave-4 switch-over RFC",
        reads: ["forge.yaml", ".git/**"],
        cacheable: false,
        flags: {},
        execute: runFlowStatus,
      },
    ],
    pipelines: [],
  };
}
