import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// Money is never a float: amounts are bigint stroops (see CLAUDE.md rule 4).
const AMOUNT_NAME = "/amount|stroops/i";
const AMOUNT_MESSAGE =
  "Amounts are bigint stroops, never floats. Use the helpers in apps/api/src/lib/amount.ts.";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "docs/**",
      "ecosystem.config.cjs",
      "**/.next/**",
      "**/out/**",
      "**/.source/**",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": "allow-with-description", "ts-expect-error": "allow-with-description" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name='parseFloat'], CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
          message: AMOUNT_MESSAGE,
        },
        {
          selector: `CallExpression[callee.name='Number'] > :matches(Identifier[name=${AMOUNT_NAME}], MemberExpression[property.name=${AMOUNT_NAME}])`,
          message: AMOUNT_MESSAGE,
        },
      ],
    },
  },
  prettier,
);
