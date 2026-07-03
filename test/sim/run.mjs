#!/usr/bin/env node
// test/sim/run.mjs
// ---------------------------------------------------------------------------
// avatar-depth.html の「奥行きポーズ」テストバッテリー・ランナー(ストリーム2)。
//
// 契約書: ../../../CONTRACT.md (このリポジトリのスクラッチパッド, ストリーム2節)
// 背景資料: understand/testSurface.md (§3 プローブの返り値, §5 理論値レシピ)
//
// 実行方法:
//   node test/sim/run.mjs            … 実ブラウザ(Playwright headless Chromium)で avatar-depth.html を検証
//   node test/sim/run.mjs --dry-run  … ブラウザを起動せず、ケース一覧と理論期待値だけを表示・出力
//   node test/sim/run.mjs --headed   … (デバッグ用) headed Chromiumで実行
//
// 重要: avatar-depth.html は本ランナーと並行して別エージェント(s2-hooks)が
// フックを追加中のため、このコミット時点では __resetCalibration 等の新フックは
// まだ存在しない。各ケースは実行前に requiredHooks の存在を確認し、欠けていれば
// クラッシュせず SKIP(hook-missing) として扱う。
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const ENTRY_HTML = "avatar-depth.html";

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const HEADED = ARGS.includes("--headed");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// =============================================================================
// 1. 理論値ヘルパー(純関数。ページを開かなくても計算できる = --dry-run で使う)
//    導出の詳細は test/sim/expectations.md を参照。
// =============================================================================

// __setManualCal(0.27, 0.25) でビルダー定数 U/F と厳密に一致させる(testSurface.md §5)。
const U = 0.27; // 上腕長 L_ua
const F = 0.25; // 前腕長 L_fa

const deg2rad = (d) => (d * Math.PI) / 180;

/** buildPoseReach(reachDeg) の肘z理論値: -U*sin(reachDeg) */
function reachElbowZ(reachDeg) {
  return -U * Math.sin(deg2rad(reachDeg));
}
/** buildPoseReach(reachDeg) の手首z理論値: -(U+F)*sin(reachDeg) */
function reachWristZ(reachDeg) {
  return -(U + F) * Math.sin(deg2rad(reachDeg));
}
/**
 * __simReach3D(azimDeg, elevDeg) の肘z理論値。
 * 仮定: 肩→肘 = U*(cos(elev)*cos(azim), -sin(elev), -cos(elev)*sin(azim))
 * (azim=0/elev=0 で buildPoseReach、azim=0 で buildPoseElev と一致する自然な球面合成。
 *  実装がこの式と異なる場合はexpectations.mdの注記を参照して許容誤差を調整すること)
 */
