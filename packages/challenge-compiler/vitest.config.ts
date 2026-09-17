import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env["CI"] ? ["default", "github-actions"] : ["default"],
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
