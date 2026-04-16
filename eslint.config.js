const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

const typedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: ["**/*.ts"],
  languageOptions: {
    ...config.languageOptions,
    parserOptions: {
      ...config.languageOptions?.parserOptions,
      project: "./tsconfig.eslint.json",
      tsconfigRootDir: __dirname
    }
  }
}));

module.exports = tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "eslint.config.js"
    ]
  },
  js.configs.recommended,
  ...typedConfigs,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  }
);