function reach3DElbowZ(azimDeg, elevDeg) {
  return -U * Math.cos(deg2rad(elevDeg)) * Math.sin(deg2rad(azimDeg));
}
function reach3DWristZ(azimDeg, elevDeg) {
  return -(U + F) * Math.cos(deg2rad(elevDeg)) * Math.sin(deg2rad(azimDeg));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---- 手アンカー方式のテスト用較正フィクスチャ ----
// handScale=1.0 で撮った手を基準に較正したことにする(= r == handScale という綺麗な恒等式が成立する)。
// makeHand() の幾何(avatar-depth.html:1497-1505)から:
//   d09  (手首→中指MCP, 幅正規化空間) = 0.07 * sc   (sc = 0.12 * handScale)
//   d517 (人差指MCP→小指MCP)          = 0.44 * sc
// W_m/w_n は D0 = f*W_m/w_n がちょうど 1.0m になるよう選んだ(f = 0.5/tan(HFOV/2), HFOV=60°既定)。
const HAND_SC_AT_SCALE1 = 0.12; // __simReachHand/__simReachHand2 が使うベーススケール
const HAND_CAL_FIXTURE = {
  d09_0: { 15: 0.07 * HAND_SC_AT_SCALE1, 16: 0.07 * HAND_SC_AT_SCALE1 }, // 0.0084
  d517_0: { 15: 0.44 * HAND_SC_AT_SCALE1, 16: 0.44 * HAND_SC_AT_SCALE1 }, // 0.0528
  W_m: 0.3464103, // f*W_m/w_n = 1.0m (f=0.8660254, HFOV=60°を__setHfov(60)で明示固定)
  w_n: 0.3,
};
const HAND_CAL_D0 = 1.0; // 上のW_m/w_nから逆算されるはずのD0(理論値の検算用)

/**
 * 手アンカー方式の理論値(computeHandAnchorSideのロジックを純関数で再現)。
 * 較正基準がhandScale=1.0のとき、r == handScale という恒等式が成り立つ前提。
 * reachDeg は __simReachHand(reachDeg, handScale) の腕角度(手首x,yはhandScaleに依存しない)。
 */
function handAnchorTheory(reachDeg, handScale) {
  const r = handScale;
  const dz = clamp(HAND_CAL_D0 * (1 - 1 / r), -0.15, U + F + 0.1);
  const dxRaw = (U + F) * Math.cos(deg2rad(reachDeg)); // 肩→手首の生x(handScaleに非依存)
  const dRaw = Math.hypot(dxRaw, 0, dz);
  const dMax = 0.995 * (U + F);
  const d = Math.min(dRaw, dMax);
  const cosDeg = clamp((U * U + F * F - d * d) / (2 * U * F), -1, 1);
  const elbowDeg = (Math.acos(cosDeg) * 180) / Math.PI;
  return { r, dz, d, elbowDeg };
}

function within(actual, expected, tol, mode = "rel") {
  if (actual == null || !Number.isFinite(actual)) return false;
  if (mode === "abs") return Math.abs(actual - expected) <= tol;
  const denom = Math.max(Math.abs(expected), 1e-6);
  return Math.abs(actual - expected) / denom <= tol;
}

function fmt(v) {
  if (v == null) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(4) : String(v);
  return String(v);
}

function getPath(obj, pathStr) {
  return pathStr.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** theoryMap: { "left.elbowZ": {value, tol, mode}, ... } を probe オブジェクトに対して検証する */
function assertFields(probe, theoryMap) {
  const details = [];
  const actual = {};
  const expected = {};
  let pass = true;
  for (const [pathStr, spec] of Object.entries(theoryMap)) {
    const av = getPath(probe, pathStr);
    actual[pathStr] = av;
    expected[pathStr] = spec.value;
    const ok = within(av, spec.value, spec.tol, spec.mode);
    if (!ok) pass = false;
    const tolLabel = spec.mode === "abs" ? `±${spec.tol}` : `±${Math.round(spec.tol * 100)}%`;
    details.push(`${pathStr}: actual=${fmt(av)} theory=${fmt(spec.value)} (tol${tolLabel}) => ${ok ? "OK" : "NG"}`);
  }
  return { pass, detail: details.join(" / "), actual, expected };
}

function monotonicDir(arr, eps = 1e-4) {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] == null || arr[i - 1] == null) return 0;
  }
  let dir = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (Math.abs(d) < eps) return 0;
    const s = Math.sign(d);
    if (dir === 0) dir = s;
    else if (s !== dir) return 0;
  }
  return dir;
}

function isStrictlyIncreasing(arr, eps = 1e-6) {
  for (let i = 1; i < arr.length; i++) {
    if (!(arr[i] > arr[i - 1] + eps)) return false;
  }
  return true;
}

// =============================================================================
// 2. 静的サーバ + Playwright操作ヘルパー
// =============================================================================

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".vrm": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
};

function startStaticServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url, "http://localhost");
        let pathname = decodeURIComponent(u.pathname);
        if (pathname === "/") pathname = `/${ENTRY_HTML}`;
        const filePath = path.normalize(path.join(rootDir, pathname));
        if (!filePath.startsWith(path.normalize(rootDir))) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const data = await readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      } catch (e) {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function setupPage() {
  const { chromium } = await import("playwright");
  const server = await startStaticServer(REPO_ROOT);
  const { port } = server.address();
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("[page console]", msg.text());
  });
  page.on("pageerror", (err) => console.error("[page error]", err.message));
  await page.goto(`http://127.0.0.1:${port}/${ENTRY_HTML}`);
  await page.waitForFunction(() => window.__vrmReady === true, null, { timeout: 30000 });
  return { server, browser, context, page };
}

function evalHook(page, name, args = []) {
  return page.evaluate(({ name, args }) => window[name](...args), { name, args });
}

async function hasAllHooks(page, names) {
  if (!names.length) return true;
  return page.evaluate((names) => names.every((n) => typeof window[n] === "function"), names);
}

async function missingHooks(page, names) {
  return page.evaluate((names) => names.filter((n) => typeof window[n] !== "function"), names);
}

/**
 * __zProbe() を100ms間隔でポーリングし、左右のelbowZが2回連続で<0.002しか
 * 変化しなくなるまで待つ(上限3秒)。CONTRACT.md ストリーム2節の収束待ち仕様どおり。
 */
async function pollUntilStable(page, { maxMs = 3000, intervalMs = 100, epsilon = 0.002, stableStreak = 2 } = {}) {
  let prev = null;
  let streak = 0;
  let elapsed = 0;
  let probe = await page.evaluate(() => window.__zProbe());
  while (elapsed <= maxMs) {
    const cur = [probe?.left?.elbowZ, probe?.right?.elbowZ];
    if (prev) {
      const deltas = cur.map((v, i) => (v == null || prev[i] == null ? Infinity : Math.abs(v - prev[i])));
      const maxDelta = Math.max(...deltas);
      if (maxDelta < epsilon) {
        streak++;
        if (streak >= stableStreak) return { probe, converged: true, elapsedMs: elapsed };
      } else {
        streak = 0;
      }
    }
    prev = cur;
    if (elapsed >= maxMs) break;
    await sleep(intervalMs);
    elapsed += intervalMs;
    probe = await page.evaluate(() => window.__zProbe());
  }
  return { probe, converged: false, elapsedMs: elapsed };
}

