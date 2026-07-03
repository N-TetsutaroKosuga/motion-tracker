#!/usr/bin/env python3
"""test/tracking/crosscheck/compare.py

web-landmarks.json (ブラウザ/WASM版 HolisticLandmarker, verify.htmlの__dump()出力)と
py-landmarks.json (Python/ネイティブ版 HolisticLandmarker, extract.pyの出力)を
タイムスタンプ最近傍(既定 ±40ms)で対応付けし、MPJPE (Mean Per Joint Position Error)
の分布 (p50/p95) を算出してPASS/FAIL判定する (CONTRACT.md記載の暫定閾値)。

同一の .task モデルファイルをロードした2つのランタイム(ブラウザWASM vs
Pythonネイティブ)の出力を突き合わせるため、モデル差ではなくランタイム/前処理
差に起因する乖離だけを検出できる (詳細: understand/research.md §4)。

== 指標の定義 ==
- MPJPE(pose2d正規化): 対応付いた各フレームペアについて、33関節の
  正規化座標(x,y ∈ [0,1]、画像基準)の平均ユークリッド距離 (x,yのみ。zは
  正規化ポーズのzが股関節幅基準のスケールで単位が異なるため対象外とする)。
- MPJPE(world): 33関節のワールド座標(メートル)の平均ユークリッド距離
  (x,y,z 全て使用)。
これらをフレームペアごとに計算し、分布のp50(中央値)・p95を報告する。
PASS判定は p50 に対して行う(p95は外れ値に敏感なため参考値として併記する。
この解釈はCONTRACT.mdの「実測分布(p50/p95)を必ずレポートに含める」という
記述に基づき本実装で定めたもの)。

== フレーム対応付けの単純化 ==
各webフレームについて、py側フレームの中からタイムスタンプ差が最小かつ
window_ms以内のものを最近傍として選ぶ(貪欲法、py側フレームの重複利用は許容する)。
両フレームともに33関節ぶんのpose2d/worldが実際に検出されている
(detected=true相当)ペアのみをMPJPE計算対象にする。

== 重大: タイムスタンプのエポック不一致 (s1-verifyで発見・修正) ==
web-landmarks.json の各フレームの `t` は「__record(true)を呼んだ時刻」からの相対msである
(CONTRACT.md/verify.html仕様)。一方 py-landmarks.json の `tMs` は「動画ファイルの先頭
(frameIdx=0)」からの絶対msである。フェイクカメラ(--use-file-for-fake-video-capture)は
getUserMedia()成功時点からライブ映像のように再生を開始し、`video.currentTime`は
record()呼び出しでリセットされず単調増加し続けるため、__record(true)が呼ばれた瞬間には
既にソース動画のループ再生上、数百ms〜数秒進んだ地点にいる(実測: 本実装のrun.mjsの
フローで約1.5秒)。したがって `t` と `tMs` は最初から起点(エポック)がずれており、
直接比較すると「タイムスタンプは近いが実際の動作フェーズは全く違うフレーム同士」を
対応付けてしまい、MPJPEが実際の精度と無関係に大きくなる(実測でMPJPE(pose2d)
p50が0.05の閾値に対し0.125など、閾値の2倍以上に達することを確認した)。
対策として、verify.html側は各フレームに `videoTimeMs` (video.currentTime*1000。
ソース動画のループ再生上の実位置を表す、record()呼び出しでリセットされない値)を
追加で記録するようにした。本ファイルはこれを `videoTimeMs mod clip_duration_ms` で
py側の絶対時刻と同じ基準に変換してから対応付けに使う(clip_duration_msは
test/tracking/media/clip.meta.json から読む。無ければpy側フレームの最大tMsから推定)。
`videoTimeMs` が無い(古い形式の)web-landmarks.jsonに対しては、エポック不一致の
リスクを警告した上で従来の `t` ベースの対応付けにフォールバックする。

== 出力 ==
- test/tracking/out/crosscheck-report.json: 全指標・対応ペア明細の生データ
- test/tracking/out/report.md: 共有レポートファイル。checks.mjs等が書いた既存の
  内容を壊さないよう、`<!-- BEGIN: python-crosscheck -->` 〜
  `<!-- END: python-crosscheck -->` のマーカーで囲った自セクションのみを
  挿入/置換する(ファイルが無ければ新規作成)。
- 失敗時は非ゼロexitで終了する。
"""

