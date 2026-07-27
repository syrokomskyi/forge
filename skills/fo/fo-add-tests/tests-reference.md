# Test Reference — Good vs Bad

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

## Good: Tests observable behavior

```typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
```

## Bad: Tests implementation details

```typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = vi.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
```

This test breaks if you rename `paymentService.process`, switch to a different payment API, or inline the call — even if checkout still works perfectly. It tests _how_, not _what_.

## Bad: Tautological test

```typescript
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});
```

If `calculateTotal` has a bug (e.g. off-by-one in the reduce), the test still passes — the expected value has the same bug. Use an independent known literal:

```typescript
// GOOD: Expected value is an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
```

## Bad: Horizontal slicing

```typescript
// BAD: Tests only one layer, missing the integration
test("validateInput returns true for valid input", () => {
  expect(validateInput("valid")).toBe(true);
});

test("processData returns result for valid input", () => {
  // Mocks validateInput, so the real validation is never tested
  vi.mock("../validate").mockReturnValue(true);
  const result = processData("invalid-but-mocked-valid");
  expect(result).toBeDefined();
});
```

The first test checks validation in isolation. The second mocks it out. If `validateInput` changes its rules, the second test still passes — but the integration is broken. Prefer a vertical slice that exercises the real validation through the public API.

## Good: Integration-style test through public API

```typescript
// GOOD: Exercises the full path through the public interface
test("processData rejects invalid input through the public API", () => {
  const result = processData("invalid input here");
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/invalid/);
});
```

This test survives internal refactors — `validateInput` can be renamed, split, or inlined — as long as `processData` still rejects invalid input, the test passes.

## Test naming

Name tests as specifications, not as test cases:

- Good: `"user can checkout with valid cart"`
- Good: `"processData rejects invalid input"`
- Good: `"normalizeText is idempotent"`
- Bad: `"test1"`
- Bad: `"checkout test"`
- Bad: `"should work"`

The name is the specification. If you can't name what behavior you're testing, you don't know what you're testing.