/** 各ケース冒頭の決定論化: __resetCalibration() -> __setManualCal(0.27,0.25) -> (任意)__setHfov/__setHandCal */
async function resetAndCal(page, { handCal = null, hfov = 60 } = {}) {
  await evalHook(page, "__resetCalibration", []);
  await evalHook(page, "__setManualCal", [U, F]);
  if (hfov != null) {
    await page.evaluate((v) => {
      if (typeof window.__setHfov === "function") window.__setHfov(v);
    }, hfov);
  }
  if (handCal) {
    await evalHook(page, "__setHandCal", [handCal]);
  }
}

// =============================================================================
// 3. ケーステーブル(宣言的)
//    各ケース: { id, desc, requiredHooks, optional?, run(page), assert(result), dryRunPreview() }
//    assert() の戻り値 { pass: true|false|null, detail, actual?, expected? }
//    pass===null は「情報提供のみ・合否判定不能」を意味し、SKIP(info-only)として扱う。
// =============================================================================

const CASES = [
  // ---------------------------------------------------------------- 回帰ケース
  {
    id: "regression-reach45",
    desc: "__simReach(45): 左右の肘/手首zが理論値 -U*sin45°, -(U+F)*sin45° に収束する",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simReach", "__zProbe"],
    async run(page) {
      await resetAndCal(page);
      await evalHook(page, "__simReach", [45]);
      const conv = await pollUntilStable(page);
      return { probe: conv.probe, converged: conv.converged, elapsedMs: conv.elapsedMs };
    },
    assert(result) {
      const theory = {
        "left.elbowZ": { value: reachElbowZ(45), tol: 0.1, mode: "rel" },
        "left.wristZ": { value: reachWristZ(45), tol: 0.1, mode: "rel" },
        "right.elbowZ": { value: reachElbowZ(45), tol: 0.1, mode: "rel" },
        "right.wristZ": { value: reachWristZ(45), tol: 0.1, mode: "rel" },
      };
      return assertFields(result.probe, theory);
    },
    dryRunPreview() {
      return {
        "left/right.elbowZ": reachElbowZ(45).toFixed(4),
        "left/right.wristZ": reachWristZ(45).toFixed(4),
        tol: "±10% (rel)",
      };
    },
  },
  {
    id: "regression-elev-sweep",
    desc: "__simElev(-60/0/60)スイープ: __armProbe().{left,right}.y が同一方向に単調変化する",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simElev", "__armProbe"],
    async run(page) {
      await resetAndCal(page);
      const angles = [-60, 0, 60];
      const ysLeft = [];
      const ysRight = [];
      for (const a of angles) {
        await evalHook(page, "__simElev", [a]);
        await pollUntilStable(page);
        const ap = await page.evaluate(() => window.__armProbe());
        ysLeft.push(ap && ap.left ? ap.left.y : null);
        ysRight.push(ap && ap.right ? ap.right.y : null);
      }
      return { angles, ysLeft, ysRight };
    },
    assert(result) {
      const dirL = monotonicDir(result.ysLeft);
      const dirR = monotonicDir(result.ysRight);
      const pass = dirL !== 0 && dirL === dirR;
      const detail =
        `left.y=[${result.ysLeft.map(fmt).join(", ")}] (dir=${dirL}) / ` +
        `right.y=[${result.ysRight.map(fmt).join(", ")}] (dir=${dirR})`;
      return { pass, detail, actual: { ysLeft: result.ysLeft, ysRight: result.ysRight }, expected: { monotonic: true, sameDirection: true } };
    },
    dryRunPreview() {
      return { note: "armProbeはVRMボーン空間の近似値のため閉形式の理論値なし。単調性のみ検証(testSurface.md §3)。", angles: [-60, 0, 60] };
    },
  },
  {
    id: "regression-handanchor-elbowdeg-monotonic",
    desc: "__simReachHand(45, 1.0→1.5): handAnchor.left.elbowDeg が単調増加する",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__setHandCal", "__simReachHand", "__zProbe"],
    async run(page) {
      await resetAndCal(page, { handCal: HAND_CAL_FIXTURE });
      const scales = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
      const degs = [];
      for (const s of scales) {
        await evalHook(page, "__simReachHand", [45, s]);
        const conv = await pollUntilStable(page);
        degs.push(conv.probe?.handAnchor?.left?.elbowDeg ?? null);
      }
      return { scales, degs };
    },
    assert(result) {
      const finite = result.degs.every((d) => Number.isFinite(d));
      const increasing = finite && isStrictlyIncreasing(result.degs);
      const theory = result.scales.map((s) => handAnchorTheory(45, s).elbowDeg);
      const pass = increasing;
      const detail =
        `actual=[${result.degs.map(fmt).join(", ")}] theory(参考)=[${theory.map((v) => v.toFixed(2)).join(", ")}]`;
      return { pass, detail, actual: { degs: result.degs }, expected: { monotonicIncreasing: true, theoryReference: theory } };
    },
    dryRunPreview() {
      const scales = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
      return Object.fromEntries(scales.map((s) => [`handScale=${s}`, handAnchorTheory(45, s).elbowDeg.toFixed(2) + "°"]));
    },
  },

  // ---------------------------------------------------------------- 新規ケース
  {
    id: "new-reachLR-60-0",
    desc: "__simReachLR(60,0): 左のみ elbowZ≈-U*sin60°、右はほぼ0(閾値未満)。左右が混ざらない",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simReachLR", "__zProbe"],
    async run(page) {
      await resetAndCal(page);
      await evalHook(page, "__simReachLR", [60, 0]);
      const conv = await pollUntilStable(page);
      return { probe: conv.probe, converged: conv.converged, elapsedMs: conv.elapsedMs };
    },
    assert(result) {
      const theory = {
        "left.elbowZ": { value: reachElbowZ(60), tol: 0.1, mode: "rel" },
        "right.elbowZ": { value: 0, tol: 0.02, mode: "abs" },
      };
      const base = assertFields(result.probe, theory);
      const notMixed = Math.abs((result.probe?.right?.elbowZ ?? 0) - (result.probe?.left?.elbowZ ?? 0)) > 0.1;
      return {
        pass: base.pass && notMixed,
        detail: `${base.detail} / notMixed(|right-left|>0.1)=${notMixed}`,
        actual: base.actual,
        expected: base.expected,
      };
    },
    dryRunPreview() {
      return { "left.elbowZ": reachElbowZ(60).toFixed(4), "right.elbowZ": "≈0 (±0.02)" };
    },
  },
  {
    id: "new-reachLR-30-75",
    desc: "__simReachLR(30,75): 左右それぞれ独立に理論値(-U*sin30°/-U*sin75°等)と一致する",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simReachLR", "__zProbe"],
    async run(page) {
      await resetAndCal(page);
      await evalHook(page, "__simReachLR", [30, 75]);
      const conv = await pollUntilStable(page);
      return { probe: conv.probe, converged: conv.converged, elapsedMs: conv.elapsedMs };
    },
    assert(result) {
      const theory = {
        "left.elbowZ": { value: reachElbowZ(30), tol: 0.1, mode: "rel" },
        "left.wristZ": { value: reachWristZ(30), tol: 0.1, mode: "rel" },
        "right.elbowZ": { value: reachElbowZ(75), tol: 0.1, mode: "rel" },
        "right.wristZ": { value: reachWristZ(75), tol: 0.1, mode: "rel" },
      };
      return assertFields(result.probe, theory);
    },
    dryRunPreview() {
      return {
        "left.elbowZ": reachElbowZ(30).toFixed(4),
        "left.wristZ": reachWristZ(30).toFixed(4),
        "right.elbowZ": reachElbowZ(75).toFixed(4),
        "right.wristZ": reachWristZ(75).toFixed(4),
      };
    },
  },
  {
    id: "new-reach3d-45-30",
    desc: "__simReach3D(45,30): zMag理論値(球面合成の仮定, expectations.md参照)と一致する",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simReach3D", "__zProbe"],
    async run(page) {
      await resetAndCal(page);
      await evalHook(page, "__simReach3D", [45, 30]);
      const conv = await pollUntilStable(page);
      return { probe: conv.probe, converged: conv.converged, elapsedMs: conv.elapsedMs };
    },
    assert(result) {
      // 許容誤差は他ケースより広め(±15%): 合成式そのものがs2-hooks実装依存の仮定のため。
      const theory = {
        "left.elbowZ": { value: reach3DElbowZ(45, 30), tol: 0.15, mode: "rel" },
        "left.wristZ": { value: reach3DWristZ(45, 30), tol: 0.15, mode: "rel" },
        "right.elbowZ": { value: reach3DElbowZ(45, 30), tol: 0.15, mode: "rel" },
        "right.wristZ": { value: reach3DWristZ(45, 30), tol: 0.15, mode: "rel" },
      };
      return assertFields(result.probe, theory);
    },
    dryRunPreview() {
      return {
        "left/right.elbowZ(理論, 仮定込み)": reach3DElbowZ(45, 30).toFixed(4),
        "left/right.wristZ(理論, 仮定込み)": reach3DWristZ(45, 30).toFixed(4),
        assumption: "肩→肘 = U*(cosE*cosA, -sinE, -cosE*sinA) の球面合成、side省略=左右対称",
      };
    },
  },
  {
    id: "new-cross-40",
    desc: "__simCross(40): 左肘/手首zが負(前方)、__armProbeで左腕方向xが対側符号、NaN/爆発なし",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simCross", "__zProbe", "__armProbe", "__simPose"],
    async run(page) {
      // 基準姿勢(tpose)での左腕方向xを符号の基準として取得
      await resetAndCal(page);
      await evalHook(page, "__simPose", ["tpose"]);
      await pollUntilStable(page);
      const baseArm = await page.evaluate(() => window.__armProbe());

      // 改めてクリーンな状態からクロスポーズへ
      await resetAndCal(page);
      await evalHook(page, "__simCross", [40]);
      const conv = await pollUntilStable(page);
      const arm = await page.evaluate(() => window.__armProbe());
      return { baseArm, arm, probe: conv.probe };
    },
    assert(result) {
      const p = result.probe;
      const nums = [p?.left?.elbowZ, p?.left?.wristZ, p?.right?.elbowZ, p?.right?.wristZ];
      const allFinite = nums.every((v) => v == null || Number.isFinite(v));
      const boundOk = nums.every((v) => v == null || Math.abs(v) < (U + F) * 1.5);
      const zNeg = (p?.left?.elbowZ ?? 0) < -0.01 && (p?.left?.wristZ ?? 0) < -0.01;
      const baseX = result.baseArm?.left?.x;
      const crossX = result.arm?.left?.x;
      const flipped =
        baseX != null && crossX != null && Math.sign(baseX) !== 0 && Math.sign(crossX) !== 0 && Math.sign(baseX) !== Math.sign(crossX);
      const pass = allFinite && boundOk && zNeg && flipped;
      const detail =
        `left.elbowZ=${fmt(p?.left?.elbowZ)} left.wristZ=${fmt(p?.left?.wristZ)} ` +
        `baseArm.left.x=${fmt(baseX)} crossArm.left.x=${fmt(crossX)} flipped=${flipped} ` +
        `finite=${allFinite} bounded=${boundOk}`;
      return { pass, detail, actual: { left: p?.left, baseX, crossX }, expected: { zNegative: true, xSignFlipped: true, finite: true } };
    },
    dryRunPreview() {
      return {
        note:
          "__simCrossの厳密な幾何はs2-hooks実装依存のため閉形式の数値目標は設定せず、" +
          "符号(z<0)・NaN/爆発なし・armProbeのx符号反転のみを判定基準にする(CONTRACT.md該当行と一致)。",
      };
    },
  },
  {
    id: "new-reachhand2-symmetric",
    desc: "__simReachHand2(45,1.4,45,1.4): 左右のhandAnchor{r,dz,elbowDeg}が非null・左右対称",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__setHandCal", "__simReachHand2", "__zProbe"],
    async run(page) {
      await resetAndCal(page, { handCal: HAND_CAL_FIXTURE });
      await evalHook(page, "__simReachHand2", [45, 1.4, 45, 1.4]);
      const conv = await pollUntilStable(page);
      return { probe: conv.probe, converged: conv.converged, elapsedMs: conv.elapsedMs };
    },
    assert(result) {
      const ha = result.probe?.handAnchor || {};
      const L = ha.left || {};
      const R = ha.right || {};
      const keys = ["r", "dz", "elbowDeg"];
      const nonNull = keys.every((k) => L[k] != null && R[k] != null && Number.isFinite(L[k]) && Number.isFinite(R[k]));
      const symTol = 0.15;
      const sym =
        nonNull &&
        within(L.r, R.r, symTol, "rel") &&
        within(L.dz, R.dz, Math.max(0.02, symTol * Math.abs(R.dz || 0)), "abs") &&
        within(L.elbowDeg, R.elbowDeg, symTol, "rel");
      const theory = handAnchorTheory(45, 1.4);
      const pass = nonNull && sym;
      const detail =
        `left={r:${fmt(L.r)},dz:${fmt(L.dz)},elbowDeg:${fmt(L.elbowDeg)}} ` +
        `right={r:${fmt(R.r)},dz:${fmt(R.dz)},elbowDeg:${fmt(R.elbowDeg)}} ` +
        `theory(参考)={r:${theory.r},dz:${theory.dz.toFixed(4)},elbowDeg:${theory.elbowDeg.toFixed(2)}} nonNull=${nonNull} symmetric=${sym}`;
      return { pass, detail, actual: { left: L, right: R }, expected: { nonNull: true, symmetric: true, theoryReference: theory } };
    },
    dryRunPreview() {
      const t = handAnchorTheory(45, 1.4);
      return { "left/right.r(理論)": t.r, "left/right.dz(理論)": t.dz.toFixed(4), "left/right.elbowDeg(理論)": t.elbowDeg.toFixed(2) + "°" };
    },
  },
  {
    id: "new-visibility-gate",
    desc:
      "__simVis: reach45収束後に肘vis=0.2へ落とした変形ポーズに切替→elbowZが直前値付近に保持(ゲート)。" +
      "vis=1なら新姿勢(tpose, elbowZ≈0)へ追従する対比",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simVis", "__zProbe"],
    async run(page) {
      // Phase A: vis=0.2でゲートがelbowZを保持することを確認
      await resetAndCal(page);
      await evalHook(page, "__simVis", ["reach45", {}]);
      const conv1 = await pollUntilStable(page);
      const before = conv1.probe?.left?.elbowZ ?? null;
      await evalHook(page, "__simVis", ["tpose", { 13: 0.2 }]);
      const samples = [];
      for (let i = 0; i < 5; i++) {
        await sleep(100);
        const pr = await page.evaluate(() => window.__zProbe());
        samples.push(pr?.left?.elbowZ ?? null);
      }
      const gatedMaxDrift = Math.max(...samples.map((v) => (v == null || before == null ? Infinity : Math.abs(v - before))));

      // Phase B: vis=1なら新姿勢に追従する対比
      await resetAndCal(page);
      await evalHook(page, "__simVis", ["reach45", {}]);
      const conv2 = await pollUntilStable(page);
      const before2 = conv2.probe?.left?.elbowZ ?? null;
      await evalHook(page, "__simVis", ["tpose", {}]);
      const conv3 = await pollUntilStable(page);
      const after2 = conv3.probe?.left?.elbowZ ?? null;
      const movedDelta = before2 == null || after2 == null ? null : Math.abs(after2 - before2);

      return { before, samples, gatedMaxDrift, before2, after2, movedDelta };
    },
    assert(result) {
      const gatedHolds = Number.isFinite(result.gatedMaxDrift) && result.gatedMaxDrift < 0.02;
      const freeMoves = result.movedDelta != null && result.movedDelta > 0.1;
      const freeNearZero = result.after2 != null && Math.abs(result.after2 - 0) < 0.05;
      const pass = gatedHolds && freeMoves && freeNearZero;
      const detail =
        `before=${fmt(result.before)} gatedSamples=[${result.samples.map(fmt).join(", ")}] gatedMaxDrift=${fmt(result.gatedMaxDrift)} / ` +
        `before2=${fmt(result.before2)} after2(vis=1)=${fmt(result.after2)} movedDelta=${fmt(result.movedDelta)}`;
      return {
        pass,
        detail,
        actual: result,
        expected: { gatedMaxDrift: "<0.02", freeMovedDelta: ">0.1", freeAfterNearTposeZero: "±0.05" },
      };
    },
    dryRunPreview() {
      return {
        assumption: '__simVis(baseName, visMap) の baseName に "reach45"(=buildPoseReach(45)相当)・"tpose" が存在する前提',
        "reach45理論elbowZ": reachElbowZ(45).toFixed(4),
        "tpose理論elbowZ": "0.0000 (lE=Uちょうどのためzmag=0)",
      };
    },
  },
  {
    // 任意フック。s2-verifyで2つのバグを修正済み:
    // (a) 製品バグ(avatar-depth.html): sampleRefDepthAligned/sampleArmPointDepthAlignedが
    //     latestDepthRaw(実AI出力)のnullガードでfakeDepthFnに到達する前に早期returnしていた。
    //     → fakeDepthFn使用時はガードを迂回するよう修正(実カメラ経路は不変)。
    // (b) テスト側バグ(本ファイル): 修正(a)の後もFAILが残った。原因は
    //     __resetCalibration()→__setManualCal()→__setFakeDepth()→__simReach(45) を
    //     別々のpage.evaluate呼び出しに分けていたため、その合間にブラウザのrAFループが
    //     「resetでinit=falseになったsignStateに対し、まだfakeDepthFn未設定のままの
    //     フォールバック分岐で符号を確定させてしまう」フレームを挟み得ること
    //     (resolveSignの「初回決定は無条件採用、以降はzMagが体側平面付近でない限り凍結」という
    //     意図的なヒステリシスにより、以後__setFakeDepthを呼んでも符号が変わらなくなる)。
    //     デバッグスクリプトで実測確認済み: 別々のevaluateだとsignElbowが常に+1のまま、
    //     reset+cal+fakeDepth+poseを1回のpage.evaluateにまとめて原子的に実行すると
    //     期待通り-1に反転する。→ 以下は後者の原子的な形にしている。
    id: "optional-fakedepth-sign",
    desc: "(任意) __setFakeDepth: 深度ベース符号分岐(SIGN_HI/LO)がFALLBACK_THRESHでなく深度で決まることを確認",
    optional: true,
    requiredHooks: [],
    async run(page) {
      const has = await page.evaluate(() => typeof window.__setFakeDepth === "function");
      if (!has) {
        const e = new Error("__setFakeDepth 未実装");
        e.hookMissing = true;
        throw e;
      }
      if (!(await hasAllHooks(page, ["__resetCalibration", "__setManualCal", "__simReach", "__zProbe"]))) {
        const e = new Error("前提フック(__resetCalibration等)が未実装");
        e.hookMissing = true;
        throw e;
      }

      // 1) フォールバック基準(深度未使用): __simReach(45)で肘は肩より生zが手前 → sign=+1のはず。
      await resetAndCal(page);
      await evalHook(page, "__simReach", [45]);
      const conv1 = await pollUntilStable(page);
      const fallbackSign = conv1.probe?.left?.signElbow ?? null;

      // 2) フェイク深度=フォールバックと逆方向(「肘は肩より奥」、xが大きいほどスコアを小さく=奥にする)。
      //    reset直後(signState.init=false)にfakeDepthFnを仕込んでから初めてポーズを適用する一連の操作を
      //    単一のpage.evaluateにまとめ、間にrAFフレームが挟まらないようにする(原子性の担保)。
      await page.evaluate(
        ({ ua, fa }) => {
          window.__resetCalibration();
          window.__setManualCal(ua, fa);
          window.__setFakeDepth((nx) => -nx * 1000);
          window.__simReach(45);
        },
        { ua: U, fa: F }
      );
      const conv2 = await pollUntilStable(page);
      const fakedOppositeSign = conv2.probe?.left?.signElbow ?? null;

      // 3) 対照実験: フェイク深度=フォールバックと同方向(「肘は肩より手前」)なら sign=+1 のまま。
      //    (2)だけだと「深度分岐が常に-1を返すバグ」等でも同じ観測結果になりうるため、
      //    両方向を確認して初めて「深度分岐が実際にスコアの符号を反映している」ことの証拠になる。
      await page.evaluate(
        ({ ua, fa }) => {
          window.__resetCalibration();
          window.__setManualCal(ua, fa);
          window.__setFakeDepth((nx) => nx * 1000);
          window.__simReach(45);
        },
        { ua: U, fa: F }
      );
      const conv3 = await pollUntilStable(page);
      const fakedSameSign = conv3.probe?.left?.signElbow ?? null;

      await page.evaluate(() => {
        if (typeof window.__setFakeDepth === "function") window.__setFakeDepth(null);
      });

      return { fallbackSign, fakedOppositeSign, fakedSameSign };
    },
    assert(result) {
      const flips = result.fallbackSign === 1 && result.fakedOppositeSign === -1;
      const staysSame = result.fakedSameSign === 1;
      const pass = flips && staysSame;
      const detail =
        `fallbackSign=${fmt(result.fallbackSign)}(期待+1) fakedOppositeSign=${fmt(result.fakedOppositeSign)}(期待-1) ` +
        `fakedSameSign=${fmt(result.fakedSameSign)}(期待+1) flips=${flips} staysSame=${staysSame}`;
      return {
        pass,
        detail,
        actual: result,
        expected: { fallbackSign: 1, fakedOppositeSign: -1, fakedSameSign: 1 },
      };
    },
    dryRunPreview() {
      return {
        note:
          "シグネチャは (nx,ny)=>number|null (大きいほど近い)。__resetCalibration→__setManualCal→" +
          "__setFakeDepth→__simReach(45)を単一のpage.evaluateで原子的に実行し(rAFフレームの割り込みで" +
          "フォールバック分岐に符号が先に凍結されるのを防ぐ)、フリップゲートのヒステリシスを経由しない" +
          "「初回決定」経路で深度分岐の結論を直接観測する。逆方向のフェイク深度でsignが反転し(+1→-1)、" +
          "同方向では変わらない(+1のまま)ことの両方を確認する。",
      };
    },
  },
];