import argparse
import bisect
import json
import math
import os
import sys

import numpy as np

SECTION_BEGIN = "<!-- BEGIN: python-crosscheck (compare.py) -->"
SECTION_END = "<!-- END: python-crosscheck (compare.py) -->"

N_JOINTS = 33


def log(msg):
    print(f"[compare.py] {msg}", file=sys.stderr, flush=True)


def default_paths():
    here = os.path.dirname(os.path.abspath(__file__))
    tracking_dir = os.path.dirname(here)
    out_dir = os.path.join(tracking_dir, "out")
    return {
        "web": os.path.join(out_dir, "web-landmarks.json"),
        "py": os.path.join(out_dir, "py-landmarks.json"),
        "out_json": os.path.join(out_dir, "crosscheck-report.json"),
        "out_md": os.path.join(out_dir, "report.md"),
        "clip_meta": os.path.join(tracking_dir, "media", "clip.meta.json"),
    }


def load_clip_duration_ms(clip_meta_path, py_frames):
    """クリップの1ループ分の長さ(ms)を求める。videoTimeMsのmod演算(ループ境界の
    折り返し)に必要。clip.meta.json (fetch-media.mjs出力) を優先し、無ければ
    py側フレームの最大tMs+1フレーム分から推定する。"""
    try:
        with open(clip_meta_path, "r", encoding="utf-8") as f:
            meta = json.load(f)
        dur = meta.get("durationSec")
        if isinstance(dur, (int, float)) and dur > 0:
            return float(dur) * 1000.0
    except Exception as exc:
        log(f"WARNING: could not read clip duration from {clip_meta_path}: {exc}")
    # フォールバック: py側の最大tMsから推定(厳密な1ループ長ではなく近似値)
    ts = [pf["t"] for pf in py_frames if pf.get("t") is not None]
    if ts:
        approx = max(ts) + (max(ts) - min(ts)) / max(1, len(ts) - 1)
        log(f"WARNING: falling back to approximated clip duration from py frames: {approx:.1f}ms")
        return approx
    log("WARNING: could not determine clip duration at all; epoch alignment will likely be wrong")
    return None


def build_arg_parser():
    d = default_paths()
    p = argparse.ArgumentParser(description="web-landmarks.json と py-landmarks.json のクロスチェック")
    p.add_argument("--web", default=d["web"], help="verify.html __dump()の出力 (既定: test/tracking/out/web-landmarks.json)")
    p.add_argument("--py", default=d["py"], help="extract.pyの出力 (既定: test/tracking/out/py-landmarks.json)")
    p.add_argument("--out-json", default=d["out_json"], help="詳細レポートJSONの出力先")
    p.add_argument("--out-md", default=d["out_md"], help="共有Markdownレポートの出力先(マーカー区間のみ更新)")
    p.add_argument("--clip-meta", default=d["clip_meta"], help="clip.meta.json (durationSecからループ長msを得る。videoTimeMsのエポック整合に使用)")
    p.add_argument("--window-ms", type=float, default=40.0, help="最近傍対応付けの許容差(ms)")
    p.add_argument("--match-rate-thresh", type=float, default=0.70, help="対応率の暫定PASS閾値")
    p.add_argument("--pose2d-thresh", type=float, default=0.05, help="MPJPE(pose2d正規化)p50の暫定PASS閾値")
    p.add_argument("--world-thresh", type=float, default=0.10, help="MPJPE(world, m)p50の暫定PASS閾値")
    p.add_argument("--skip-report-md", action="store_true", help="report.mdの更新をスキップ(テスト用)")
    return p


# ---------------------------------------------------------------------------
# データ読み込み・正規化
# ---------------------------------------------------------------------------

