import { Router } from "express";
import axios, { type AxiosInstance } from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import path from "path";
import { URL } from "url";

import JSZip from "jszip";

const router = Router();

export interface CrawlLog {
  ts: number;
  type: "page" | "asset" | "skip" | "error" | "info";
  msg: string;
}

export interface Job {
  jobId: string;
  status: "pending" | "running" | "done" | "error";
  url: string;
  pagesFound: number;
  assetsFound: number;
  bytesTotal: number;
  message: string | null;
  downloadUrl: string | null;
  zipBuffer: Buffer | null;
  logs: CrawlLog[];
  fileTree: string[];
}

const jobs = new Map<string, Job>();

function addLog(job: Job, type: CrawlLog["type"], msg: string) {
  job.logs.push({ ts: Date.now(), type, msg });
  if (job.logs.length > 500) job.logs.shift();
}

function getRootDomain(hostname: string): string {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join(".");
}

function isSameSite(linkUrl: URL, baseUrl: URL): boolean {
  const linkRoot = getRootDomain(linkUrl.hostname);
  const baseRoot = getRootDomain(baseUrl.hostname);
  return linkRoot === baseRoot;
}

/**
 * Convert a URL pathname + hostname into a meaningful file path.
 * Examples:
 *   /             → index.html
 *   /about        → about.html
 *   /blog/my-post → blog/my-post.html
 *   /blog/my-post/→ blog/my-post/index.html
 *   /styles.css   → styles.css  (keep extension)
 *   blog.example.com/post → blog/post.html  (subdomain prefix)
 */
