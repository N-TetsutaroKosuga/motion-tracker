#!/usr/bin/env node
// test/tracking/checks.mjs
//
// window.__dump() / window.__stats() の出力に対する不変量チェック(CONTRACT.md記載の暫定閾値)。
// PASS/WARN/FAIL表をコンソールと out/report.md に出力し、失敗時は非ゼロexitする。
//
// 使い方:
//   - run.mjs から `import { runChecks } from "./checks.mjs"` して直接呼ぶ(推奨・通常経路。
//     run.mjs --media <key> で対象メディアを切り替えた場合もこの経路でそのまま動く)
//   - もしくは単体で `node test/tracking/checks.mjs [--media <key>]` を実行し、
//     out/[<key>-]web-landmarks.json / out/[<key>-]web-stats.json を読み込んでチェックする
//     (run.mjsを介さない再チェック用。--media省略時は既定"clip"=既存の out/web-*.json を読む)
//
// 前提となる __dump() の形状(CONTRACT.md, verify.html仕様):
//   { meta: {width, height, startedAt},
//     frames: [{ t, pose2d:[[x,y,z],...33], world:[[x,y,z],...33], vis:[v,...33],
//                hands:{left,right} }] }
// ランドマークindexはMediaPipe Pose/Holisticの標準33点規約
// (11/12=肩, 13/14=肘, 15/16=手首, 23/24=腰, 25/26=膝, 27/28=足首)に従う。
//
// 注意(s1-verifyへの申し送り): verify.htmlは本エージェントと並行実装中のため、__dump()/__stats()
// の実際の出力形状がここでの想定(上記)と細部で食い違う可能性がある。その場合はこのファイルの
// isFrameDetected() / MAJOR_BONES 等の前提をverify.html実装に合わせて調整すること。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "out");

// --- 閾値 (CONTRACT.md 記載の暫定値) ---
export const THRESHOLDS = {
  detectRate: { op: ">", value: 0.9 },
  boneCV: { op: "<", value: 0.15 },
  symmetry: { op: "<", value: 0.2 },
  angleViolationRate: { op: "<", value: 0.05 },
};

// MediaPipe Pose 33点規約: 主要8ボーン(上腕L/R, 前腕L/R, 大腿L/R, 下腿L/R)
const MAJOR_BONES = {
  upperArmL: [11, 13],
  upperArmR: [12, 14],
  forearmL: [13, 15],
  forearmR: [14, 16],
  thighL: [23, 25],
  thighR: [24, 26],
  shinL: [25, 27],
  shinR: [26, 28],
};

// 左右対称性チェック対象ペア(同一フレーム内で4点すべて可視のときだけ比較する)
const SYMMETRY_PAIRS = [
  ["upperArmL", "upperArmR", MAJOR_BONES.upperArmL, MAJOR_BONES.upperArmR],
  ["forearmL", "forearmR", MAJOR_BONES.forearmL, MAJOR_BONES.forearmR],
  ["thighL", "thighR", MAJOR_BONES.thighL, MAJOR_BONES.thighR],
  ["shinL", "shinR", MAJOR_BONES.shinL, MAJOR_BONES.shinR],
];

// コア体幹(肩2点+腰2点)の可視性で「検出フレーム」を判定する
const CORE_LANDMARKS = [11, 12, 23, 24];
const VIS_THRESHOLD = 0.5;

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}

