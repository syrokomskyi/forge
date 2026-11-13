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
  <item>RFC-1531: add flow.integrate remediation flags on the shared dirty classifier</item>
  <item>RFC-1543: attribute shared-checkout dirt to live ops and expose peers (RFC-1543)</item>
  <item>RFC-1568: durable gate-run records, --detach mechanics, and forge CLI wiring</item>
  <item>RFC-1573: step 2 — declare flow.cut, flow.backmerge, mission.close detachable

Each runs a long gate (integrateFlowBranch / runMissionValidate); leitstand.ship stays attached (Q-1).</item>
  <item>RFC-1580: correctness.gate and the flow.integrate step

Add os/correctness/gate (frozen set at --base, weakening diff incl. byte changes without verifier trailers and frozen exempt mode, git-derived oracle origin with forge/oracle-review@1 records, argv oracle runner with timeout, schema-hash substrate attestation, anchor events, tier high/formal, forge/correctness-bundle@1), the correctness.gate command, test-side helpers @warpgogol/forge/correctness, bindings.paths.oracleReviewsDir, and flow.integrate spawning the primary install's gate after hooks/integration-gate.sh (FLOW-INT-18, --accept-weakening with an X-Correctness-Weakening trailer commit). Flow and system test primaries get a stand-in forge binary; integration warnings now survive the cleanup report.</item>
  <history>RFC-1486, RFC-1487, RFC-1488, RFC-1490, RFC-1491, RFC-1498, RFC-1502, RFC-1503, RFC-1517, RFC-1528, RFC-1533, RFC-1537, RFC-1538</history>
</CHANGE_SUMMARY>
*/

import type { ForgeModule } from "../../src/forge-module.ts";

