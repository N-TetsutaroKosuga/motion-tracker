#!/usr/bin/env node
// test/tracking/fetch-media.mjs
//
// テスト用映像の取得と変換(冪等: 既存ファイルはスキップ)。
// 複数メディアセットをマニフェスト形式(MEDIA_MANIFEST)で扱う。
//
//   [clip セット] 従来どおりの基準クリップ(正面向き・全身・腕の可動が大きい)
//     media/src.mp4  — Pexelsからのダウンロード原本
//     media/clip.mp4 — 1280x720・8〜10秒にトリム/スケールした比較用クリップ
//     media/clip.y4m — 同クリップのY4M(ヘッダ C420mpeg2→C420 修正済み)
//     media/clip.meta.json
//
//   [punch セット] 正面向きパンチ/シャドーボクシング(拳がカメラ方向へ伸びる区間を含む)
//     media/punch-src.mp4 — Pexelsからのダウンロード原本
//     media/punch.mp4     — 1280x720・8〜12秒にトリムしたパンチクリップ
//     media/punch.y4m     — 同クリップのY4M(ヘッダ修正済み)
//     media/punch.meta.json — 元URL/尺/fps/パンチストロークのおおよその時刻(notes)
//
// 実行: node test/tracking/fetch-media.mjs
// 各生成物は既に存在し、かつ最低限のサイズ/整合性チェックを満たす場合はスキップする。
// マニフェストに新しいセットを追加すれば、同じパイプライン(ダウンロード→トリム/スケール→Y4M化→meta書き出し)
// が自動的に適用される。

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

const PEXELS_LICENSE =
  "Pexels License (商用可・改変可・帰属表示不要) https://www.pexels.com/license/";

// ---------------------------------------------------------------------------
// 採用動画candidates
// ---------------------------------------------------------------------------

// [clip セット] 正面向き・全身・単独人物・腕の可動が大きい(ジャンピングジャック)。
// 調査手順は understand/research.md および本エージェントのPexels探索(WebFetch)による。
// 屋外公園、単独人物、正面カメラ、2560x1440(16:9)@29.97fps、ネイティブ長 6.47秒
// (目標尺に満たないため clip 生成時に ffmpeg -stream_loop でループ延長する)。
const PRIMARY_VIDEO = {
  url: "https://videos.pexels.com/video-files/4764177/4764177-uhd_2560_1440_30fps.mp4",
  page: "https://www.pexels.com/video/video-of-woman-doing-jumping-jacks-4764177/",
  author: "Gustavo Fring",
  license: PEXELS_LICENSE,
  note: "正面向き・全身・単独人物のジャンピングジャック(屋外公園)。2560x1440 @29.97fps, ネイティブ長約6.47秒",
};

// CONTRACT.md記載のフォールバック(生存確認済み: 腕立て伏せ・横向き)
const FALLBACK_VIDEO = {
  url: "https://videos.pexels.com/video-files/4754030/4754030-uhd_2732_1440_25fps.mp4",
  page: "https://www.pexels.com/video/a-woman-doing-push-ups-on-a-boxing-ring-4754030/",
  author: "unknown (フォールバック、research.mdの生存確認済みURLを使用)",
  license: PEXELS_LICENSE,
  note: "フォールバック: 腕立て伏せ・横向き。2732x1440 @25fps",
};

// [punch セット] シャドーボクシング。全身/腰上が写り、ジャブ/ストレートがカメラ方向へ
// 伸びるストロークが複数回入っている。屋内ジム、単独人物、1920x1080@25fps、ネイティブ長12.08秒。
// 探索過程(WebSearch/WebFetch、m1担当エージェントによる目視フレーム確認)の詳細・却下した候補は
// 本ファイルを消費するタスクの報告に記載。完全な正対(カメラが打撃線の真正面)の映像はPexels上で
// 見つからず、打撃線に対しおよそ20〜30度オフセットした構図を採用(CONTRACT.md ｍ1タスクの
// フォールバック方針「正対でなくても腕がカメラ方向へ伸びる動作を含む最善の代替」に基づく)。
const PUNCH_VIDEO = {
  url: "https://videos.pexels.com/video-files/10988078/10988078-hd_1920_1080_25fps.mp4",
  page: "https://www.pexels.com/video/man-shadowboxing-in-gym-10988078/",
  author: "gusat silviu (modus-vivendi)",
  license: PEXELS_LICENSE,
  note:
    "屋内ジムでのシャドーボクシング(全身/腰上、単独人物)。1920x1080 @25fps、ネイティブ長12.08秒。" +
    "ジャブ/ストレートがカメラ方向(打撃線に対し約20〜30度オフセット)へ伸びるストロークが" +
    "約1.3s/4.1s/5.1s/6.4sの4回入っている(6.4sが最も正対に近い最大伸展)。他に0.8s/9.0s付近にも" +
    "小さい伸展あり(punch.mp4を5fpsでコンタクトシート化して目視確認・確定)。" +
    "照明はやや暗め(青系リムライト)だが人物のシルエット・四肢は判別可能。",
};

