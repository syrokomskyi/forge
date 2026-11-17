# Correctness gate reference

`correctness.gate` (RFC-1580) closes the self-verifying contour: `flow.integrate` consumes the product correctness manifest (RFC-1578), runs its oracles, and refuses an integration whose evidence does not hold — with the oracles frozen before the implementing session could touch them.

```sh
pnpm exec forge correctness.gate --base <sha> [--json]
pnpm exec forge correctness.gate --base <sha> --policy-only   # CI: policy surface only
pnpm exec forge flow.integrate                         # spawns the primary install's correctness.gate
pnpm exec forge flow.integrate --accept-weakening "<reason>"   # operator decision only
pnpm exec forge rfc.verify.workspace --manifest --candidate <sha>
```

`flow.integrate` spawns `"$FLOW_PRIMARY/node_modules/.bin/forge" correctness.gate --base "$FLOW_BASE_SHA" --json` with cwd = the session worktree, after `hooks/integration-gate.sh` passes and before the fast-forward. The code under review never judges its own gate. A missing primary binary, a spawn failure, unparseable output, or a failing gate refuses with `FLOW-INT-18`. Bootstrap only: a primary install that answers exactly `Unknown command: correctness.gate` (its forge predates RFC-1580) degrades to a `FLOW-INT-18` warning while forge.yaml at the base has not adopted the contour; after adoption the same answer refuses, so a forge downgrade cannot drop the gate.

## Frozen set (read at `--base`)

- the manifest at the base value of `bindings.paths.correctnessManifest` (repointing the binding is a weakening);
- `bindings.commands.checkRun`, `bindings.paths.correctnessManifest`, `bindings.paths.oracleReviewsDir`;
- `forge.yaml` `correctness.*` — `mode` (leaving `enforce`, or switching to `exempt`), `tier` (lowering), `audit.allow[]` (adding);
- every oracle check file of a base entry, every capture and its `.capture.yaml` sidecar, every file the base `support` globs match — a `!`-prefixed `support` glob is a picomatch negation that would silently freeze the _complement_; the manifest refuses as `CORR-GATE-01` (same rule as `policy.freezeFiles` negations);
- the git mode of every frozen file — a blob-equal `100755`→`100644` flip (`git update-index --chmod`, `chmod` + commit) is a weakening, not invisible bookkeeping;
- the statements of the `@ai-invariant[…]` anchors base entries bind (RFC-1390 normalized-statement hash);
- **the declared policy surface (RFC-1615)** — when forge.yaml at `--base` carries a `policy:` section, the gate additionally freezes: every file matching `policy.freezeFiles` globs, every top-level forge.yaml key not listed in `policy.mutable`, and the `policy:` section itself.

## Declared policy surface (`policy:`, RFC-1615)

The `policy:` section declares which parts of forge.yaml and which repo files a session may change — everything else is judged against its state at `--base`:

```yaml
policy:
  mutable: [project, forge, moves]      # top-level keys a session may change freely
  additive: [bindings, paths, loopMetrics]  # may gain new leaves; existing leaves are frozen
  freezeFiles:                           # repo-root globs — byte-frozen at --base
    - "hooks/**"
    - ".github/workflows/**"
    - ".forge/pinned.yaml"
```

