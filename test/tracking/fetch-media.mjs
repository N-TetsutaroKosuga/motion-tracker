#!/usr/bin/env node
// test/tracking/fetch-media.mjs
//
// テスト用映像の取得と変換(冪等: 既存ファイルはスキップ)。
//   media/src.mp4  — Pexelsからのダウンロード原本
//   media/clip.mp4 — 1280x720・8〜10秒にトリム/スケールした比較用クリップ
//   media/clip.y4m — 同クリップのY4M(ヘッダ C420mpeg2→C420 修正済み)
//
// 実行: node test/tracking/fetch-media.mjs
// 各生成物は既に存在し、かつ最低限のサイズ/整合性チェックを満たす場合はスキップする。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = path.join(__dirname, "media");
const SRC_MP4 = path.join(MEDIA_DIR, "src.mp4");
const CLIP_MP4 = path.join(MEDIA_DIR, "clip.mp4");
const CLIP_Y4M = path.join(MEDIA_DIR, "clip.y4m");
const SRC_META = path.join(MEDIA_DIR, "src.meta.json");
const CLIP_META = path.join(MEDIA_DIR, "clip.meta.json"); // run.mjsが実尺(待機時間の算出)に使う

// clip.mp4 / clip.y4m の目標仕様(CONTRACT.md: 1280x720, 8〜10秒)
const TARGET_W = 1280;
const TARGET_H = 720;
const TARGET_DURATION_SEC = 9; // 8〜10秒レンジの中央値
const TARGET_FPS = 30;

// 採用動画: 正面向き・全身・単独人物・腕の可動が大きい(ジャンピングジャック)。
// 調査手順は understand/research.md および本エージェントのPexels探索(WebFetch)による。
// 屋外公園、単独人物、正面カメラ、2560x1440(16:9)@29.97fps、ネイティブ長 6.47秒
// (目標尺に満たないため clip 生成時に ffmpeg -stream_loop でループ延長する)。
const PRIMARY_VIDEO = {
  url: "https://videos.pexels.com/video-files/4764177/4764177-uhd_2560_1440_30fps.mp4",
  page: "https://www.pexels.com/video/video-of-woman-doing-jumping-jacks-4764177/",
  author: "Gustavo Fring",
  license:
    "Pexels License (商用可・改変可・帰属表示不要) https://www.pexels.com/license/",
  note: "正面向き・全身・単独人物のジャンピングジャック(屋外公園)。2560x1440 @29.97fps, ネイティブ長約6.47秒",
};

// CONTRACT.md記載のフォールバック(生存確認済み: 腕立て伏せ・横向き)
const FALLBACK_VIDEO = {
  url: "https://videos.pexels.com/video-files/4754030/4754030-uhd_2732_1440_25fps.mp4",
  page: "https://www.pexels.com/video/a-woman-doing-push-ups-on-a-boxing-ring-4754030/",
  author: "unknown (フォールバック、research.mdの生存確認済みURLを使用)",
  license:
    "Pexels License (商用可・改変可・帰属表示不要) https://www.pexels.com/license/",
  note: "フォールバック: 腕立て伏せ・横向き。2732x1440 @25fps",
};

function log(...args) {
  console.log("[fetch-media]", ...args);
}

function fileExistsNonEmpty(p, minBytes = 1024) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size >= minBytes;
  } catch {
    return false;
  }
}

// リダイレクトを追従しつつダウンロードする。成功時は {bytes, contentType} を返す。
function downloadFile(url, dest, { maxRedirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl, redirectsLeft) => {
      const mod = currentUrl.startsWith("https:") ? https : http;
      const req = mod.get(currentUrl, (res) => {
        const { statusCode, headers } = res;
        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          const nextUrl = new URL(headers.location, currentUrl).toString();
          attempt(nextUrl, redirectsLeft - 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} for ${currentUrl}`));
          return;
        }
        const tmp = dest + ".part";
        const out = fs.createWriteStream(tmp);
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
        });
        res.pipe(out);
        out.on("finish", () => {
          out.close(() => {
            fs.renameSync(tmp, dest);
            resolve({ bytes, contentType: headers["content-type"] || "" });
          });
        });
        out.on("error", (err) => {
          try {
            fs.unlinkSync(tmp);
          } catch {}
          reject(err);
        });
      });
      req.on("error", reject);
      req.setTimeout(60000, () => {
        req.destroy(new Error("download timeout"));
      });
    };
    attempt(url, maxRedirects);
  });
}

// spawnをPromise化し、exit code!=0でreject。stdout/stderrを蓄積して返す。
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${cmd} exited with code ${code}\n--- stderr ---\n${stderr.slice(-4000)}`
          )
        );
    });
  });
}

