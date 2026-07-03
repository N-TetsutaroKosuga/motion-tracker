#!/usr/bin/env python3
"""test/tracking/crosscheck/extract.py

Holistic Landmarker (Tasks API, VIDEO mode) を使い、test/tracking/media/clip.mp4 を
フレーム毎に処理して test/tracking/out/py-landmarks.json を出力する。

Web版 (avatar-depth.html / verify.html) と全く同じ `.task` モデルファイルを
ロードするため、モデル差ではなくランタイム(WASM vs ネイティブ)差だけを
クロスチェックできる(詳細は understand/research.md §4)。

== 既知の重大バグ (mediapipe==0.10.21, Python Tasks API) ==
site-packages/mediapipe/tasks/python/vision/holistic_landmarker.py の
HolisticLandmarker.detect() / detect_for_video() は、そのフレームの
FACE_LANDMARKS 出力パケットが空かどうかだけで結果全体の運命を決めている:

  1. 顔が検出できなかったフレーム (例: 横向きで顔検出が外れた)
     -> pose/hand が実際には検出できていても、結果は丸ごと空リストになって
        返る (サイレントなデータロス。例外は出ない)。
  2. 顔は検出できたが pose が検出できなかったフレーム
     -> `_build_landmarker_result()` が空の pose_landmarks パケットに対して
        `packet_getter.get_proto()` を呼び、C++側で
        `Check failed: holder_ != nullptr The packet is empty.` という
        回復不能な致命的アボート(SIGABRT)でプロセスごと強制終了する。
        これは Python の try/except では一切捕まえられない(OSシグナルによる
        プロセス終了であり、Python の例外機構を経由しない)。

上記は本タスクの実装時に実機で再現確認済み(mediapipe-assets の
male_full_height_hands.jpg / pose.jpg / portrait.jpg を使用。詳細は
crosscheck 実装者の報告を参照)。全身運動の動画(ジャンピングジャック等)では
「顔は映っているが一瞬 pose 推定が外れる」フレームが現実的に起こり得るため、
素朴な実装だと動画の途中でプロセスごと落ちて処理が完走しないリスクが高い。

== 対策: supervisor / worker 構成 ==
このファイルは自分自身を2つの役割で起動する:
  - supervisor (デフォルト): 自分自身を `--worker-mode` サブプロセスとして
    起動する。ワーカーが上記のネイティブクラッシュ(= OSシグナルによる終了。
    Python の subprocess では returncode が負値になる)で死んだら、
    チェックポイント(NDJSON、フレームごとに1行を都度 flush+fsync)を見て
    「どこまで書けていたか」を確認し、クラッシュしたフレームを
    detected=false のプレースホルダとして記録した上で、次のフレームから
    新しい HolisticLandmarker インスタンス(=新しいワーカープロセス)で
    処理を再開する。これを動画の終端に達するまで繰り返す。
  - worker (`--worker-mode`): 実際に動画を開き、`--start-frame` から
    フレームを読み進めて `detect_for_video()` を呼び、結果をチェックポイント
    ファイルに1行(1フレーム)ずつ追記する。

出力形式 (CONTRACT.md 準拠、frames配列がコア):
  {
    "meta": {...診断情報(件数・クラッシュ有無・fps等)...},
    "frames": [
      {"tMs": <int>, "pose2d": [[x,y,z]x33]|null, "world": [[x,y,z]x33]|null,
       "vis": [v]x33|null, "detected": bool, "frameIdx": int, "crashed"?: true},
      ...
    ]
  }
"""

import argparse
import json
import os
import subprocess
import sys
import time

import cv2

# s1-verifyでの実測: 実クリップ(9秒/270フレーム, ジャンピングジャック)で50/270フレーム(約18.5%)が
# mediapipe==0.10.21のPython SIGABRTバグを踏んだ(顔が一瞬隠れる/ブレる腕振り動作で頻発)。
# 既定値50だとちょうど上限に達し(restarts=50)、あと1回クラッシュすれば FATAL で全体が
# 失敗する寸前だった。安全マージンを持たせるため引き上げる(調整理由: 実測クラッシュ率が
# 想定より高かったため。処理時間への影響は再起動1回あたり数百ms〜1秒程度のプロセス起動
# オーバーヘッドのみで軽微)。
DEFAULT_MAX_RESTARTS = 200
SETUP_ERROR_EXIT_CODE = 2  # worker起動前の環境エラー(モデル/動画が無い等)を表す専用exit code


def log(msg):
    print(f"[extract.py] {msg}", file=sys.stderr, flush=True)


def default_paths():
    here = os.path.dirname(os.path.abspath(__file__))
    tracking_dir = os.path.dirname(here)
    return {
        "video": os.path.join(tracking_dir, "media", "clip.mp4"),
        "model": os.path.join(tracking_dir, "media", "holistic_landmarker.task"),
        "out": os.path.join(tracking_dir, "out", "py-landmarks.json"),
    }


