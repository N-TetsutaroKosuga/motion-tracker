# test/sim/ 理論期待値の導出

対象: `test/sim/run.mjs` が実行する全ケースの理論値。数式はすべて `run.mjs` 冒頭の
「1. 理論値ヘルパー」セクションの純関数として実装されており、`node test/sim/run.mjs --dry-run`
で数値を確認できる(ブラウザ不要)。

参照元:
- `../../avatar-depth.html`(行番号は s2-runner 着手時点のもの。s2-hooks の変更で前後する可能性あり)
- `understand/testSurface.md` §3(プローブの返り値)・§5(理論値レシピ)
- `CONTRACT.md` ストリーム2節(フックAPIとケース一覧)

## 0. 前提・決定論化

全ケース共通で、ポーズ投入の直前に以下を実行する(CONTRACT.md指定どおり):

```js
window.__resetCalibration();      // L_ua/L_fa・handCal・signState・One Euro/LP・shoulderZRef等を初期化
window.__setManualCal(0.27, 0.25); // L_ua=U=0.27, L_fa=F=0.25 に固定。calStatus="manual"で自動較正を止める
```

これにより、`fuseArmZHybrid` が使う骨長 `L_ua/L_fa` は **ビルダー定数 `U=0.27`/`F=0.25`
(avatar-depth.html:1469,1483 の `buildPoseElev`/`buildPoseReach` ローカル変数)と厳密に一致**する。
testSurface.md §5 の指摘どおり、この一致がないと `zMag = sqrt(L² − l2D²)` の理論値が
「自分が注入した真のz」と一致しなくなるため、これは全ケースの成立条件そのものである。

また `shoulderZRef` は全ポーズで肩の生z=0固定(全ビルダーで肩は`z=0`)なので、
`expLerp(prev ?? target, target, ...)` により**初回フレームから常に0**に収束する。
したがって以下の式では「肩z=0」を前提にしてよい。

収束待ちは `run.mjs` の `pollUntilStable()` が担う: `__zProbe()` を100ms間隔でポーリングし、
`left.elbowZ`/`right.elbowZ` の両方が2回連続で前回との差 `<0.002` になった時点、または3秒経過で打ち切る。

## 1. `fuseArmZHybrid` の理論値レシピ(共通)

`avatar-depth.html:1169-1193` より、肘・手首のzは次の独立した2つの情報だけで決まる:

- **符号**: `resolveSign(idx, zMag)`(avatar-depth.html:1087-1107)。深度AI無効時(シム経路は常に無効、
  testSurface.md §1)は生z(LP済み)を親関節と比較するフォールバックのみが働く:
  `score = rawZLP[親] - rawZLP[idx]`。`score > FALLBACK_THRESH(0.03m)` なら `sign=+1`(子が親より手前=前方)、
  `score < -0.03` なら `sign=-1`。
- **大きさ**: `zMag = sqrt(max(0, L² - l2D²))`、`l2D = hypot(dx, dy)`(world.x,yのみ、world.zは一切使わない)。

肘: `l2D_elbow = hypot(elbow.x-shoulder.x, elbow.y-shoulder.y)`, `zMag_elbow = sqrt(L_ua² - l2D_elbow²)`,
`elbowZ = shoulderZRef(=0) - sign_elbow * zMag_elbow`。

手首: `l2D_wrist = hypot(wrist.x-elbow.x, wrist.y-elbow.y)`, `zMag_wrist = sqrt(L_fa² - l2D_wrist²)`,
`wristZ = elbowZ - sign_wrist * zMag_wrist`(親は肘)。

**注入したzがそのまま理論値になる条件**: セグメントを `(dx,dy,dz)` で `dx²+dy²+dz²=L²` を満たすように
設計すれば、`l2D=sqrt(dx²+dy²)=sqrt(L²-dz²)` なので `zMag=sqrt(L²-l2D²)=|dz|` となり、
自分が注入した真のzの大きさとアルゴリズムが再構成した大きさが一致する(testSurface.md §5)。
既存の `buildPoseReach`/`buildPoseElev` はこれを体現しており、以下の新ケースもすべて同じレシピに従う。

## 2. 回帰ケース

### 2.1 `regression-reach45` — `__simReach(45)`