// ffmpegのstderrログから "Duration: HH:MM:SS.xx" を抽出して秒数で返す
async function probeDurationSec(file) {
  try {
    await run(ffmpegPath, ["-i", file]);
    // 通常ここには到達しない(入力のみ・出力指定なしだとffmpegは非ゼロ終了する)
    return null;
  } catch (err) {
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err.message);
    if (!m) throw new Error(`could not parse duration from ffmpeg output for ${file}`);
    const [, hh, mm, ss] = m;
    return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
  }
}

async function probeResolution(file) {
  try {
    await run(ffmpegPath, ["-i", file]);
    return null;
  } catch (err) {
    const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(err.message);
    if (!m) return null;
    return { width: Number(m[1]), height: Number(m[2]) };
  }
}

async function ensureSrcVideo() {
  if (fileExistsNonEmpty(SRC_MP4, 100_000)) {
    log(`skip: ${SRC_MP4} already exists (${fs.statSync(SRC_MP4).size} bytes)`);
    if (fileExistsNonEmpty(SRC_META, 10)) {
      return JSON.parse(fs.readFileSync(SRC_META, "utf8"));
    }
    return { url: "(既存ファイル、由来不明)", note: "既存src.mp4を再利用" };
  }

  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  for (const candidate of [PRIMARY_VIDEO, FALLBACK_VIDEO]) {
    log(`downloading candidate: ${candidate.url}`);
    try {
      const { bytes, contentType } = await downloadFile(candidate.url, SRC_MP4);
      if (bytes < 100_000 || !/video|octet-stream/.test(contentType)) {
        throw new Error(
          `suspicious download (bytes=${bytes}, contentType=${contentType})`
        );
      }
      log(`downloaded ${bytes} bytes, content-type=${contentType}`);
      fs.writeFileSync(SRC_META, JSON.stringify(candidate, null, 2));
      return candidate;
    } catch (err) {
      log(`candidate failed: ${candidate.url} -> ${err.message}`);
      try {
        fs.unlinkSync(SRC_MP4);
      } catch {}
    }
  }
  throw new Error("all video candidates failed to download");
}

async function ensureClipMp4() {
  if (fileExistsNonEmpty(CLIP_MP4, 100_000)) {
    log(`skip: ${CLIP_MP4} already exists (${fs.statSync(CLIP_MP4).size} bytes)`);
    return;
  }
  const srcDuration = await probeDurationSec(SRC_MP4);
  log(`src.mp4 duration = ${srcDuration.toFixed(2)}s`);

  // 目標尺に届かない場合は -stream_loop で必要な回数だけ延長してからトリム
  const loops = Math.max(0, Math.ceil(TARGET_DURATION_SEC / srcDuration) - 1);
  log(`stream_loop=${loops} (target=${TARGET_DURATION_SEC}s)`);

  const args = [
    "-y",
    ...(loops > 0 ? ["-stream_loop", String(loops)] : []),
    "-i",
    SRC_MP4,
    "-t",
    String(TARGET_DURATION_SEC),
    "-vf",
    `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H}`,
    "-r",
    String(TARGET_FPS),
    "-an",
    "-pix_fmt",
    "yuv420p",
    CLIP_MP4,
  ];
  log(`ffmpeg ${args.join(" ")}`);
  await run(ffmpegPath, args);
  log(`generated ${CLIP_MP4}`);
}

