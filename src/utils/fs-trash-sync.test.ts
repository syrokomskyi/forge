// @vitest-environment node

import { describe, expect, it } from "vitest";

import * as mod from "./fs-trash-sync.ts";

describe("utils/fs-trash-sync (load verification)", () => {
  it("module loads successfully", () => {
    expect(mod).toBeDefined();
  });
});