`buildPoseReach(45)`(avatar-depth.html:1482-1493)の注入値:
```
elbow: (dx,dy,dz) = (U·cos45°, 0, −U·sin45°)   |v|=U
wrist(肘基準): (F·cos45°, 0, −F·sin45°)         |v|=F
```
`l2D_elbow = U·cos45° = U·sin(90°−45°)`, `zMag_elbow = sqrt(U² − U²cos²45°) = U·sin45° = U·|sin45°|`。
生z差 `rawZLP[肩]-rawZLP[肘] = 0-(-U sin45°) = U sin45° ≈0.191 ≫ 0.03` → `sign=+1`。

```
理論値: elbowZ = -U·sin45° = -0.27 × 0.70711 = -0.19092
理論値: wristZ = -(U+F)·sin45° = -0.52 × 0.70711 = -0.36770
```
左右対称ポーズなので left/right とも同一理論値。許容誤差 ±10%(相対)。

### 2.2 `regression-elev-sweep` — `__simElev(-60/0/60)`

`buildPoseElev`(avatar-depth.html:1468-1479)は **z が常に0**(前額面内の仰角スイープ)。
肘y = `-0.45 - U·sin(deg)`(MediaPipe world: +Y=下)なので、`deg`が増えるほど肘は上(yが小さく=より負)へ動く。

`__armProbe()`(three-vrmボーン空間)はKalidokitのIK抽出とVRMボーン階層を経由するため
閉形式の理論値は立てられない(testSurface.md §3)。よって本ケースは
「`deg=-60→0→60` の順で `armProbe().left.y` と `.right.y` が同一方向に単調変化すること」
のみを検証する(数値の厳密一致は求めない)。

### 2.3 `regression-handanchor-elbowdeg-monotonic` — `__simReachHand(45, 1.0→1.5)`

手アンカー方式の理論値は §3 の較正フィクスチャを前提とする。要旨:
`handScale`を較正基準(1.0)に対する比とみなすと `r = handScale` という恒等式が成り立ち、
`dz = D0·(1 − 1/r)`、2ボーンIKの `d = hypot((U+F)·cos45°, 0, dz)` から
`elbowDeg = acos((U²+F²−d²)/(2UF))` が単調増加する(§3.3 に数値表)。

## 3. 手アンカー方式の較正フィクスチャ(`HAND_CAL_FIXTURE`)

`__setHandCal(cal)` に渡す注入値。`handCal` の自然な形(avatar-depth.html:362)に合わせ、
`{ d09_0: {15,16}, d517_0: {15,16}, W_m, w_n }` を直接埋める。

### 3.1 `d09_0`/`d517_0` の導出

`makeHand(W,f,s,sc)`(avatar-depth.html:1497-1505)で `__simReachHand(reachDeg, handScale)` が
作る左手(`f={0,0,-1}, s={-1,0,0}, sc=0.12·handScale`)について、`handSizeMetrics`
(avatar-depth.html:873-879)が読む2点を計算する:

- 中指MCP(9) = `P(0.45, 0.07)` → `x = W.x - 0.07·sc`, `y = W.y`(f.y=0のため)
- 手首(0) = `W`
- → `d09 = widthNormDist(hand[0],hand[9]) = |dx| = 0.07·sc`(dy=0なのでaspectの影響を受けない)

- 人差指MCP(5) = `P(0.45, 0.22)` → `x = W.x - 0.22·sc`
- 小指MCP(17) = `P(0.45, -0.22)` → `x = W.x + 0.22·sc`
- → `d517 = |dx| = 0.44·sc`

`sc = 0.12·handScale` なので、**`handScale=1.0` を較正基準**とすると:
```
d09_0  = 0.07 × 0.12 = 0.0084
d517_0 = 0.44 × 0.12 = 0.0528
```
この基準で較正すれば、`computeHandAnchorSide` の
`r = max(d09/d09_0, d517/d517_0)` は **d09もd517も同じ比率でhandScaleにスケールする**ため、
`r = handScale` という綺麗な恒等式になる(avatar-depth.html:970-976)。

### 3.2 `W_m`/`w_n` の導出(D0=1.0m に固定)

`currentD0() = f·W_m/w_n`, `f = 0.5/tan(HFOV_DEG/2)`(avatar-depth.html:908-912)。
`HFOV_DEG=60°`(既定値。`run.mjs`は各ケースで明示的に`__setHfov(60)`も呼び、既定値のズレに依存しないようにする):
```
f = 0.5 / tan(30°) = 0.8660254
```
`D0 = 1.0m` になるよう `W_m=0.3464103, w_n=0.3` を選ぶ(`f×0.3464103/0.3 = 1.0`)。
D0の絶対値そのものに強い意味はなく、`dz`のクランプ範囲 `[-0.15, U+F+0.1=0.62]` に収まる
扱いやすい値であることが目的。

