# Property-Based Testing Guide

Reference for writing property-based tests (PBT) using `fast-check` + `vitest` per RFC-XXXX (DNA-41).

## Decision tree

Every function MUST be classified per this tree. The decision is made **per-function**, not per-file.

```
Is the function pure (no I/O, no side effects, no mutation of inputs)?
├── No → Use example-based tests or integration tests. Do NOT use PBT.
└── Yes → Does the function have at least one verifiable algebraic property?
    ├── No → Use example-based tests. Do NOT use PBT.
    └── Yes → Is the input domain large enough that examples are insufficient?
        ├── No (small enum, <10 values) → Use example-based tests with exhaustive coverage. Do NOT use PBT.
        └── Yes → Write a property-based test in a *.pbt.test.ts file using fast-check.
            ├── Check if a *.pbt.test.ts already exists for this function.
            │   ├── Yes → Add the new property to the existing file.
            │   └── No → Create a new *.pbt.test.ts file alongside the existing tests.
            └── Choose the property pattern from the catalog below.
```

## When PBT is required

ALL of the following must be true:

1. **Pure function** — output determined solely by input. No I/O, no `Date.now()`, no `Math.random()`, no side effects, no mutation of input arguments.
2. **Verifiable property** — at least one algebraic property holds and is non-trivial.
3. **Non-trivial input space** — large enough that hand-picked examples are unlikely to cover all edge cases. Functions with a small enum input (<10 values) do not need PBT.

## When PBT is NOT required

ANY of the following:

1. **Impure function** — I/O, `Date.now()`, `Math.random()`, external state mutation.
2. **UI / Astro component** — verified by visual inspection, Playwright, or snapshot tests.
3. **Build pipeline / OS command** — reads files, runs processes, orchestrates pipelines. Integration-tested.
4. **Content validation rules** — deterministic rule checks (e.g. "does this YAML key exist?").
5. **Small input domain** — closed enum with <10 values. Exhaustive example-based coverage is sufficient.
6. **Thin delegation** — one-line pass-through to another function that is already property-tested.
7. **No verifiable property** — behavior cannot be expressed as a universal quantifier over input.

## Property patterns catalog

Each pattern shows the fast-check idiom. Use the pattern names exactly — do not invent custom property names.

### Idempotency

`f(f(x)) == f(x)` for all valid `x`.

```ts
import { test, expect } from "vitest";
import fc from "fast-check";
import { normalizeText } from "../text-normalize.ts";

test("normalizeText is idempotent", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 500 }), (input) => {
      const once = normalizeText(input, ALL_ON);
      expect(normalizeText(once, ALL_ON)).toBe(once);
    }),
  );
});
```

### Round-trip

`g(f(x)) == x` for all valid `x`.

```ts
import { test, expect } from "vitest";
import fc from "fast-check";
import { parseSemver, formatSemver } from "../semver.ts";

test("parseSemver and formatSemver are round-trip", () => {
  fc.assert(
    fc.property(
      fc.record({
        major: fc.nat({ max: 999 }),
        minor: fc.nat({ max: 999 }),
        patch: fc.nat({ max: 999 }),
      }),
      ({ major, minor, patch }) => {
        const formatted = formatSemver({ major, minor, patch });
        const reparsed = parseSemver(formatted);
        expect(reparsed).toEqual({ major, minor, patch });
      },
    ),
  );
});
```

### Immutability

`f(x)` does not mutate `x`; `x` is deep-equal before and after.

```ts
import { test, expect } from "vitest";
import fc from "fast-check";
import { substituteRefsDeep } from "../substitute-deep.ts";

test("substituteRefsDeep does not mutate input", async () => {
  fc.assert(
    fc.asyncProperty(
      fc.object({ maxLength: 5, maxDepth: 3 }),
      fc.func(fc.string()),
      async (input, resolve) => {
        const snapshot = JSON.parse(JSON.stringify(input));
        await substituteRefsDeep(input, resolve);
        expect(input).toEqual(snapshot);
      },
    ),
  );
});
```

### Transitivity

`a < b and b < c implies a < c`.