// ffmpegが出力するY4Mヘッダの "C420mpeg2" は Chromium の file_video_capture_device が
// 受け付けない(サポートは "C420" のみ)。ヘッダ行(先頭1行、FRAME区切り前)だけをテキスト
// 置換し、以降のバイナリフレームデータはストリームでそのままコピーする
// (無圧縮で数百MBになるため全体をメモリに載せない)。
async function patchY4mHeader(rawPath, finalPath) {
  const fh = await fsp.open(rawPath, "r");
  try {
    const headBuf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(headBuf, 0, 512, 0);
    const head = headBuf.subarray(0, bytesRead);
    const newlineIdx = head.indexOf(0x0a); // '\n'
    if (newlineIdx === -1) {
      throw new Error("could not locate Y4M header newline in first 512 bytes");
    }
    const headerLine = head.subarray(0, newlineIdx).toString("ascii");
    if (!headerLine.startsWith("YUV4MPEG2")) {
      throw new Error(`unexpected Y4M header: ${headerLine}`);
    }
    if (!headerLine.includes("C420mpeg2")) {
      log(`warning: header does not contain "C420mpeg2" (got: ${headerLine}); writing through unchanged`);
    }
    const patchedHeaderLine = headerLine.replace("C420mpeg2", "C420");
    const dataStartOffset = newlineIdx + 1;

    const outTmp = finalPath + ".part";
    const out = fs.createWriteStream(outTmp);
    await new Promise((resolve, reject) => {
      out.write(patchedHeaderLine + "\n", (err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) => {
      const rest = fs.createReadStream(rawPath, { start: dataStartOffset });
      rest.pipe(out);
      rest.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
    });

    fs.renameSync(outTmp, finalPath);
    log(`patched Y4M header: "${headerLine}" -> "${patchedHeaderLine}"`);
  } finally {
    await fh.close();
  }
}

async function ensureClipY4m() {
  if (fileExistsNonEmpty(CLIP_Y4M, 1_000_000)) {
    log(`skip: ${CLIP_Y4M} already exists (${fs.statSync(CLIP_Y4M).size} bytes)`);
    return;
  }
  const rawY4m = path.join(MEDIA_DIR, "_clip.raw.y4m");
  const args = ["-y", "-i", CLIP_MP4, "-pix_fmt", "yuv420p", rawY4m];
  log(`ffmpeg ${args.join(" ")}`);
  await run(ffmpegPath, args);
  await patchY4mHeader(rawY4m, CLIP_Y4M);
  try {
    fs.unlinkSync(rawY4m);
  } catch {}
  log(`generated ${CLIP_Y4M} (${fs.statSync(CLIP_Y4M).size} bytes)`);
}

async function main() {
  log("=== fetch-media: start ===");
  const chosen = await ensureSrcVideo();
  await ensureClipMp4();
  await ensureClipY4m();

  const clipDuration = await probeDurationSec(CLIP_MP4).catch(() => null);
  const clipRes = await probeResolution(CLIP_MP4).catch(() => null);
  const y4mHead = fs.readFileSync(CLIP_Y4M).subarray(0, 200).toString("ascii").split("\n")[0];

  // run.mjs が「クリップ実尺+1秒」の待機時間を算出するために読む軽量メタデータ
  fs.writeFileSync(
    CLIP_META,
    JSON.stringify(
      {
        width: clipRes?.width ?? TARGET_W,
        height: clipRes?.height ?? TARGET_H,
        durationSec: clipDuration ?? TARGET_DURATION_SEC,
        fps: TARGET_FPS,
        y4mHeader: y4mHead,
        sourceUrl: chosen.url,
      },
      null,
      2
    )
  );

  log("--- summary ---");
  log(`source: ${chosen.url}`);
  if (chosen.page) log(`page: ${chosen.page}`);
  if (chosen.author) log(`author: ${chosen.author}`);
  if (chosen.license) log(`license: ${chosen.license}`);
  log(`clip.mp4: ${clipRes ? `${clipRes.width}x${clipRes.height}` : "?"} , ${clipDuration ? clipDuration.toFixed(2) : "?"}s`);
  log(`clip.y4m header: ${y4mHead}`);
  log("=== fetch-media: done ===");
}

main().catch((err) => {
  console.error("[fetch-media] FATAL:", err);
  process.exit(1);
});