// フォールバック候補(生存確認済み): カメラにより近い距離でジャブがレンズ方向へ伸びる場面を含むが、
// 胸から上のクローズアップで下半身は写らない。プライマリがダウンロード不能な場合のみ使用。
const PUNCH_VIDEO_FALLBACK = {
  url: "https://videos.pexels.com/video-files/9943633/9943633-uhd_2560_1440_24fps.mp4",
  page: "https://www.pexels.com/video/a-man-throwing-punches-in-the-air-9943633/",
  author: "KoolShooters",
  license: PEXELS_LICENSE,
  note:
    "フォールバック: 胸から上のクローズアップ、暗め照明、低アングル。2560x1440 @24fps、ネイティブ長10.71秒。" +
    "拳がレンズへ直接伸びる瞬間を複数含むが全身/腰上の要件は完全には満たさない。",
};

// ---------------------------------------------------------------------------
// メディアセット・マニフェスト
// ---------------------------------------------------------------------------
// 各セットは「ダウンロード原本 → トリム/スケール済みmp4 → Y4M化 → meta.json書き出し」という
// 同一パイプラインを通る。新しいメディアが必要になったら配列に要素を追加するだけでよい。

const MEDIA_MANIFEST = [
  {
    key: "clip",
    srcMp4: path.join(MEDIA_DIR, "src.mp4"),
    srcMeta: path.join(MEDIA_DIR, "src.meta.json"),
    clipMp4: path.join(MEDIA_DIR, "clip.mp4"),
    clipY4m: path.join(MEDIA_DIR, "clip.y4m"),
    clipMeta: path.join(MEDIA_DIR, "clip.meta.json"),
    // CONTRACT.md: 1280x720, 8〜10秒(中央値9秒)
    targetW: 1280,
    targetH: 720,
    targetDurationSec: 9,
    targetFps: 30,
    minSrcBytes: 100_000,
    minClipBytes: 100_000,
    minY4mBytes: 1_000_000,
    candidates: [PRIMARY_VIDEO, FALLBACK_VIDEO],
    notes: null,
  },
  {
    key: "punch",
    srcMp4: path.join(MEDIA_DIR, "punch-src.mp4"),
    srcMeta: path.join(MEDIA_DIR, "punch-src.meta.json"),
    clipMp4: path.join(MEDIA_DIR, "punch.mp4"),
    clipY4m: path.join(MEDIA_DIR, "punch.y4m"),
    clipMeta: path.join(MEDIA_DIR, "punch.meta.json"),
    // 8〜12秒レンジ。原本(12.08秒)中の5回のパンチストローク(最終約10.3s)を余裕を持って収める
    targetW: 1280,
    targetH: 720,
    targetDurationSec: 11,
    targetFps: 25,
    minSrcBytes: 100_000,
    minClipBytes: 100_000,
    minY4mBytes: 1_000_000,
    candidates: [PUNCH_VIDEO, PUNCH_VIDEO_FALLBACK],
    notes:
      "パンチストローク(ジャブ/ストレートがカメラ方向へ伸びる瞬間)のおおよその時刻(punch.mp4内、" +
      "trimStart=0のため原本と同一): 約1.3s, 4.1s, 5.1s, 6.4s(6.4sが最も伸展が大きく正対に近い)。" +
      "他に0.8s, 9.0s付近にも小さい伸展あり。punch.mp4を5fps/0.2秒刻みのコンタクトシートにして" +
      "目視確認済み。カメラは打撃線に対し約20〜30度オフセットしており、厳密な正対ではない" +
      "(採用理由・却下した候補はfetch-media.mjs冒頭のコメントおよびタスク報告を参照)。",
  },
];

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

// ---------------------------------------------------------------------------
// セット単位の汎用パイプライン(clip/punch共通)
// ---------------------------------------------------------------------------

async function ensureSrcVideo(set) {
  if (fileExistsNonEmpty(set.srcMp4, set.minSrcBytes)) {
    log(`skip: ${set.srcMp4} already exists (${fs.statSync(set.srcMp4).size} bytes)`);
    if (fileExistsNonEmpty(set.srcMeta, 10)) {
      return JSON.parse(fs.readFileSync(set.srcMeta, "utf8"));
    }
    return { url: "(既存ファイル、由来不明)", note: "既存srcを再利用" };
  }

  await fsp.mkdir(MEDIA_DIR, { recursive: true });

  for (const candidate of set.candidates) {
    log(`[${set.key}] downloading candidate: ${candidate.url}`);
    try {
      const { bytes, contentType } = await downloadFile(candidate.url, set.srcMp4);
      if (bytes < set.minSrcBytes || !/video|octet-stream/.test(contentType)) {
        throw new Error(
          `suspicious download (bytes=${bytes}, contentType=${contentType})`
        );
      }
      log(`[${set.key}] downloaded ${bytes} bytes, content-type=${contentType}`);
      fs.writeFileSync(set.srcMeta, JSON.stringify(candidate, null, 2));
      return candidate;
    } catch (err) {
      log(`[${set.key}] candidate failed: ${candidate.url} -> ${err.message}`);
      try {
        fs.unlinkSync(set.srcMp4);
      } catch {}
    }
  }
  throw new Error(`[${set.key}] all video candidates failed to download`);
}

