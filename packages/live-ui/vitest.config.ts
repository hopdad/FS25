import { defineConfig } from "vitest/config";

// The components are written against React; tests run them on preact/compat, as the page does.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
      { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
    ],
  },
});
