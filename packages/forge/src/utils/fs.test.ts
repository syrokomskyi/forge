// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./fs.ts";

describe("utils/fs (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
