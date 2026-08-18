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
