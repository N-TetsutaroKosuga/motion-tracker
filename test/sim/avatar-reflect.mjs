#!/usr/bin/env node
// test/sim/avatar-reflect.mjs
// ---------------------------------------------------------------------------
// シミュレーション姿勢が VRM アバターに正しく反映されているかを検証する。
// 既存の test/sim/run.mjs が z 融合・手アンカー等を広く見るのに対し、本ランナーは
// 「シムポーズ → アバター骨の向き/位置」に絞る。
//
//   node test/sim/avatar-reflect.mjs
//   node test/sim/avatar-reflect.mjs --headed
// ---------------------------------------------------------------------------

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(__dirname, "out");
const SHOT_DIR = path.join(OUT_DIR, "avatar-reflect-shots");
const ENTRY_HTML = "avatar-depth.html";
const HEADED = process.argv.includes("--headed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const U = 0.27;
const F = 0.25;
const deg2rad = (d) => (d * Math.PI) / 180;

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
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function pollConverge(page, { maxMs = 8000, intervalMs = 200, epsilon = 0.01, stableStreak = 2 } = {}) {
  const extract = () => {
    const z = typeof window.__zProbe === "function" ? window.__zProbe() : null;
    const a = typeof window.__armProbe === "function" ? window.__armProbe() : null;
    const bw =
      typeof window.__boneWorldProbe === "function"
        ? window.__boneWorldProbe([
            "leftHand",
            "rightHand",
            "leftShoulder",
            "rightShoulder",
            "leftUpperArm",
            "rightUpperArm",
            "leftLowerArm",
            "rightLowerArm",
            "chest",
            "hips",
          ])
        : null;
    const b3 = typeof window.__b3Probe === "function" ? window.__b3Probe() : null;
    const flat = [];
    if (z) for (const s of ["left", "right"]) {
      const d = z[s] || {};
      flat.push(d.elbowZ, d.wristZ);
    }
    if (a) for (const s of ["left", "right"]) {
      const d = a[s] || {};
      flat.push(d?.x, d?.y, d?.z);
    }
    if (bw) for (const k of Object.keys(bw)) {
      const p = bw[k];
      if (p) flat.push(p.x, p.y, p.z);
    }
    return { flat, z, a, bw, b3 };
  };
  let prev = null;
  let streak = 0;
  let elapsed = 0;
  let sample = await page.evaluate(extract);
  while (elapsed <= maxMs) {
    if (prev) {
      const deltas = sample.flat.map((v, i) =>
        v == null || prev[i] == null ? Infinity : Math.abs(v - prev[i])
      );
      const maxDelta = deltas.length ? Math.max(...deltas) : Infinity;
      if (maxDelta < epsilon) {
        streak++;
        if (streak >= stableStreak) {
          return { ...sample, converged: true, elapsedMs: elapsed };
        }
      } else streak = 0;
    }
    prev = sample.flat;
    if (elapsed >= maxMs) break;
    await sleep(intervalMs);
    elapsed += intervalMs;
    sample = await page.evaluate(extract);
  }
  return { ...sample, converged: false, elapsedMs: elapsed };
}

function fmt(v) {
  if (v == null) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? v.toFixed(3) : String(v);
  return String(v);
}

function handDz(bw, side) {
  const hand = bw?.[`${side}Hand`];
  const chest = bw?.chest;
  if (!hand || !chest) return null;
  return hand.z - chest.z;
}

function handOx(bw, side) {
  const hand = bw?.[`${side}Hand`];
  const shoulder = bw?.[`${side}Shoulder`];
  if (!hand || !shoulder) return null;
  return hand.x - shoulder.x;
}

function handDy(bw, side) {
  const hand = bw?.[`${side}Hand`];
  const shoulder = bw?.[`${side}Shoulder`];
  if (!hand || !shoulder) return null;
  return hand.y - shoulder.y;
}

/** ケース定義: シム投入 → アバター骨の期待条件 */
const CASES = [
  {
    id: "tpose-arms-lateral",
    desc: "Tポーズ: 両腕が横方向に伸び、前後(handZ-chestZ)は中立付近",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simPose("tpose");
      });
    },
    assert({ a, bw }) {
      const checks = [];
      // 上腕方向: 左は +X、右は -X 寄り
      const leftOut = a?.left?.x != null && a.left.x > 0.7;
      const rightOut = a?.right?.x != null && a.right.x < -0.7;
      checks.push({ name: "leftUpperArm.x > 0.7", ok: leftOut, actual: a?.left });
      checks.push({ name: "rightUpperArm.x < -0.7", ok: rightOut, actual: a?.right });
      const dzL = handDz(bw, "left");
      const dzR = handDz(bw, "right");
      checks.push({ name: "|left handZ-chestZ| < 0.15", ok: dzL != null && Math.abs(dzL) < 0.15, actual: dzL });
      checks.push({ name: "|right handZ-chestZ| < 0.15", ok: dzR != null && Math.abs(dzR) < 0.15, actual: dzR });
      const oxL = handOx(bw, "left");
      const oxR = handOx(bw, "right");
      checks.push({ name: "left |handX-shoulderX| > 0.35", ok: oxL != null && Math.abs(oxL) > 0.35, actual: oxL });
      checks.push({ name: "right |handX-shoulderX| > 0.35", ok: oxR != null && Math.abs(oxR) > 0.35, actual: oxR });
      return checks;
    },
  },
  {
    id: "elev-up-arms-raise",
    desc: "__simElev(60): 両腕が上方向へ上がる(armProbe.y が正、hand が肩より上)",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simElev(60);
      });
    },
    assert({ a, bw }) {
      const checks = [];
      checks.push({ name: "left.arm.y > 0.4", ok: a?.left?.y != null && a.left.y > 0.4, actual: a?.left });
      checks.push({ name: "right.arm.y > 0.4", ok: a?.right?.y != null && a.right.y > 0.4, actual: a?.right });
      const dyL = handDy(bw, "left");
      const dyR = handDy(bw, "right");
      // VRM: +Y が上
      checks.push({ name: "left handY-shoulderY > 0.15", ok: dyL != null && dyL > 0.15, actual: dyL });
      checks.push({ name: "right handY-shoulderY > 0.15", ok: dyR != null && dyR > 0.15, actual: dyR });
      return checks;
    },
  },
  {
    id: "elev-down-arms-lower",
    desc: "__simElev(-60): 両腕が下方向へ下がる(armProbe.y が負)",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simElev(-60);
      });
    },
    assert({ a, bw }) {
      const checks = [];
      checks.push({ name: "left.arm.y < -0.4", ok: a?.left?.y != null && a.left.y < -0.4, actual: a?.left });
      checks.push({ name: "right.arm.y < -0.4", ok: a?.right?.y != null && a.right.y < -0.4, actual: a?.right });
      const dyL = handDy(bw, "left");
      const dyR = handDy(bw, "right");
      checks.push({ name: "left handY-shoulderY < -0.15", ok: dyL != null && dyL < -0.15, actual: dyL });
      checks.push({ name: "right handY-shoulderY < -0.15", ok: dyR != null && dyR < -0.15, actual: dyR });
      return checks;
    },
  },
  {
    id: "reach60-both-forward",
    desc: "__simReach(60): 両腕が前方(handZ-chestZ > +0.25)かつ横伸びしすぎない",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simReach(60);
      });
    },
    assert({ a, bw, z, b3 }) {
      const checks = [];
      const dzL = handDz(bw, "left");
      const dzR = handDz(bw, "right");
      checks.push({ name: "left handZ-chestZ > 0.25", ok: dzL != null && dzL > 0.25, actual: dzL });
      checks.push({ name: "right handZ-chestZ > 0.25", ok: dzR != null && dzR > 0.25, actual: dzR });
      // 上腕方向も前方寄り(VRM: +Z がカメラ/前方側になる想定 — 既存 absolute-forward と整合)
      checks.push({
        name: "left.arm.z > 0.3 (forward-ish)",
        ok: a?.left?.z != null && a.left.z > 0.3,
        actual: a?.left,
      });
      checks.push({
        name: "right.arm.z > 0.3 (forward-ish)",
        ok: a?.right?.z != null && a.right.z > 0.3,
        actual: a?.right,
      });
      // fused z も負(手前)であること
      checks.push({
        name: "zProbe.left.wristZ < -0.2",
        ok: z?.left?.wristZ != null && z.left.wristZ < -0.2,
        actual: z?.left?.wristZ,
      });
      checks.push({
        name: "zProbe.right.wristZ < -0.2",
        ok: z?.right?.wristZ != null && z.right.wristZ < -0.2,
        actual: z?.right?.wristZ,
      });
      // B3 ブレンドが中〜高リーチで効いているか(情報。失敗でも WARN 扱い)
      const rhoL = b3?.left?.ua?.rho;
      const rhoR = b3?.right?.ua?.rho;
      checks.push({
        name: "b3.left.ua.rho > 0 (info)",
        ok: true,
        warn: !(rhoL > 0),
        actual: { rho: rhoL, blended: b3?.left?.ua?.blended },
      });
      checks.push({
        name: "b3.right.ua.rho > 0 (info)",
        ok: true,
        warn: !(rhoR > 0),
        actual: { rho: rhoR, blended: b3?.right?.ua?.blended },
      });
      return checks;
    },
  },
  {
    id: "reach85-strong-forward",
    desc: "__simReach(85): 高リーチで前方伸展が強く、B3 直接 quat が効く",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simReach(85);
      });
    },
    assert({ a, bw, b3 }) {
      const checks = [];
      const dzL = handDz(bw, "left");
      const dzR = handDz(bw, "right");
      checks.push({ name: "left handZ-chestZ > 0.30", ok: dzL != null && dzL > 0.3, actual: dzL });
      checks.push({ name: "right handZ-chestZ > 0.30", ok: dzR != null && dzR > 0.3, actual: dzR });
      const oxL = handOx(bw, "left");
      const oxR = handOx(bw, "right");
      checks.push({ name: "left |ox| < 0.25", ok: oxL != null && Math.abs(oxL) < 0.25, actual: oxL });
      checks.push({ name: "right |ox| < 0.25", ok: oxR != null && Math.abs(oxR) < 0.25, actual: oxR });
      // 高リーチでは B3 が効くはず (REACH_BLEND_LO=0.8, sin85≈0.996)
      const rhoL = b3?.left?.ua?.rho ?? 0;
      const rhoR = b3?.right?.ua?.rho ?? 0;
      checks.push({ name: "b3.left.ua.rho > 0.5", ok: rhoL > 0.5, actual: b3?.left?.ua });
      checks.push({ name: "b3.right.ua.rho > 0.5", ok: rhoR > 0.5, actual: b3?.right?.ua });
      checks.push({
        name: "left.arm.z > 0.5",
        ok: a?.left?.z != null && a.left.z > 0.5,
        actual: a?.left,
      });
      checks.push({
        name: "right.arm.z > 0.5",
        ok: a?.right?.z != null && a.right.z > 0.5,
        actual: a?.right,
      });
      return checks;
    },
  },
  {
    id: "reachLR-asymmetric",
    desc: "__simReachLR(75,0): 左のみ前方、右は横/中立。左右が混ざらない",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simReachLR(75, 0);
      });
    },
    assert({ bw, z }) {
      const checks = [];
      // mediapipe left(11/13/15) → VRM rightHand (Kalidokit ミラー)
      const punchDz = handDz(bw, "right"); // VRM right = mediapipe left punch side
      const otherDz = handDz(bw, "left");
      checks.push({
        name: "VRM rightHand (mp-left) forward dz > 0.25",
        ok: punchDz != null && punchDz > 0.25,
        actual: punchDz,
      });
      checks.push({
        name: "VRM leftHand (mp-right) not strongly forward dz < 0.15",
        ok: otherDz != null && otherDz < 0.15,
        actual: otherDz,
      });
      checks.push({
        name: "zProbe.left.wristZ < -0.2",
        ok: z?.left?.wristZ != null && z.left.wristZ < -0.2,
        actual: z?.left?.wristZ,
      });
      checks.push({
        name: "|zProbe.right.wristZ| < 0.08",
        ok: z?.right?.wristZ != null && Math.abs(z.right.wristZ) < 0.08,
        actual: z?.right?.wristZ,
      });
      return checks;
    },
  },
  {
    id: "punch-left-avatar-forward",
    desc: "__simPunch(left,85): 突き腕(VRM rightHand)が前方、引き手は前方に出ない",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simPunch("left", 85);
      });
    },
    assert({ bw, z, a }) {
      const checks = [];
      const punchDz = handDz(bw, "right");
      const chamberDz = handDz(bw, "left");
      const punchOx = handOx(bw, "right");
      checks.push({ name: "punchDz(rightHand) > 0.30", ok: punchDz != null && punchDz > 0.3, actual: punchDz });
      checks.push({ name: "chamberDz(leftHand) < 0.05", ok: chamberDz != null && chamberDz < 0.05, actual: chamberDz });
      checks.push({ name: "|punchOx| < 0.20", ok: punchOx != null && Math.abs(punchOx) < 0.2, actual: punchOx });
      checks.push({
        name: "zProbe.left.wristZ ≈ -(U+F)*sin85",
        ok: z?.left?.wristZ != null && Math.abs(z.left.wristZ - -(U + F) * Math.sin(deg2rad(85))) / ((U + F) * Math.sin(deg2rad(85))) < 0.15,
        actual: { wristZ: z?.left?.wristZ, theory: -(U + F) * Math.sin(deg2rad(85)) },
      });
      checks.push({
        name: "right.arm.z > 0.5 (punch arm forward)",
        ok: a?.right?.z != null && a.right.z > 0.5,
        actual: a?.right,
      });
      return checks;
    },
  },
  {
    id: "cross40-crossing-arm",
    desc: "__simCross(40): 交差腕が正中線を越え、前方を維持",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simPose("tpose");
      });
      await pollConverge(page, { maxMs: 4000 });
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simCross(40);
      });
    },
    assert({ a, bw, z }, ctx) {
      const checks = [];
      // mediapipe left cross → VRM right
      const crossDz = handDz(bw, "right");
      checks.push({
        name: "cross arm (rightHand) forward dz > 0.15",
        ok: crossDz != null && crossDz > 0.15,
        actual: crossDz,
      });
      checks.push({
        name: "zProbe.left.wristZ < 0",
        ok: z?.left?.wristZ != null && z.left.wristZ < 0,
        actual: z?.left?.wristZ,
      });
      // tpose 基準の right.x と比べて符号が反転していること(既存 new-cross-40 と同趣旨)
      const baseX = ctx?.tposeArmRightX;
      const crossX = a?.right?.x;
      const flipped = baseX != null && crossX != null && Math.sign(baseX) !== Math.sign(crossX) && Math.abs(crossX - baseX) > 0.3;
      checks.push({
        name: "armProbe.right.x flipped vs tpose",
        ok: flipped,
        actual: { baseX, crossX },
      });
      return checks;
    },
    async beforeAssert(page) {
      // tpose の right.x を先に取る
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simPose("tpose");
      });
      const conv = await pollConverge(page, { maxMs: 5000 });
      return { tposeArmRightX: conv.a?.right?.x };
    },
  },
  {
    id: "reach3d-45-30-composite",
    desc: "__simReach3D(45,30): 方位+仰角の複合がアバターに反映(前方かつ上)",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__simReach3D(45, 30, "both");
      });
    },
    assert({ a, bw, z }) {
      const checks = [];
      const dzL = handDz(bw, "left");
      const dzR = handDz(bw, "right");
      const dyL = handDy(bw, "left");
      const dyR = handDy(bw, "right");
      checks.push({ name: "left dz > 0.10", ok: dzL != null && dzL > 0.1, actual: dzL });
      checks.push({ name: "right dz > 0.10", ok: dzR != null && dzR > 0.1, actual: dzR });
      checks.push({ name: "left dy > 0.05", ok: dyL != null && dyL > 0.05, actual: dyL });
      checks.push({ name: "right dy > 0.05", ok: dyR != null && dyR > 0.05, actual: dyR });
      const theoryEz = -U * Math.cos(deg2rad(30)) * Math.sin(deg2rad(45));
      checks.push({
        name: "zProbe.left.elbowZ ≈ theory",
        ok: z?.left?.elbowZ != null && Math.abs(z.left.elbowZ - theoryEz) / Math.max(Math.abs(theoryEz), 1e-3) < 0.15,
        actual: { elbowZ: z?.left?.elbowZ, theory: theoryEz },
      });
      checks.push({
        name: "arm.y both positive-ish",
        ok: a?.left?.y != null && a.left.y > 0.1 && a?.right?.y != null && a.right.y > 0.1,
        actual: { left: a?.left, right: a?.right },
      });
      return checks;
    },
  },
  {
    id: "ui-pose-buttons",
    desc: "UI の data-sim ボタン(tpose→punch)でもアバターが前方突きになる",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        // UI 経路は手動較正なし(自動較正)を再現
      });
      await page.click('[data-sim="tpose"]');
      await pollConverge(page, { maxMs: 4000 });
      await page.click('[data-sim="punch"]');
    },
    assert({ bw }) {
      const checks = [];
      // UI punch = buildPosePunch("left", 85) → VRM rightHand
      const punchDz = handDz(bw, "right");
      const chamberDz = handDz(bw, "left");
      checks.push({
        name: "UI punch: rightHand dz > 0.20",
        ok: punchDz != null && punchDz > 0.2,
        actual: punchDz,
      });
      checks.push({
        name: "UI punch: leftHand (chamber) dz < 0.10",
        ok: chamberDz != null && chamberDz < 0.1,
        actual: chamberDz,
      });
      return checks;
    },
  },
  {
    id: "punch-cycle-peak-reach",
    desc: "__simPunchCycle(800ms): ピーク punchDz>0.30 かつ arm.z>0.6 (静止パンチ並みの追従)",
    // 動的ケース: apply でサイクル開始、assert は runCase 側の peak サンプルを使う
    dynamic: true,
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        // visDip=false: ゲート凍結でピークが潰れる経路は new-punch-cycle が別途検証。
        // ここでは「アバターがフル伸展まで追従するか」を見る。
        window.__simPunchCycle({ periodMs: 800, alternate: false, visDip: false });
      });
    },
    async samplePeak(page) {
      let maxDz = -Infinity;
      let best = null;
      for (let i = 0; i < 40; i++) {
        await sleep(50);
        const s = await page.evaluate(() => {
          const bw = window.__boneWorldProbe(["leftHand", "rightHand", "chest"]);
          const a = window.__armProbe();
          const b3 = window.__b3Probe?.() || null;
          return {
            punchDz: bw.rightHand.z - bw.chest.z,
            chamberDz: bw.leftHand.z - bw.chest.z,
            armRz: a?.right?.z,
            armRy: a?.right?.y,
            b3rho: b3?.right?.ua?.rho ?? null,
          };
        });
        if (s.punchDz > maxDz) {
          maxDz = s.punchDz;
          best = s;
        }
      }
      await page.evaluate(() => window.__simPunchStop());
      return best;
    },
    assertPeak(peak) {
      const checks = [];
      checks.push({
        name: "peak punchDz > 0.30",
        ok: peak != null && peak.punchDz > 0.3,
        actual: peak?.punchDz,
      });
      checks.push({
        name: "peak arm.z > 0.6",
        ok: peak != null && peak.armRz != null && peak.armRz > 0.6,
        actual: peak?.armRz,
      });
      checks.push({
        name: "chamber stays back dz < 0.08",
        ok: peak != null && peak.chamberDz < 0.08,
        actual: peak?.chamberDz,
      });
      return checks;
    },
  },
  {
    id: "punch-ha-underestimate-reject",
    desc: "手較正が r≈1.05(Δz過小)でも幾何チェーンを優先し前方突きを維持する",
    async apply(page) {
      await page.evaluate(() => {
        window.__resetCalibration();
        window.__setManualCal(0.27, 0.25);
        window.__setHfov(60);
        window.__setHandAnchor(true);
        // 開き手基準の較正を、拳シムに対して r≈1.05 になるようスケールして注入
        // (ユーザー実機: L w=1.00 r=1.05 Δz=0.04 で前方リーチが潰れる症状の再現)
        window.__simPunch("left", 85);
      });
      await sleep(200);
      await page.evaluate(() => {
        // 現在の拳サイズで r を測り、r=1.05 になる較正へ差し替える
        const z = window.__zProbe();
        // まず open-hand fixture を入れて拳の r を得る
        window.__setHandCal({
          d09_0: { 15: 0.0084, 16: 0.0084 },
          d517_0: { 15: 0.0528, 16: 0.0528 },
          W_m: 0.3464103,
          w_n: 0.3,
        });
      });
      await sleep(400);
      await page.evaluate(() => {
        const r = window.__zProbe()?.handAnchor?.left?.r;
        if (!(r > 0)) return;
        const scale = r / 1.05;
        window.__setHandCal({
          d09_0: { 15: 0.0084 * scale, 16: 0.0084 * scale },
          d517_0: { 15: 0.0528 * scale, 16: 0.0528 * scale },
          W_m: 0.3464103,
          w_n: 0.3,
        });
        window.__simPunch("left", 85);
      });
    },
    assert({ bw, z, a }) {
      const checks = [];
      const punchDz = handDz(bw, "right");
      const punchOx = handOx(bw, "right");
      const ha = z?.handAnchor?.left;
      // ゲートが効いていれば w は減衰し、幾何の前方リーチが残る
      checks.push({
        name: "punchDz > 0.28 (not collapsed by HA)",
        ok: punchDz != null && punchDz > 0.28,
        actual: punchDz,
      });
      checks.push({
        name: "arm.z > 0.7",
        ok: a?.right?.z != null && a.right.z > 0.7,
        actual: a?.right,
      });
      checks.push({
        name: "|punchOx| < 0.25",
        ok: punchOx != null && Math.abs(punchOx) < 0.25,
        actual: punchOx,
      });
      checks.push({
        name: "HA w decayed or dz rejected (w < 0.3)",
        ok: ha == null || ha.w < 0.3,
        actual: ha,
      });
      checks.push({
        name: "zProbe.left.wristZ < -0.25 (geometry kept)",
        ok: z?.left?.wristZ != null && z.left.wristZ < -0.25,
        actual: z?.left?.wristZ,
      });
      return checks;
    },
  },
];

