# Correctness gate reference

`correctness.gate` (RFC-1580) closes the self-verifying contour: `flow.integrate` consumes the product correctness manifest (RFC-1578), runs its oracles, and refuses an integration whose evidence does not hold — with the oracles frozen before the implementing session could touch them.

```sh
pnpm exec forge correctness.gate --base <sha> [--json]
pnpm exec forge flow.integrate                         # spawns the primary install's correctness.gate
pnpm exec forge flow.integrate --accept-weakening "<reason>"   # operator decision only
pnpm exec forge rfc.verify.workspace --manifest --candidate <sha>
```

`flow.integrate` spawns `"$FLOW_PRIMARY/node_modules/.bin/forge" correctness.gate --base "$FLOW_BASE_SHA" --json` with cwd = the session worktree, after `hooks/integration-gate.sh` passes and before the fast-forward. The code under review never judges its own gate, and a session-pinned forge cannot drop it. A missing primary binary, a spawn failure, unparseable output, or a failing gate refuses with `FLOW-INT-18`. Only a primary install that answers `Unknown command: correctness.gate` (its forge predates RFC-1580 — the integration that installs the gate) degrades to a `FLOW-INT-18` warning.

## Frozen set (read at `--base`)

- the manifest at the base value of `bindings.paths.correctnessManifest` (repointing the binding is a weakening);
- `bindings.commands.checkRun`, `bindings.paths.correctnessManifest`, `bindings.paths.oracleReviewsDir`;
- `forge.yaml` `correctness.*` — `mode` (leaving `enforce`, or switching to `exempt`), `tier` (lowering), `audit.allow[]` (adding);
- every oracle check file of a base entry, every capture and its `.capture.yaml` sidecar, every file the base `support` globs match;
- the statements of the `@ai-invariant[…]` anchors base entries bind (RFC-1390 normalized-statement hash).

## Pipeline