### 3.3 `handAnchorTheory(reachDeg, handScale)` の計算(`computeHandAnchorSide`の再現)

`avatar-depth.html:964-1057` を辿ると、`reachDeg`固定・`handScale`可変のとき:

```
r  = handScale                              (§3.1の恒等式)
dz = clamp(D0·(1 − 1/r), −0.15, U+F+0.1)     (avatar-depth.html:978)
```
`anchorWristZ = shoulderZRef − dz = −dz`。IK用の差ベクトル `S→W` は
`wrist`の生x,y(handScaleに非依存、`__simReachHand`はz以外を変えない)から:
```
dxIK = (U+F)·cos(reachDeg)   dyIK = 0   dzIK = −dz
d    = min(hypot(dxIK,0,dzIK), 0.995·(U+F))   (avatar-depth.html:1000-1005)
cos(elbowDeg) = (U²+F² − d²) / (2UF)          (avatar-depth.html:1035-1036)
```
`reachDeg=45`(`(U+F)cos45°=0.36770`)での数値表(`node test/sim/run.mjs --dry-run`の出力と一致):

| handScale | r | dz | d | elbowDeg |
|---|---|---|---|---|
| 1.0 | 1.0 | 0.0000 | 0.3677 | 89.92° |
| 1.1 | 1.1 | 0.0909 | 0.3788 | 93.42° |
| 1.2 | 1.2 | 0.1667 | 0.4037 | 101.79° |
| 1.3 | 1.3 | 0.2308 | 0.4341 | 113.14° |
| 1.4 | 1.4 | 0.2857 | 0.4656 | 127.10° |
| 1.5 | 1.5 | 0.3333 | 0.4963 | 145.24° |

`d`が単調増加 → `cos(elbowDeg)`が単調減少 → `elbowDeg`が単調増加、という連鎖で
「近づくほど(handScaleが大きいほど)肘が伸びて見える」という直感と整合する。
全てクランプ境界(`d<0.995×0.52=0.5174`, `dz`は`[-0.15,0.62]`内)に収まっており、
特異点処理を踏まない範囲であることも確認済み。

**この較正フィクスチャの妥当性は s2-hooks の実際の `__setHandCal` 実装に依存する**
(「実装はhandCal構造を読んで自然な形を定義してよい」とCONTRACT.mdに明記されているため)。
実装が上記と異なるキー名・単位を要求する場合は、s2-verifyで `HAND_CAL_FIXTURE` を
実装に合わせて調整すること。

## 4. 新規ケース

### 4.1 `new-reachLR-60-0` — `__simReachLR(60, 0)`

左右独立に矢状面リーチを与えるビルダー(`degX=0`はTポーズ位置)。左は2.1と同じ式で`deg=60`:
```
理論値: left.elbowZ = -U·sin60° = -0.27 × 0.86603 = -0.23383
```
右は`deg=0`(Tポーズ位置)なので `l2D = U·cos0° = U`、`zMag = sqrt(U²-U²) = 0`
→ `elbowZ ≈ 0` (符号によらず大きさが0)。生z差も0で `FALLBACK_THRESH=0.03`未満のため
符号は不定(前回値 or 初期値+1のまま)だが、`zMag=0`なのでどちらにせよ結果は0。
許容誤差は絶対値 `±0.02`。さらに「左右が混ざらない」ことを
`|right.elbowZ − left.elbowZ| > 0.1` で明示的に確認する。

### 4.2 `new-reachLR-30-75` — `__simReachLR(30, 75)`

左右とも2.1と同じ式をそれぞれの角度で適用する(角度が独立に効くことの確認):
```
理論値: left.elbowZ  = -U·sin30°     = -0.13500
理論値: left.wristZ  = -(U+F)·sin30° = -0.26000
理論値: right.elbowZ = -U·sin75°     = -0.26080
理論値: right.wristZ = -(U+F)·sin75° = -0.50228
```

### 4.3 `new-reach3d-45-30` — `__simReach3D(45, 30)`