async function setupPage() {
  const { chromium } = await import("playwright");
  const server = await startStaticServer(REPO_ROOT);
  const { port } = server.address();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--use-angle=metal"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("[page error]", err.message));
  await page.goto(`http://127.0.0.1:${port}/${ENTRY_HTML}`);
  await page.waitForFunction(() => window.__vrmReady === true, null, { timeout: 60000 });
  // 側面ビューで前後が目視しやすい角度に
  await page.evaluate(() => {
    if (typeof window.__view === "function") window.__view(55);
  });
  return { server, browser, page };
}

async function runCase(page, c) {
  const t0 = Date.now();
  try {
    if (c.dynamic) {
      await c.apply(page);
      const peak = await c.samplePeak(page);
      const checks = c.assertPeak(peak);
      const failed = checks.filter((x) => !x.ok);
      const shotPath = path.join(SHOT_DIR, `${c.id}.png`);
      await page.screenshot({ path: shotPath, fullPage: false });
      return {
        id: c.id,
        desc: c.desc,
        status: failed.length ? "FAIL" : "PASS",
        detail: checks
          .map((x) => `${x.ok ? "OK" : "NG"} ${x.name}: ${fmt(typeof x.actual === "object" ? JSON.stringify(x.actual) : x.actual)}`)
          .join(" / "),
        checks,
        elapsedMs: Date.now() - t0,
        shot: shotPath,
        sample: { peak },
      };
    }

    let ctx = {};
    if (typeof c.beforeAssert === "function") {
      ctx = (await c.beforeAssert(page)) || {};
    }
    await c.apply(page);
    const conv = await pollConverge(page);
    const checks = c.assert(
      { a: conv.a, bw: conv.bw, z: conv.z, b3: conv.b3 },
      { ...ctx, tposeArmRightX: ctx.tposeArmRightX ?? conv.a?.right?.x }
    );
    const failed = checks.filter((x) => !x.ok);
    const warns = checks.filter((x) => x.warn);
    const shotPath = path.join(SHOT_DIR, `${c.id}.png`);
    await page.screenshot({ path: shotPath, fullPage: false });
    return {
      id: c.id,
      desc: c.desc,
      status: failed.length ? "FAIL" : "PASS",
      detail: checks
        .map((x) => `${x.ok ? "OK" : "NG"}${x.warn ? "(warn)" : ""} ${x.name}: ${fmt(typeof x.actual === "object" ? JSON.stringify(x.actual) : x.actual)}`)
        .join(" / "),
      checks,
      warns: warns.length,
      converged: conv.converged,
      elapsedMs: Date.now() - t0,
      shot: shotPath,
      sample: {
        arm: conv.a,
        z: conv.z
          ? {
              left: conv.z.left,
              right: conv.z.right,
            }
          : null,
        dz: { left: handDz(conv.bw, "left"), right: handDz(conv.bw, "right") },
        b3: conv.b3,
      },
    };
  } catch (e) {
    return {
      id: c.id,
      desc: c.desc,
      status: "ERROR",
      detail: e && e.stack ? e.stack : String(e),
      elapsedMs: Date.now() - t0,
    };
  }
}

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });
  if (!existsSync(SHOT_DIR)) await mkdir(SHOT_DIR, { recursive: true });

  let server, browser;
  try {
    const setup = await setupPage();
    server = setup.server;
    browser = setup.browser;
    const { page } = setup;

    // cross40 用に tpose 基準を先に取る
    await page.evaluate(() => {
      window.__resetCalibration();
      window.__setManualCal(0.27, 0.25);
      window.__simPose("tpose");
    });
    const tposeConv = await pollConverge(page, { maxMs: 5000 });
    const tposeArmRightX = tposeConv.a?.right?.x;

    const results = [];
    for (const c of CASES) {
      process.stdout.write(`→ ${c.id} ... `);
      // inject baseline for cross case via closure patch
      const caseRunner = { ...c };
      if (c.id === "cross40-crossing-arm") {
        const origAssert = c.assert;
        caseRunner.assert = (probes) => origAssert(probes, { tposeArmRightX });
        caseRunner.apply = async (pg) => {
          await pg.evaluate(() => {
            window.__resetCalibration();
            window.__setManualCal(0.27, 0.25);
            window.__simCross(40);
          });
        };
      }
      const r = await runCase(page, caseRunner);
      results.push(r);
      console.log(`${r.status} (${r.elapsedMs}ms)`);
      if (r.status !== "PASS") console.log(`   ${r.detail?.slice(0, 300)}`);
    }

    const summary = { PASS: 0, FAIL: 0, ERROR: 0 };
    for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;

    const report = {
      generatedAt: new Date().toISOString(),
      summary,
      results,
    };
    await writeFile(path.join(OUT_DIR, "avatar-reflect-report.json"), JSON.stringify(report, null, 2), "utf8");

    const md = [
      "# avatar-reflect レポート",
      "",
      `- 生成: ${report.generatedAt}`,
      `- PASS=${summary.PASS} FAIL=${summary.FAIL} ERROR=${summary.ERROR}`,
      "",
      "| ケース | 結果 | 詳細 |",
      "|---|---|---|",
      ...results.map(
        (r) =>
          `| ${r.id} | ${r.status} | ${(r.detail || "").replace(/\|/g, "\\|").slice(0, 400)} |`
      ),
      "",
      `スクリーンショット: \`${SHOT_DIR}\``,
      "",
    ].join("\n");
    await writeFile(path.join(OUT_DIR, "avatar-reflect-report.md"), md, "utf8");

    console.log("\n==== SUMMARY ====");
    console.log(summary);
    console.log(`report: ${path.join(OUT_DIR, "avatar-reflect-report.md")}`);
    console.log(`shots:  ${SHOT_DIR}`);

    process.exit(summary.FAIL + summary.ERROR > 0 ? 1 : 0);
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