1. **Validate** the manifest at HEAD (`correctness.manifest.validate`); any error → `CORR-GATE-01`. `mode: exempt` ends the gate only when the base was exempt too.
2. **Weakening diff** (`CORR-GATE-02`, refuses in `warn` mode too): a base entry deleted or its `ref`/`seam`/`anchors` changed; an oracle removed, rebound, or its substrate lowered; an `unverifiable` exemption added, or a `deferred` one for a `ref` that existed at base; an allow entry added; a frozen binding or mode/tier weakened; **any byte change** of a frozen oracle, capture, sidecar, or support file unless the last commit touching it carries the verifier trailer pair; a frozen anchor removed or reworded.
3. **Origin** of each oracle, from git only: `verified` (verifier trailer pair on the last commit touching the check file, or a committed `forge/oracle-review@1` record naming the check with its current sha256 and `verdict: pass`), `requirement` (`rfc-ac`/`fixed-input` entry whose check file is byte-identical to its state at the governing RFC's `accepted` commit), `self` otherwise. A `self` oracle never covers (`CORR-GATE-03`).
4. **Tier** — `high`: only verifier-trailer oracles cover; `formal`: each entry also needs a `proof:` oracle whose `proof.check` verdict is `proved` (`CORR-GATE-06`).
5. **Run** each non-self oracle through the frozen `checkRun` (argv form, `{file}` is one argument), with `FORGE_CORRECTNESS_DIR=<fresh run dir>/<entry>/o<N>` and a per-oracle timeout (`correctness.oracleTimeoutMs`, default 300000). Non-zero exit, spawn failure, or timeout → `CORR-GATE-07`.
6. **Substrate attestation** — an L1/L2 oracle covers only when its run left an attestation whose level matches and whose normalized schema hash equals the hash of the repository's D1 migrations; otherwise `CORR-GATE-04` and it counts as L0.
7. **Anchor events** — a lifecycle entry's L2 run must leave, for each anchor, a verified `forge.anchor` event; a failed or missing event → `CORR-GATE-05`.
8. **Coverage** — each entry needs ≥ 1 oracle that is non-self, passing, attested at or above the seam minimum, and (lifecycle) anchor-verified; else `CORR-GATE-08`.
9. **Bundle** `forge/correctness-bundle@1` at `<git-common-dir>/forge/gate-reports/<runId>.correctness.json`.
10. **Verdict** — `enforce`: any error refuses; `warn`: `CORR-GATE-03..08` become warnings; `CORR-GATE-02` refuses in both modes.

| Rule | Severity | Condition |
| --- | --- | --- |
| `CORR-GATE-01` | error | manifest invalid at HEAD (warning when no manifest is bound) |
| `CORR-GATE-02` | error (both modes) | weakening against the frozen set without an accepted, isolated weakening session (`mixed-weakening` when the session diff leaves the frozen set) |
| `CORR-GATE-03` | error in `enforce` | an entry's only oracles are `self` |
| `CORR-GATE-04` | error in `enforce` | declared L1/L2 without a matching attestation; declared captures not loaded through `loadCapture` |
| `CORR-GATE-05` | error in `enforce` | a lifecycle anchor without a verified anchor event |
| `CORR-GATE-06` | error in `enforce` | tier high/formal origin or proof requirement unmet |
| `CORR-GATE-07` | error in `enforce` | an oracle run exits non-zero, cannot start, or times out |
| `CORR-GATE-08` | error in `enforce` | an entry left without a covering oracle |

## Test-side helpers (`@warpgogol/forge/correctness`)

Imported only from test code — production code emits plain JSON log lines.

```ts
import { attestSubstrate, verifyAnchorEvents, loadCapture } from "@warpgogol/forge/correctness";

// L1 harness shape (dialogue-steward dispatch.schema.test.ts): real migrations on node:sqlite.
const db = new DatabaseSync(":memory:");
for (const m of migrations) db.exec(readFileSync(m, "utf8"));
attestSubstrate(db, { level: "L1", engine: "node:sqlite" });

// L2 harness shape (send-lifecycle.test.ts): spawned workerd / wrangler dev, request through the
// real handler chain, then verify the production log lines against the same database handle.
attestSubstrate(d1, { level: "L2", engine: "miniflare-d1" });
verifyAnchorEvents(capturedLogLines, d1);
```

Normalization: `SELECT type, name, sql FROM sqlite_schema`, engine tables dropped (`sqlite_%`, `_cf_%`, `d1_migrations`), whitespace collapsed, trailing semicolons stripped, sorted by type and name, sha256. Without `FORGE_CORRECTNESS_DIR` (ordinary `pnpm test`) the helpers write nothing.

Production anchor event (no forge import):

```json
{ "forge.anchor": "INV-candidate-02", "ref": { "table": "candidates", "key": { "id": "c_123" }, "column": "state", "value": "queued" } }
```

Table, column, and key names must exist in the attested schema; values are bound as parameters.

## Oracle review records

```yaml
# <bindings.paths.oracleReviewsDir>/<yyyy-mm-dd>-<slug>.yaml   (default dir: docs/correctness/reviews)
schema: forge/oracle-review@1
reviewedAt: 2026-11-20T10:00:00Z
isolation: subagent
candidate: <sha the export was built from>
export: "rfc.verify.workspace --manifest"
verdict: pass
oracles:
  - check: test:apps/api/src/dispatch.schema.test.ts
    sha256: "<from MANIFEST-REVIEW-BUNDLE.md>"
    verdict: pass
    attestedHandleIsUnderTest: true
    notes: "asserts against the node:sqlite handle built from migrations/"
```

Produced by `fo-review` in oracle review mode (clean-context subagent) on the `rfc.verify.workspace --manifest` export, committed in its own commit with `X-Expectation-Origin: independent-verifier` and `X-Verifier-Report: <record path>`.

## Accepting a weakening

A weakening lands only through a session whose diff touches frozen-set paths only, integrated with `flow.integrate --accept-weakening "<reason>"` — an operator decision. The integration gains an empty commit carrying `X-Correctness-Weakening: <reason>`; `flow.digest` lists every such trailer and every verifier-trailer commit in the unpushed range (`correctnessTrail`), so both are visible at the `flow.push` hard stop.

## Limitations (stated in every bundle)

- git trailers are agent-writable; the verifier trailer raises the cost of mislabeling, it does not prove authorship;
- a schema-hash attestation proves a real schema existed in the run, not that every assertion used it;
- imports of oracle files outside the declared support globs are not frozen.
