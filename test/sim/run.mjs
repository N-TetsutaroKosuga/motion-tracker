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
  const browser = await chromium.launch({
    headless: !HEADED,
    args: [
      // headless既定のANGLE(software GL相当)だと本ファイルのthree.js/VRMレンダリングが
      // 3〜4fps程度しか出ず(実測)、正拳突きサイクル(new-punch-cycle、periodMs=600の高速な
      // visibility往復)のようにフレームレート依存の挙動を検証するケースで閾値を跨ぐ回数が
      // 環境依存で暴れる(実測: 3.5fps時にtotalFlips=132、100fps超では22に安定収束)。
      // macOSではANGLEをMetalバックエンドに切り替えることで実GPU相当の速度(100fps超)に戻る
      // (test/tracking/run.mjsが既に採用している対策と同じもの)。Linux CIでは効果が無い
      // 可能性があるが無害なだけの指定として付与する。
      "--use-angle=metal",
    ],
  });
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
 * 汎用収束待ちヘルパー(g1タスクで一本化)。__zProbe/__armProbe/__boneWorldProbeの数値を
 * 200ms間隔でポーリングし、2回連続で全フィールドの変化が<0.01になるまで待つ(上限8秒)。
 *
 * 旧実装は__zProbe().{left,right}.elbowZのみを100ms間隔・上限3秒・閾値0.002で監視していたが、
 * これだと「fuseArmZの融合済みzはOne Euroフィルタでdt基準に収束していても、rigRotationの
 * quaternion.slerp(target, SMOOTH)はフレーム数ベースの固定ブレンド率(dt非依存)で収束するため、
 * headless低fps環境(高負荷時)では同じ壁時計3秒でも消化できるフレーム数が減り、__armProbeが
 * 実際のVRMボーン回転として収束しきる前にサンプリングしてしまう」という時間依存の脆弱性があった。
 * 実測(2026-07-03、高負荷下でのnew-cross-40): crossArm.left.xが旧実装の+0.22のまま(=収束途中の
 * 値)でFAILする再現を確認済み。__armProbe/__boneWorldProbeも収束条件に含めることで、
 * armProbe系アサーションを持つ全ケース(cross-40含む)がこの脆弱性から解放される。
 *
 * 返り値: { z, arm, bw, converged, elapsedMs }。zは__zProbe()の生値(従来のprobeフィールド相当)、
 * armは__armProbe()、bwは__boneWorldProbe()の最終サンプル。
 */
async function pollConverge(page, { maxMs = 8000, intervalMs = 200, epsilon = 0.01, stableStreak = 2 } = {}) {
  const extract = () => {
    const z = typeof window.__zProbe === "function" ? window.__zProbe() : null;
    const a = typeof window.__armProbe === "function" ? window.__armProbe() : null;
    const bw = typeof window.__boneWorldProbe === "function" ? window.__boneWorldProbe() : null;
    const flat = [];
    if (z) for (const s of ["left", "right"]) { const d = z[s] || {}; flat.push(d.elbowZ, d.wristZ); }
    if (a) for (const s of ["left", "right"]) { const d = a[s] || {}; flat.push(d?.x, d?.y, d?.z); }
    if (bw) for (const k of Object.keys(bw)) { const p = bw[k]; if (p) flat.push(p.x, p.y, p.z); }
    return { flat, z, a, bw };
  };
  let prev = null;
  let streak = 0;
  let elapsed = 0;
  let sample = await page.evaluate(extract);
  while (elapsed <= maxMs) {
    if (prev) {
      const deltas = sample.flat.map((v, i) => (v == null || prev[i] == null ? Infinity : Math.abs(v - prev[i])));
      const maxDelta = deltas.length ? Math.max(...deltas) : Infinity;
      if (maxDelta < epsilon) {
        streak++;
        if (streak >= stableStreak) return { z: sample.z, arm: sample.a, bw: sample.bw, converged: true, elapsedMs: elapsed };
      } else {
        streak = 0;
      }
    }
    prev = sample.flat;
    if (elapsed >= maxMs) break;
    await sleep(intervalMs);
    elapsed += intervalMs;
    sample = await page.evaluate(extract);
  }
  return { z: sample.z, arm: sample.a, bw: sample.bw, converged: false, elapsedMs: elapsed };
}

/** 後方互換ラッパ: 既存ケースの `{ probe, converged, elapsedMs }` 形状をそのまま返す(probe=__zProbe()の値)。
 * 内部はpollConverge()に一本化されており、__armProbe/__boneWorldProbeが存在すればその収束も
 * 待ってから返るため、zProbeしか見ていない既存ケースも副次的にスラープ収束の恩恵を受ける。 */