def build_arg_parser():
    d = default_paths()
    p = argparse.ArgumentParser(description="Python HolisticLandmarker (Tasks API, VIDEO mode) 抽出")
    p.add_argument("--video", default=d["video"], help="入力動画 (既定: test/tracking/media/clip.mp4)")
    p.add_argument("--model", default=d["model"], help=".taskモデル (既定: test/tracking/media/holistic_landmarker.task)")
    p.add_argument("--out", default=d["out"], help="出力JSON (既定: test/tracking/out/py-landmarks.json)")
    p.add_argument("--max-restarts", type=int, default=DEFAULT_MAX_RESTARTS,
                   help="ワーカークラッシュ時の最大再起動回数(構造的な問題での無限ループを防ぐ安全弁)")
    # --- worker内部フラグ (通常は直接使わない) ---
    p.add_argument("--worker-mode", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--start-frame", type=int, default=0, help=argparse.SUPPRESS)
    p.add_argument("--checkpoint", default=None, help=argparse.SUPPRESS)
    return p


# ---------------------------------------------------------------------------
# Worker: 実際にフレームを処理してチェックポイントに追記する
# ---------------------------------------------------------------------------

def run_worker(args):
    if not os.path.isfile(args.video):
        log(f"ERROR: video not found: {args.video}")
        sys.exit(SETUP_ERROR_EXIT_CODE)
    if not os.path.isfile(args.model):
        log(f"ERROR: model not found: {args.model}")
        sys.exit(SETUP_ERROR_EXIT_CODE)
    if not args.checkpoint:
        log("ERROR: --checkpoint is required in --worker-mode")
        sys.exit(SETUP_ERROR_EXIT_CODE)

    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except Exception as exc:  # pragma: no cover
        log(f"ERROR: mediapipe import failed: {exc}")
        sys.exit(SETUP_ERROR_EXIT_CODE)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        log(f"ERROR: failed to open video: {args.video}")
        sys.exit(SETUP_ERROR_EXIT_CODE)

    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps <= 0 or fps != fps:  # NaNガード
        log(f"WARNING: invalid fps from video metadata ({fps!r}); falling back to 30.0")
        fps = 30.0

    # start_frame まで読み飛ばす。CAP_PROP_POS_FRAMES による厳密シークは
    # コンテナ/コーデックによって精度が不安定なため、確実性を優先してデコードで
    # 読み飛ばす(再起動時にしか発生しないため許容できるコスト)。
    for _ in range(args.start_frame):
        ok, _ = cap.read()
        if not ok:
            # 動画長より先を指定された(直前のクラッシュ処理で最終フレームに
            # プレースホルダを積んだ直後、等)。やることがないので正常終了。
            cap.release()
            sys.exit(0)

    base_options = mp_python.BaseOptions(model_asset_path=args.model)
    options = vision.HolisticLandmarkerOptions(
        base_options=base_options,
        running_mode=vision.RunningMode.VIDEO,
    )
    try:
        landmarker = vision.HolisticLandmarker.create_from_options(options)
    except Exception as exc:
        log(f"ERROR: failed to create HolisticLandmarker: {exc}")
        sys.exit(SETUP_ERROR_EXIT_CODE)

    frame_idx = args.start_frame
    last_ts = -1
    n_written = 0
    try:
        with open(args.checkpoint, "a", encoding="utf-8") as ckpt:
            while True:
                ok, frame_bgr = cap.read()
                if not ok:
                    break
                rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

                ts_ms = round(frame_idx / fps * 1000)
                if ts_ms <= last_ts:
                    ts_ms = last_ts + 1  # detect_for_videoは狭義単調増加のタイムスタンプが必須
                last_ts = ts_ms

                # NOTE: ここで mediapipe==0.10.21 の既知バグ(モジュールdocstring参照)
                # により、「顔は検出できたがposeが検出できない」フレームで
                # SIGABRTする可能性がある。try/exceptでは捕まえられないため、
                # supervisor側でプロセスクラッシュとして検知・復旧する設計にしている。
                result = landmarker.detect_for_video(mp_image, ts_ms)

                detected = len(result.pose_landmarks) == 33
                world_ok = detected and len(result.pose_world_landmarks) == 33
                record = {
                    "tMs": ts_ms,
                    "frameIdx": frame_idx,
                    "detected": detected,
                    "pose2d": (
                        [[lm.x, lm.y, lm.z] for lm in result.pose_landmarks]
                        if detected else None
                    ),
                    "world": (
                        [[lm.x, lm.y, lm.z] for lm in result.pose_world_landmarks]
                        if world_ok else None
                    ),
                    "vis": (
                        [lm.visibility for lm in result.pose_landmarks]
                        if detected else None
                    ),
                }
                ckpt.write(json.dumps(record) + "\n")
                ckpt.flush()
                os.fsync(ckpt.fileno())
                n_written += 1
                frame_idx += 1
    finally:
        try:
            landmarker.close()
        except Exception:
            pass
        cap.release()

    log(f"worker done: wrote {n_written} frame(s) starting at frame {args.start_frame}")
    sys.exit(0)


# ---------------------------------------------------------------------------
# Supervisor: workerを監督し、ネイティブクラッシュから復旧する
# ---------------------------------------------------------------------------

def count_checkpoint_lines(path):
    if not os.path.isfile(path):
        return 0
    with open(path, "r", encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def probe_video(video_path):
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None, None
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    n = int(n) if n and n == n and n > 0 else None
    fps = fps if fps and fps == fps and fps > 0 else None
    return n, fps


def run_supervisor(args):
    if not os.path.isfile(args.video):
        log(f"ERROR: video not found: {args.video}")
        return 1
    if not os.path.isfile(args.model):
        log(f"ERROR: model not found: {args.model}")
        return 1

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    checkpoint = os.path.join(out_dir, ".py-landmarks.checkpoint.ndjson")
    if os.path.exists(checkpoint):
        os.remove(checkpoint)

    total_frames, fps = probe_video(args.video)
    if total_frames:
        log(f"video: {args.video} (~{total_frames} frames @ {fps or '?'} fps)")
    else:
        log(f"video: {args.video} (frame count unknown from metadata; will run until worker reports completion)")

    restarts = 0
    crashed_frames = []
    start_frame = 0
    t_start = time.time()

    while True:
        if total_frames is not None and start_frame >= total_frames:
            break

        worker_cmd = [
            sys.executable, os.path.abspath(__file__),
            "--worker-mode",
            "--video", args.video,
            "--model", args.model,
            "--start-frame", str(start_frame),
            "--checkpoint", checkpoint,
        ]
        log(f"launching worker from frame {start_frame} (restart #{restarts})")
        proc = subprocess.run(worker_cmd, capture_output=True, text=True)

        if proc.returncode == 0:
            log("worker finished cleanly (reached end of video)")
            break

        if proc.returncode == SETUP_ERROR_EXIT_CODE:
            log("FATAL: worker setup failed:")
            log(proc.stderr.strip()[-4000:])
            return 1

        # ここに来るのは想定外の終了のみ:
        #   - returncode < 0 : OSシグナルによる終了。mediapipeのSIGABRTクラッシュが主因
        #     (モジュールdocstring参照)。POSIXではPythonのsubprocessはシグナル終了時
        #     returncodeを負値(-シグナル番号)にする。
        #   - それ以外の正の予期しないコード
        n_done = count_checkpoint_lines(checkpoint)
        crashed_idx = n_done  # 直前まで書けたフレーム数 = クラッシュしたフレームのインデックス(0始まり)
        log(
            f"WARNING: worker exited abnormally (code={proc.returncode}) "
            f"while processing frame {crashed_idx}; stderr tail:\n"
            f"{proc.stderr.strip()[-2000:]}"
        )

        # クラッシュしたフレームをプレースホルダとして記録し、次のフレームから再開する
        ts_ms = round(crashed_idx / (fps or 30.0) * 1000)
        placeholder = {
            "tMs": ts_ms,
            "frameIdx": crashed_idx,
            "detected": False,
            "pose2d": None,
            "world": None,
            "vis": None,
            "crashed": True,
        }
        with open(checkpoint, "a", encoding="utf-8") as ckpt:
            ckpt.write(json.dumps(placeholder) + "\n")

        crashed_frames.append(crashed_idx)
        restarts += 1
        if restarts > args.max_restarts:
            log(
                f"FATAL: exceeded max-restarts ({args.max_restarts}); aborting. "
                "This suggests a structural problem (e.g. broken model/video), not just a few bad frames."
            )
            return 1

        start_frame = crashed_idx + 1

    # チェックポイントを最終フォーマットに変換
    frames = []
    with open(checkpoint, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                frames.append(json.loads(line))

    n_detected = sum(1 for fr in frames if fr.get("detected"))
    n_crashed = len(crashed_frames)
    elapsed = time.time() - t_start

    out_doc = {
        "meta": {
            "video": os.path.abspath(args.video),
            "model": os.path.abspath(args.model),
            "totalFramesProbed": total_frames,
            "fps": fps,
            "framesWritten": len(frames),
            "detectedFrames": n_detected,
            "crashedFrames": n_crashed,
            "crashedFrameIndices": crashed_frames,
            "restarts": restarts,
            "elapsedSec": round(elapsed, 1),
            "note": (
                "mediapipe==0.10.21 の Python HolisticLandmarker には、顔検出に失敗した"
                "フレームの結果が(poseが取れていても)丸ごと空になって返る問題と、"
                "顔は検出できたがposeが検出できなかったフレームでプロセスがSIGABRTする"
                "バグが存在する(詳細はextract.pyのdocstring参照)。crashed=trueのフレームは"
                "後者を検知しdetected=falseのプレースホルダとして復旧したもの。"
            ),
        },
        "frames": frames,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out_doc, f)

    log(
        f"done: {len(frames)} frame(s) written, {n_detected} detected, "
        f"{n_crashed} crashed-and-recovered, {restarts} restart(s), "
        f"{elapsed:.1f}s -> {args.out}"
    )
    return 0


def main():
    args = build_arg_parser().parse_args()
    if args.worker_mode:
        run_worker(args)  # sys.exit()内部で完結
    else:
        sys.exit(run_supervisor(args))


if __name__ == "__main__":
    main()