export async function createForgeFlowModule(): Promise<ForgeModule> {
  const { runFlowCheck } = await import("./handlers/flow-check.ts");
  const { runFlowDigest } = await import("./handlers/flow-digest.ts");
  const { runFlowDiscard } = await import("./handlers/flow-discard.ts");
  const { runFlowInstall } = await import("./handlers/flow-install.ts");
  const { runFlowBackmerge } = await import("./handlers/flow-backmerge.ts");
  const { runFlowCut } = await import("./handlers/flow-cut.ts");
  const { runFlowFix } = await import("./handlers/flow-fix.ts");
  const { runFlowHold } = await import("./handlers/flow-hold.ts");
  const { runFlowIntegrate } = await import("./handlers/flow-integrate.ts");
  const { runFlowOpen } = await import("./handlers/flow-open.ts");
  const { runFlowPush } = await import("./handlers/flow-push.ts");
  const { runFlowPublicationRetire } = await import("./handlers/flow-publication-retire.ts");
  const { runFlowStatus } = await import("./handlers/flow-status.ts");
  const { runFlowPeers } = await import("./handlers/flow-peers.ts");
  const { runFlowUnhold } = await import("./handlers/flow-unhold.ts");
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
          { id: "FLOW-10", severity: "error" },
          { id: "FLOW-VER-02", severity: "error" },
        ],
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        coverage: "operator",
        coverageNote: "adoption/model check — wired into pipelines by the wave-4 switch-over RFC",
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
            description: "Plan phase only — report the computed steps[] without mutating anything.",
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
        reads: [
          "pnpm-workspace.yaml",
          "*/package.json",
          "*/extract.config.yaml",
          ".git/**",
          "docs/rfcs/**",
        ],
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
          { id: "FLOW-OPEN-02", severity: "warning" },
          { id: "FLOW-OPEN-03", severity: "error" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-05", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
          { id: "FLOW-OPEN-11", severity: "error" },
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
            description:
              "Owner id — required for --kind task (e.g. T-0007); sessions default to 'unspecified'.",
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
        detachable: true,
        description:
          "Integrate a registered auto branch into develop as a linear " +
          "fast-forward (RFC-1487), idempotent and rerun-safe: under the " +
          "integration lock the clean branch worktree rebases onto develop, " +
          "the primary's hooks/integration-gate.sh gates, the clean primary " +
          "on develop fast-forwards via git -C <primary> merge --ff-only " +
          "(never a merge commit — the primary working tree is rewritten by " +
          "the merge itself), then teardown, worktree removal, branch delete, " +
          "registry drop and journal finish the lifecycle. On the non-port " +
          "path a bounded preflight (classified dirty-tree checks, " +
          "ecosystem.manifest.validate, scoped rfc.validate, " +
          "friction.validate) refuses before the rebase and the gate " +
          "(RFC-1528). Refusals: FLOW-INT-01..17. RFC-1531 remediation " +
          "flags: --reattach recreates a vanished worktree, --auto-clean " +
          "deletes closed-class disposable dirt, --autocommit sweeps the " +
          "rest into a fixed-subject commit.",
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
          { id: "FLOW-INT-11", severity: "error" },
          { id: "FLOW-INT-12", severity: "error" },
          { id: "FLOW-INT-13", severity: "error" },
          { id: "FLOW-INT-14", severity: "error" },
          { id: "FLOW-INT-15", severity: "error" },
          { id: "FLOW-INT-16", severity: "warning" },
          { id: "FLOW-INT-17", severity: "error" },
          { id: "FLOW-INT-18", severity: "error" },
          { id: "FLOW-07", severity: "error" },
          { id: "WT-GATE-01", severity: "error" },
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
          reattach: {
            kind: "boolean",
            required: false,
            description:
              "RFC-1531: recreate a vanished registered worktree at its recorded (or canonical sibling) path instead of refusing.",
          },
          "auto-clean": {
            kind: "boolean",
            required: false,
            description:
              "RFC-1531: delete dirty paths in the closed disposable class (coverage/, tmp*/, *.log, *.stale), then re-evaluate.",
          },
          "accept-weakening": {
            kind: "string",
            required: false,
            description:
              "RFC-1580: operator decision — accept the correctness weakening of an isolated session (frozen-set paths only); recorded as an X-Correctness-Weakening trailer and listed by flow.digest.",
          },
          autocommit: {
            kind: "boolean",
            required: false,
            description:
              "RFC-1531: sweep all remaining dirty entries into the fixed-subject commit 'chore(flow): sweep session leftovers' before the rebase.",
          },
          "wait-foreign": {
            kind: "string",
            required: false,
            description:
              "RFC-1543: seconds to wait for live foreign op-claim holders on the primary before FLOW-INT-03 refuses (default 600; 0 restores fail-fast).",
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
        // RFC-1573: runs the integration gate (integrateFlowBranch) under the lock.
        detachable: true,
        description:
          "Cut a release on the fixed branch model (RFC-1490): plan refusals " +
          "FLOW-CUT-01..07, then under the integration lock — release branch " +
          "through flow.open (owner release), verified version-file writes, " +
          "release-prepare hook (RFC-1502: FLOW-CUT-12 refusal, FLOW-CUT-14 " +
          "untracked warning), chore(release) commit, pre-tag extract " +
          "verification per named package line (FLOW-CUT-13), " +
          "gate + fast-forward into develop, " +
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
          { id: "FLOW-CUT-12", severity: "error" },
          { id: "FLOW-CUT-13", severity: "error" },
          { id: "FLOW-CUT-14", severity: "warning" },
          { id: "FLOW-INT-02", severity: "error" },
          { id: "FLOW-INT-05", severity: "error" },
          { id: "FLOW-INT-06", severity: "error" },
          { id: "FLOW-INT-08", severity: "error" },
          { id: "FLOW-07", severity: "error" },
          { id: "FLOW-OPEN-02", severity: "warning" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
          { id: "FLOW-OPEN-11", severity: "error" },
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
        reads: [
          "forge.yaml",
          "forge.generated.yaml",
          ".git/**",
          "hooks/**",
          "pnpm-workspace.yaml",
          "package.json",
          "packages/*/package.json",
          "packages/*/extract.config.yaml",
        ],
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
        // RFC-1573: the clean path delegates to integrateFlowBranch under the lock.
        detachable: true,
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
          { id: "FLOW-OPEN-02", severity: "warning" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
          { id: "FLOW-OPEN-11", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "rerun-safe",
        execOnReadOnly: false,
        mutatingFlags: ["redo"],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "release workflow — activated by the wave-4 switch-over RFC",
        reads: [
          "forge.yaml",
          "forge.generated.yaml",
          ".git/**",
          "hooks/**",
          "pnpm-workspace.yaml",
          "package.json",
        ],
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
          { id: "FLOW-OPEN-02", severity: "warning" },
          { id: "FLOW-OPEN-04", severity: "error" },
          { id: "FLOW-OPEN-06", severity: "error" },
          { id: "FLOW-OPEN-07", severity: "error" },
          { id: "FLOW-OPEN-11", severity: "error" },
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
        reads: [
          "forge.yaml",
          "forge.generated.yaml",
          ".git/**",
          "hooks/**",
          "pnpm-workspace.yaml",
          "package.json",
        ],
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
        name: "flow.digest",
        description:
          "Read-only outbound risk digest (RFC-1491): the unpushed " +
          "develop tail segmented into journal-attributed items " +
          "(integration, backmerge, release, unattributed) classified by " +
          "risk category — contract, migration, invariant, " +
          "capability-removal, major-dependency, other — plus new release " +
          "tags versus origin, held branches and journal-scoped pending " +
          "publications. Prints the digestId flow.push must quote. " +
          "--no-fetch skips git fetch for offline review; a fetch failure " +
          "downgrades to stale remote-tracking refs with a warning. " +
          "FLOW-PUSH-01 (error) when no origin remote exists.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-PUSH-01", severity: "error" },
          { id: "FLOW-DIGEST-01", severity: "warning" },
          { id: "FLOW-07", severity: "error" },
          { id: "FLOW-11", severity: "warning" },
        ],
        mutatesState: true, // git fetch updates remote-tracking refs unless --no-fetch
        idempotency: "rerun-safe",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "release workflow — activated by the wave-4 switch-over RFC",
        reads: [
          "forge.yaml",
          ".git/**",
          "docs/rfcs/*.md",
          "pnpm-workspace.yaml",
          "package.json",
          "packages/*/package.json",
          ".github/workflows/**",
        ],
        cacheable: false,
        flags: {
          "no-fetch": {
            kind: "boolean",
            required: false,
            description: "Skip git fetch origin --prune — digest on existing remote-tracking refs.",
          },
        },
        execute: runFlowDigest,
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
        name: "flow.hold",
        description:
          "Pull one integration item out of the unpushed develop tail " +
          "(RFC-1491) under the integration lock: refuses FLOW-HOLD-01..06 " +
          "(not in a fresh digest, unpushed release tag above the item, an " +
          "open branch based above it, dirty or off-develop primary, " +
          "non-integration kind, a merge above it), then replays the tail " +
          "without the item via cherry-pick in a detached temporary " +
          "worktree, keeps a held auto branch at the item's tip, resets " +
          "develop to the replayed tip and journals rewrites so the next " +
          "digest still attributes the replayed items. FLOW-HOLD-07 when " +
          "the replay conflicts — nothing changes.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-HOLD-01", severity: "error" },
          { id: "FLOW-HOLD-02", severity: "error" },
          { id: "FLOW-HOLD-03", severity: "error" },
          { id: "FLOW-HOLD-04", severity: "error" },
          { id: "FLOW-HOLD-05", severity: "error" },
          { id: "FLOW-HOLD-06", severity: "error" },
          { id: "FLOW-HOLD-07", severity: "error" },
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
        reads: ["forge.yaml", ".git/**", "docs/rfcs/*.md", "hooks/**"],
        cacheable: false,
        flags: {
          item: {
            kind: "string",
            required: true,
            description: "Digest item id to hold — I-<9 hex of tip> from flow.digest.",
          },
          reason: {
            kind: "string",
            required: true,
            description: "Why the item is held — recorded on the registry entry and journal.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate every refusal and print the held branch name without mutating.",
          },
        },
        execute: runFlowHold,
      },
      {
        name: "flow.unhold",
        description:
          "Bring a held branch back (RFC-1491): refuses FLOW-HOLD-08 when " +
          "the registry entry is not held, then creates the RFC-1487 " +
          "sibling worktree at the branch tip, runs hooks/worktree-setup.sh, " +
          "clears held and journals the unhold. The branch integrates " +
          "normally afterwards via flow.integrate.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-HOLD-08", severity: "error" },
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
        reads: ["forge.yaml", ".git/**", "hooks/**"],
        cacheable: false,
        flags: {
          branch: {
            kind: "string",
            required: true,
            description: "Held auto branch to unhold — see flow.status held entries.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate the unhold plan without mutating.",
          },
        },
        execute: runFlowUnhold,
      },
      {
        name: "flow.push",
        description:
          "The only outbound path (RFC-1491, AUDIT-RFC-1491-E1): refuses " +
          "preflight FLOW-PUSH-01 (no origin), FLOW-PUSH-02 (stale digest " +
          "— quote the current flow.digest id), FLOW-PUSH-03 (origin " +
          "diverged), FLOW-PUSH-06 (package line without a valid " +
          "forge.generated.yaml marker) and FLOW-PUSH-07 (repo-extract " +
          "missing), then pushes develop + main + new release tags in one " +
          "atomic push under FORGE_FLOW_OP=push (FLOW-PUSH-04 on failure) " +
          "and publishes each package-line tag through repo-extract " +
          "(FLOW-PUSH-05 per failure, ours-merge reconcile on " +
          "non-fast-forward only, never force). A rerun with an empty " +
          "digest retries journal-scoped pending publications. Per-tag " +
          "preflight refuses before repo-extract spawns: FLOW-PUB-01 " +
          "(missing [version] CHANGELOG section at ref) and PKG-HEALTH-10 " +
          "(shipped ../ literal escaping the package root — same-line " +
          '"// pkg-health-10:" suppression or pkgHealth10Suppressions in ' +
          "extract.config.yaml for justified non-path literals).",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-PUSH-01", severity: "error" },
          { id: "FLOW-PUSH-02", severity: "error" },
          { id: "FLOW-PUSH-03", severity: "error" },
          { id: "FLOW-PUSH-04", severity: "error" },
          { id: "FLOW-PUSH-05", severity: "error" },
          { id: "FLOW-PUSH-06", severity: "error" },
          { id: "FLOW-PUSH-07", severity: "error" },
          { id: "FLOW-PUB-01", severity: "error" },
          { id: "PKG-HEALTH-10", severity: "error" },
          { id: "FLOW-07", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "not-idempotent",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "outbound — operator command only (RFC-1491 E1)",
        reads: [
          "forge.yaml",
          ".git/**",
          "docs/rfcs/*.md",
          "hooks/**",
          "pnpm-workspace.yaml",
          "package.json",
          "packages/*/extract.config.yaml",
        ],
        cacheable: false,
        flags: {
          digest: {
            kind: "string",
            required: true,
            description: "The flow.digest id the operator reviewed — 12 hex of sha256.",
          },
          "dry-run": {
            kind: "boolean",
            required: false,
            description: "Evaluate preflight only — nothing leaves the machine.",
          },
        },
        execute: runFlowPush,
      },
      {
        name: "flow.publication.retire",
        description:
          "Retire a pending publication tag (RFC-1503) — operator-only. " +
          "Appends one publish-retired journal event so flow.push never " +
          "attempts the tag again: the escape for a pushed tag that can " +
          "never publish (broken extract config the destination must not " +
          "see, a version that must not ship). Refuses FLOW-RETIRE-01 " +
          "when the tag is not pending and FLOW-RETIRE-02 on an empty " +
          "--reason.",
        scope: "workspace",
        contract: "flow",
        rules: [
          { id: "FLOW-RETIRE-01", severity: "error" },
          { id: "FLOW-RETIRE-02", severity: "error" },
          { id: "FLOW-07", severity: "error" },
        ],
        mutatesState: true,
        idempotency: "not-idempotent",
        execOnReadOnly: false,
        mutatingFlags: [],
        writes: [".git/**"],
        generates: [],
        coverage: "operator",
        coverageNote: "outbound journal mutation — operator command only (RFC-1503)",
        reads: [
          "forge.yaml",
          ".git/**",
          "docs/rfcs/*.md",
          "pnpm-workspace.yaml",
          "package.json",
          "packages/*/package.json",
          ".github/workflows/**",
        ],
        cacheable: false,
        flags: {
          tag: {
            kind: "string",
            required: true,
            description: "The pending publication tag to retire (e.g. lib@1.2.3).",
          },
          reason: {
            kind: "string",
            required: true,
            description: "Why the tag can never publish — journaled verbatim.",
          },
        },
        execute: runFlowPublicationRetire,
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
      {
        name: "flow.peers",
        description:
          "Read-only live resource map (RFC-1543): integrate.lock holder, " +
          "live op-claims grouped by checkout, open missions per worktree " +
          "and registered in-flight branches — the forge/peers@1 report a " +
          "second session reads before waiting on a held primary.",
        scope: "workspace",
        contract: "flow",
        rules: [],
        mutatesState: false,
        execOnReadOnly: true,
        writes: [],
        coverage: "operator",
        coverageNote: "shared-checkout visibility — RFC-1543",
        reads: [".git/**"],
        cacheable: false,
        flags: {},
        execute: runFlowPeers,
      },
    ],
    pipelines: [],
  };
}
