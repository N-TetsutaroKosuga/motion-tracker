#!/usr/bin/env bash
# test/tracking/crosscheck/setup.sh
#
# Python版MediaPipeクロスチェック環境のセットアップ(冪等)。
#   1. python3.11 で test/tracking/crosscheck/.venv を作成(既存ならスキップ)
#   2. mediapipe==0.10.21 / opencv-python / numpy をインストール
#   3. Holistic Landmarker (.task) モデルを test/tracking/media/holistic_landmarker.task に
#      curlでダウンロード(既存かつ空でなければスキップ)
#
# 前提: python3.11 が PATH 上にあること(3.13はmediapipe未対応 — research.md参照)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CROSSCHECK_DIR="${SCRIPT_DIR}"
TRACKING_DIR="$(cd "${CROSSCHECK_DIR}/.." && pwd)"
VENV_DIR="${CROSSCHECK_DIR}/.venv"
MEDIA_DIR="${TRACKING_DIR}/media"
MODEL_PATH="${MEDIA_DIR}/holistic_landmarker.task"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task"

PYTHON_BIN="${PYTHON_BIN:-python3.11}"

echo "== [1/3] venv セットアップ =="
if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "ERROR: ${PYTHON_BIN} が見つかりません。python3.11 をインストールしてください(mediapipeは3.13未対応)。" >&2
  exit 1
fi

if [ -x "${VENV_DIR}/bin/python" ]; then
  echo "  既存の venv を使用: ${VENV_DIR}"
else
  echo "  venv を作成: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
fi

VENV_PY="${VENV_DIR}/bin/python"
VENV_PIP="${VENV_DIR}/bin/pip"

echo "== [2/3] 依存パッケージインストール =="
"${VENV_PY}" -m pip install --upgrade pip >/dev/null
# 既にバージョンが一致していれば pip install はほぼ即時no-opになるため常に呼んでOK(冪等)
"${VENV_PIP}" install \
  "mediapipe==0.10.21" \
  "opencv-python" \
  "numpy"

echo "== [3/3] Holistic Landmarker モデルのダウンロード =="
mkdir -p "${MEDIA_DIR}"
if [ -s "${MODEL_PATH}" ]; then
  echo "  既存モデルを使用(スキップ): ${MODEL_PATH} ($(wc -c < "${MODEL_PATH}" | tr -d ' ') bytes)"
else
  echo "  ダウンロード: ${MODEL_URL}"
  curl -fL --retry 3 -o "${MODEL_PATH}.tmp" "${MODEL_URL}"
  mv "${MODEL_PATH}.tmp" "${MODEL_PATH}"
  echo "  完了: ${MODEL_PATH} ($(wc -c < "${MODEL_PATH}" | tr -d ' ') bytes)"
fi

echo ""
echo "セットアップ完了。"
echo "  venv python: ${VENV_PY}"
echo "  model:       ${MODEL_PATH}"