**当初は仮定として立てた式だが、着手後に確認できた s2-hooks の実装(`avatar-depth.html`の
`reach3DDir`/`buildPoseReach3D`, 現行diffベース。今後さらに変更される可能性はある)は
下記の式と完全に一致している**(`reach3DDir`: `outward=cos(el)cos(az)`, `y=-sin(el)`,
`z=-cos(el)sin(az)`)。方位角(azim, 0=横→90=正面)と仰角(elev, -90..90)の複合リーチを、
`buildPoseReach`(azim専用)と`buildPoseElev`(elev専用)を素直に一般化した球面座標合成とみなす:
```
肩→肘 = U · (cos(elev)·cos(azim), −sin(elev), −cos(elev)·sin(azim))
肘→手首 = F · (同じ方向)                     (腕は一直線、既存ビルダーと同じ規約)
```
`azim=elev=0` で `buildPoseReach(0)`(Tポーズ)、`elev=deg,azim=0` で `buildPoseElev(deg)`、
`azim=deg,elev=0` で `buildPoseReach(deg)` に一致する、という境界条件を満たす最も自然な式。

`l2D_elbow = U·sqrt(cos²(elev)cos²(azim) + sin²(elev))` なので:
```
zMag_elbow = sqrt(U² − l2D_elbow²) = U·sqrt(cos²(elev) − cos²(elev)cos²(azim))
           = U·|cos(elev)·sin(azim)|
```
これは注入した `dz = −U·cos(elev)·sin(azim)` の絶対値と一致する(自己無矛盾)。
`azim=45°, elev=30°`:
```
理論値: elbowZ = -U·cos30°·sin45° = -0.27 × 0.86603 × 0.70711 = -0.16534
理論値: wristZ = -(U+F)·cos30°·sin45° = -0.52 × 0.61237 = -0.31843
```
`side`省略(=both)は左右とも同じ式(右は`x`成分の外向きのみ反転、`z`は反転しない;
既存の`buildPoseElev`/`buildPoseReach`の右腕ミラー規約と同じ)。これも`buildPoseReach3D`の
`doLeft/doRight`(`side!=="right"`/`side!=="left"`)の実装と一致することを確認済み。
`run.mjs`では、実装を直接実行しての最終確認はまだ行っていないこと(本タスクではnode --checkと
--dry-runのみに限定)、および今後さらにファイルが変更されうることを踏まえ、引き続き他ケースより
広め(±15%)の許容誤差を安全側に設定している。s2-verifyで実行し、収束後の値が安定して
±10%以内に収まるようなら、他ケース同様±10%へ締めてよい。

### 4.4 `new-cross-40` — `__simCross(40)`

左腕が正中線を越えて右前方へ交差するリーチ。着手後に確認できた実装(`buildPoseCross`)は
`theta = 90° + deg` として `buildPoseReach`と同じ式 `(U·cosθ, 0, −U·sinθ)` を単に
theta>90°まで振り切るだけの設計だった(`deg=40`→`theta=130°`→`cos130°<0`でxが対側に転じ、
`sin130°>0`は保たれるのでzは負のまま)。この式で数値を検算すると
`left.elbowZ ≈ -U·sin130° = -0.2068`, `left.wristZ ≈ elbowZ - F·sin130° = -0.3983` となり、
下記の不変量は問題なく満たされる。ただしこの式は今後変更される可能性があり、
CONTRACT.md自体も本ケースについては数値の一致ではなく次の不変量のみを要求しているため、
`run.mjs`はこの検算値をハードコードした期待値としては使わず、不変量ベースの判定のみを行う:

1. `left.elbowZ < 0` かつ `left.wristZ < 0`(前方に出ている)
2. `__armProbe().left.x` の符号が、基準姿勢(`__simPose("tpose")`)での
   `armProbe().left.x` の符号と反転している(体の反対側へ腕が向いた証拠)
3. `__zProbe()`の主要な数値フィールド(left/right の elbowZ/wristZ)が有限値であり、
   `|value| < 1.5×(U+F) = 0.78` の範囲に収まっている(NaN/爆発が起きていないことの代理指標)

`run.mjs`はこの3点のみを判定基準にしており、閉形式の数値目標は設定しない。

### 4.5 `new-reachhand2-symmetric` — `__simReachHand2(45, 1.4, 45, 1.4)`

左右とも同じ `(reachDeg=45, handScale=1.4)` を与えるため、§3.3の表より理論値は:
```
理論値: r = 1.4, dz = 0.2857, elbowDeg ≈ 127.10°  (左右とも同一)
```
判定基準はCONTRACT.mdの文言どおり「非null」かつ「左右対称」を主とし
(`r`は相対誤差15%以内、`dz`は絶対誤差 `max(0.02, 15%)`以内、`elbowDeg`は相対誤差15%以内で
左右を比較)、上記の理論値は補助的な参考情報としてレポートに残す(理論値との一致は
合否条件に含めない。較正フィクスチャの前提がずれても左右対称性そのものは
実装が正しく動いていれば成立するはずのため、より頑健な判定基準として採用した)。

