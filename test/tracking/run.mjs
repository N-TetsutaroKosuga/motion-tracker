#!/usr/bin/env node
// test/tracking/run.mjs
//
// インライン静的サーバ + Chromiumフェイクカメラ(--use-fake-device-for-media-stream 等, CONTRACT.md
// 記載のフラグ)で /verify.html を開き、
//   __ready 待ち → __start() → __record(true) → クリップ実尺+1秒待機 → __record(false) →
//   __dump()/__stats() を out/ にJSON保存 → checks.mjs で不変量チェック
// を行う。
//
// 使い方:
//   node test/tracking/run.mjs            # headless実行(通常の自動実行用)
//   node test/tracking/run.mjs --headed   # ヘッドあり実行(目視確認用)。まずheadedで一度
//                                          # 確認してからheadlessで回す運用を推奨(research.md)
//
// 前提: test/tracking/media/clip.y4m が事前に生成済みであること
//       (node test/tracking/fetch-media.mjs を先に実行する)。
//
// 注意: このスクリプトは verify.html (s1-page 担当、本エージェントと並行実装中)に依存するため、
// s1-harness の作業範囲では実行せず node --check による構文検証のみに留めている。
// full e2e の実走・グリーン化は s1-verify フェーズの責務(CONTRACT.md参照)。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { runChecks } from "./checks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MEDIA_DIR = path.join(__dirname, "media");
const OUT_DIR = path.join(__dirname, "out");
const CLIP_Y4M = path.join(MEDIA_DIR, "clip.y4m");
const CLIP_META = path.join(MEDIA_DIR, "clip.meta.json");

const HEADED = process.argv.includes("--headed");
const DEFAULT_CLIP_DURATION_SEC = 9; // clip.meta.jsonが無い場合のフォールバック
const READY_TIMEOUT_MS = 30_000;
// --use-angle=metal 適用後でもコールドスタート(shaderキャッシュ未温間)で13秒程度かかることを
// s1-verifyで実測したため、CI環境差を見込んで余裕を持たせる。
const START_TIMEOUT_MS = 40_000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".y4m": "application/octet-stream",
};

function log(...args) {
  console.log("[run]", ...args);
}

// リポジトリルート配下を配信するだけの最小限インライン静的サーバ(外部依存・共有ヘルパ禁止のため
// 各テストスクリプトごとに実装する方針。CONTRACT.md参照)。ポートは0指定で実ポートを取得する。
function startStaticServer(rootDir) {
  const server = http.createServer((req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url || "/").split("?")[0]);
      const rel = rawPath === "/" ? "/verify.html" : rawPath;
      const filePath = path.normalize(path.join(rootDir, rel));
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`not found: ${rel}`);
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(data);
      });
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function readClipDurationSec() {
  try {
    const meta = JSON.parse(await fsp.readFile(CLIP_META, "utf8"));
    if (typeof meta.durationSec === "number" && meta.durationSec > 0) {
      return meta.durationSec;
    }
  } catch {
    // clip.meta.json が無い/壊れている場合は既定値にフォールバック
  }
  return DEFAULT_CLIP_DURATION_SEC;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  if (!fs.existsSync(CLIP_Y4M)) {
    console.error(
      `[run] FATAL: ${CLIP_Y4M} が見つかりません。先に node test/tracking/fetch-media.mjs を実行してください。`
    );
    process.exit(1);
  }
  const verifyHtmlPath = path.join(REPO_ROOT, "verify.html");
  if (!fs.existsSync(verifyHtmlPath)) {
    console.error(
      `[run] FATAL: ${verifyHtmlPath} が見つかりません(s1-page担当、未実装の可能性があります)。`
    );
    process.exit(1);
  }

  await fsp.mkdir(OUT_DIR, { recursive: true });

  const clipDurationSec = await readClipDurationSec();
  log(`clip duration = ${clipDurationSec}s (待機 = 実尺+1秒)`);

  const server = await startStaticServer(REPO_ROOT);
  const port = server.address().port;
  log(`static server: http://127.0.0.1:${port}/ (root=${REPO_ROOT})`);

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${CLIP_Y4M}`,
      // headless(--headless=new)ではANGLEの既定バックエンドがsoftware GL相当になり、
      // HolisticLandmarkerのGPUデリゲート初回推論が20秒超かかることをs1-verifyで確認した
      // (headed実行や__start()の実測ログで判明。research.md未記載の実機依存の罠)。
      // macOSではANGLEをMetalバックエンドに切り替えることで実GPU相当の速度に戻る
      // (実測: 初回__start()が約27s→約1〜13s)。Linux CIでは効果がない可能性があるため
      // 無害なだけの指定として付与する(該当プラットフォームでなければ無視される想定)。
      "--use-angle=metal",
    ],
  });

  let exitCode = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.grantPermissions(["camera", "microphone"]);
    const page = await context.newPage();
    page.on("console", (msg) => log(`[page:${msg.type()}]`, msg.text()));
    page.on("pageerror", (err) => log("[page:error]", err.message));

    log(`opening http://127.0.0.1:${port}/verify.html ...`);
    await page.goto(`http://127.0.0.1:${port}/verify.html`, { waitUntil: "load" });

    log("waiting for window.__ready ...");
    await page.waitForFunction(() => window.__ready === true, { timeout: READY_TIMEOUT_MS });

    log("calling __start() ...");
    await withTimeout(
      page.evaluate(() => window.__start()),
      START_TIMEOUT_MS,
      "__start() did not resolve in time"
    );

    // 目視確認用スクリーンショット(フェイクカメラが黒画面/フリーズしていないかの簡易確認にも使う)
    await page.screenshot({ path: path.join(OUT_DIR, "screenshot-after-start.png") });
    log(`saved out/screenshot-after-start.png`);

    log("calling __record(true) ...");
    await page.evaluate(() => window.__record(true));

    const waitMs = Math.round((clipDurationSec + 1) * 1000);
    log(`recording... waiting ${waitMs}ms (クリップ実尺+1秒)`);
    await page.waitForTimeout(waitMs);

    log("calling __record(false) ...");
    await page.evaluate(() => window.__record(false));

    log("calling __dump() / __stats() ...");
    const dump = await page.evaluate(() => window.__dump());
    const stats = await page.evaluate(() => window.__stats());

    await page.screenshot({ path: path.join(OUT_DIR, "screenshot-after-record.png") });
    log(`saved out/screenshot-after-record.png`);

    await fsp.writeFile(
      path.join(OUT_DIR, "web-landmarks.json"),
      JSON.stringify(dump, null, 2)
    );
    await fsp.writeFile(path.join(OUT_DIR, "web-stats.json"), JSON.stringify(stats, null, 2));
    log(
      `saved out/web-landmarks.json (${dump?.frames?.length ?? 0} frames), out/web-stats.json`
    );

    try {
      await page.evaluate(() => window.__stop());
    } catch (err) {
      log("warn: __stop() failed (非致命的):", err.message);
    }

    const { pass, reportMd } = runChecks(dump, stats);
    await fsp.writeFile(path.join(OUT_DIR, "report.md"), reportMd);
    log(pass ? "CHECKS: PASS" : "CHECKS: FAIL");
    if (!pass) exitCode = 1;
  } catch (err) {
    log("FATAL:", err.stack || err.message || err);
    exitCode = 1;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  process.exit(exitCode);
}

main();