// =============================================================================
// 4. 実行制御
// =============================================================================

async function runCase(page, c) {
  const t0 = Date.now();
  try {
    if (c.requiredHooks.length) {
      const ok = await hasAllHooks(page, c.requiredHooks);
      if (!ok) {
        const missing = await missingHooks(page, c.requiredHooks);
        return {
          id: c.id,
          desc: c.desc,
          status: "SKIP",
          reason: "hook-missing",
          detail: `未実装フック: ${missing.join(", ")}`,
          elapsedMs: Date.now() - t0,
        };
      }
    }
    const result = await c.run(page);
    const assertion = await c.assert(result);
    let status;
    if (assertion.pass === null) status = "SKIP";
    else status = assertion.pass ? "PASS" : "FAIL";
    let detail = assertion.detail;
    if (result && result.converged === false) {
      detail = `[収束せず、${result.elapsedMs}ms時点の値で判定] ${detail}`;
    }
    return {
      id: c.id,
      desc: c.desc,
      status,
      reason: assertion.pass === null ? "info-only" : undefined,
      detail,
      actual: assertion.actual,
      expected: assertion.expected,
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    if (c.optional || e.hookMissing) {
      return {
        id: c.id,
        desc: c.desc,
        status: "SKIP",
        reason: e.hookMissing ? "hook-missing" : "hook-mismatch",
        detail: `任意フック呼び出しで例外(スキップ): ${e.message}`,
        elapsedMs: Date.now() - t0,
      };
    }
    return {
      id: c.id,
      desc: c.desc,
      status: "ERROR",
      detail: e && e.stack ? e.stack : String(e),
      elapsedMs: Date.now() - t0,
    };
  }
}

function dryRunCase(c) {
  let preview = null;
  let previewError = null;
  try {
    preview = typeof c.dryRunPreview === "function" ? c.dryRunPreview() : null;
  } catch (e) {
    previewError = String(e);
  }
  return {
    id: c.id,
    desc: c.desc,
    status: "DRY",
    optional: !!c.optional,
    requiredHooks: c.requiredHooks,
    preview,
    previewError,
  };
}

function printLiveTable(results) {
  const rows = results.map((r) => [r.status, r.id, r.reason ? `(${r.reason})` : "", r.detail || ""]);
  const widths = [6, 42, 16, 0];
  console.log("\n=== test/sim/run.mjs 実行結果 ===\n");
  for (const row of rows) {
    const line = `${pad(row[0], widths[0])} ${pad(row[1], widths[1])} ${pad(row[2], widths[2])} ${row[3]}`;
    console.log(line);
  }
  const summary = summarize(results);
  console.log(
    `\nPASS=${summary.PASS} FAIL=${summary.FAIL} SKIP=${summary.SKIP} ERROR=${summary.ERROR} (total=${results.length})\n`
  );
}

function printDryRunTable(results) {
  console.log("\n=== test/sim/run.mjs --dry-run: ケース一覧と理論期待値 ===\n");
  for (const r of results) {
    console.log(`- [${r.optional ? "任意" : "必須"}] ${r.id}`);
    console.log(`    ${r.desc}`);
    console.log(`    requiredHooks: ${r.requiredHooks.length ? r.requiredHooks.join(", ") : "(なし/実行時に個別確認)"}`);
    if (r.previewError) {
      console.log(`    previewエラー: ${r.previewError}`);
    } else if (r.preview) {
      for (const [k, v] of Object.entries(r.preview)) {
        console.log(`    理論値: ${k} = ${typeof v === "object" ? JSON.stringify(v) : v}`);
      }
    }
    console.log("");
  }
  console.log(`合計 ${results.length} ケース(うち任意 ${results.filter((r) => r.optional).length} 件)\n`);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function summarize(results) {
  const s = { PASS: 0, FAIL: 0, SKIP: 0, ERROR: 0 };
  for (const r of results) s[r.status] = (s[r.status] || 0) + 1;
  return s;
}

function buildReportMarkdown(results, mode) {
  const lines = [];
  lines.push("# test/sim/run.mjs レポート");
  lines.push("");
  lines.push(`- 生成日時: ${new Date().toISOString()}`);
  lines.push(`- モード: ${mode}`);
  lines.push("");
  if (mode === "dry-run") {
    lines.push("| ケース | 種別 | requiredHooks | 理論値プレビュー |");
    lines.push("|---|---|---|---|");
    for (const r of results) {
      const preview = r.previewError ? `ERROR: ${r.previewError}` : r.preview ? JSON.stringify(r.preview) : "-";
      lines.push(`| ${r.id} | ${r.optional ? "任意" : "必須"} | ${r.requiredHooks.join(", ") || "-"} | ${preview.replace(/\|/g, "\\|")} |`);
    }
  } else {
    const summary = summarize(results);
    lines.push(`## サマリ: PASS=${summary.PASS} FAIL=${summary.FAIL} SKIP=${summary.SKIP} ERROR=${summary.ERROR} (total=${results.length})`);
    lines.push("");
    lines.push("| ケース | ステータス | 理由 | 詳細 |");
    lines.push("|---|---|---|---|");
    for (const r of results) {
      lines.push(`| ${r.id} | ${r.status} | ${r.reason || "-"} | ${(r.detail || "").replace(/\|/g, "\\|").slice(0, 500)} |`);
    }
  }
  lines.push("");
  lines.push("詳細な数式導出は `test/sim/expectations.md` を参照。");
  lines.push("");
  return lines.join("\n");
}

async function writeReports(results, mode) {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), mode, results };
  await writeFile(path.join(OUT_DIR, "report.json"), JSON.stringify(payload, null, 2), "utf8");
  await writeFile(path.join(OUT_DIR, "report.md"), buildReportMarkdown(results, mode), "utf8");
}

async function main() {
  if (DRY_RUN) {
    const results = CASES.map(dryRunCase);
    printDryRunTable(results);
    await writeReports(results, "dry-run");
    process.exit(0);
    return;
  }

  let server, browser;
  try {
    const setup = await setupPage();
    server = setup.server;
    browser = setup.browser;
    const { page } = setup;
    const results = [];
    for (const c of CASES) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runCase(page, c));
    }
    printLiveTable(results);
    await writeReports(results, "live");
    const bad = results.some((r) => r.status === "FAIL" || r.status === "ERROR");
    process.exitCode = bad ? 1 : 0;
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