### 4.6 `new-visibility-gate` — `__simVis`

`__simVis(baseName, visMap)` の `baseName` 語彙は実装者(s2-hooks)が定義してよいとされているため、
**CONTRACT.md自身が例示する最低限の語彙 `"既存4ポーズ+reach45相当"` に従い、
`"tpose"`(既存4ポーズの1つ)と `"reach45"`(`buildPoseReach(45)`相当の新規名)が
存在するという前提**でケースを組んだ。着手後に確認できた実装(`simVisBase`)は
`"down"|"up"|"tpose"|"leftup"` の4つに加え `/^reach(-?\d+(?:\.\d+)?)$/` に一致する
任意の `"reach<deg>"`(`"reach45"`はもちろん `"reach-30"`等も)を受け付ける設計であり、
本ケースの前提と一致している。

手順(f1タスクでヒステリシス化に合わせて更新、旧版は末尾§4.6.1参照):
1. `__simVis("reach45", {})` → 収束 → `elbowZ_before ≈ -U·sin45° = -0.19092`(§2.1と同じ)
2. `__simVis("tpose", {13: 0.45})` に切替(vis=0.45は新旧どちらの閾値でも凍結開始域
   `<HZ.VIS_GATE_MIN=0.5`)→ 100ms間隔で3サンプル観測
3. 続けて `__simVis("tpose", {13: 0.55})` に切替(vis=0.55は**旧VIS_GATE_MIN=0.5より上**だが
   **新VIS_GATE_EXIT=0.6未満**というヒステリシスの中間帯)→ 100ms間隔でさらに3サンプル観測
4. 上記6サンプル全部が`elbowZ_before`から`<0.02`しか乖離しないことを確認
   (**旧・単一閾値実装なら手順3でvis=0.55>0.5により凍結解除され`tpose`理論値0へ動き出すため
   FAILするはず**。実測: 旧コードで再現実行したところ`mid(vis0.55)`で`-0.0170`まで動いてしまい
   実際にFAILすることを確認済み=このケースが新仕様への回帰保護として機能している)
5. 対比として、フレッシュな状態から同じ`reach45→tpose`切替を **vis=1のまま**行うと
   `elbowZ`は`tpose`の理論値`0`付近まで追従するはず
   (`|after − 0| < 0.05` かつ `|after − before| > 0.1` で「実際に動いた」ことを確認)

他の全点(肩・手首等)のvisibilityは1のままなので、`updateVisibilityWatchdog`
(avatar-depth.html:1091-1101)の「全点visibility~0で自動ゲート解除」は発火しない
(`maxVis`は常に1)。したがってvis=0.45/0.55によるゲートは`visGateDisabled`で無効化されず、
意図通り機能するはずである。

### 4.6.1 `new-vis-hysteresis` — ヒステリシス境界の直接検証(f1タスク新規)

`new-visibility-gate`が「中間帯で凍結維持」の1点だけを見るのに対し、本ケースは
CONTRACT.mdが例示する `vis=0.45→0.55→0.65` の3段階を1本の時系列として直接検証する
(`avatar-depth.html`の`visGated()`関数、HZ定数は`VIS_GATE_MIN=0.5`(凍結開始)・
`VIS_GATE_EXIT=0.6`(凍結解除)が既定値)。

```
手順: reach45収束(elbowZ_before≈-0.19092) → tpose+vis13=0.45(3サンプル) →
      tpose+vis13=0.55(3サンプル) → tpose+vis13=0.65(10サンプル)
判定:
  enter(vis=0.45): |elbowZ - before| < 0.02 が全サンプルで成立(凍結開始)
  mid(vis=0.55)  : |elbowZ - before| < 0.02 が全サンプルで成立(凍結維持、旧実装ならここでFAIL)
  exit(vis=0.65) : 最終サンプルが tpose理論値0 に ±0.05 で収束(凍結解除→追従)
```