def load_web_frames(path):
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    frames = []
    for fr in doc.get("frames", []):
        pose2d = fr.get("pose2d")
        world = fr.get("world")
        ok = (
            isinstance(pose2d, list) and len(pose2d) == N_JOINTS
            and isinstance(world, list) and len(world) == N_JOINTS
        )
        frames.append({
            "t": fr.get("t"),
            "videoTimeMs": fr.get("videoTimeMs"),
            "pose2d": pose2d if ok else None,
            "world": world if ok else None,
            "valid": ok,
        })
    return doc.get("meta", {}), frames


def assign_match_keys(web_frames, clip_duration_ms):
    """各webフレームに、py側のtMs(動画ファイル先頭=0msの絶対ms)と同じ基準の
    対応付け用キー `matchT` を付与する。videoTimeMsが使えれば
    `videoTimeMs mod clip_duration_ms` (エポック整合済み、s1-verifyで修正)を使い、
    使えなければ従来の `t` (record開始基準。エポックがずれている可能性がある)に
    フォールバックする。戻り値: (使用した方式の説明, フォールバックが発生したか)
    """
    have_video_time = clip_duration_ms and all(
        isinstance(wf.get("videoTimeMs"), (int, float)) for wf in web_frames
    )
    if have_video_time:
        for wf in web_frames:
            wf["matchT"] = wf["videoTimeMs"] % clip_duration_ms
        return "videoTimeMs mod clip_duration_ms (エポック整合済み)", False
    log(
        "WARNING: web-landmarks.json に videoTimeMs が無い、またはclip_duration_msが不明。"
        "'t'(record開始からの相対ms)をそのままpy側tMs(動画ファイル先頭からの絶対ms)と"
        "比較するフォールバックを使うが、エポックが一致していない可能性がありMPJPEが"
        "実際の精度と無関係に大きくなる場合がある(s1-verifyのCONTRACT.md注記参照)。"
    )
    for wf in web_frames:
        wf["matchT"] = wf["t"]
    return "t (フォールバック、エポック不一致のリスクあり)", True


def load_py_frames(path):
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    frames = []
    for fr in doc.get("frames", []):
        pose2d = fr.get("pose2d")
        world = fr.get("world")
        ok = (
            bool(fr.get("detected"))
            and isinstance(pose2d, list) and len(pose2d) == N_JOINTS
            and isinstance(world, list) and len(world) == N_JOINTS
        )
        frames.append({
            "t": fr.get("tMs"),
            "pose2d": pose2d if ok else None,
            "world": world if ok else None,
            "valid": ok,
        })
    return doc.get("meta", {}), frames


# ---------------------------------------------------------------------------
# タイムスタンプ最近傍対応付け
# ---------------------------------------------------------------------------

def nearest_match(web_frames, py_frames, window_ms):
    """各webフレームについてpy側の最近傍(window_ms以内)を貪欲に探す。

    戻り値: [(web_idx, py_idx_or_None, dt_ms_or_None), ...] (web_framesと同じ長さ・順序)
    """
    py_times = [pf["t"] for pf in py_frames]
    order = sorted(range(len(py_times)), key=lambda i: py_times[i])
    sorted_times = [py_times[i] for i in order]

    results = []
    for wi, wf in enumerate(web_frames):
        t = wf["matchT"]
        if t is None or not sorted_times:
            results.append((wi, None, None))
            continue
        pos = bisect.bisect_left(sorted_times, t)
        candidates = []
        if pos < len(sorted_times):
            candidates.append(pos)
        if pos > 0:
            candidates.append(pos - 1)
        best = None
        best_dt = None
        for c in candidates:
            dt = abs(sorted_times[c] - t)
            if best_dt is None or dt < best_dt:
                best_dt = dt
                best = c
        if best is not None and best_dt <= window_ms:
            results.append((wi, order[best], best_dt))
        else:
            results.append((wi, None, None))
    return results


# ---------------------------------------------------------------------------
# MPJPE計算
# ---------------------------------------------------------------------------

