# motion-tracker

Webカメラでリアルタイムにモーショントラッキング／VRMアバター連動を行う、**ブラウザ完結・単一HTML（ビルド不要）** の実験アプリです。映像は外部送信されず、すべてブラウザ内で処理されます。

## 収録アプリ

- **`index.html` — モーショントラッカー**
  MediaPipe Tasks Vision で、ポーズ(33点)／ハンド(指21点×2)／フェイス(顔メッシュ)／全身(Holistic) をWebカメラ映像に重ねて可視化。ミラー表示・軌跡エフェクト・スナップショット保存など。

- **`avatar.html` — VRMアバター連動**
  Webカメラの全身モーションを three.js + `@pixiv/three-vrm` のVRMアバターに反映（Kalidokit）。サンプルVRM同梱＋自分の`.vrm`読込可。
  オプションで **Depth-Anything-V2（transformers.js + WebGPU）** による前後（奥行き）推定を追加できます（トグルON）。

- **`avatar-depth.html` — VRMアバター連動（奥行き改善版）**
  `avatar.html` から分岐した比較用サンプル。骨長短縮(foreshortening)による幾何計算・深度マップ由来の符号判定・One Euroフィルタ等を組み合わせ、腕をカメラ方向へ伸ばす動きのz(前後)精度を改善。「従来方式」「ハイブリッド方式」をUIで切り替えてA/B比較可能。

- **`depth-lab.html` — z計測ラボ（開発用ツール）**
  Webカメラ映像から複数方式のz推定値を並べて比較・計測できる開発用ツール。

- **`verify.html` — トラッキング検証ページ**
  Webカメラのポーズトラッキングが正しく取れているかを目視＋数値で確認するツール。スケルトンをvisibilityで色分け表示（緑/黄/赤）、計測パネル（FPS・検出率・主要8ボーン長CV・左右対称性・ジッターσ・関節可動域逸脱）とPASS/WARN/FAILバッジを表示。CSV出力・スナップショット保存にも対応。

## 動かし方

カメラAPIはセキュアコンテキスト必須のため **`file://` では動きません**。ローカルHTTPで配信してください。

```bash
cd motion-tracker
python3 -m http.server 8000
```

ブラウザ（Chrome推奨）で開く：

- トラッカー: <http://localhost:8000/index.html>
- アバター:   <http://localhost:8000/avatar.html>
- アバター（奥行き改善版）: <http://localhost:8000/avatar-depth.html>
- z計測ラボ: <http://localhost:8000/depth-lab.html>
- 検証ページ: <http://localhost:8000/verify.html>

初回はモデルをCDNから取得します（要ネット接続）。カメラ使用を「許可」してください。

## 動作環境

- **Chrome / Edge 推奨。**
- アバターの「奥行きAI（深度推定）」は **WebGPU 必須**（Chrome/Edge、Safariは18+）。初回に約50MBのモデルをダウンロードします。
- 静的HTTPSホスト（GitHub Pages / Netlify 等）に置けばチーム共有も可能（ローカル起動不要）。※Claudeの「アーティファクト」は外部CDNをブロックするため不可。

## 技術スタック

- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe) (`@mediapipe/tasks-vision`)
- [three.js](https://threejs.org/) / [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm)
- [Kalidokit](https://github.com/yeemachine/kalidokit)（ランドマーク→ボーン）
- [Hugging Face transformers.js](https://github.com/huggingface/transformers.js) + Depth-Anything-V2（任意・奥行き）
- すべてCDNから読み込み（依存インストール不要）

## 開発者向け: 自動テスト

`test/` 配下にNode 24 + Playwrightの自動テストがあります（`npm install` 必要）。

- `node test/sim/run.mjs` — 奥行きポーズのシミュレーションテスト（`avatar-depth.html`のハイブリッドz/手アンカーを理論値と突き合わせ、26ケース）
- `node test/sim/avatar-reflect.mjs` — シム姿勢がVRMアバター骨に正しく反映されるかを検証（前後/上下/左右・UIボタン・正拳突きサイクルのピーク追従）。スクリーンショットは `test/sim/out/avatar-reflect-shots/`
- `node test/tracking/fetch-media.mjs` — テスト映像（Pexels）の取得とY4M変換
- `node test/tracking/run.mjs` — Chromiumのフェイクカメラで`verify.html`にテスト映像を流し込み、不変量チェック（`checks.mjs`）まで自動実行
- `test/tracking/crosscheck/` — Python版MediaPipe（同一.taskモデル）とのクロスチェック（python3.11必要）。`bash setup.sh` → `.venv/bin/python extract.py` → `.venv/bin/python compare.py`

生成物（`test/**/media`, `test/**/out`, `.venv`）は`.gitignore`済みです。

## 既知の制約

- 単眼カメラのため **前後（奥行き）は原理的に不安定**。深度AIは近似で、ジッターが出る場合があります（`window.__setDepthGain(gain, smooth)` で調整可）。
- 手首の正確な向き付けは単眼では困難なため、既定では前腕に自然追従（誇張しない）。
- VRM0 / VRM1 の両方に対応（腕の仰角符号はバージョンで自動切替）。
