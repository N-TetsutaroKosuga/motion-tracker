#!/usr/bin/env node
// test/tracking/probe-avatar.mjs
// ---------------------------------------------------------------------------
// 恒久ツール(f1タスク): 任意の test/tracking/media/<key>.y4m を「フェイクカメラ」として
// avatar-depth.html に流し込み、__zProbe()/__armProbe()/__visProbe()/__calProbe() の
// 時系列と指定時刻のスクリーンショットを test/tracking/out/ へ保存する。
//
// d2診断(scratchpad/d2-probe.mjs、使い捨て)の手法を一般化・恒久化したもの。
// avatar-depth.html のパンチ/遮蔽ロバスト性の修正前後を同一手法で比較できるようにする。
//
// 使い方:
//   node test/tracking/probe-avatar.mjs --media punch
//   node test/tracking/probe-avatar.mjs --media punch --tag after --arm-slerp-min 0.45
//   node test/tracking/probe-avatar.mjs --media punch --shot-times 0.8,1.3,4.1,5.1,6.4,9.0
//   node test/tracking/probe-avatar.mjs --media punch --hand-anchor off --headed
//
// 出力:
//   test/tracking/out/probe-<media>[-<tag>].json   … {meta, samples:[{wallMs,videoT,zProbe,armProbe,visProbe}]}
//   test/tracking/out/probe-<media>[-<tag>]-shot-<t>s.png … --shot-times で指定した時刻に最も近いサンプル時点のスクショ
//
// 主なCLIオプション:
//   --media <key>          media/<key>.y4m を使う(既定 punch)
//   --tag <name>           出力ファイル名に -<name> を付与(before/after等の区別用)
//   --interval-ms <n>      サンプリング間隔ms(既定100、d2と同一)
//   --shot-times <csv>     スクショを撮る動画内時刻(秒)のカンマ区切りリスト
//   --max-wall-ms <n>      打ち切りまでの実時間上限ms(既定30000)
//   --headed               ヘッドありChromiumで実行(目視確認用)
//   --cal <none|manual-btn|inject>  較正条件(既定 none)。
//       none        = 何もしない(__resetCalibrationのみ)
//       manual-btn  = トラッキング開始直後に#calBtnをクリック(手動較正を試行)
//       inject      = --hand-cal-json / --manual-cal で明示注入
//   --manual-cal <ua,fa>       __setManualCal(ua,fa)を注入(--cal inject時、または単独でも可)
//   --hand-cal-json <json>     __setHandCal(...)へ渡すJSON文字列(--cal inject時)
//   --hand-anchor <on|off>     __setHandAnchor(...)
//   --arm-slerp-min <n>        __setArmSlerpMin(n)
//   --vis-gate <enter,exit>    __setVisGate(enter,exit)
//   --cal-drift-clamp <ratio>  __setCalDriftClamp(ratio)
//   --cal-near-max-ratio <r>   __setCalNearMaxRatio(r)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MEDIA_DIR = path.join(__dirname, "media");
const OUT_DIR = path.join(__dirname, "out");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".task": "application/octet-stream",
  ".y4m": "application/octet-stream",
  ".vrm": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
};

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--headed") { a.headed = true; continue; }
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) { a[key] = true; }
      else { a[key] = next; i++; }
      continue;
    }
    a._.push(t);
  }
  return a;
}
const ARGS = parseArgs(process.argv.slice(2));

const MEDIA_KEY = /^[a-zA-Z0-9_-]+$/.test(String(ARGS.media || "punch")) ? String(ARGS.media || "punch") : (() => { throw new Error("invalid --media"); })();
const TAG = ARGS.tag ? String(ARGS.tag) : null;
const INTERVAL_MS = ARGS["interval-ms"] ? Number(ARGS["interval-ms"]) : 100;
const MAX_WALL_MS = ARGS["max-wall-ms"] ? Number(ARGS["max-wall-ms"]) : 30000;
const SHOT_TIMES = ARGS["shot-times"] ? String(ARGS["shot-times"]).split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : [];
const CAL_MODE = ARGS.cal ? String(ARGS.cal) : "none";
const HEADED = !!ARGS.headed;

const Y4M_PATH = path.join(MEDIA_DIR, `${MEDIA_KEY}.y4m`);
const META_PATH = path.join(MEDIA_DIR, `${MEDIA_KEY}.meta.json`);

const outBase = TAG ? `probe-${MEDIA_KEY}-${TAG}` : `probe-${MEDIA_KEY}`;
const OUT_JSON = path.join(OUT_DIR, `${outBase}.json`);

