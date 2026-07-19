import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const typedFiles = [
  "src/**/*.ts",
  "web/src/**/*.ts",
  "web/src/**/*.tsx",
  "test/**/*.ts",
  "scripts/**/*.ts"
];

export default tseslint.config(
  { ignores: ["node_modules", ".wrangler", "dist", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((config) => ({ ...config, files: typedFiles })),
  {
    files: typedFiles,
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./tsconfig.web.json",
          "./tsconfig.test.json",
          "./tsconfig.scripts.json"
        ],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ["scripts/**/*.ts"],
    languageOptions: {
      globals: {
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        process: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly"
      }
    }
  },
  {
    files: ["web/src/**/*.ts", "web/src/**/*.tsx"],
    ...reactHooks.configs.flat["recommended-latest"],
    languageOptions: {
      globals: {
        document: "readonly",
        history: "readonly",
        location: "readonly",
        fetch: "readonly",
        URLSearchParams: "readonly"
      }
    }
  },
  {
    files: typedFiles,
    languageOptions: { globals: { crypto: "readonly", TextEncoder: "readonly" } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }]
    }
  }
);