- `mutable` — any change to the listed top-level keys is permitted.
- `additive` — new leaves under the listed keys are permitted; changing or removing an existing leaf is a `policy-key` weakening. The RFC-1580 frozen bindings (`checkRun`, `correctnessManifest`, `oracleReviewsDir`) keep their dedicated rules even when `bindings` is listed — frozen wins over `additive`, and the dedicated `binding`/`correctness-key` checks also win over a hand-tuned `mutable` declaration (they judge the contour's own substrate, not a permission policy). Under `--policy-only` a `mutable: [bindings]` declaration does release the binding check — the dedicated rules belong to the full gate contour.
- Everything not listed is frozen: `agentTools.deny`, `guardRules`, `correctness.*`, `instructions.budget`, and every key not yet invented. A new top-level key outside `mutable`/`additive` is a `policy-key` weakening.
- `policy:` is **self-frozen** — amending it in-session is a `policy-decl` weakening; a session cannot expand its own permissions.
- `freezeFiles` matches are byte-frozen like oracle files: change, delete, or a _new_ file matching the glob is a `policy-file` weakening unless the last commit touching it carries the verifier trailer pair. A `!`-prefixed glob is a picomatch negation — it would freeze the complement, so the declaration is malformed. A glob matching `forge.yaml` itself (`forge.yaml`, `*.yaml`, `x/../forge.yaml`) never byte-freezes it — its surface is judged by the policy key diff and the isolation strip, or `mutable` would be voided and the accept path bypassed.
- No `policy:` at `--base` → the policy checks are inert (adoption is opt-in). A malformed declaration parses to empty lists — deny-by-default, never fail-open; a `policy:` that is present but not a `{mutable?, additive?, freezeFiles?}` string-list map (including the bare `policy:` null form and non-string members) refuses as `CORR-GATE-01`.
- `forge init` scaffolds the block; `forge upgrade` adds it when absent **and heals a declared-but-malformed one** — a well-formed, operator-tuned `policy:` is never rewritten.
- The policy diff judges forge.yaml **at the HEAD commit**, never the worktree — an uncommitted edit neither masks a committed weakening nor fabricates one. A forge.yaml that exists but does not parse to a YAML map (scalar/array/unreadable, at `--base` or HEAD) is `CORR-GATE-01`, never a "no policy declared" pass — and "a YAML map" means a _plain_ map: `!!set`/`!!omap`/`!!timestamp`/`!!binary` roots parse to Set/Map/Date/Buffer objects that carry no readable keys, so they refuse too (the same plain-map rule applies to the `policy:` value itself).

`--policy-only` runs just the policy judgements (`policy-key`/`policy-decl`/`policy-file`) — the cheap mode CI runs on every forge.yaml or frozen-file diff without loading the manifest or running oracles. Weakening kinds land in the same `CORR-GATE-02` verdict and the same isolated `--accept-weakening` path (forge.yaml counts as a frozen-set path when its diff is confined to frozen correctness/policy keys).

## Pipeline

1. **Validate** the manifest at HEAD (`correctness.manifest.validate`); any error → `CORR-GATE-01`. `mode: exempt` ends the gate only when the base was exempt too **and neither side declares `policy:`** — a declared policy is a separate opt-in, so an exempt×exempt contour still judges the policy surface (`policy-key`/`policy-decl`/`policy-file` weakenings, no oracle runs). Every verdict input — both contour legs, the `mode`/`tier` that shape severities and tier requirements, the manifest-validation violations, `oracleTimeoutMs` — is read **from commits** (`frozen.base` × the HEAD commit's `forge.yaml`), never the worktree: an uncommitted `mode:`/`tier:`/timeout flip can neither mask a committed weakening nor fabricate a failure, and a HEAD-adopted malformed `policy:` refuses `CORR-GATE-01` on every contour. The bundle's `mode`/`tier` fields record this committed flavor.
2. **Weakening diff** (`CORR-GATE-02`, refuses in `warn` mode too): a base entry deleted or its `ref`/`seam`/`anchors` changed; an oracle removed, rebound, or its substrate lowered; an `unverifiable` exemption added, or a `deferred` one for a `ref` that existed at base; an allow entry added; a frozen binding or mode/tier weakened; **any byte change** of a frozen oracle, capture, sidecar, or support file unless the last commit touching it carries the verifier trailer pair; a frozen anchor removed (every base carrier touched and no verbatim copy left anywhere — a partial drop from a multi-carrier id is not a removal) or reworded (a changed copy whose statement sha is none of the shas the id carried at base — divergent base copies are each frozen by their own sha) — every weakening input judges **commits**, including anchor statements and git modes (a committed reword masked by an uncommitted revert still reports; an uncommitted reword on a clean diff never fabricates). A HEAD `forge.yaml` that parses to a YAML map but fails the forge config schema reports `CORR-GATE-01` exactly as an unreadable one does, and adopting `policy:` in an accepted-weakening session never counts as a foreign path.
   - **Git-read failures fail closed**: a failed `ls-tree`/`diff`/`grep`/`status` (corrupt object, spawn failure, timeout) is never an empty result — every failed listing read is recorded and refused as `CORR-GATE-01`, because mapping it to `[]` would silently empty the frozen set or launder foreign files through `--accept-weakening`. Content reads keep the same split: `git show rev:path` distinguishes **absent** (the tree entry does not resolve — a legitimate miss) from **unreadable** (the entry resolves but the blob cannot be shown — a corrupt object, flagged), so a corrupt committed `forge.yaml`/manifest/support blob fails closed instead of reading as "file gone" and inerting the surface it carries. Verdict exit codes are not failures: `git grep` exit 1 is a legitimate zero-match listing and `merge-base --is-ancestor` exit 1 is the not-an-ancestor verdict — only other codes flag. The changed-paths diff runs `--no-renames` so a `git mv`d anchor carrier keeps its old path visible to `anchor-removed`, and path listings validate UTF-8 **at byte level** — a genuinely invalid byte sequence can never round-trip through `:(literal)` argv pathspecs and flags, while a legal U+FFFD codepoint in a filename decodes fine and does not. History reads keep the split too: a failed `git log` is not "path never touched" — the flag carries the refusal, exemption callers treat it as verifier (no fabricated `frozen-file` claim) while the origin derivation promotes only on a proven `yes`, and `resolveImplementationRange` reports its own `git log`/`rev-parse` failures instead of degrading to `self` silently. `repo.blob()` is a blob-only read — a directory or gitlink at the path is not a file (a dir→file flip is an addition, never a fabricated byte edit), and an anchor-source file that cannot be shown suppresses `anchor-removed` rather than claiming a removal the unreadable copy might disprove. The same discipline covers the remaining read surfaces: an incomplete base `ls-tree` makes glob additions re-check membership per path instead of fabricating "new file" claims, and a failed `git ls-files` workspace listing (whose fs fallback would include ignored files) refuses like any other unreadable read. Frozen declarations are judged in both directions — adding `bindings.commands.checkRun`, `paths.oracleReviewsDir`, or `paths.rfcsDir` under a declared contour is a binding weakening, and any `bindings.paths.compassDocs` change redirects requirement resolution and is judged the same way. The RFC namespace is the top-level `paths.rfcsDir` key (the loader strips `bindings.paths.rfcsDir` — judging it would be a dead check), and CORR-03 resolves every governing reference — RFC acceptance criteria, requirements, DNA ids — at the integration base through git, so a session cannot mint its own provenance by planting or editing files at HEAD. A `requirement` oracle origin demands governed provenance on the acceptance-transition commit (`X-RFC: <id>` or the verifier trailer pair) — `status: accepted` text alone mints nothing. A malformed `policy:` resolves its glob surface to nothing, so a `!`-negated `freezeFiles` can neither fabricate policy-file claims nor whitelist foreign paths in the accept check. Failures recorded after the early emit — oracle origin derivation, review-record listings, `commonDir` — are re-judged at bundle write: the violation is surfaced, the status flips to fail (an exempt×exempt contour cannot end clean on a corrupt base), and the bundle carries `unreadableReads` as evidence. Judgement degrades, not disappears: the name-only diff skips identical subtrees, so glob-frozen edits, mode flips (path-scoped `ls-tree`), additions, and anchor changes on touched paths are still reported even when full-tree enumeration fails; `--accept-weakening` on an unproven diff refuses as `mixed-weakening`.
   - **Governing references resolve at the base but are not frozen files** (RFC-1615 review O-5/O-6): `rfc-ac`/`fixed-input` refs, `compassDocs` documents, and the DNA invariants file judge their base-committed content, so a session cannot mint `requirement` provenance by planting or rewriting them at HEAD. Deleting a governing doc at HEAD passes the weakening diff by declared design — the base copy still resolves, and a corrupt base copy blinds that anchor grep but refuses through the read ledger. The judged binding keys — `paths.rfcsDir`, `bindings.paths.compassDocs`, `bindings.paths.invariantsFile`, alongside the RFC-1580 set — are also inside the accept-isolation strip, so an isolated binding rebind can be operator-accepted exactly like a `checkRun`/`correctnessManifest`/`oracleReviewsDir` rebind (O-7); containers left empty by the strip are pruned, so adding or removing a whole `paths:`/`bindings:` parent around only frozen subkeys still compares isolated (CX-112). The base-side RFC resolver mirrors `findRfcFile` scope exactly — files directly under `paths.rfcsDir` or inside its `archive/` subtree, `.` meaning the repo root, a root-level file preferred over an `archive/` duplicate (CX-113/CX-114), and a binding normalizing to the repo root (`""`/`"."`/`"./"`) substitutes `.` as the `ls-tree` pathspec so the empty pathspec cannot fatal-flag the ledger while blinding ref resolution (CX-115). Archive ordering mirrors `findRfcFile` traversal exactly — files before dirs at each level, files lexical, sibling dirs reverse-lexical (CX-116) — and path bindings compare resolution-equivalent spellings via `path.posix.normalize` — `./`-respells, `//`, `..`, and trailing slashes name the same target (CX-118) while backslashes and whitespace stay literal POSIX filename content that resolves a different file and must still report the rebind (CX-120/CX-122); `checkRun` is a whitespace-tokenized command template, not a path — it compares argv-collapsed only; POSIX normalization must never see it (`./x` vs `x` spawn different executables: PATH vs the session worktree). The oracle runner itself must resolve via PATH — an `argv[0]` carrying a path separator is refused as a spawn failure before launch (CX-126), so a repo-committed binary can never run as the oracle. Canonicalization and leaf maps mark reference cycles with a private sentinel no YAML value can equal — a literal `"<cycle>"`/`"cycle"` string can never collide with a true alias cycle (CX-128). `execFile`/`spawn` failures from attacker-controlled bytes (e.g. NUL in a binding) degrade to unreadable-read refusals, never an unhandled gate crash (CX-129). History queries carry `:(literal)` pathspecs so glob-metachar filenames cannot borrow a sibling's acceptance range (CX-117), and only plain objects prune in the isolation strip — tagged `!!set`/`!!omap`/`!!timestamp` containers stay foreign (CX-119).
3. **Origin** of each oracle, from git only: `verified` (verifier trailer pair on the last commit touching the check file, or a committed `forge/oracle-review@1` record naming the check with its current sha256 and `verdict: pass`), `requirement` (`rfc-ac`/`fixed-input` entry whose check file is byte-identical to its state at the governing RFC's `accepted` commit), `self` otherwise. A `self` oracle never covers (`CORR-GATE-03`).
4. **Tier** — `high`: only verifier-trailer oracles cover; `formal`: each entry also needs a `proof:` oracle whose `proof.check` verdict is `proved` (`CORR-GATE-06`).
5. **Run** each non-self oracle through the frozen `checkRun` (argv form, `{file}` is one argument), with `FORGE_CORRECTNESS_DIR=<fresh run dir>/<entry>/o<N>` and a per-oracle timeout (`correctness.oracleTimeoutMs`, default 300000; a non-finite value such as `.inf`, one above `2^31 − 1`, or a sub-millisecond value falls back to the default — `Infinity` and int32 overflow fire the timer at ~1 ms). Non-zero exit, spawn failure, or timeout → `CORR-GATE-07`.
6. **Substrate attestation** — an L1/L2 oracle covers only when its run left an attestation whose level matches and whose normalized schema hash equals the hash of the repository's D1 migrations; otherwise `CORR-GATE-04` and it counts as L0. A declared L3 needs every declared capture loaded through `loadCapture` (provider seams) or a matching attestation (data/lifecycle seams, where it counts at the attested level).
7. **Anchor events** — a lifecycle entry's L2 run must leave, for each anchor, a `forge.anchor` event verified against the attested handle; a failed, missing, or foreign-handle event → `CORR-GATE-05`.
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