def mpjpe_2d(pose2d_a, pose2d_b):
    a = np.asarray(pose2d_a, dtype=float)[:, :2]
    b = np.asarray(pose2d_b, dtype=float)[:, :2]
    d = np.linalg.norm(a - b, axis=1)
    return float(np.mean(d))


def mpjpe_3d(world_a, world_b):
    a = np.asarray(world_a, dtype=float)
    b = np.asarray(world_b, dtype=float)
    d = np.linalg.norm(a - b, axis=1)
    return float(np.mean(d))


def percentile(values, q):
    if not values:
        return None
    return float(np.percentile(np.asarray(values, dtype=float), q))


# ---------------------------------------------------------------------------
# report.md のマーカー区間更新(既存内容を壊さない)
# ---------------------------------------------------------------------------

def render_section_md(result):
    v = result["verdicts"]
    lines = []
    lines.append("## Python Cross-Check (compare.py)")
    lines.append("")
    lines.append(f"- タイムスタンプ整合方式: {result['matchMethod']}" + ("  ⚠️ エポック不一致リスクあり" if result.get("epochFallback") else ""))
    lines.append(f"- web frames: {result['nWeb']} / py frames: {result['nPy']}")
    lines.append(
        f"- 対応付け(±{result['windowMs']:.0f}ms): {result['nMatched']} / {result['nWeb']} "
        f"({result['matchRate']*100:.1f}%) — 閾値 > {result['matchRateThresh']*100:.0f}%: "
        f"**{v['matchRate'].upper()}**"
    )
    lines.append(f"- 有効ペア(両側とも33関節検出済み): {result['nValidPairs']}")
    lines.append("")
    lines.append("| 指標 | p50 | p95 | 閾値(p50) | 判定 |")
    lines.append("|---|---|---|---|---|")

    def fmt(x):
        return f"{x:.4f}" if x is not None else "N/A"

    lines.append(
        f"| MPJPE(pose2d正規化) | {fmt(result['pose2d']['p50'])} | {fmt(result['pose2d']['p95'])} "
        f"| < {result['pose2dThresh']} | **{v['pose2d'].upper()}** |"
    )
    lines.append(
        f"| MPJPE(world) [m] | {fmt(result['world']['p50'])} | {fmt(result['world']['p95'])} "
        f"| < {result['worldThresh']} | **{v['world'].upper()}** |"
    )
    lines.append("")
    lines.append(f"総合判定: **{v['overall'].upper()}**")
    lines.append("")
    lines.append(
        "(注) PASS/FAILの閾値はCONTRACT.mdに記載の暫定値。p50を判定に用い、p95は参考情報として併記。"
        "対応付けは各webフレームに対するpy側最近傍(貪欲法、重複利用許容)。"
    )
    return "\n".join(lines)


def update_shared_report_md(path, section_md):
    section_block = f"{SECTION_BEGIN}\n{section_md}\n{SECTION_END}\n"

    if not os.path.exists(path):
        content = "# Tracking Verification Report\n\n" + section_block
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        log(f"report.md was missing; created new file with crosscheck section: {path}")
        return

    with open(path, "r", encoding="utf-8") as f:
        existing = f.read()

    if SECTION_BEGIN in existing and SECTION_END in existing:
        start = existing.index(SECTION_BEGIN)
        end = existing.index(SECTION_END) + len(SECTION_END)
        new_content = existing[:start] + section_block + existing[end + 1:]
    else:
        sep = "\n" if existing.endswith("\n") else "\n\n"
        new_content = existing + sep + section_block

    with open(path, "w", encoding="utf-8") as f:
        f.write(new_content)
    log(f"updated crosscheck section in existing report.md: {path}")


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