```ts
test("compareSemver is transitive: a < b and b < c implies a < c", () => {
  fc.assert(
    fc.property(
      semverStringArbitrary,
      semverStringArbitrary,
      semverStringArbitrary,
      (a, b, c) => {
        if (compareSemver(a, b) < 0 && compareSemver(b, c) < 0) {
          expect(compareSemver(a, c)).toBeLessThan(0);
        }
      },
    ),
  );
});
```

### Antisymmetry

`f(a, b) == -f(b, a)`.

```ts
test("compareSemver is antisymmetric: compare(a, b) == -compare(b, a)", () => {
  fc.assert(
    fc.property(semverStringArbitrary, semverStringArbitrary, (a, b) => {
      expect(compareSemver(a, b)).toBe(-compareSemver(b, a));
    }),
  );
});
```

### Other patterns

- **Commutativity:** `f(a, b) == f(b, a)` for all valid `a`, `b`.
- **Associativity:** `f(f(a, b), c) == f(a, f(b, c))` for all valid `a`, `b`, `c`.
- **Monotonicity:** `a <= b => f(a) <= f(b)` for all valid `a`, `b`.
- **Reflexivity:** `f(x, x) == 0` (or identity element).
- **Distributivity:** `f(a, g(b, c)) == g(f(a, b), f(a, c))` for all valid inputs.
- **Invariance:** `p(f(x)) == p(x)` for some invariant `p` and all valid `x`.

## Agent rules (MUST / MUST NOT)

- **MUST** use `vitest` as the test runner for all packages with real test scripts.
- **MUST** add `fast-check` as a dev dependency before writing PBT in a package.
- **MUST** place PBT in `*.pbt.test.ts` files (not in regular `*.test.ts` files).
- **MUST** use `fc.assert(fc.property(...))` or `fc.assert(fc.asyncProperty(...))` as the PBT idiom.
- **MUST** set a `numRuns` value when the default 100 is insufficient: `fc.assert(fc.property(...), { numRuns: 1000 })`.
- **MUST NOT** use PBT for impure functions, I/O-bound code, UI components, or build pipelines.
- **MUST NOT** replace existing example-based tests with PBT. PBT complements example-based tests.
- **MUST NOT** use `fast-check` in production code or runtime dependencies. It is dev-only.
- **MUST NOT** invent custom property names. Use the names from the catalog above.
- **MUST** write a comment above each property stating which algebraic property it verifies and why it holds.
- **MUST** ensure PBT tests are deterministic. If the property involves randomness, the random source must be the fast-check generator, not `Math.random()` or `Date.now()`.
- **MAY** use `fc.pre()` to constrain generated inputs to the function's valid domain.
- **MAY** create custom arbitraries with `fc.record()`, `fc.array()`, `fc.tuple()`, etc.

## Functions that qualify for PBT (non-exhaustive)

| Function | Package | Property | Pattern |
| --- | --- | --- | --- |
| `normalizeText` | `@gogol/share` | `normalize(normalize(x)) == normalize(x)` | Idempotency |
| `normalizeHtml` | `@gogol/share` | `normalize(normalize(x)) == normalize(x)` | Idempotency |
| `normalizeMarkdown` | `@gogol/share` | `normalize(normalize(x)) == normalize(x)` | Idempotency |
| `normalizeJson` | `@gogol/share` | `normalize(normalize(x)) == normalize(x)` | Idempotency |
| `compareSemver` | `@gogol/site-kernel-handoff` | `a < b and b < c implies a < c` | Transitivity |
| `compareSemver` | `@gogol/site-kernel-handoff` | `compare(a, b) == -compare(b, a)` | Antisymmetry |
| `parseSemver` / `formatSemver` | `@gogol/site-kernel-handoff` | `parse(format(parsed)) == parsed` | Round-trip |
| `substituteRefsDeep` | `@gogol/share` | Input is not mutated after call | Immutability |
| `markdownTwinRelPath` | `@gogol/share` | `twinUrlPath(twinRelPath(x))` is consistent for valid paths | Round-trip |
| `deepMergeEntryData` | `@gogol/share` | Merge is associative for nested objects (not arrays) | Associativity |
| `citySlug` | `@gogol/geo` | Output only contains lowercase alphanumeric and hyphens | Invariance |
| `redactUrl` | `@gogol/observability` | Output never contains a query string | Invariance |
| `validateAgainstCapabilitySchema` | `@gogol/agent-gate` | Non-object input always fails validation | Invariance |
