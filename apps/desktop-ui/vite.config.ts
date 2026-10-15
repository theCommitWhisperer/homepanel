import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy the API to the mock (pnpm mock, port 8790) or a real HomePanel UI server (HP_UI_SERVER).
const target = process.env.HP_UI_SERVER ?? "http://127.0.0.1:8790";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
  },
  server: { port: 5174, host: "127.0.0.1", proxy: { "/api": { target, changeOrigin: true } } },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
} as any);