async function ensureClipMp4(set) {
  if (fileExistsNonEmpty(set.clipMp4, set.minClipBytes)) {
    log(`skip: ${set.clipMp4} already exists (${fs.statSync(set.clipMp4).size} bytes)`);
    return;
  }
  const srcDuration = await probeDurationSec(set.srcMp4);
  log(`[${set.key}] src duration = ${srcDuration.toFixed(2)}s`);

  // 目標尺に届かない場合は -stream_loop で必要な回数だけ延長してからトリム
  const loops = Math.max(0, Math.ceil(set.targetDurationSec / srcDuration) - 1);
  log(`[${set.key}] stream_loop=${loops} (target=${set.targetDurationSec}s)`);

  const args = [
    "-y",
    ...(loops > 0 ? ["-stream_loop", String(loops)] : []),
    "-i",
    set.srcMp4,
    "-t",
    String(set.targetDurationSec),
    "-vf",
    `scale=${set.targetW}:${set.targetH}:force_original_aspect_ratio=increase,crop=${set.targetW}:${set.targetH}`,
    "-r",
    String(set.targetFps),
    "-an",
    "-pix_fmt",
    "yuv420p",
    set.clipMp4,
  ];
  log(`[${set.key}] ffmpeg ${args.join(" ")}`);
  await run(ffmpegPath, args);
  log(`[${set.key}] generated ${set.clipMp4}`);
}

async function ensureClipY4m(set) {
  if (fileExistsNonEmpty(set.clipY4m, set.minY4mBytes)) {
    log(`skip: ${set.clipY4m} already exists (${fs.statSync(set.clipY4m).size} bytes)`);
    return;
  }
  const rawY4m = path.join(MEDIA_DIR, `_${set.key}.raw.y4m`);
  const args = ["-y", "-i", set.clipMp4, "-pix_fmt", "yuv420p", rawY4m];
  log(`[${set.key}] ffmpeg ${args.join(" ")}`);
  await run(ffmpegPath, args);
  await patchY4mHeader(rawY4m, set.clipY4m);
  try {
    fs.unlinkSync(rawY4m);
  } catch {}
  log(`[${set.key}] generated ${set.clipY4m} (${fs.statSync(set.clipY4m).size} bytes)`);
}

async function processSet(set) {
  log(`=== [${set.key}] start ===`);
  const chosen = await ensureSrcVideo(set);
  await ensureClipMp4(set);
  await ensureClipY4m(set);

  const clipDuration = await probeDurationSec(set.clipMp4).catch(() => null);
  const clipRes = await probeResolution(set.clipMp4).catch(() => null);
  const y4mHead = fs
    .readFileSync(set.clipY4m)
    .subarray(0, 200)
    .toString("ascii")
    .split("\n")[0];

  // run.mjs等が実尺(待機時間の算出)に使う軽量メタデータ。既存の{width,height,durationSec,fps,
  // y4mHeader,sourceUrl}のshapeは維持し、notesがあるセットのみ追加フィールドとして書き出す。
  const metaObj = {
    width: clipRes?.width ?? set.targetW,
    height: clipRes?.height ?? set.targetH,
    durationSec: clipDuration ?? set.targetDurationSec,
    fps: set.targetFps,
    y4mHeader: y4mHead,
    sourceUrl: chosen.url,
  };
  if (set.notes) metaObj.notes = set.notes;
  fs.writeFileSync(set.clipMeta, JSON.stringify(metaObj, null, 2));

  log(`--- [${set.key}] summary ---`);
  log(`source: ${chosen.url}`);
  if (chosen.page) log(`page: ${chosen.page}`);
  if (chosen.author) log(`author: ${chosen.author}`);
  if (chosen.license) log(`license: ${chosen.license}`);
  log(
    `${path.basename(set.clipMp4)}: ${clipRes ? `${clipRes.width}x${clipRes.height}` : "?"} , ${
      clipDuration ? clipDuration.toFixed(2) : "?"
    }s`
  );
  log(`${path.basename(set.clipY4m)} header: ${y4mHead}`);

  return { set, chosen, clipDuration, clipRes, y4mHead };
}

async function main() {
  log("=== fetch-media: start ===");
  const results = [];
  for (const set of MEDIA_MANIFEST) {
    results.push(await processSet(set));
  }
  log("=== fetch-media: all sets done ===");
  for (const r of results) {
    log(
      `[summary] ${r.set.key}: ${path.basename(r.set.clipMp4)} (${
        r.clipRes ? `${r.clipRes.width}x${r.clipRes.height}` : "?"
      }, ${r.clipDuration ? r.clipDuration.toFixed(2) : "?"}s) <- ${r.chosen.url}`
    );
  }
  log("=== fetch-media: done ===");
}

main().catch((err) => {
  console.error("[fetch-media] FATAL:", err);
  process.exit(1);
});
