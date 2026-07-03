import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Test harness for the rethink (blueprint Phase 0.5). Characterization tests
// pin down CURRENT behavior so later refactors (state migration, backend split,
// etc.) can prove they don't change it. Kept separate from vite.config.ts so the
// build is untouched.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