実測(現行avatar-depth.html): `enter=[-0.1909,-0.1909,-0.1909]` `mid=[-0.1909,-0.1909,-0.1909]`
`exit=[-0.0129,-0.0052,...,-0.0000]`(10サンプル目で0に収束)で **PASS**。
同じケースを旧実装(ヒステリシス無し、`VIS_GATE_MIN`単一閾値=0.5)で実行すると
`mid(vis=0.55)=[-0.0170,-0.0046,-0.0014]`となり、vis=0.55の時点で即座に凍結が解除されて
`tpose`側へ動き出してしまうため`holds=false`で**FAIL**することを確認済み
(`git stash`でavatar-depth.htmlだけ変更前に戻して再実行、本タスクの検証記録)。
これが「ヒステリシス化が実際に点滅を防いでいる」ことの直接証拠になっている。

exit相当のフィルタ収束が10サンプル(≈1秒)かかるのは、凍結中は`oneEuro()`が一度も
呼ばれず内部の`tPrev`が更新されないため、解除直後の1呼び出しで`dt`が長時間分
まとまって渡り、OneEuroFilterのアルファが一時的に1に近づいて大きく動いた後、
通常の`mincutoff=1.0`ベースの追従に戻るため(`avatar-depth.html`の`OneEuroFilter.filter`実装通りの挙動)。

## 5. (任意) `optional-fakedepth-sign` — `__setFakeDepth`

CONTRACT.mdは本フックについて「実装はテスト注入点を自由に設計してよい。実カメラ経路を
変えずに実装できる場合のみ。困難ならスキップし理由を報告」としている。

着手後に確認できた実装(`avatar-depth.html:701-706`)により、シグネチャは確定している:
`window.__setFakeDepth(fn)`、`fn: (nx, ny) => number|null`(正規化画像座標→深度スコア、
**値が大きいほど「近い」**という規約)。`depthAvailable()`も`!!fakeDepthFn || (depthEnabled && !!latestDepthRaw)`
に拡張されており、フェイク深度セット時は「深度AI利用可能」とみなされるようになっている。

`run.mjs`では以下の方針で扱う:
- `window.__setFakeDepth`が存在しなければ即 `SKIP(hook-missing)`。
- 存在すれば `(nx) => -nx*1000` (xが大きいほど「奥」)を注入する。`buildPoseReach(45)`では
  肘のlm2.xが肩より確実に大きいため、この関数は「肘は肩より奥」という、フォールバック
  (生zに基づく符号、この姿勢ではsign=+1=肘が肩より手前)と**意図的に逆の結論**を
  深度分岐に出させる設計になっている。ランドマークidxではなく幾何(x座標)に基づくため、
  他の姿勢に差し替えても壊れにくい。

### 5.1 s2-verifyで確認・修正した結果(実行済み)

**予想通り製品コードのバグが実在した。** `resolveSign`の深度分岐が呼ぶ`sampleRefDepthAligned`
(肩の参照値、旧l730-733)と`sampleArmPointDepthAligned`(肘/手首自身、旧l772-784)は、
**どちらも`depthWindowValues`を呼ぶ前に`if (!latestDepthRaw) return null;`で早期returnして
いた**(旧l732, l773)。`latestDepthRaw`(実Depth-Anything-V2推論結果のキャッシュ)は
`__setFakeDepth`では一切設定されないため、`depthAvailable()`がtrueになっても上記2関数は
常にnullを返し、`fakeDepthFn`自体は`depthWindowValues`の中では正しく参照される実装に
なっているにもかかわらず、呼び出し元の手前で握りつぶされて到達していなかった。

**修正(avatar-depth.html:730-736, 775-778)**: 両関数のガードを
`if (!fakeDepthFn && !latestDepthRaw) return null;` に変更し、`fakeDepthFn`使用時のみ
`latestDepthRaw`の有無を問わないようにした。`fakeDepthFn`は既定`null`のため、実カメラ経路
(`fakeDepthFn==null`)では従来の条件式`!latestDepthRaw`に完全に還元され、挙動は一切変わらない
(`Z_METHOD==="legacy"`のときはそもそも`fuseArmZHybrid`自体を経由しないため、この2関数も
`resolveSign`も呼ばれず無関係)。

この修正だけでは`run.mjs`側でまだ差分が観測できず、**テスト側にもう1つ設計ミスがあった**
ことが判明した: `__resetCalibration()`→`__setManualCal()`→`__setFakeDepth()`→`__simReach(45)`
を別々の`page.evaluate`呼び出しに分けていたため、その合間にブラウザの`requestAnimationFrame`
ループが割り込み、「resetで`signState.init=false`になった直後、まだ`fakeDepthFn`未設定のうちに
フォールバック分岐で符号を確定させてしまう」フレームが挟まっていた。`resolveSign`は
「初回決定は`proposed`を無条件採用、以降は`zMag`が体側平面付近(`FLIP_ZMAG_THRESH`未満)でない限り
前回符号を凍結し続ける」という意図的なヒステリシス(Schmittトリガー)を持つため、
一度フォールバック分岐で`+1`に決まってしまうと、後から`__setFakeDepth`を呼んでも
`__simReach(45)`のような`zMag`が常に大きい静的ポーズでは符号は二度と反転しない。
デバッグスクリプトで実測確認済み: 別々の`evaluate`だと`signElbow`は常に`+1`のまま、
reset+cal+fakeDepth+poseを1回の`page.evaluate`にまとめて原子的に実行すると
期待通り`-1`に反転する。

