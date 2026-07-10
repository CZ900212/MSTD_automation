import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.MSTD_API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": apiTarget },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
} as never);
