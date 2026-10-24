/*
<MODULE_CONTRACT>
<purpose>@warpgogol/forge/compass subpath — the pure Compass parsers shared
across packages (RFC-1392: the tagged-invariant parser consumed by
werkstatt-site's TEST-WEAKEN-10).</purpose>
<non-goals>
  <item>Do not re-export os/ surfaces — the subpath exposes src/ contracts only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1392: initial barrel for the compass src surface.</item>
  <item>RFC-1392: extend test-weakening gate to generators, invariants, proof specs (RFC-1392)

TEST-WEAKEN-08..11 extend the RFC-1331 analyzer: numRuns budget reduced
or removed, property input domain narrowed (fc.pre / chained .filter /
numeric bound), bound @ai-invariant removed-reworded-unbound via the new
@warpgogol/forge/compass parser export, and *.proof.yaml field weakening
(fail-closed on unreadable or entry-less deletion). Blob collection now
covers implementation files and proof specs. Warn-only until the census
is operator-accepted — TEST_WEAKEN_ENFORCED keeps {01..06}; EC-22 records
advisory rules in the Test-Weakened trailer.</item>
  <item>RFC-1392: close RFC-1392 review r1 — per-call-site generator and budget pairing</item>
</CHANGE_SUMMARY>
*/

export {
  extractInvariants,
  invariantStatementSha,
  normalizeInvariantStatement,
  baselineKey,
  INVARIANT_ID_RE,
  VACUOUS_INVARIANT_PATTERNS,
  BINDING_KINDS,
  type InvariantBindingKind,
  type ParsedInvariant,
  type RawBinding,
} from "./invariant-parser.ts";