**対応**: `test/sim/run.mjs`の該当ケースを、上記の一連の呼び出しを単一の`page.evaluate`に
まとめる形に修正し、あわせて`pass: null`(info-only)だった判定を実際のpass/fail判定に格上げした
(CONTRACT.mdの「深度符号分岐: フェイク深度で『肘が肩より手前』を示す→sign確定がFALLBACKでなく
SIGN_HI/LOで決まることを確認する」という要求に対応)。判定は3値の組み合わせ:
`fallbackSign===1`(深度未使用時の基準) かつ `fakedOppositeSign===-1`(逆方向のフェイク深度で反転)
かつ `fakedSameSign===1`(同方向のフェイク深度では変わらない、対照実験)。
実行結果: `fallbackSign=1, fakedOppositeSign=-1, fakedSameSign=1` で**PASS**。
深度分岐が実際にFALLBACK_THRESHではなくSIGN_HI/LOのスコアで符号を決めていることを確認できた。

## 6. s2-verifyでの実走結果・修正まとめ

s2-verifyが`node test/sim/run.mjs`を実ブラウザ(headless Chromium, インターネット経由で
jsdelivr CDNからthree.js等を取得)で実行し、以下を確認・修正した。最終結果は
**PASS=10 FAIL=0 SKIP=0 ERROR=0(全10ケース、3回連続実行して再現性も確認済み)**。

- §4.1〜4.6の新規ケース(`__simReachLR`/`__simReach3D`/`__simCross`/`__simReachHand2`/
  `__simVis`)は理論値どおりに**すべてPASS**。s2-hooksの実装(`buildPoseReachLR`/`reach3DDir`+
  `buildPoseReach3D`/`buildPoseCross`/`__simReachHand2`/`simVisBase`)は本ファイルが着手時に
  立てた仮定と実測値ベースでも一致していた。
- 回帰3ケース(`regression-reach45`/`regression-elev-sweep`/`regression-handanchor-elbowdeg-monotonic`)
  も全てPASS。既存機能に対する副作用は観測されなかった。
- `optional-fakedepth-sign`は§5.1に記載の**製品コードのバグ1件**(`sampleRefDepthAligned`/
  `sampleArmPointDepthAligned`の`latestDepthRaw`nullガードが`fakeDepthFn`を握りつぶす)と
  **テスト側のバグ1件**(`page.evaluate`呼び出しの分割によるrAFレース)を修正した上で
  実際のpass/fail判定に格上げし、PASS。
- `avatar-depth.html`起動には`https://cdn.jsdelivr.net/...`(three.js / three-vrm / Kalidokit /
  mediapipe tasks-vision / サンプルVRM 約10MB)へのインターネット接続が必要であることを確認
  (このs2-verify実行環境では到達可能だった)。
- 実カメラ経路・`Z_METHOD="legacy"`方式への影響: 今回の製品コード修正2箇所はいずれも
  `!fakeDepthFn && !latestDepthRaw` という形で、`fakeDepthFn`が`null`(実カメラ経路の既定)の
  場合は修正前の条件式`!latestDepthRaw`に完全に還元される。また`legacy`方式は
  `fuseArmZHybrid`自体を呼ばないため、この2関数にも`resolveSign`にも到達しない。
  回帰ケース(hybrid方式のsim実行)が全てPASSしていることも合わせ、実カメラ・legacy経路への
  影響はないと判断した。

## 7. f1タスク新規ケース: 較正結果フィードバック(`__calProbe`)

CONTRACT.mdの検証手順dに対応。`window.__calProbe()`の仕様は本タスクで新規追加した
`avatar-depth.html`のフックで、既存フックとは異なり `__resetCalibration`→`__setManualCal`という
共通前提を踏まない(骨長較正そのものをテスト対象にするため、あえて`L_ua/L_fa`を
プリセットしない状態から手動較正フロー全体を素で走らせる)。開始は他の較正関連操作と同じく
`page.click("#calBtn")`でDOM経由(`startManualCalibration`にヘッドレス専用フックは無く、
既存のUIボタン一本槍という設計は変更していない)。

