import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env["DATABASE_URL"] ??
        "postgres://progress:progress@127.0.0.1:5432/progress_bot_test",
    },
  },
});
