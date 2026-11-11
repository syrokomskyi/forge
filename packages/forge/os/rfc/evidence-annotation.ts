/*
<MODULE_CONTRACT>
<purpose>RFC-1569 — the single evidence-annotation grammar shared by
  rfc.implement.stamp (resolution) and rfc.validate V-53 (shape lint). Pure —
  no IO; the stamp decides resolution, V-53 only asks "is this a form the
  stamp can resolve".</purpose>
<non-goals>
  <item>No file existence or probe-envelope checks — resolution stays the
    stamp's job (RFC-1322).</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1569: step 1 — extract the annotation grammar into a pure parser</item>
  <item>RFC-1569: lint rfc evidence annotations and transient probe targets</item>
</CHANGE_SUMMARY>
*/

export type EvidenceAnnotation =
  | { kind: "probe"; criterion: string }
  | { kind: "test" | "file"; path: string; lines?: string }
  | { kind: "path-line"; path: string; lines: string }
  | { kind: "invalid"; raw: string; reason: string };

const PROBE_RE = /^probe:\s*([A-Za-z][\w.:-]*)$/;
const TEST_FILE_RE = /^(test|file):\s*(\S+?)(?::(\d+(?:-\d+)?))?$/;
const PATH_LINE_RE = /^([^\s:]+):(\d+(?:-\d+)?)$/;

export const EVIDENCE_FORMS = "probe:AC-N | test:<path> | file:<path> | <path>:<line>";

/**
 * Parse the `(evidence: …)` payload. Whitespace after the prefix colon is
 * tolerated; paths carry no whitespace. The probe arm accepts the full
 * criterion-id alphabet (`AC-N`, `design:<heading>`) — whether the named
 * criterion exists and binds a passing probe is the caller's arbitration,
 * not the regex's.
 */
export function parseEvidenceAnnotation(raw: string): EvidenceAnnotation {
  const annotation = raw.trim();
  if (annotation === "") return { kind: "invalid", raw, reason: "empty annotation" };

  const probe = PROBE_RE.exec(annotation);
  if (probe) return { kind: "probe", criterion: probe[1]! };

  const testFile = TEST_FILE_RE.exec(annotation);
  if (testFile) {
    return {
      kind: testFile[1] === "test" ? "test" : "file",
      path: testFile[2]!,
      ...(testFile[3] !== undefined ? { lines: testFile[3] } : {}),
    };
  }

  const pathLine = PATH_LINE_RE.exec(annotation);
  if (pathLine) return { kind: "path-line", path: pathLine[1]!, lines: pathLine[2]! };

  return {
    kind: "invalid",
    raw,
    reason: `not a resolvable form (expected ${EVIDENCE_FORMS})`,
  };
}
