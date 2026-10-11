import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Matches the "@/*" path in tsconfig.json so route handlers can be tested directly.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
