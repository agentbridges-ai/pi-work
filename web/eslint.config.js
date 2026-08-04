import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFiles = ["**/*.{js,mjs,cjs,ts,tsx}"];
const typescriptFiles = ["**/*.{ts,tsx}"];
const browserFiles = ["src/**/*.{ts,tsx}"];
const serverFiles = [
  "bin/**/*.ts",
  "scripts/**/*.{js,mjs,ts}",
  "server/**/*.{ts,mjs}",
  "*.config.{js,mjs,ts}",
];
const sharedFiles = ["shared/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: [
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "public/onlyoffice-plugin/plugins.js",
      "src/user-workspace-core/pkg/**",
      "wasm/user-workspace-core/target/**",
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    ...eslint.configs.recommended,
    files: sourceFiles,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    rules: {
      // The dedicated dead-code TypeScript project owns unused-symbol checks.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-unused-vars": "off",
      // These legacy patterns are reviewed separately; enabling them here would
      // turn the initial gate into a broad behavior-changing rewrite.
      "no-control-regex": "off",
      "no-empty": "off",
      "no-useless-catch": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
    },
  },
  {
    files: ["server/**/*.{ts,tsx}", "src/**/*.{ts,tsx}", "shared/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
    },
  },
  {
    files: browserFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../server/**", "../../server/**", "../../../server/**"],
              message:
                "Browser code must use the API boundary and cannot import server runtime modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: serverFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../src/**", "../src/**/*"],
              message:
                "Server code must depend on web/shared, never on frontend implementation modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["server/**/*.{ts,mjs}"],
    ignores: [
      "server/**/*.test.ts",
      "server/**/*.test.tsx",
      "server/**/*.spec.ts",
      "server/**/*.spec.tsx",
      "server/service.ts",
      "server/logger.ts",
    ],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Integration tests may exercise the browser adapter directly; production
    // server modules remain isolated from frontend implementation modules.
    files: [
      "server/**/*.test.ts",
      "server/**/*.test.tsx",
      "server/**/*.spec.ts",
      "server/**/*.spec.tsx",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  {
    files: sharedFiles,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../server/**", "../server/**/*"],
              message: "Shared contracts cannot import server runtime modules.",
            },
            {
              group: ["../src/**", "../src/**/*"],
              message: "Shared contracts cannot import frontend implementation modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["server/local-runtime-registry.ts"],
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: browserFiles,
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
        ...globals.worker,
      },
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
  {
    files: serverFiles,
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.node,
        ...(globals.bun ?? {}),
      },
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              allowTypeImports: true,
              group: [
                "../server/**",
                "../../server/**",
                "../../../server/**",
                "../user-space-index.*",
                "../../user-space-index.*",
                "../user-space-persistence.*",
                "../../user-space-persistence.*",
              ],
              message:
                "View components must use the authenticated API or User Space controller boundary instead of server, index, or persistence internals.",
            },
          ],
        },
      ],
    },
  },
);