function dist3(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = (a[2] ?? 0) - (b[2] ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isFrameDetected(frame) {
  if (!frame || !Array.isArray(frame.world) || frame.world.length < 33) return false;
  if (!Array.isArray(frame.vis) || frame.vis.length < 33) return false;
  const coreVis = CORE_LANDMARKS.map((i) => frame.vis[i] ?? 0);
  return mean(coreVis) >= VIS_THRESHOLD;
}

// 検出率: verify.html の __dump().frames は「検出成功フレームのみ」を積む設計(33要素固定shapeを
// 保つため)なので、frames.length を分母にすると未検出フレームが構造的に不可視になり検出率が
// 常に100%近くへ水増しされる(s1-verifyで発見)。verify.html側はこれに対応して
// meta.totalTicks / meta.detectedTicks (記録区間中の全処理試行回数/検出成功回数)を別途持つように
// なったので、それが使える場合は優先する。古い__dump()実装(meta.totalTicksが無い場合)との
// 後方互換のため、無ければ frames.length ベースの近似にフォールバックする
// (その場合 detectRate は上振れした概算値になる点に注意)。
function computeDetectRate(frames, meta) {
  if (meta && typeof meta.totalTicks === "number" && meta.totalTicks > 0) {
    const detected = typeof meta.detectedTicks === "number" ? meta.detectedTicks : frames.length;
    return { rate: detected / meta.totalTicks, detected, total: meta.totalTicks, approximated: false };
  }
  if (!frames || !frames.length) return { rate: 0, detected: 0, total: 0, approximated: true };
  const detected = frames.filter(isFrameDetected).length;
  return { rate: detected / frames.length, detected, total: frames.length, approximated: true };
}

// 主要ボーン長のフレーム系列(可視条件を満たすフレームのみ)を作る
function collectBoneLengthSeries(frames) {
  const series = {};
  for (const name of Object.keys(MAJOR_BONES)) series[name] = [];
  for (const f of frames) {
    if (!isFrameDetected(f)) continue;
    for (const [name, [i, j]] of Object.entries(MAJOR_BONES)) {
      const vi = f.vis[i] ?? 0;
      const vj = f.vis[j] ?? 0;
      if (vi < VIS_THRESHOLD || vj < VIS_THRESHOLD) continue;
      const len = dist3(f.world[i], f.world[j]);
      if (Number.isFinite(len) && len > 1e-4) series[name].push(len);
    }
  }
  return series;
}

function computeBoneCV(frames) {
  const series = collectBoneLengthSeries(frames);
  const perBone = {};
  for (const [name, lens] of Object.entries(series)) {
    if (lens.length < 5) {
      perBone[name] = null; // サンプル不足
      continue;
    }
    const m = mean(lens);
    const s = std(lens);
    perBone[name] = m > 1e-6 ? s / m : null;
  }
  const valid = Object.entries(perBone).filter(([, v]) => v != null);
  const overall = valid.length ? mean(valid.map(([, v]) => v)) : null;
  let worst = null;
  for (const [name, v] of valid) {
    if (worst == null || v > worst.cv) worst = { bone: name, cv: v };
  }
  return { overall, worst, perBone };
}

// 左右対称性: 同一フレーム内で対応ボーン(L/R)の長さ差を相対誤差として集計
function computeSymmetry(frames) {
  const errs = [];
  for (const f of frames) {
    if (!isFrameDetected(f)) continue;
    for (const [, , [li, lj], [ri, rj]] of SYMMETRY_PAIRS) {
      const visOk = [li, lj, ri, rj].every((idx) => (f.vis[idx] ?? 0) >= VIS_THRESHOLD);
      if (!visOk) continue;
      const lLen = dist3(f.world[li], f.world[lj]);
      const rLen = dist3(f.world[ri], f.world[rj]);
      const denom = (lLen + rLen) / 2;
      if (denom > 1e-6) errs.push(Math.abs(lLen - rLen) / denom);
    }
  }
  return { overall: errs.length ? mean(errs) : null, samples: errs.length };
}

// 関節角逸脱率: verify.html側が累積カウントしている stats.angleViolations を
// 「検出フレーム数」に対する比率として評価する(独自の生理的可動域テーブルを
// checks.mjs側で二重実装しない方針。詳細はファイル冒頭の申し送りコメント参照)。
function computeAngleViolationRate(stats, detectedFrameCount) {
  const count = stats?.angleViolations;
  if (typeof count !== "number" || !detectedFrameCount) {
    return { rate: null, count: count ?? null, denominator: detectedFrameCount };
  }
  return { rate: count / detectedFrameCount, count, denominator: detectedFrameCount };
}

function judge(op, value, threshold) {
  if (value == null || Number.isNaN(value)) return "FAIL"; // 値が取れない = 不変量崩壊とみなす
  if (op === ">") return value > threshold ? "PASS" : "FAIL";
  if (op === "<") return value < threshold ? "PASS" : "FAIL";
  throw new Error(`unknown op: ${op}`);
}

function fmtNum(v, digits = 4) {
  return v == null || Number.isNaN(v) ? "N/A" : v.toFixed(digits);
}

function fmtPct(v, digits = 1) {
  return v == null || Number.isNaN(v) ? "N/A" : `${(v * 100).toFixed(digits)}%`;
}

// dump: __dump()の返り値, stats: __stats()の返り値
export function runChecks(dump, stats) {
  const frames = Array.isArray(dump?.frames) ? dump.frames : [];
  const { rate: detectRate, detected, total, approximated } = computeDetectRate(frames, dump?.meta);
  const boneCV = computeBoneCV(frames);
  const symmetry = computeSymmetry(frames);
  const angleViol = computeAngleViolationRate(stats, detected);

  const rows = [
    {
      metric: "detectRate",
      value: detectRate,
      fmt: fmtPct(detectRate),
      thresholdText: `> ${THRESHOLDS.detectRate.value * 100}%`,
      verdict: judge(THRESHOLDS.detectRate.op, detectRate, THRESHOLDS.detectRate.value),
      detail: `検出 ${detected}/${total} フレーム${approximated ? "(注: meta.totalTicks無し。framesベースの近似値=水増しの疑いあり)" : "(meta.totalTicks基準の実測値)"}`,
    },
    {
      metric: "boneCV (主要8ボーン, overall)",
      value: boneCV.overall,
      fmt: fmtNum(boneCV.overall),
      thresholdText: `< ${THRESHOLDS.boneCV.value}`,
      verdict: judge(THRESHOLDS.boneCV.op, boneCV.overall, THRESHOLDS.boneCV.value),
      detail: boneCV.worst
        ? `worst: ${boneCV.worst.bone} (cv=${fmtNum(boneCV.worst.cv)})`
        : "有効サンプル不足",
    },
    {
      metric: "symmetry (左右対称性誤差, overall)",
      value: symmetry.overall,
      fmt: fmtNum(symmetry.overall),
      thresholdText: `< ${THRESHOLDS.symmetry.value}`,
      verdict: judge(THRESHOLDS.symmetry.op, symmetry.overall, THRESHOLDS.symmetry.value),
      detail: `サンプル数=${symmetry.samples}`,
    },
    {
      metric: "angleViolationRate (関節角逸脱率)",
      value: angleViol.rate,
      fmt: fmtPct(angleViol.rate),
      thresholdText: `< ${THRESHOLDS.angleViolationRate.value * 100}%`,
      verdict: judge(
        THRESHOLDS.angleViolationRate.op,
        angleViol.rate,
        THRESHOLDS.angleViolationRate.value
      ),
      detail: `stats.angleViolations=${angleViol.count ?? "N/A"} / 検出フレーム数=${angleViol.denominator ?? "N/A"}`,
    },
  ];

  const pass = rows.every((r) => r.verdict === "PASS");

  const lines = [];
  lines.push("# トラッキング不変量チェック レポート (test/tracking)");
  lines.push("");
  lines.push(`生成日時: ${new Date().toISOString()}`);
  lines.push(`総フレーム数: ${total} / 検出フレーム数: ${detected}`);
  if (stats?.fps != null) lines.push(`stats.fps (直近5秒窓): ${stats.fps}`);
  lines.push("");
  lines.push("| 指標 | 実測値 | 閾値 | 判定 | 詳細 |");
  lines.push("|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(`| ${r.metric} | ${r.fmt} | ${r.thresholdText} | ${r.verdict} | ${r.detail} |`);
  }
  lines.push("");
  lines.push(`## 総合判定: ${pass ? "PASS" : "FAIL"}`);
  lines.push("");
  lines.push("### 前提・注記");
  lines.push("- detectRate は __dump().meta.totalTicks/detectedTicks(記録区間中の全処理試行回数/検出成功回数)を優先的に使用する。__dump().frames は検出成功フレームのみを含む設計のため、meta.totalTicksが無い実装では frames.length を分母にした近似値にフォールバックする(その場合は水増しの疑いがある旨を明記する。s1-verifyで発見・修正)。");
  lines.push("- boneCV / symmetry は __dump() の生フレーム(pose2d/world/vis)から checks.mjs が独立に再計算した値(verify.htmlの自己申告値ではない)。");
  lines.push("- angleViolationRate のみ __stats().angleViolations (verify.html側の累積カウント)を検出フレーム数で割った近似値。生理的可動域テーブルの二重実装を避けるための簡略化。");
  lines.push("- 主要8ボーン: upperArmL/R(11-13/12-14), forearmL/R(13-15/14-16), thighL/R(23-25/24-26), shinL/R(25-27/26-28)。可視性(vis)>=0.5の両端点を持つフレームのみ集計対象。");
  lines.push("- 本ファイルはverify.htmlの実装(s1-page, s1-verifyフェーズで確定)と並行して書かれたもの。__dump()の実際の形状がここでの想定と異なる場合は前提を調整すること。");

  const reportMd = lines.join("\n") + "\n";

  // コンソール表示用(Markdown表と同内容をそのまま出す)
  console.log(reportMd);

  return { pass, rows, reportMd, computed: { detectRate, detected, total, boneCV, symmetry, angleViol } };
}

// --media <key> (既定 "clip")。run.mjs と同じ命名規則(clip以外は out/<key>-xxx)で読み書きする。
function parseMediaKey(argv) {
  const idx = argv.indexOf("--media");
  if (idx === -1 || idx + 1 >= argv.length) return "clip";
  const key = argv[idx + 1];
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    throw new Error(`invalid --media value: ${key}`);
  }
  return key;
}

async function mainStandalone() {
  const mediaKey = parseMediaKey(process.argv);
  const outName = (base) => (mediaKey === "clip" ? base : `${mediaKey}-${base}`);
  const dumpPath = path.join(OUT_DIR, outName("web-landmarks.json"));
  const statsPath = path.join(OUT_DIR, outName("web-stats.json"));
  const reportPath = path.join(OUT_DIR, outName("report.md"));
  if (!fs.existsSync(dumpPath) || !fs.existsSync(statsPath)) {
    console.error(
      `[checks] ${dumpPath} / ${statsPath} が見つかりません。先に node test/tracking/run.mjs --media ${mediaKey} を実行してください。`
    );
    process.exit(1);
  }
  const dump = JSON.parse(await fsp.readFile(dumpPath, "utf8"));
  const stats = JSON.parse(await fsp.readFile(statsPath, "utf8"));
  const { pass, reportMd } = runChecks(dump, stats);
  await fsp.mkdir(OUT_DIR, { recursive: true });
  await fsp.writeFile(reportPath, reportMd);
  process.exit(pass ? 0 : 1);
}

// `node test/tracking/checks.mjs` として直接実行された場合のみスタンドアロン動作する
if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  mainStandalone();
}
