// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./types.ts";

describe("forge types (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