function urlToFilePath(u: URL, baseUrl: URL): string {
  let prefix = "";
  if (u.hostname !== baseUrl.hostname) {
    const sub = u.hostname.replace(`.${getRootDomain(u.hostname)}`, "");
    if (sub && sub !== u.hostname) prefix = sub + "/";
  }

  let p = u.pathname;
  if (!p || p === "/") return prefix + "index.html";

  const ext = path.extname(p);
  if (ext && ext !== ".") {
    // has real extension — keep as-is
    return prefix + sanitize(p.replace(/^\//, ""));
  }

  // trailing slash → directory index
  if (p.endsWith("/")) {
    return prefix + sanitize(p.replace(/^\//, "") + "index.html");
  }

  // no extension → .html file
  return prefix + sanitize(p.replace(/^\//, "") + ".html");
}

function assetToFilePath(u: URL, baseUrl: URL): string {
  let prefix = "assets/";
  if (u.hostname !== baseUrl.hostname) {
    const sub = u.hostname.replace(`.${getRootDomain(u.hostname)}`, "");
    if (sub && sub !== u.hostname) prefix = `assets/${sub}/`;
  }
  const p = u.pathname.replace(/^\//, "") || "file";
  return prefix + sanitize(p);
}

function sanitize(p: string): string {
  return p
    .replace(/[<>:"|?*\\]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[./]+/, "");
}

const CSS_URL_RE = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
const SRCSET_RE = /([^\s,]+)(?:\s+[\d.]+[wx])?/g;

function extractCssUrls(css: string, base: string): string[] {
  const urls: string[] = [];
  let m;
  CSS_URL_RE.lastIndex = 0;
  while ((m = CSS_URL_RE.exec(css)) !== null) {
    if (m[1] && !m[1].startsWith("data:")) {
      try { urls.push(new URL(m[1], base).href); } catch {}
    }
  }
  return urls;
}

function extractSrcset(srcset: string, base: string): string[] {
  const urls: string[] = [];
  let m;
  SRCSET_RE.lastIndex = 0;
  while ((m = SRCSET_RE.exec(srcset)) !== null) {
    if (m[1]) {
      try { urls.push(new URL(m[1], base).href); } catch {}
    }
  }
  return urls;
}

function makeAxios(): AxiosInstance {
  return axios.create({
    timeout: 15000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; SiteRipper/2.0; +https://siteripper.app)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    maxRedirects: 8,
    validateStatus: s => s < 400,
  });
}

async function runScrape(job: Job, maxPages: number): Promise<Buffer> {
  const baseUrl = new URL(job.url);
  const http = makeAxios();

  const visitedPages = new Set<string>();
  const visitedAssets = new Set<string>();
  const pageQueue: string[] = [job.url];
  const assetQueue: string[] = [];

  const fileMap = new Map<string, Buffer>(); // filePath → data

  addLog(job, "info", `Starting crawl of ${baseUrl.hostname}`);

  // ── Page BFS ─────────────────────────────────────────────────────────────
  while (pageQueue.length > 0 && visitedPages.size < maxPages) {
    const currentUrl = pageQueue.shift()!;
    const normalized = currentUrl.split("#")[0];
    if (visitedPages.has(normalized)) continue;
    visitedPages.add(normalized);

    try {
      addLog(job, "info", `Fetching ${normalized}`);
      const resp = await http.get(normalized, { responseType: "arraybuffer" });
      const ct = (resp.headers["content-type"] as string) ?? "";

      if (!ct.includes("text/html")) {
        assetQueue.push(normalized);
        continue;
      }

      const html = Buffer.from(resp.data);
      const $ = cheerio.load(html);
      const filePath = urlToFilePath(new URL(normalized), baseUrl);

      // rewrite asset paths inline so the zip is self-contained? skip for now — keep raw HTML
      fileMap.set(filePath, html);
      job.fileTree.push(filePath);
      job.pagesFound = visitedPages.size;
      addLog(job, "page", filePath);

      // ── Collect links ──────────────────────────────────────────────────
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return;
        try {
          const abs = new URL(href, normalized);
          abs.hash = "";
          if (isSameSite(abs, baseUrl) && !visitedPages.has(abs.href)) {
            pageQueue.push(abs.href);
          }
        } catch {}
      });

      // ── Collect assets ─────────────────────────────────────────────────
      const addAsset = (src: string | undefined, base: string) => {
        if (!src || src.startsWith("data:")) return;
        try {
          const abs = new URL(src, base);
          if (!visitedAssets.has(abs.href)) assetQueue.push(abs.href);
        } catch {}
      };

      $("link[rel='stylesheet'][href]").each((_, el) => addAsset($(el).attr("href"), normalized));
      $("link[rel='preload'][href]").each((_, el) => addAsset($(el).attr("href"), normalized));
      $("script[src]").each((_, el) => addAsset($(el).attr("src"), normalized));
      $("img[src]").each((_, el) => {
        addAsset($(el).attr("src"), normalized);
        const ss = $(el).attr("srcset");
        if (ss) extractSrcset(ss, normalized).forEach(u => addAsset(u, normalized));
      });
      $("source[src]").each((_, el) => addAsset($(el).attr("src"), normalized));
      $("source[srcset]").each((_, el) => {
        const ss = $(el).attr("srcset");
        if (ss) extractSrcset(ss, normalized).forEach(u => addAsset(u, normalized));
      });
      $("video[src]").each((_, el) => addAsset($(el).attr("src"), normalized));
      $("audio[src]").each((_, el) => addAsset($(el).attr("src"), normalized));
      $("[style]").each((_, el) => {
        const style = $(el).attr("style") ?? "";
        extractCssUrls(style, normalized).forEach(u => addAsset(u, normalized));
      });
      $("style").each((_, el) => {
        extractCssUrls($(el).text(), normalized).forEach(u => addAsset(u, normalized));
      });

      job.message = `Crawling… ${visitedPages.size} pages queued`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(job, "error", `Failed ${normalized}: ${msg}`);
    }
  }

  if (visitedPages.size >= maxPages) {
    addLog(job, "info", `Page limit (${maxPages}) reached`);
  }

  // ── Asset pass ────────────────────────────────────────────────────────────
  addLog(job, "info", `Downloading ${assetQueue.length} assets…`);

  const uniqueAssets = [...new Set(assetQueue)];
  await Promise.allSettled(
    uniqueAssets.map(async (assetUrl) => {
      if (visitedAssets.has(assetUrl)) return;
      visitedAssets.add(assetUrl);

      try {
        const parsed = new URL(assetUrl);
        const resp = await http.get(assetUrl, { responseType: "arraybuffer" });
        const data = Buffer.from(resp.data);
        const ct = (resp.headers["content-type"] as string) ?? "";
        let filePath = assetToFilePath(parsed, baseUrl);

        // If it's CSS, also parse its url() references
        if (ct.includes("text/css")) {
          const cssText = data.toString("utf-8");
          extractCssUrls(cssText, assetUrl).forEach(u => {
            if (!visitedAssets.has(u)) assetQueue.push(u);
          });
        }

        // avoid collisions
        let finalPath = filePath;
        let idx = 1;
        while (fileMap.has(finalPath)) {
          const ext = path.extname(filePath);
          finalPath = filePath.replace(ext, `_${idx}${ext}`);
          idx++;
        }

        fileMap.set(finalPath, data);
        job.fileTree.push(finalPath);
        job.assetsFound++;
        job.bytesTotal += data.length;
        addLog(job, "asset", finalPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(job, "skip", `Asset skip ${assetUrl}: ${msg}`);
      }
    })
  );

  addLog(job, "info", `Packing ZIP — ${fileMap.size} files`);

  const zip = new JSZip();
  for (const [fp, buf] of fileMap) {
    zip.file(fp, buf);
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.post("/scrape/start", async (req, res) => {
  const { url, maxPages = 20 } = req.body as { url?: string; maxPages?: number };

  if (!url) { res.status(400).json({ error: "url is required" }); return; }

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    res.status(400).json({ error: "Invalid URL — must start with http:// or https://" });
    return;
  }

  const jobId = crypto.randomUUID();
  const job: Job = {
    jobId, status: "pending", url,
    pagesFound: 0, assetsFound: 0, bytesTotal: 0,
    message: "Starting…", downloadUrl: null, zipBuffer: null,
    logs: [], fileTree: [],
  };
  jobs.set(jobId, job);

  const safeMax = Math.min(Math.max(1, Number(maxPages) || 20), 200);

  (async () => {
    job.status = "running";
    job.message = "Crawling…";
    try {
      const buf = await runScrape(job, safeMax);
      job.zipBuffer = buf;
      job.bytesTotal = buf.length;
      job.downloadUrl = `/api/scrape/download/${jobId}`;
      job.status = "done";
      job.message = `Done — ${job.pagesFound} pages, ${job.assetsFound} assets`;
    } catch (err) {
      job.status = "error";
      job.message = err instanceof Error ? err.message : "Unknown error";
    }
  })();

  res.json(safeJobView(job));
});

router.get("/scrape/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  const since = Number(req.query.since ?? 0);
  res.json({ ...safeJobView(job), logs: job.logs.filter(l => l.ts > since) });
});

router.get("/scrape/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.zipBuffer) {
    res.status(404).json({ error: "ZIP not ready" }); return;
  }
  let hostname = "";
  try { hostname = new URL(job.url).hostname; } catch {}
  const filename = `${hostname || "site"}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", job.zipBuffer.length);
  res.setHeader("Cache-Control", "no-cache");
  res.end(job.zipBuffer);
});

// Preview: serve individual files out of the in-memory zip
router.get("/scrape/preview/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.zipBuffer) {
    res.status(404).send("Not ready"); return;
  }
  const zip = await JSZip.loadAsync(job.zipBuffer);
  const file = zip.file("index.html");
  if (!file) { res.status(404).send("No index.html"); return; }
  const content = await file.async("nodebuffer");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.end(content);
});

router.get("/scrape/preview/:jobId/*filePath", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== "done" || !job.zipBuffer) {
    res.status(404).send("Not ready"); return;
  }
  const filePath = req.params.filePath ?? "index.html";
  const zip = await JSZip.loadAsync(job.zipBuffer);
  const file = zip.file(filePath) ?? zip.file(filePath + "/index.html") ?? zip.file(filePath.replace(/\/$/, "") + "/index.html");
  if (!file) { res.status(404).send("File not found: " + filePath); return; }

  const ext = path.extname(filePath).toLowerCase();
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
    ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff",
    ".woff2": "font/woff2", ".ttf": "font/ttf",
  };
  res.setHeader("Content-Type", mime[ext] ?? "application/octet-stream");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.end(await file.async("nodebuffer"));
});

function safeJobView(job: Job) {
  return {
    jobId: job.jobId, status: job.status, url: job.url,
    pagesFound: job.pagesFound, assetsFound: job.assetsFound,
    bytesTotal: job.bytesTotal,
    message: job.message, downloadUrl: job.downloadUrl,
    fileTree: job.fileTree.slice(-200),
  };
}

export default router;
