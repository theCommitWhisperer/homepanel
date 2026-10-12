import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The real server and the dev mock both listen on 8080.
const target = process.env.HOMEPANEL_SERVER ?? "http://localhost:8080";
const proxy = {
  "/api": { target, changeOrigin: true },
  "/media": { target, changeOrigin: true },
  "/mock": { target, changeOrigin: true },
  "/ws": { target: target.replace(/^http/, "ws"), ws: true, changeOrigin: true },
};

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fire HD 8 (Fully Kiosk, Android WebView ~Chromium 100) and older iPads
    target: "es2019",
    cssTarget: ["chrome87", "safari14"],
    sourcemap: false,
  },
  server: { port: 5173, host: true, proxy },
  preview: { port: 4173, host: true, proxy },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
} as any);
