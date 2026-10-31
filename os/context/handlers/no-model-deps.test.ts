/*
<MODULE_CONTRACT>
<purpose>RFC-1470 AC-7: the assemble path completes with zero model calls — the handlers must not import any model/embedding provider.</purpose>
</MODULE_CONTRACT>
*/

import { test, expect, describe } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const HANDLERS = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

const MODEL_PROVIDER_RE = /openai|anthropic|@cf\/|workers-ai|@anthropic|embedding(-|_)?gemma|huggingface|@huggingface|inference\.js|transformers\.js|api\.(openai|anthropic|google)/i;

describe("AC-7: assemble path carries zero model-provider imports", () => {
  test("no handler imports a model/embedding provider", () => {
    const offenders: string[] = [];
    for (const f of HANDLERS) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/(?:import|from|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        if (MODEL_PROVIDER_RE.test(m[1]!)) offenders.push(`${f} → ${m[1]}`);
      }
      // No fetch/http calls to model endpoints.
      if (/fetch\(\s*['"]https:\/\/(api\.openai|api\.anthropic|generativelanguage|api-inference)/.test(src)) {
        offenders.push(`${f} → model endpoint fetch`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