function startServer(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || "/").split("?")[0]);
    const fp = path.normalize(path.join(root, rel === "/" ? "/avatar-depth.html" : rel));
    if (!fp.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end("not found: " + rel); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  if (!fs.existsSync(Y4M_PATH)) {
    throw new Error(`media not found: ${Y4M_PATH} (先に test/tracking/fetch-media.mjs 等でmedia/${MEDIA_KEY}.y4m を用意すること)`);
  }
  let meta = { durationSec: 11 };
  if (fs.existsSync(META_PATH)) {
    try { meta = JSON.parse(fs.readFileSync(META_PATH, "utf8")); } catch (e) { /* fallback既定値を使う */ }
  }
  const clipDuration = Number(meta.durationSec) > 0 ? Number(meta.durationSec) : 11;

  if (!fs.existsSync(OUT_DIR)) await fsp.mkdir(OUT_DIR, { recursive: true });

  const server = await startServer(REPO_ROOT);
  const port = server.address().port;

  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${Y4M_PATH}`,
      "--use-angle=metal",
    ],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(["camera", "microphone"]);
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

    await page.goto(`http://127.0.0.1:${port}/avatar-depth.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__vrmReady === true, { timeout: 30000 });

    await page.evaluate(() => window.__resetCalibration());

    // 実行時定数の調整(すべて任意。未指定なら製品の既定値のまま)
    if (ARGS["arm-slerp-min"] != null && ARGS["arm-slerp-min"] !== true) {
      await page.evaluate((v) => window.__setArmSlerpMin(v), Number(ARGS["arm-slerp-min"]));
    }
    if (ARGS["vis-gate"] != null && ARGS["vis-gate"] !== true) {
      const [enterV, exitV] = String(ARGS["vis-gate"]).split(",").map(Number);
      await page.evaluate(({ enterV, exitV }) => window.__setVisGate(enterV, exitV), { enterV, exitV });
    }
    if (ARGS["cal-drift-clamp"] != null && ARGS["cal-drift-clamp"] !== true) {
      await page.evaluate((v) => window.__setCalDriftClamp(v), Number(ARGS["cal-drift-clamp"]));
    }
    if (ARGS["cal-near-max-ratio"] != null && ARGS["cal-near-max-ratio"] !== true) {
      await page.evaluate((v) => window.__setCalNearMaxRatio(v), Number(ARGS["cal-near-max-ratio"]));
    }
    if (ARGS["hand-anchor"] === "off") await page.evaluate(() => window.__setHandAnchor(false));
    if (ARGS["hand-anchor"] === "on") await page.evaluate(() => window.__setHandAnchor(true));

    if (CAL_MODE === "inject") {
      if (ARGS["manual-cal"] != null && ARGS["manual-cal"] !== true) {
        const [ua, fa] = String(ARGS["manual-cal"]).split(",").map(Number);
        await page.evaluate(({ ua, fa }) => window.__setManualCal(ua, fa), { ua, fa });
      }
      if (ARGS["hand-cal-json"] != null && ARGS["hand-cal-json"] !== true) {
        const cal = JSON.parse(String(ARGS["hand-cal-json"]));
        await page.evaluate((cal) => window.__setHandCal(cal), cal);
      }
    }

    await page.click("#toggleCam");
    await page.waitForFunction(() => {
      const v = window.__visProbe && window.__visProbe();
      return !!(v && (v.left.shoulderVis != null || v.right.shoulderVis != null));
    }, { timeout: 60000, polling: 100 });

    if (CAL_MODE === "manual-btn") {
      await page.click("#calBtn");
    }

    const samples = [];
    const t0 = Date.now();
    const shotsTaken = new Set();
    while (true) {
      const elapsed = Date.now() - t0;
      const snap = await page.evaluate(() => ({
        videoT: document.getElementById("cam").currentTime,
        zProbe: window.__zProbe ? window.__zProbe() : null,
        armProbe: window.__armProbe ? window.__armProbe() : null,
        visProbe: window.__visProbe ? window.__visProbe() : null,
      }));
      samples.push({ wallMs: elapsed, ...snap });

      for (const st of SHOT_TIMES) {
        if (!shotsTaken.has(st) && snap.videoT >= st) {
          shotsTaken.add(st);
          const shotPath = path.join(OUT_DIR, `${outBase}-shot-${st}s.png`);
          await page.screenshot({ path: shotPath });
        }
      }

      if (snap.videoT >= clipDuration - 0.15 || elapsed >= MAX_WALL_MS) break;
      await page.waitForTimeout(INTERVAL_MS);
    }

    const calProbe = await page.evaluate(() => (window.__calProbe ? window.__calProbe() : null));
    const gateProbe = await page.evaluate(() => (window.__gateProbe ? window.__gateProbe() : null));

    const payload = {
      meta: {
        generatedAt: new Date().toISOString(),
        media: MEDIA_KEY,
        tag: TAG,
        intervalMs: INTERVAL_MS,
        calMode: CAL_MODE,
        args: ARGS,
        sampleCount: samples.length,
        calProbeAtEnd: calProbe,
        gateProbeAtEnd: gateProbe,
      },
      samples,
    };
    await fsp.writeFile(OUT_JSON, JSON.stringify(payload, null, 2));
    console.log(`wrote ${OUT_JSON} (${samples.length} samples, last videoT=${samples[samples.length - 1]?.videoT?.toFixed?.(2)}s)`);

    await context.close();
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
