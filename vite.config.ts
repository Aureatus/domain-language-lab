import oxfmt from "ultracite/oxfmt";
import { defineConfig } from "vite-plus";

const generated = [
  "adapters/lean/generated/**",
  "adapters/lean/test-output/**",
];

export default defineConfig({
  fmt: {
    ...oxfmt,
    // Builds and tests match CSS, HTML and prose as literal text.
    ignorePatterns: [
      ...oxfmt.ignorePatterns,
      ...generated,
      "**/*.css",
      "**/*.html",
      "**/*.md",
    ],
  },
});
