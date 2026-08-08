import { copyFileSync, createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dashboardAnalysisRoot = path.resolve(projectRoot, "dashboard_analysis");
const promoFootGifPath = path.resolve(projectRoot, "foot2.gif");

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function sendFile(req: IncomingMessage, res: ServerResponse, filePath: string): void {
  const stat = statSync(filePath);
  const total = stat.size;
  const type = mimeFor(filePath);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", "no-cache");

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Content-Length", String(end - start + 1));
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
  }

  res.setHeader("Content-Length", String(total));
  createReadStream(filePath).pipe(res);
}

/** Serve `gait_project/foot2.gif` at `/promo-assets/foot2.gif` (pane 1 for all promo dogs). */
function servePromoAssets(): Plugin {
  return {
    name: "serve-promo-assets",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathname = (req.url || "").split("?")[0];
        if (pathname !== "/promo-assets/foot2.gif") {
          next();
          return;
        }
        if (!existsSync(promoFootGifPath) || !statSync(promoFootGifPath).isFile()) {
          res.statusCode = 404;
          res.end("Not found: gait_project/foot2.gif");
          return;
        }
        sendFile(req, res, promoFootGifPath);
      });
    },
  };
}

/** Serve `../dashboard_analysis` at `/dashboard_analysis/*` (promo filming assets). */
function serveDashboardAnalysis(): Plugin {
  return {
    name: "serve-dashboard-analysis",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const rawUrl = req.url || "";
        if (!rawUrl.startsWith("/dashboard_analysis/")) {
          next();
          return;
        }
        const rel = decodeURIComponent(rawUrl.slice("/dashboard_analysis/".length).split("?")[0] || "");
        const filePath = path.normalize(path.join(dashboardAnalysisRoot, rel));
        if (!filePath.startsWith(dashboardAnalysisRoot + path.sep) && filePath !== dashboardAnalysisRoot) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        sendFile(req, res, filePath);
      });
    },
  };
}

// Plain TS + Canvas app; config.json is copied into dist for production/Electron.
export default defineConfig({
  root: ".",
  // Relative paths so Electron loadFile(file://) resolves JS/CSS assets correctly.
  base: "./",
  build: { outDir: "dist", target: "es2022" },
  server: {
    port: 5173,
    host: "0.0.0.0",
    fs: {
      allow: [".", projectRoot, dashboardAnalysisRoot],
    },
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE_URL || "http://localhost:3000",
        changeOrigin: true,
      },
      "/uploads": {
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
    servePromoAssets(),
    serveDashboardAnalysis(),
    {
      name: "copy-config-json",
      closeBundle() {
        copyFileSync("config.json", "dist/config.json");
      },
    },
  ],
});
