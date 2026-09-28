import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Builds the extension pages (dashboard, offscreen + its SQLite worker).
// Background and content scripts are bundled by scripts/build-ext.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        dashboard: path.resolve(import.meta.dirname, "dashboard.html"),
        offscreen: path.resolve(import.meta.dirname, "offscreen.html"),
      },
    },
  },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
})
