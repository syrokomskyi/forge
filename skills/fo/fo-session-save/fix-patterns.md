# Fix Patterns

Patterns of errors in auto-extracted metadata (by `session.save`) and their fixes (applied by `fo-session-save` skill). Each pattern helps the skill recognize and correct common extraction mistakes.

## Format

Each entry: pattern name, symptom, root cause, fix.

---

1. **False-positive RFC-id in comments**

   - **Symptom:** `relatedRfcs` contains an RFC-id that doesn't exist.
   - **Root cause:** Regex `RFC-\d{4}` matches references in code comments, URLs, or quoted text that aren't actual related RFCs.
   - **Fix:** Verify each RFC-id exists in `docs/rfcs/` before keeping it in `relatedRfcs`. Remove non-existent ones.

2. **Commit hash matching version numbers**

   - **Symptom:** `commits` array contains strings like `1.0.0` or `12345678`.
   - **Root cause:** Regex `\b[0-9a-f]{7,40}\b` matches version strings and short numeric sequences.
   - **Fix:** Filter out strings that look like version numbers (contain dots) or are pure decimal numbers. Verify remaining hashes correspond to actual git commits.

3. **File paths from error messages**

   - **Symptom:** `files` array contains paths from error messages or stack traces that weren't actually edited.
   - **Root cause:** Regex matches any path starting with `packages/`, `docs/`, etc., including paths in error output.
   - **Fix:** Cross-reference with `commits` and actual git diff to identify files that were genuinely modified during the session.

4. **Missing session type**

   - **Symptom:** Auto-detected `types` is `["freeform"]` but the session clearly involved implementation or review.
   - **Root cause:** The type detection patterns didn't match the specific phrasing used in the session.
   - **Fix:** Semantically analyze the transcript and override `types` with the correct classification.