async function pollUntilStable(page, opts) {
  const r = await pollConverge(page, opts);
  return { probe: r.z, converged: r.converged, elapsedMs: r.elapsedMs };
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
        // g1タスク: __armProbeの収束をpollConverge()で直接待ってから読む(旧実装は__zProbeの
        // 収束だけを待って別途__armProbeを1回読んでいたため、低fps環境でスラープ未収束の
        // 値を拾う余地があった)。
        const conv = await pollConverge(page);
        const ap = conv.arm;
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
      // g1タスク: __armProbeの収束をpollConverge()で直接待つ(旧実装は__zProbeの収束後に
      // __armProbeを別途1回読むだけだったため、headless低fps環境でスラープ未収束の
      // crossArm.left.xを拾いFAILする不具合を実測確認済み。2026-07-03高負荷実測: +0.22のまま=
      // "down"姿勢に近い未収束値)。
      const convBase = await pollConverge(page);
      const baseArm = convBase.arm;

      // 改めてクリーンな状態からクロスポーズへ
      await resetAndCal(page);
      await evalHook(page, "__simCross", [40]);
      const conv = await pollConverge(page);
      const arm = conv.arm;
      return { baseArm, arm, probe: conv.z };
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
    // g1タスク: 「前方リーチでVRMアバターが背中方向へ腕を伸ばす」という実機報告(punch-fix以降のUX観測)の
    // 恒久回帰ガード。__boneWorldProbeの実測値(handZ-chestZ)を直接判定基準にする点が
    // new-cross-40(__armProbeのx符号反転のみを見る)と異なり、絶対的な前後方向そのものを検証する。
    id: "new-absolute-forward",
    desc: "__simReach(60)(両腕): 左右ともhandZ-chestZが大きく正(=前方)。tpose基準値との対比も記録。背面リーチ回帰の恒久ガード",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simReach", "__simPose", "__boneWorldProbe"],
    async run(page) {
      // tpose基準値(参考。前方でも後方でもない中立姿勢でのhandZ-chestZ)
      await resetAndCal(page);
      await evalHook(page, "__simPose", ["tpose"]);
      const convT = await pollConverge(page);
      const bwT = convT.bw || (await page.evaluate(() => window.__boneWorldProbe()));

      // 本題: 両腕前方リーチ60°
      await resetAndCal(page);
      await evalHook(page, "__simReach", [60]);
      const convR = await pollConverge(page);
      const bwR = convR.bw || (await page.evaluate(() => window.__boneWorldProbe()));

      const dz = (bw) => ({ left: bw.leftHand.z - bw.chest.z, right: bw.rightHand.z - bw.chest.z });
      return { dzTpose: dz(bwT), dzReach60: dz(bwR), convergedT: convT.converged, convergedR: convR.converged };
    },
    assert(result) {
      // 閾値+0.15m の根拠(expectations.md参照): 修正後の実測はleft/rightとも+0.334〜+0.336mに
      // 3回の独立実行で収束(理論チェーン長(U+F)*sin60°=0.4503mに対しVRMボーンスケールを反映した値)。
      // 修正前バグ値は-0.385m前後(符号が逆)だった。+0.15mは両者を確実に判別しつつ、
      // 実行間のフィルタ収束ばらつきを吸収する余裕を持たせた値。
      const THRESH = 0.15;
      const passL = result.dzReach60.left > THRESH;
      const passR = result.dzReach60.right > THRESH;
      const pass = passL && passR;
      const detail =
        `reach60: left=${fmt(result.dzReach60.left)} right=${fmt(result.dzReach60.right)} (要 > +${THRESH}) / ` +
        `tpose基準: left=${fmt(result.dzTpose.left)} right=${fmt(result.dzTpose.right)} / ` +
        `converged(tpose/reach60)=${result.convergedT}/${result.convergedR}`;
      return {
        pass,
        detail,
        actual: result.dzReach60,
        expected: { left: `> +${THRESH}`, right: `> +${THRESH}`, note: "handZ-chestZ (VRM world, m)" },
      };
    },
    dryRunPreview() {
      return {
        note:
          "理論チェーン長(U+F)*sin60°=0.4503m(MediaPipe座標)に対応するVRMワールド換算値。" +
          "修正後の実測ではleft/rightとも+0.334〜+0.336mに収束(3回の独立実行で確認、expectations.md参照)。" +
          "閾値+0.15mは旧バグ値(-0.385m前後)を確実に判別しつつ実行間ばらつきを吸収するための余裕を持たせた値。",
        "reach60理論チェーン長(U+F)*sin60°": ((U + F) * Math.sin(deg2rad(60))).toFixed(4),
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
    // f1タスク: visibilityゲートのヒステリシス化(VIS_GATE_MIN=凍結開始/VIS_GATE_EXIT=凍結解除)後の
    // 新仕様に合わせて更新。Phase Aは「凍結開始域(0.45)→ヒステリシスの中間帯(0.55、旧VIS_GATE_MIN=0.5
    // より高いが新VIS_GATE_EXIT=0.6未満)」の2段階に変更し、中間帯でも凍結が解除されない
    // (=旧・単一閾値0.5の実装なら0.55で解除されてしまいFAILするはずの)ことを確認する形にした。
    // ヒステリシスの境界そのもの(enter/exit)を単独で検証する専用ケースは new-vis-hysteresis を参照。
    id: "new-visibility-gate",
    desc:
      "__simVis: reach45収束後にvis=0.45→0.55(ヒステリシスの中間帯)へ落とした変形ポーズに切替→" +
      "elbowZが直前値付近に保持され続ける(ゲート、中間帯でも解除されない)。vis=1なら新姿勢(tpose, elbowZ≈0)へ追従する対比",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simVis", "__zProbe"],
    async run(page) {
      // Phase A: vis=0.45(凍結開始)→0.55(ヒステリシス中間帯、旧VIS_GATE_MIN=0.5超だが
      // 新VIS_GATE_EXIT=0.6未満)でelbowZが保持され続けることを確認
      await resetAndCal(page);
      await evalHook(page, "__simVis", ["reach45", {}]);
      const conv1 = await pollUntilStable(page);
      const before = conv1.probe?.left?.elbowZ ?? null;
      await evalHook(page, "__simVis", ["tpose", { 13: 0.45 }]);
      const samplesEnter = [];
      for (let i = 0; i < 3; i++) {
        await sleep(100);
        const pr = await page.evaluate(() => window.__zProbe());
        samplesEnter.push(pr?.left?.elbowZ ?? null);
      }
      await evalHook(page, "__simVis", ["tpose", { 13: 0.55 }]);
      const samplesMid = [];
      for (let i = 0; i < 3; i++) {
        await sleep(100);
        const pr = await page.evaluate(() => window.__zProbe());
        samplesMid.push(pr?.left?.elbowZ ?? null);
      }
      const samples = [...samplesEnter, ...samplesMid];
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
        `before=${fmt(result.before)} gatedSamples(vis0.45→0.55)=[${result.samples.map(fmt).join(", ")}] gatedMaxDrift=${fmt(result.gatedMaxDrift)} / ` +
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
        note: "vis=0.45→0.55(ヒステリシスの中間帯)の2段階で凍結が解除されないことを確認する(f1タスク仕様変更)",
      };
    },
  },
  {
    // f1タスク新規ケース: VIS_GATE_MIN(凍結開始)/VIS_GATE_EXIT(凍結解除)のヒステリシス境界そのものを
    // vis=0.45→0.55→0.65と振って直接検証する(CONTRACT.md該当行の例に対応)。
    // 既定値は VIS_GATE_MIN=0.5, VIS_GATE_EXIT=0.6 (avatar-depth.html HZ定数)。
    id: "new-vis-hysteresis",
    desc:
      "__simVis: vis=0.45(<ENTER)で凍結開始→0.55(ENTER<vis<EXIT、中間帯)で凍結維持→" +
      "0.65(>EXIT)で凍結解除、の3段階を__zProbeで直接確認",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simVis", "__zProbe"],
    async run(page) {
      await resetAndCal(page);
      await evalHook(page, "__simVis", ["reach45", {}]);
      const conv0 = await pollUntilStable(page);
      const before = conv0.probe?.left?.elbowZ ?? null;

      const sampleFor = async (visMap, n = 3) => {
        await evalHook(page, "__simVis", ["tpose", visMap]);
        const out = [];
        for (let i = 0; i < n; i++) {
          await sleep(100);
          const pr = await page.evaluate(() => window.__zProbe());
          out.push(pr?.left?.elbowZ ?? null);
        }
        return out;
      };

      const stepEnter = await sampleFor({ 13: 0.45 }); // < VIS_GATE_MIN(0.5) => 凍結開始
      const stepMid = await sampleFor({ 13: 0.55 });   // ENTER<vis<EXIT => 凍結維持(ヒステリシス本体)
      const stepExit = await sampleFor({ 13: 0.65 }, 10); // > VIS_GATE_EXIT(0.6) => 凍結解除、tpose理論値(≈0)へ追従

      return { before, stepEnter, stepMid, stepExit };
    },
    assert(result) {
      const drift = (arr) => Math.max(...arr.map((v) => (v == null || result.before == null ? Infinity : Math.abs(v - result.before))));
      const enterHolds = Number.isFinite(drift(result.stepEnter)) && drift(result.stepEnter) < 0.02;
      const midHolds = Number.isFinite(drift(result.stepMid)) && drift(result.stepMid) < 0.02;
      const exitLast = result.stepExit[result.stepExit.length - 1];
      const released = exitLast != null && Math.abs(exitLast - 0) < 0.05; // tpose理論elbowZ=0
      const pass = enterHolds && midHolds && released;
      const detail =
        `before=${fmt(result.before)} / enter(vis0.45)=[${result.stepEnter.map(fmt).join(",")}] holds=${enterHolds} / ` +
        `mid(vis0.55)=[${result.stepMid.map(fmt).join(",")}] holds=${midHolds} / ` +
        `exit(vis0.65)=[${result.stepExit.map(fmt).join(",")}] released(last≈0)=${released}`;
      return {
        pass,
        detail,
        actual: result,
        expected: { enterHoldsDrift: "<0.02", midHoldsDrift: "<0.02(旧単一閾値なら0.5を超えているため解除されFAILするはず)", exitLastNearZero: "±0.05" },
      };
    },
    dryRunPreview() {
      return {
        note:
          "HZ.VIS_GATE_MIN=0.5(凍結開始)/HZ.VIS_GATE_EXIT=0.6(凍結解除)の既定値を前提。" +
          "vis=0.45→凍結開始、0.55→(0.5より上だが0.6未満のため)凍結維持、0.65→(0.6超のため)凍結解除でtpose理論値(elbowZ≈0)へ追従。",
        "reach45理論elbowZ(開始点)": reachElbowZ(45).toFixed(4),
        "tpose理論elbowZ(解除後の収束先)": "0.0000",
      };
    },
  },
  {
    // f1タスク新規ケース: 較正結果のフィードバック(__calProbe)。tposeフィクスチャは
    // leftHandLandmarks/rightHandLandmarksを持たない(既存4ポーズ共通の仕様、testSurface.md §1)ため、
    // 手動較正(#calBtnクリック→startManualCalibration/stepManualCalibration)を走らせると
    // 骨長・肩幅は測定できるが手サイズだけが構造的に欠損するはず。この「部分的成功」を
    // __calProbe()が正しく項目別に報告できることを確認する(CONTRACT.md検証手順d)。
    // 他ケースと異なり__setManualCal は呼ばない(較正フローそのものを素の状態からテストするため)。
    id: "new-calibration-feedback-handmissing",
    desc: "tposeフィクスチャで手動較正を実行→__calProbe(): 骨長/肩幅はok、手サイズは左右ともmissingと報告される",
    requiredHooks: ["__resetCalibration", "__simPose", "__calProbe"],
    async run(page) {
      await evalHook(page, "__resetCalibration", []);
      await evalHook(page, "__simPose", ["tpose"]);
      const hasCalBtn = await page.evaluate(() => !!document.getElementById("calBtn"));
      if (!hasCalBtn) {
        const e = new Error("#calBtn が見つからない(手動較正UIが無い)");
        e.hookMissing = true;
        throw e;
      }
      await page.click("#calBtn");
      // MANUAL_CAL_MS(3000ms、performance.now()基準の実時間)+ 余裕分を待つ
      await sleep(3500);
      const probe = await page.evaluate(() => window.__calProbe());
      return { probe };
    },
    assert(result) {
      const p = result.probe;
      if (!p) return { pass: false, detail: "__calProbe()がnull(較正が完了していない)", actual: p };
      const boneOk = p.ok?.bone === true;
      const shoulderOk = p.ok?.shoulder === true;
      const handMissing = p.ok?.handLeft === false && p.ok?.handRight === false;
      const missingHasHands = p.missing?.includes("handLeft") && p.missing?.includes("handRight");
      const pass = boneOk && shoulderOk && handMissing && missingHasHands;
      const detail =
        `ok=${JSON.stringify(p.ok)} missing=${JSON.stringify(p.missing)} samples=${JSON.stringify(p.samples)} adopted.L_ua/L_fa=${fmt(p.adopted?.L_ua)}/${fmt(p.adopted?.L_fa)}`;
      return {
        pass,
        detail,
        actual: p,
        expected: { boneOk: true, shoulderOk: true, handLeftOk: false, handRightOk: false, missingIncludes: ["handLeft", "handRight"] },
      };
    },
    dryRunPreview() {
      return {
        note:
          "buildPose系フィクスチャ(tpose含む)はleftHandLandmarks/rightHandLandmarksを持たない仕様" +
          "(testSurface.md §1)。手動較正は骨長(11-13-15/12-14-16)・肩幅(11-12)は手に依存せず取得できるが、" +
          "手サイズ(handSizeMetrics)はhand[0]が無いためmatchHandsToWrists()が常にnullを返し、" +
          "構造的に欠損し続けるはず。",
        "tpose理論L_ua/L_fa": "0.2700 / 0.2500 (buildPoseのtpose座標がU=0.27,F=0.25と厳密に一致するため)",
      };
    },
  },
  {
    // f1タスク新規ケース: 手動較正の画面平行性ゲート(stepManualCalibrationのCAL_NEAR_MAX_RATIOフィルタ)。
    // tpose(画面平行)の収集中に reach45相当の大きく前傾した姿勢(__simReachLR(80,80)、2D投影が
    // 大きく縮む)を一時的に混入させ、そのフレームがサンプルとして採用されず、最終的な
    // L_ua/L_faがtposeの理論値(U=0.27/F=0.25)付近に留まる(=混入姿勢に汚染されない)ことを確認する。
    // d2診断が実測した「手動較正は自動較正より悪化しうる(0.28→0.173まで過小)」バグの再発防止テスト。
    id: "new-calibration-parallelism-gate",
    desc: "手動較正中にreach45相当の非平行姿勢を混入→CAL_NEAR_MAX_RATIOで棄却され、L_ua/L_faがtpose理論値付近に留まる",
    requiredHooks: ["__resetCalibration", "__simPose", "__simReachLR", "__calProbe"],
    async run(page) {
      await evalHook(page, "__resetCalibration", []);
      await evalHook(page, "__simPose", ["tpose"]);
      await page.click("#calBtn");
      await sleep(900); // tpose(画面平行)のサンプルでランニング最大2D長を先に確立させる
      await evalHook(page, "__simReachLR", [80, 80]); // 大きく前傾した非平行姿勢を混入
      await sleep(600);
      await evalHook(page, "__simPose", ["tpose"]); // 平行姿勢に戻す
      await sleep(2200); // 合計3000ms(MANUAL_CAL_MS)を超えるまで待つ
      const probe = await page.evaluate(() => window.__calProbe());
      return { probe };
    },
    assert(result) {
      const p = result.probe;
      if (!p) return { pass: false, detail: "__calProbe()がnull(較正が完了していない)", actual: p };
      const boneOk = p.ok?.bone === true;
      const uaOk = within(p.adopted?.L_ua, 0.27, 0.1, "rel");
      const faOk = within(p.adopted?.L_fa, 0.25, 0.1, "rel");
      const notContaminated = uaOk && faOk; // 混入姿勢の見かけ長(理論上tposeの約1/5)に汚染されていないこと
      const pass = boneOk && notContaminated;
      const detail =
        `ok.bone=${boneOk} adopted.L_ua=${fmt(p.adopted?.L_ua)}(理論0.27, ±10%) adopted.L_fa=${fmt(p.adopted?.L_fa)}(理論0.25, ±10%) samples=${JSON.stringify(p.samples)}`;
      return {
        pass,
        detail,
        actual: p,
        expected: { boneOk: true, L_ua: "0.27±10%", L_fa: "0.25±10%" },
      };
    },
    dryRunPreview() {
      return {
        note:
          "__simReachLR(80,80)のlm2投影2D長はtposeの約17%(cos80°≈0.174)まで縮むため、" +
          "CAL_NEAR_MAX_RATIO=0.92のゲートで確実に棄却されるはず(0.174 < 0.92)。" +
          "棄却が機能していれば最終L_ua/L_faはtpose理論値0.27/0.25付近に留まる。",
      };
    },
  },
  {
    // g2タスク新規ケース: ポーズ非依存キャリブレーション(1) — Y字ポーズでも較正が成立すること。
    // buildPoseElev(45)は腕を画像平面内(z=0で固定)で仰角45°に上げたY字相当のポーズ。
    // 実機ユーザー観測(CONTRACT.md背景)は「Tポーズだと手が画面に入らずY字にしたら較正が
    // 過小推定になった」というものだったため、Y字そのもの(z=0で画面と平行)では正しく
    // 理論値どおりに較正できることを確認する(=ポーズの見た目ではなく各セグメントの
    // 画面平行性だけが条件であることの直接証明)。
    id: "new-calibration-ypose",
    desc: "buildPoseElev(45)(Y字相当、腕は画像平面内=z一定)で手動較正→採用L_ua/L_faが理論値0.27/0.25(±10%)",
    requiredHooks: ["__resetCalibration", "__simElev", "__calProbe"],
    async run(page) {
      await evalHook(page, "__resetCalibration", []);
      await evalHook(page, "__simElev", [45]);
      const hasCalBtn = await page.evaluate(() => !!document.getElementById("calBtn"));
      if (!hasCalBtn) {
        const e = new Error("#calBtn が見つからない(手動較正UIが無い)");
        e.hookMissing = true;
        throw e;
      }
      await page.click("#calBtn");
      await sleep(3500); // MANUAL_CAL_MS(3000ms) + 余裕分
      const probe = await page.evaluate(() => window.__calProbe());
      return { probe };
    },
    assert(result) {
      const p = result.probe;
      if (!p) return { pass: false, detail: "__calProbe()がnull(較正が完了していない)", actual: p };
      const boneOk = p.ok?.bone === true;
      const uaOk = within(p.adopted?.L_ua, U, 0.1, "rel");
      const faOk = within(p.adopted?.L_fa, F, 0.1, "rel");
      const pass = boneOk && uaOk && faOk;
      const detail =
        `ok.bone=${boneOk} adopted.L_ua=${fmt(p.adopted?.L_ua)}(理論${U}, ±10%) adopted.L_fa=${fmt(p.adopted?.L_fa)}(理論${F}, ±10%) samples=${JSON.stringify(p.samples)}`;
      return {
        pass,
        detail,
        actual: p,
        expected: { boneOk: true, L_ua: `${U}±10%`, L_fa: `${F}±10%` },
      };
    },
    dryRunPreview() {
      return {
        note:
          "buildPoseElev(45)は腕を画像平面内(z=0一定)で仰角45°に上げるY字相当のポーズ。" +
          "セグメント単位の絶対平面性チェック(|Δz|<0.06)は常にΔz=0で通過するはず。",
        "理論L_ua/L_fa": `${U} / ${F}`,
      };
    },
  },
  {
    // g2タスク新規ケース: ポーズ非依存キャリブレーション(2) — 前傾姿勢の棄却(絶対平面性チェック)。
    // __simReachLR(80,80)を使った既存の parallelism-gate ケース(相対ゲート=ランニング最大比)とは
    // 異なり、こちらは「セッション全体を通して一定角度だけ前傾したまま」というシナリオを再現する。
    // 相対ゲートだけでは、セッション中ずっと同じ角度なら"ランニング最大値=常にその角度の値"に
    // なってしまい毎フレーム自分自身と比較して合格してしまう(=相対ゲートが無力化される)。
    // 絶対平面性チェック(CAL_PLANAR_Z_THRESH)を追加した理由そのものを直接検証するケース。
    id: "new-calibration-frontlean-rejected",
    desc: "__simReach3D(30,45)(前傾を含むリーチ)を較正中ずっと維持→絶対平面性チェックが全フレーム棄却しbone=falseのまま(既定値から汚染されない)",
    requiredHooks: ["__resetCalibration", "__simReach3D", "__calProbe"],
    async run(page) {
      await evalHook(page, "__resetCalibration", []);
      await evalHook(page, "__simReach3D", [30, 45]);
      const hasCalBtn = await page.evaluate(() => !!document.getElementById("calBtn"));
      if (!hasCalBtn) {
        const e = new Error("#calBtn が見つからない(手動較正UIが無い)");
        e.hookMissing = true;
        throw e;
      }
      await page.click("#calBtn");
      await sleep(3500);
      const probe = await page.evaluate(() => window.__calProbe());
      return { probe };
    },
    assert(result) {
      const p = result.probe;
      if (!p) return { pass: false, detail: "__calProbe()がnull(較正が完了していない)", actual: p };
      const boneOk = p.ok?.bone === true;
      const noSamples = p.samples?.ua === 0 && p.samples?.fa === 0;
      const pass = !boneOk && noSamples;
      const detail =
        `ok.bone=${boneOk}(期待false) samples=${JSON.stringify(p.samples)}(期待ua=0,fa=0) ` +
        `adopted.L_ua/L_fa=${fmt(p.adopted?.L_ua)}/${fmt(p.adopted?.L_fa)}(参考、汚染されなければ既定値0.28/0.25のまま)`;
      return {
        pass,
        detail,
        actual: p,
        expected: { boneOk: false, samplesUa: 0, samplesFa: 0 },
      };
    },
    dryRunPreview() {
      const elbowDz = Math.abs(reach3DElbowZ(30, 45)); // = |z(elbow)-z(shoulder)|, shoulder.z=0
      const wristDz = Math.abs(reach3DWristZ(30, 45) - reach3DElbowZ(30, 45)); // = |z(wrist)-z(elbow)|
      return {
        note: "CAL_PLANAR_Z_THRESH既定0.06m。az=30°,el=45°ではua/fa両セグメントとも|Δz|が閾値超のため、収集ウィンドウ全体で1サンプルも採用されないはず。",
        "|Δz|(shoulder-elbow, ua)": elbowDz.toFixed(4) + " > 0.06",
        "|Δz|(elbow-wrist, fa)": wristDz.toFixed(4) + " > 0.06",
      };
    },
  },
  {
    // g2タスク新規ケース: ポーズ非依存キャリブレーション(3) — 左右独立ゲート。
    // 左腕(reachDeg=0、Tポーズ相当でz=0固定=常に画面平行)と右腕(reachDeg=75、常時大きく
    // 前傾=常に棄却)を同時に3秒間流し続ける。g1以前の実装は"ua2d"/"fa2d"が左右共有だったため、
    // 例えばこのケースでは右腕(実際には棄却されるべき)の値が左腕のランニング最大値の分母に
    // 混ざる余地があった。g2でセグメントをchildIndex単位(ua_13/ua_14/fa_15/fa_16)に分離した
    // ことで、左腕の較正が右腕の状態と無関係に成立することを直接確認する。
    id: "new-calibration-side-independent",
    desc: "__simReachLR(0,75)を較正中維持(左=常時平行/右=常時棄却)→左のサンプルのみでL_ua/L_faが理論値にほぼ厳密一致し、右腕の非平行に汚染されない",
    requiredHooks: ["__resetCalibration", "__simReachLR", "__calProbe"],
    async run(page) {
      await evalHook(page, "__resetCalibration", []);
      await evalHook(page, "__simReachLR", [0, 75]);
      const hasCalBtn = await page.evaluate(() => !!document.getElementById("calBtn"));
      if (!hasCalBtn) {
        const e = new Error("#calBtn が見つからない(手動較正UIが無い)");
        e.hookMissing = true;
        throw e;
      }
      await page.click("#calBtn");
      await sleep(3500);
      const probe = await page.evaluate(() => window.__calProbe());
      return { probe };
    },
    assert(result) {
      const p = result.probe;
      if (!p) return { pass: false, detail: "__calProbe()がnull(較正が完了していない)", actual: p };
      const boneOk = p.ok?.bone === true;
      const uaOk = within(p.adopted?.L_ua, U, 0.05, "rel"); // 左のみの寄与のため厳密一致に近い値のはず
      const faOk = within(p.adopted?.L_fa, F, 0.05, "rel");
      const pass = boneOk && uaOk && faOk;
      const detail =
        `ok.bone=${boneOk} adopted.L_ua=${fmt(p.adopted?.L_ua)}(理論${U}, ±5%) adopted.L_fa=${fmt(p.adopted?.L_fa)}(理論${F}, ±5%) samples=${JSON.stringify(p.samples)}`;
      return {
        pass,
        detail,
        actual: p,
        expected: { boneOk: true, L_ua: `${U}±5%`, L_fa: `${F}±5%` },
      };
    },
    dryRunPreview() {
      return {
        note:
          "reachDeg=0(左、Tポーズ相当でz=0固定)とreachDeg=75(右、|Δz|=U·sin75°≈0.2608>>0.06で常時棄却)を" +
          "同時に流す。左右独立ゲートが機能していれば左のサンプルだけが採用され、理論値にほぼ厳密一致するはず。",
        "理論L_ua/L_fa(左のみ寄与)": `${U} / ${F}`,
      };
    },
  },
  {
    // h1タスク新規ケース: 正拳突き(punch)静止ポーズ。buildPosePunch("left",85)は
    //   突き腕(左, 11-13-15): buildPoseReachの片腕版と同じ数学(elbowZ=-U*sinθ, wristZ=-(U+F)*sinθ)。
    //   引き手(右, 12-14-16, チャンバー): セグメント長U/F厳守の閉形式(avatar-depth.htmlのchamberUaDir/
    //   chamberFaDir、導出はexpectations.md参照)。elbowZ=+U*sin(20°)>0(体より後ろ)。
    // Phase1/Phase2に分けているのは、makeHandで手ランドマークを付与するとHAND_ANCHOR_ENABLED既定trueの
    // 手アンカー機構が(手較正済みなら)作動し、extendDeg=85でのリーチ度ρが高いため全重み(w=1)で
    // elbowZ/wristZをプレーンなチェーン理論値から2ボーンIK再構成値へ上書きしてしまうため
    // (実測: 較正ありだとleft.elbowZ=-0.194/wristZ=-0.286で理論値-0.269/-0.518と一致しない)。
    // 手較正を注入しない(=D0未確定でcomputeHandAnchorSideがquality=false経路にフォールバックする、
    // testSurface.md/d2診断の既存仕様どおり)Phase1でチェーン理論値とboneWorldProbeを検証し、
    // 手較正込みのPhase2でr≈handScale(1.4)のみを検証する(regression-handanchor-elbowdeg-monotonicが
    // elbowZでなくelbowDegだけを見ているのと同じ理由の切り分け)。
    id: "new-punch-static",
    desc:
      "__simPunch(\"left\",85): 突き腕(左)elbowZ/wristZが理論値、引き手(右)elbowZ>0(体より後ろ)、" +
      "boneWorldProbeで前後が正しい、手アンカー較正時はr≈1.4",
    requiredHooks: ["__resetCalibration", "__setManualCal", "__simPunch", "__zProbe", "__boneWorldProbe", "__setHandCal"],
    async run(page) {
      // Phase 1: 手アンカー未較正(既定)。チェーン理論値とboneWorldProbe(前後)を検証する。
      // reset→cal→simPunchを単一のpage.evaluateで原子的に実行する: 別々のevaluateに分けると、
      // 直前のケースが残したstale simResult(例: 前ケースの右腕=前方75°リーチ)に対して
      // ブラウザのrAFループが割り込み、resetでinit=falseになった直後のsignState(resolveSignの
      // ヒステリシス)がそのstaleな前方ポーズを見て誤った符号にロックしてしまうことがある
      // (§5.1 optional-fakedepth-signと同種の既知の罠)。チャンバー(引き手)は本ケースが初めて
      // 「正しい符号が-1(後方)」になるケースのため、この罠が実測で顕在化した
      // (既存ケースは正しい符号が常に+1のため、誤ロックされても偶然一致し顕在化しなかった)。
      await page.evaluate(
        ({ ua, fa, side, deg }) => {
          window.__resetCalibration();
          window.__setManualCal(ua, fa);
          window.__simPunch(side, deg);
        },
        { ua: U, fa: F, side: "left", deg: 85 }
      );
      const conv1 = await pollConverge(page);
      const bw1 = conv1.bw || (await page.evaluate((names) => window.__boneWorldProbe(names), ["leftHand", "rightHand", "chest"]));

      // Phase 2: 手アンカー較正済み(HAND_CAL_FIXTURE, handScale基準1.0)。r≈1.4のみを検証する。同じ理由で原子的に実行する。
      await page.evaluate(
        ({ ua, fa, side, deg, cal }) => {
          window.__resetCalibration();
          window.__setManualCal(ua, fa);
          window.__setHandCal(cal);
          if (typeof window.__setHfov === "function") window.__setHfov(60);
          window.__simPunch(side, deg);
        },
        { ua: U, fa: F, side: "left", deg: 85, cal: HAND_CAL_FIXTURE }
      );
      const conv2 = await pollUntilStable(page);

      return { z1: conv1.z, bw1, r: conv2.probe?.handAnchor?.left?.r ?? null };
    },
    assert(result) {
      const theory = {
        "left.elbowZ": { value: reachElbowZ(85), tol: 0.1, mode: "rel" },
        "left.wristZ": { value: reachWristZ(85), tol: 0.1, mode: "rel" },
      };
      const base = assertFields(result.z1, theory);
      const rightElbowZ = result.z1?.right?.elbowZ;
      const rightElbowBack = rightElbowZ != null && rightElbowZ > 0.03; // FALLBACK_THRESH(0.03)超のマージンで「有意に後ろ」
      const bw = result.bw1 || {};
      const punchDz = bw.leftHand && bw.chest ? bw.leftHand.z - bw.chest.z : null;
      const chamberDz = bw.rightHand && bw.chest ? bw.rightHand.z - bw.chest.z : null;
      const punchFwd = punchDz != null && punchDz > 0.15;
      const chamberNotFwd = chamberDz != null && chamberDz < 0.05;
      const rOk = within(result.r, 1.4, 0.1, "rel");
      const pass = base.pass && rightElbowBack && punchFwd && chamberNotFwd && rOk;
      const detail =
        `${base.detail} / right.elbowZ=${fmt(rightElbowZ)}(要>0.03) / ` +
        `boneWorldProbe: punchDz=${fmt(punchDz)}(要>0.15) chamberDz=${fmt(chamberDz)}(要<0.05) / ` +
        `handAnchor.left.r=${fmt(result.r)}(理論1.4, ±10%)`;
      return {
        pass,
        detail,
        actual: { z1: result.z1, bw1: result.bw1, r: result.r },
        expected: {
          "left.elbowZ": reachElbowZ(85),
          "left.wristZ": reachWristZ(85),
          "right.elbowZ": "> +0.03",
          punchDz: "> +0.15",
          chamberDz: "< +0.05",
          r: "1.4 ±10%",
        },
      };
    },
    dryRunPreview() {
      const chamberElbowZ = U * Math.sin(deg2rad(20));
      return {
        "left(突き).elbowZ": reachElbowZ(85).toFixed(4),
        "left(突き).wristZ": reachWristZ(85).toFixed(4),
        "right(引き手).elbowZ": "+" + chamberElbowZ.toFixed(4) + " (>0.03)",
        note: "CHAMBER_UA_DEG=20°/CHAMBER_FA_DEG=50°の閉形式導出はexpectations.md参照。Phase1(手較正無し)/Phase2(手較正あり)の2段階で検証。",
      };
    },
  },
  {
    // h1タスク新規ケース: 正拳突き(punch)連続サイクル。__simPunchCycle({periodMs:600})を
    // 約3秒(≈5突き)実行しながら100ms間隔でプローブし、NaN無し・|z|<1.5*(U+F)で有界・
    // visディップ(1.0→0.3→1.0、extend位相に連動)中にヒステリシスゲートが作動する
    // (gateFlips>0)がフリップ回数は有界であること、停止(__simPunchStop)後にsimResult/simAnimator
    // が両方nullに戻ることを検証する。
    // 手アンカー(HAND_ANCHOR_ENABLED既定true)はテスト開始時に一時的に無効化する:
    // 有効なままだと肘のx/y軸にも独立したゲートキー("13x"/"13y"等)が追加され、1punchあたりの
    // フリップ数がelbow/wrist(zのみ)の理論値4から8に倍増し、CONTRACT.mdが例示する
    // 「1punchあたり≤4」との対応が付けにくくなるため(手アンカー自体の正しさはnew-punch-staticで
    // 別途検証済み)。テスト終了時に必ず元(true)へ戻す(後続ケースへの影響を残さないため)。
    id: "new-punch-cycle",
    desc:
      "__simPunchCycle({periodMs:600})を約3秒実行: NaN無し・|z|<0.78で有界・visディップ中に" +
      "ヒステリシスゲートが作動(gateFlips>0)しつつフリップ回数は有界、停止後はsimResult/simAnimatorがnull",
    requiredHooks: [
      "__resetCalibration",
      "__setManualCal",
      "__setHandAnchor",
      "__simPunchCycle",
      "__simPunchStop",
      "__simAnimState",
      "__zProbe",
      "__gateProbe",
    ],
    async run(page) {
      await resetAndCal(page);
      await evalHook(page, "__setHandAnchor", [false]);
      const periodMs = 600;
      const t0 = await page.evaluate((o) => { window.__simPunchCycle(o); return performance.now(); }, { periodMs });
      const animDuring = await page.evaluate(() => window.__simAnimState());

      const samples = [];
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        // eslint-disable-next-line no-await-in-loop
        samples.push(await page.evaluate(() => window.__zProbe()));
      }
      const [tEnd, gate] = await page.evaluate(() => [performance.now(), window.__gateProbe()]);
      const elapsedMs = tEnd - t0;

      await evalHook(page, "__simPunchStop", []);
      const animAfter = await page.evaluate(() => window.__simAnimState());
      await evalHook(page, "__setHandAnchor", [true]); // 後続ケースを汚染しないよう必ず復元

      return { samples, gate, elapsedMs, periodMs, animDuring, animAfter };
    },
    assert(result) {
      const nums = [];
      for (const s of result.samples) {
        for (const side of ["left", "right"]) {
          const d = s?.[side] || {};
          nums.push(d.elbowZ, d.wristZ);
        }
      }
      const finiteVals = nums.filter((v) => v != null);
      const allFinite = finiteVals.length > 0 && finiteVals.every((v) => Number.isFinite(v));
      const bound = (U + F) * 1.5;
      const bounded = finiteVals.every((v) => Math.abs(v) < bound);
      const totalFlips = Object.values(result.gate?.gateFlips || {}).reduce((a, b) => a + b, 0);
      const punchesLo = Math.floor(result.elapsedMs / result.periodMs);
      const punchesHi = Math.ceil(result.elapsedMs / result.periodMs);
      // 手アンカー無効化時はelbow/wrist(z)各1キー×(凍結開始+解除)の2回=1punchあたり4フリップの設計
      // (buildPosePunchFrameのvis=1→0.3→1の半コサイン往復がHZ.VIS_GATE_MIN/EXITの両方を1回ずつ跨ぐ、
      // --use-angle=metalで100fps超なら実測でも安定して4×punch数±1に収まることを確認済み)。
      // ビート境界と100msサンプリングのずれ・往復開始時の半端分の余裕として1.5倍を掛けた値を上限とする。
      const flipBound = Math.max(8, punchesHi * 4 * 1.5);
      const gateWorked = totalFlips > 0 && totalFlips <= flipBound;
      const animStartedOk = result.animDuring?.hasSimResult === true && result.animDuring?.hasAnimator === true;
      const stoppedClean = result.animAfter?.hasSimResult === false && result.animAfter?.hasAnimator === false;
      const pass = allFinite && bounded && gateWorked && animStartedOk && stoppedClean;
      const detail =
        `samples=${result.samples.length} allFinite=${allFinite} bounded(<${bound.toFixed(3)})=${bounded} maxAbs=${fmt(Math.max(...finiteVals.map(Math.abs)))} / ` +
        `elapsedMs=${fmt(result.elapsedMs)} punches≈${punchesLo}-${punchesHi} totalFlips=${totalFlips}(要 0<flips≤${fmt(flipBound)}) gateFlips=${JSON.stringify(result.gate?.gateFlips)} / ` +
        `animDuring=${JSON.stringify(result.animDuring)} animAfterStop=${JSON.stringify(result.animAfter)}`;
      return {
        pass,
        detail,
        actual: { totalFlips, gateFlips: result.gate?.gateFlips, animDuring: result.animDuring, animAfter: result.animAfter },
        expected: { allFinite: true, boundedBy: bound, gateFlips: `0 < flips <= ${flipBound}`, animDuring: { hasSimResult: true, hasAnimator: true }, animAfter: { hasSimResult: false, hasAnimator: false } },
      };
    },
    dryRunPreview() {
      return {
        note:
          "periodMs=600で約3秒(≈5突き)実行。手アンカーを一時的に無効化し、1punchあたり" +
          "elbow/wrist(z)の凍結開始+解除=4フリップの設計値を基準に、ビート境界のずれを見込んだ" +
          "1.5倍を上限とする。--use-angle=metal(100fps超)前提の設計(低fpsだとエイリアシングで" +
          "フリップ数が環境依存になることを実測確認済み、詳細は本タスクの報告参照)。",
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
