import { copyFileSync } from "node:fs";
import { defineConfig } from "vite";

// Plain TS + Canvas app; config.json is copied into dist for production/Electron.
export default defineConfig({
  root: ".",
  // Relative paths so Electron loadFile(file://) resolves JS/CSS assets correctly.
  base: "./",
  build: { outDir: "dist", target: "es2022" },
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE_URL || "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.VITE_API_BASE_URL || "http://localhost:3000",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  plugins: [
    {
      name: "copy-config-json",
      closeBundle() {
        copyFileSync("config.json", "dist/config.json");
      },
    },
  ],
});
