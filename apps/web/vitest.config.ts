import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react"
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 15000,
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/e2e/**"]
  }
});