def run(args):
    if not os.path.isfile(args.web):
        log(f"ERROR: web landmarks file not found: {args.web}")
        return 1
    if not os.path.isfile(args.py):
        log(f"ERROR: py landmarks file not found: {args.py}")
        return 1

    web_meta, web_frames = load_web_frames(args.web)
    py_meta, py_frames = load_py_frames(args.py)

    if not web_frames:
        log("ERROR: web-landmarks.json contains zero frames")
        return 1
    if not py_frames:
        log("ERROR: py-landmarks.json contains zero frames")
        return 1

    clip_duration_ms = load_clip_duration_ms(args.clip_meta, py_frames)
    match_method, epoch_fallback = assign_match_keys(web_frames, clip_duration_ms)
    log(f"timestamp alignment method: {match_method}")

    matches = nearest_match(web_frames, py_frames, args.window_ms)
    matched_pairs = [(wi, pi, dt) for (wi, pi, dt) in matches if pi is not None]
    n_matched = len(matched_pairs)
    match_rate = n_matched / len(web_frames)

    pose2d_errs = []
    world_errs = []
    pair_details = []
    for wi, pi, dt in matched_pairs:
        wf = web_frames[wi]
        pf = py_frames[pi]
        valid_pair = wf["valid"] and pf["valid"]
        entry = {"webIdx": wi, "pyIdx": pi, "dtMs": dt, "validPair": valid_pair}
        if valid_pair:
            e2d = mpjpe_2d(wf["pose2d"], pf["pose2d"])
            e3d = mpjpe_3d(wf["world"], pf["world"])
            pose2d_errs.append(e2d)
            world_errs.append(e3d)
            entry["mpjpe2d"] = e2d
            entry["mpjpeWorld"] = e3d
        pair_details.append(entry)

    n_valid_pairs = len(pose2d_errs)

    pose2d_p50 = percentile(pose2d_errs, 50)
    pose2d_p95 = percentile(pose2d_errs, 95)
    world_p50 = percentile(world_errs, 50)
    world_p95 = percentile(world_errs, 95)

    v_match = "pass" if match_rate > args.match_rate_thresh else "fail"
    if n_valid_pairs == 0:
        v_pose2d = "fail"
        v_world = "fail"
        log("WARNING: zero valid (both-detected) matched pairs; cannot compute MPJPE -> FAIL")
    else:
        v_pose2d = "pass" if pose2d_p50 < args.pose2d_thresh else "fail"
        v_world = "pass" if world_p50 < args.world_thresh else "fail"

    overall = "pass" if (v_match == "pass" and v_pose2d == "pass" and v_world == "pass") else "fail"

    result = {
        "web": os.path.abspath(args.web),
        "py": os.path.abspath(args.py),
        "clipDurationMs": clip_duration_ms,
        "matchMethod": match_method,
        "epochFallback": epoch_fallback,
        "windowMs": args.window_ms,
        "nWeb": len(web_frames),
        "nPy": len(py_frames),
        "nMatched": n_matched,
        "matchRate": match_rate,
        "matchRateThresh": args.match_rate_thresh,
        "nValidPairs": n_valid_pairs,
        "pose2dThresh": args.pose2d_thresh,
        "worldThresh": args.world_thresh,
        "pose2d": {"p50": pose2d_p50, "p95": pose2d_p95, "n": n_valid_pairs},
        "world": {"p50": world_p50, "p95": world_p95, "n": n_valid_pairs},
        "verdicts": {
            "matchRate": v_match,
            "pose2d": v_pose2d,
            "world": v_world,
            "overall": overall,
        },
        "webMeta": web_meta,
        "pyMeta": py_meta,
        "pairs": pair_details,
    }

    out_dir = os.path.dirname(os.path.abspath(args.out_json))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out_json, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
    log(f"wrote detailed report: {args.out_json}")

    if not args.skip_report_md:
        section_md = render_section_md(result)
        update_shared_report_md(args.out_md, section_md)

    log(
        f"match_rate={match_rate:.3f} (thr>{args.match_rate_thresh}) [{v_match}] | "
        f"pose2d p50={pose2d_p50} p95={pose2d_p95} (thr<{args.pose2d_thresh}) [{v_pose2d}] | "
        f"world p50={world_p50} p95={world_p95} (thr<{args.world_thresh}) [{v_world}] | "
        f"overall={overall}"
    )

    return 0 if overall == "pass" else 1


def main():
    args = build_arg_parser().parse_args()
    sys.exit(run(args))


if __name__ == "__main__":
    main()