### 7.1 `new-calibration-feedback-handmissing`

`__simPose("tpose")`(既存4ポーズの1つ、`leftHandLandmarks`/`rightHandLandmarks`を持たない仕様、
testSurface.md §1)のまま`#calBtn`をクリックし`MANUAL_CAL_MS=3000ms`+500ms待って
`__calProbe()`を読む。

```
理論値: L_ua = 0.2700, L_fa = 0.2500 (buildPose("tpose")の11-13-15/12-14-16セグメント長が
        U=0.27/F=0.25と厳密に一致するため、§1のtpose座標から検算可能)
期待:   ok.bone === true, ok.shoulder === true, ok.handLeft === false, ok.handRight === false,
        missing に "handLeft" と "handRight" の両方を含む
```

実測: `ok={"bone":true,"handLeft":false,"handRight":false,"shoulder":true}`
`missing=["handLeft","handRight"]` `adopted.L_ua/L_fa=0.2700/0.2500` で**PASS**。
「骨長・肩幅は較正できるが手サイズだけ構造的に欠損する」という設計通りの分離が確認できた。

### 7.2 `new-calibration-parallelism-gate`

`__simPose("tpose")`で900ms収集した後、`__simReachLR(80, 80)`(両腕とも矢状面80°、
画面に対しほぼ正面を向いた強い遠近短縮姿勢)を600ms混入させ、再度`tpose`に戻して
合計3000ms超まで待つ。

```
混入姿勢のlm2上2D長 ≈ tposeの cos(80°) ≈ 0.1736倍(=17%)
CAL_NEAR_MAX_RATIO=0.92 のゲート判定: 0.1736 < 0.92 → 確実に棄却されるはず
期待: 棄却が機能していればL_ua/L_faはtpose理論値(0.27/0.25)付近(±10%)に留まる
```

実測: `ok.bone=true adopted.L_ua=0.2700 adopted.L_fa=0.2500`(混入姿勢の影響ゼロ)で**PASS**。
`stepManualCalibration`に追加したランニング最大2D長ゲート(`manualCalBuf`、
`avatar-depth.html`の`stepManualCalibration`内、CAL_NEAR_MAX_RATIO流用)が
意図通り機能していることを確認した。

## 8. f1タスクでの実走結果まとめ(本タスク該当分)

`node test/sim/run.mjs`(f1タスクの変更後、全13ケース)を実行した結果:
**PASS=12 FAIL=1 SKIP=0 ERROR=0**。

- f1タスクで変更・追加した6ケース(`new-visibility-gate`更新版・`new-vis-hysteresis`・
  `new-calibration-feedback-handmissing`・`new-calibration-parallelism-gate`、および既存の
  回帰3ケース+新規4ケースの計7ケースは無変更のまま)は**全てPASS**。
- **FAIL=1件は`new-cross-40`**(f1タスクの担当範囲外、s2-hooks/s2-verifyが実装した既存ケース)。
  `git stash`で`avatar-depth.html`だけをf1変更前の状態に戻して同じ`test/sim/run.mjs`
  (f1が追加した新ケースはこの状態だと`__calProbe`未実装によりSKIPになるが、`new-cross-40`
  自体は既存フックのみで動く)を再実行したところ、**f1変更前から同じ内容で同じくFAILする**
  ことを確認した(`flipped=false`、`crossArm.left.x=0.2200`が正符号のまま反転しない)。
  原因はおそらく`buildPoseCross(40)`の肩オフセット(x=0.18)に対し`theta=130°`時の
  肘x座標(`0.18+0.27·cos130°≈0.0064`)がほぼゼロ止まりで、意図された「対側への交差」ほど
  深く潜り込んでいないテスト側の角度選定に起因すると見られるが、これは本タスク(f1)の
  担当範囲(HZ/CAL定数のチューニングとゲート挙動)の外であり、既存コード(`buildPoseCross`/
  `new-cross-40`のassert)の修正はs2-verify領域の再訪が必要な別問題として報告に留め、
  本タスクでは変更していない。
- 上記の切り分けにより、f1タスクの変更(ヒステリシス化・slerpフロア調整・ドリフトクランプ・
  手動較正の平行性ゲート・較正フィードバックUI)が新たな回帰を生んでいないことを確認した。
