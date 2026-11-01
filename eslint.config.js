/*
<MODULE_CONTRACT>
<purpose>The eslintconfig flat-config for forge — tseslint recommended over src/os trees plus the local no-as-any rule.</purpose>
<non-goals>
  <item>Do not carry repo-wide rules — root and per-package configs own their own scope.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>no-as-any is a narrow local rule — `as any` assertions blocked, plain `any` annotations allowed.</item>
</KEY_DECISIONS>
<CHANGE_SUMMARY>
  <item>RFC-1485: sweep compass headers — forge-src + forge root eslint</item>
</CHANGE_SUMMARY>
*/

import tseslint from "typescript-eslint";

/** Narrow rule: blocks only `as any` (TSAsExpression → TSAnyKeyword), not every `any` annotation. */
function createNoAsAnyRule() {
  return {
    meta: {
      type: "problem",
      docs: { description: "Disallow `as any` type assertions" },
      schema: [],
      messages: {
        noAsAny:
          "Unexpected `as any`. Fix the call-site type or use `unknown`; `as any` on workspace-internal APIs silently drops properties and causes runtime bugs.",
      },
    },
    create(context) {
      return {
        TSAsExpression(node) {
          if (node.typeAnnotation && node.typeAnnotation.type === "TSAnyKeyword") {
            context.report({ node, messageId: "noAsAny" });
          }
        },
      };
    },
  };
}

export default tseslint.config(
  // typescript-eslint recommended rules for .ts files
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.ts", "os/**/*.ts"],
    ignores: ["**/*.d.ts", "**/*.template.ts", "**/*.template.mjs"],
  })),
  // .ts files — custom rules
  {
    files: ["src/**/*.ts", "os/**/*.ts"],
    ignores: ["**/*.d.ts", "**/*.template.ts", "**/*.template.mjs"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: {
      "local-rules": {
        rules: {
          "no-as-any": createNoAsAnyRule(),
        },
      },
    },
    rules: {
      "local-rules/no-as-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
