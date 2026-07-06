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

## 9. g1タスク: 背面リーチ(前後逆転)バグの修正と恒久回帰ガード

### 9.1 バグの実証(`__boneWorldProbe`)

実機報告(「Y字ポーズで較正後、腕を前に出すとサンプルVRMアバターが背中方向へ腕を伸ばす」)を
`window.__boneWorldProbe(names?)`(新規・読み取り専用。`currentVrm.humanoid.getNormalizedBoneNode(name)
.getWorldPosition()`をそのまま返すだけで判定ロジックには一切関与しない)で実証した。

手順: `__resetCalibration()` → `__setManualCal(0.27,0.25)` → `__simReach(60)`(両腕前方60°) →
収束待ち(§9.3のpollConverge) → `__boneWorldProbe(["leftHand","rightHand","chest"])`で
`handZ − chestZ`を測定。three.jsシーンの規約(CONTRACT.md: 既定カメラ(0,0.85,3.0)が+Z側から
アバターを見る=アバターは+Z方向を向く)より、`handZ − chestZ`が正なら前方、負なら背面。

**修正前の実測値(3回の独立実行で再現、いずれも同一パターン)**:
```
reach60: handZ-chestZ  left=-0.3857  right=-0.3871   (tpose基準: left=-0.0184 right=-0.0162)
```
理論上は前方(+)になるべきところ大きく負(-0.39m前後)になっており、実機報告どおり
「前方リーチのはずが背面へ伸びる」バグを定量的に再現できた。`__zProbe()`(MediaPipe world座標系での
elbowZ/wristZ)は理論値(`-U·sin60°=-0.2338`, `-(U+F)·sin60°=-0.4503`)と完全一致しており、
**world zの計算自体(fuseArmZ/resolveSign)は正しい**ことも同時に確認した
(実機デバッグパネルの「sign L=1/1」観測と整合)。問題はVRMボーン回転への写像だけに絞り込めた。

### 9.2 原因箇所と修正(`avatar-depth.html:1560-1577`付近、`animateVRM`内)

`armSagittal(w, sIdx, eIdx, leftSide)`(前後角を`atan2(forward, outward)`で算出、`forward`は
両側で符号統一済み=前方なら常に正)の出力に、左右のボーン局所軸のミラー関係を表す
`SAG_L=1, SAG_R=-1`(既定値、`avatar-depth.html:286`)を掛けて`rp.LeftUpperArm.y`/
`rp.RightUpperArm.y`へ上書きしていた。この`SAG_L/SAG_R`は「ヘッドレスで決定」(既存コメント)
された値で、`__boneWorldProbe`のような絶対座標ベースの検証を経ておらず、実際には
**両腕とも符号が反転していた**(`SAG_L=1,SAG_R=-1` → 両方 backward、正しくは
`SAG_L=-1,SAG_R=1`相当でforward)。

`__setSag(l,r,s)`で総当たり実験した結果:
```
デフォルト(SAG_L=1,SAG_R=-1):     left=-0.386  right=-0.387  (背面、バグ再現)
__setSag(-1, 1):                left=+0.336  right=+0.334  (前方、正しい)
__setSag(-1,-1) / __setSag(1,1): 左右どちらかのみ正しい(左右が別々に壊れているのではなく、
                                  丸ごと反転で両方直ることを確認 = 左右ミラー関係自体は
                                  壊れておらず、絶対方向だけが全体的に反転していた)
```
この「丸ごと反転」というパターンは、`avatar-depth.html:1531`で仰角(z)成分に既に適用されている
`const sgn = isVRM0 ? 1 : -1;`(VRM0/VRM1のrotateVRM0による180°回転の補正)と同種の現象と推測し、
同梱サンプルVRM(`https://.../three-vrm-girl.vrm`、glTF拡張を確認したところ`extensions.VRM`
(0.x形式)を持ちVRMC_vrmは無い=**VRM0**)について、以下の`sagSgn`を追加することで修正した:

```js
const sagSgn = isVRM0 ? -1 : 1;   // z成分のsgn(isVRM0?1:-1)とは極性が逆
const rawL = SAG_L * sagSgn * armSagittal(src3d, 11, 13, true) * SAG_SCALE;
const rawR = SAG_R * sagSgn * armSagittal(src3d, 12, 14, false) * SAG_SCALE;
```

`isVRM0=true`(同梱サンプル)のとき`sagSgn=-1`となり、`SAG_L(1)*sagSgn(-1)=-1`,
`SAG_R(-1)*sagSgn(-1)=+1`と、実験で確認した「丸ごと反転」後の値に一致する。
`SAG_L/SAG_R`自体の既定値(1/-1)は変更しておらず、左右のミラー関係を表す値としてそのまま残した
(`__setSag`の互換性を保つため。挙動を変えたい場合は`sagSgn`適用後の実効値を
逆算して`__setSag`に渡せばよい)。**z成分の`sgn`とは極性が逆**(z: VRM0で無反転/VRM1で反転、
y: VRM0で反転/VRM1で無反転)である点は、Kalidokitのオイラー分解順序とthree-vrmの正規化ボーン軸が
z成分とy成分で異なる影響を受けるためと推測されるが、第一原理からの完全な導出はできておらず、
**実測ベースの経験的な修正**であることを明記する。VRM1側(`sagSgn=1`=変更なし)は手元に
VRM1モデルが無いため未検証(z側の実装時と同じ前提を踏襲した設計)。

**修正後の実測値(3回の独立実行、いずれも寸分違わず一致)**:
```
reach60: handZ-chestZ  left=+0.3358  right=+0.3343   (tpose基準: left=+0.008〜+0.028 right=+0.016〜+0.020)
```
World z(`__zProbe`)は`left.elbowZ=-0.2338, wristZ=-0.4503`のまま変化なし
(理論値と完全一致、resolveSign/armSagittal自体・fuseArmZの幾何チェーンには一切手を入れていないことの裏付け)。

### 9.3 タイミング脆弱性の修正: `pollConverge`(`run.mjs`)

旧`pollUntilStable`は`__zProbe().{left,right}.elbowZ`のみを100ms間隔・上限3秒・閾値0.002で
監視していた。`__zProbe`の値はOne Euroフィルタ(dt基準)で収束するが、`rigRotation`の
`node.quaternion.slerp(target, SMOOTH)`は**フレーム数ベースの固定ブレンド率**(dt非依存、
`avatar-depth.html`の`rigRotation`実装どおり)で収束するため、headless低fps環境(高負荷時)では
同じ壁時計時間でも消化できるフレーム数が減り、「`__zProbe`は収束済みだが`__armProbe`の実ボーン
回転はまだ動いている」という乖離が生じうる。`new-cross-40`は`__armProbe`の値を直接assertする
ため、この乖離の影響を受けやすい。

**実測(2026-07-03、12倍CPUスロットリング下で3回反復、scratchpad/throttle-cross40.mjs)**:
```
旧実装(__zProbeのみ、100ms/3秒上限/閾値0.002):
  run1: crossArm.left.x=0.57 flipped=false (FAIL)
  run2: crossArm.left.x=0.54 flipped=false (FAIL)
  run3: crossArm.left.x=0.54 flipped=false (FAIL)   ← 3回とも収束途中の値でFAIL

新実装pollConverge(__zProbe+__armProbe+__boneWorldProbe、200ms/8秒上限/閾値0.01):
  run1: crossArm.left.x=-0.27 flipped=true (PASS)
  run2: crossArm.left.x=-0.27 flipped=true (PASS)
  run3: crossArm.left.x=-0.27 flipped=true (PASS)   ← 3回とも正しく収束後の値でPASS
```
`pollConverge(page, opts)`(`run.mjs`)は`__zProbe`/`__armProbe`/`__boneWorldProbe`(存在すれば)の
数値をすべてフラット化し、200ms間隔で2回連続<0.01の変化に収まるまで待つ(上限8秒)。
旧`pollUntilStable(page, opts)`は`pollConverge`の薄いラッパとして残し(`{probe, converged,
elapsedMs}`の形状を維持)、既存の全呼び出し箇所を変更せずに恩恵を受けられるようにした。
`regression-elev-sweep`と`new-cross-40`(いずれも`__armProbe`を直接assertする既存2ケース)は
`pollUntilStable`ではなく`pollConverge`を直接呼ぶ形に変更し、収束済みの`arm`フィールドを
再取得なしでそのまま使う(別途`page.evaluate(() => window.__armProbe())`を呼ぶタイムラグを解消)。

通常負荷下(スロットリングなし)では3回連続実行してPASS=14 FAIL=0を再現確認済み(本文§10参照)。

### 9.4 新規恒久回帰ケース: `new-absolute-forward`

§4.4の`new-cross-40`が「基準姿勢との相対的なx符号反転」のみを見るのに対し、本ケースは
`__boneWorldProbe`の絶対値(`handZ-chestZ`)を直接assertし、「背中に伸びない」ことそのものを
恒久的にガードする。

```
理論チェーン長: (U+F)*sin60° = 0.52 * 0.86603 = 0.45114 (MediaPipe座標系, wristZの理論値の大きさ)
修正後の実測: reach60時 handZ-chestZ = left +0.3358, right +0.3343 (3回の独立実行で
             +0.334〜+0.336の範囲に収束、寸分の違いはOne Euroフィルタの初期状態依存)
修正前(バグ)の実測: left -0.3857, right -0.3871
```
判定閾値は`+0.15`(m)。根拠: 修正後の実測値(+0.33台)の半分以下に設定することで実行間の
フィルタ収束ばらつきを十分吸収しつつ、修正前のバグ値(-0.39台)とは符号はもちろん絶対値でも
大きく乖離しているため、`+0.15`を跨いで誤判定する余地はない。tpose基準値
(`handZ-chestZ`が±0.03程度、中立姿勢なので理論上0付近)も併記し、reach60の値が
「中立から明確に前方へ動いた」ことも参考情報として記録する。

## 10. g1タスクでの実走結果まとめ

`node test/sim/run.mjs`(g1タスクの変更後、既存13ケース+新規1ケースの計14ケース)を実行した結果:
**PASS=14 FAIL=0 SKIP=0 ERROR=0**(3回連続実行して再現性も確認済み)。

- 新規`new-absolute-forward`は**PASS**(§9.4)。
- 従来FAILしていた`new-cross-40`(f1タスク報告の既知問題、§8参照)は、`pollConverge`導入により
  **PASS**に転じた。原因はテスト側のタイミング脆弱性であり(§9.3)、`buildPoseCross`自体の
  角度設計(理論値未設定、不変量ベース判定)は変更していない。
- 他12ケース(回帰3件+新規9件+任意1件)は全てPASS、g1タスクの変更(`sagSgn`の追加、
  `pollConverge`への一本化)による回帰は観測されなかった。
- `regression-elev-sweep`(`__armProbe`の`y`成分の単調性のみを見る既存ケース)は、
  `sagSgn`の変更が仰角(elev)スイープには影響しないことも確認できた。`buildPoseElev`は
  肘/手首のworld z成分を常に0にする(前額面内のみの動き)ため、`armSagittal`(z成分の差分から
  角度を出す関数)の出力は`sagSgn`の値によらず常に0になり、矢状角の上書きパス自体は通っても
  実質的な影響が生じない。`__armProbe`が見ている「world空間でのy(上下)方向」は
  仰角(z)成分の`sgn=isVRM0?1:-1`(g1タスクでは変更していない既存ロジック)で決まるため、
  今回の`sagSgn`追加とは独立に単調性が保たれる。

## 11. g2タスク: ポーズ非依存キャリブレーション(T字/Y字/サボテン対応)

### 11.1 背景と方針

実機ユーザー観測(CONTRACT.md): 「Tポーズだと手が画面に入らない」ためY字で較正したところ
`L_ua=0.213/L_fa=0.197`(理論比でそれぞれ約79%)まで過小推定され、手アンカーのリーチ度`ρ`が
`HA.CAL_RHO_MAX`未満に収まらず`w=0.00`まで抑制されて手アンカーが事実上封殺された。

数学的な必要条件は「Tポーズであること」ではなく「各腕セグメント(上腕・前腕それぞれ)が
画像平面と平行であること」+「手が画面内にあること」。`stepManualCalibration`
(`avatar-depth.html`)の既存の相対ゲート(`CAL_NEAR_MAX_RATIO`、そのセッション内でのランニング
最大2D長との比較)は、**セッション全体が一貫して前傾している場合には無力**という弱点がある
(全フレームが同程度に縮んでいれば、ランニング最大値自体も縮んだ値に落ち着き、以後の全フレームが
「ランニング最大の92%以上」を満たして合格し続けてしまう)。これがY字較正での過小推定を
説明する仮説である。

g2タスクでは、この相対ゲートに加えて **MediaPipe world zを使った絶対的な平面性チェック**を
導入した。既存の相対ゲートは維持しつつ(混入姿勢の検出には引き続き有効、§7.2/11.4参照)、
新たに「セグメント両端点のworld z差」を直接見ることで、セッション全体の前傾も検出できるように
した。

### 11.2 実装(`avatar-depth.html`、行番号は本タスク完了時点)

- L271-272: ボタンラベルを`CAL_BTN_LABEL_IDLE`定数に外出し(`"📐 キャリブレーション（3秒・
  T字/Y字/サボテン可）"`)。
- L173-174 (HTML): ボタンラベル更新＋ヘルプ1行を新規追加
  (`「腕の各パーツが画面と平行になるポーズで。手まで画面内に入れると手アンカーも較正されます。」`)。
- L896-919: `manualCalBuf`を`{ua2d, fa2d}`(左右共有)から`{ua_13, ua_14, fa_15, fa_16}`
  (childIndexキー、左右完全独立)に変更。`resetManualCalBuf()`ヘルパーを新設し
  `startManualCalibration`/`__resetCalibration`の両方から呼ぶ形に統一。
- L907-910: 新規定数`CAL_PLANAR_Z_THRESH`(既定0.06m、`__setCalPlanarZThresh`)と
  `MANUAL_CAL_VIS_MIN`(既定0.6、`__setManualCalVisMin`)を追加。
- L926-950 (`stepManualCalibration`): セグメントループ内で
  - visibilityしきい値を既存の`visOk`既定0.5から`MANUAL_CAL_VIS_MIN`(0.6)に引き上げ
  - `Math.abs(world[bI].z - world[aI].z) >= CAL_PLANAR_Z_THRESH`を新たな棄却条件として追加
    (相対ゲートの前に評価、両方を満たしたサンプルだけが`seg2DLen`/`seg3DLenXY`の計算に進む)
  - 相対ゲートの`maxKey`を`key + "2d"`(共有)から`key + "_" + bI`(左右独立)に変更
- 自動較正(`updateBoneCalibration`)・`fuseArmZHybrid`・`resolveSign`・`armSagittal`等の
  幾何チェーンには一切手を入れていない(制約どおり)。

### 11.3 閾値の選定根拠

**`CAL_PLANAR_Z_THRESH = 0.06`[m]**: `L_ua≈0.27`/`L_fa≈0.25`に対し、セグメントが画面法線
(視線方向)から角度`θ`だけ傾いているとき`|Δz| = L·sin(θ)`となる。
`0.06/0.27 → θ≈13.3°`、`0.06/0.25 → θ≈13.9°`。すなわちこの閾値は**画面平行から
約13〜14°以内の傾きは許容**しつつ、それを超える傾きは棄却する設計になっている。

この値の妥当性を新規ケースで両側から検証した:
- 許容側: `new-calibration-ypose`(`buildPoseElev(45)`、Y字ポーズ。腕が前額面内=z一定=θ=0°)
  → 全フレーム`|Δz|=0`で通過、理論値どおり較正できる(§11.4.1)。
- 棄却側: `new-calibration-frontlean-rejected`(`__simReach3D(30,45)`)
  → `|Δz|(ua)=0.0955m`, `|Δz|(fa)=0.0884m`(いずれも導出はθ=arcsin(sin(45°)·sin(30°))相当の
  複合角で、0.06mを大きく超える)で全フレーム棄却される(§11.4.2)。この角度は実機観測の
  「Y字較正でやや前傾していた」を模した中程度の前傾であり、少なくともこの程度の前傾は
  確実に弾けることを保証する。

**`MANUAL_CAL_VIS_MIN = 0.6`**: 自動較正(`updateBoneCalibration`)の`visOk`既定0.5より
やや厳しい値。手動較正は3秒間という短いウィンドウの中から「一部の良質なフレームだけ」を
選別できればよく(自動較正のように継続的にサンプルを積み増す必要がない)、より高いvisibilityを
要求しても実用上支障がないと判断した。既定の`visOk`引数化を使い回しているため実装コストは
実質ゼロ(`visOk(world, idx, MANUAL_CAL_VIS_MIN)`)。sim側のフィクスチャは全て`visibility:1`
固定のため、この変更によるsim既存ケースへの回帰は発生しない。

### 11.4 新規ケース

#### 11.4.1 `new-calibration-ypose`

`__simElev(45)`(=`buildPoseElev(45)`、Y字相当。肘・手首のworld z成分は仰角によらず常に0)を
流した状態で`#calBtn`をクリックし、`MANUAL_CAL_MS(3000ms)`+500ms待って`__calProbe()`を読む。

```
理論値: L_ua=0.2700, L_fa=0.2500 (buildPoseElevの11-13/13-15セグメント長がU=0.27/F=0.25と
        厳密に一致、z=0のためCAL_PLANAR_Z_THRESHは常に通過)
期待:   ok.bone===true, adopted.L_ua/L_fa が理論値の±10%以内
```

実測: `ok.bone=true adopted.L_ua=0.2700 adopted.L_fa=0.2500 samples={"ua":32,"fa":32,...}`で
**PASS**。「Tポーズでなくても、各セグメントが画面平行でありさえすれば較正が理論値どおりに
成立する」ことを直接確認した(Y字だから過小推定になるわけではなく、腕が前後に傾いていたことが
原因だったという背景仮説と整合)。

#### 11.4.2 `new-calibration-frontlean-rejected`

`__simReach3D(30, 45)`(方位角30°+仰角45°の複合リーチ。前傾を含む)を**較正開始前から
終了まで一定に維持したまま**(§7.2の`parallelism-gate`ケースと異なり、混入ではなく
セッション全体が一貫して同じ角度)`#calBtn`をクリックし、3.5秒待って`__calProbe()`を読む。

```
reach3DDir(30°,45°)より (avatar-depth.html:1821-1825の式):
  cz = cos(45°) = 0.7071
  d.x(左) = cz·cos(30°) = 0.6124,  d.y = -sin(45°) = -0.7071,  d.z = -cz·sin(30°) = -0.3536
  肩(shoulder)のz = 0 (全ビルダー共通)
  肘(elbow)のz  = U·d.z = 0.27×(-0.3536) = -0.0955   → |Δz(肩-肘)| = 0.0955m
  手首(wrist)のz = 肘のz + F·d.z = -0.0955 + 0.25×(-0.3536) = -0.1839
                                                        → |Δz(肘-手首)| = 0.0884m
両方とも CAL_PLANAR_Z_THRESH=0.06m を超えるため、収集ウィンドウ全体で
上腕・前腕セグメントとも1サンプルも採用されないはず。
期待: samples.ua===0 かつ samples.fa===0 → ok.bone===false のまま(既定値0.28/0.25から不変)
```

実測: `ok.bone=false samples={"ua":0,"fa":0,...} adopted.L_ua/L_fa=0.2526/0.2339`で**PASS**
(`samples.ua/fa`が期待どおり0)。なお`adopted.L_ua/L_fa`が既定値(0.28/0.25)からわずかに
ずれているのは、本タスクの変更対象外である**自動較正(`updateBoneCalibration`)が
このシムポーズに対して独立に動作し続けている**ため(`calStatus`は手動較正完了の瞬間まで
`"default"`のままなので、`fuseArmZHybrid`から毎フレーム呼ばれる自動較正が並行して走る)。
自動較正は相対ゲートのみを使うため、一定角度で静止したこのポーズでは「ランニング最大値=
常にその角度の値」となり毎フレーム自身と比較して合格してしまう(自動較正にとってはこれが
既存の仕様であり、本タスクでは変更していない)。実測値`0.2526`は
`U·√(1-d.z²) = 0.27×√(1-0.3536²) = 0.2526`と手計算でも完全に一致し、想定内の副作用である
ことを確認した。手動較正自身の判定(`ok.bone`/`samples`)は自動較正の状態と独立に正しく
機能しており、テストの主張(「絶対平面性チェックが全フレーム棄却する」)には影響しない。

#### 11.4.3 `new-calibration-side-independent`

`__simReachLR(0, 75)`(左=reachDeg0=Tポーズ相当でz=0固定・常時平行、右=reachDeg75=
`|Δz|=U·sin75°≈0.2608m`で常時棄却)を較正開始前から終了まで一定に維持する。

```
左(11-13/13-15)は全フレームz=0で通過し続けるため、manualCalUA/manualCalFAには左由来の
サンプルのみが入り、それぞれ理論値ちょうど(seg3DLenXYがz=0なのでl3=U/Fそのもの)になるはず。
右(12-14/14-16)は全フレーム棄却されるため寄与しない。
期待: ok.bone===true, adopted.L_ua/L_fa が理論値の±5%以内(左のみの寄与なので通常の
      ±10%より厳しいtoleranceで検証)
```

実測(3回の独立実行): `ok.bone=true adopted.L_ua=0.2700 adopted.L_fa=0.2500`で**毎回PASS**
(samplesは17→13→…とフレームレート依存で変動するが値自体は毎回理論値に厳密一致)。
g1以前の実装(`manualCalBuf`が`ua2d`/`fa2d`で左右共有)では、この構成で右腕の縮んだ2D長が
左腕のランニング最大値と混線する余地があった(本ケースは新設のためg1時点での実測比較はできないが、
`manualCalBuf`をchildIndex単位に分離した設計意図をこのケースで直接検証している)。

### 11.5 既存較正ケースの再確認(回帰なし)

`new-calibration-feedback-handmissing`(§7.1)・`new-calibration-parallelism-gate`(§7.2)は
いずれも`buildPose`系(tpose)フィクスチャを使用し、その`z`成分は常に0(全ビルダー共通)である
ため、新設した`CAL_PLANAR_Z_THRESH`ゲートは常に通過し、挙動・実測値とも変化しないことを
確認した(§12実走結果参照)。

## 12. g2タスクでの実走結果まとめ

`node test/sim/run.mjs`(g2タスクの変更後、既存14ケース+新規3ケースの計17ケース)を
**3回連続実行**した結果、いずれも**PASS=17 FAIL=0 SKIP=0 ERROR=0**。

| ケースID | 1回目 | 2回目 | 3回目 |
|---|---|---|---|
| regression-reach45 | PASS | PASS | PASS |
| regression-elev-sweep | PASS | PASS | PASS |
| regression-handanchor-elbowdeg-monotonic | PASS | PASS | PASS |
| new-reachLR-60-0 | PASS | PASS | PASS |
| new-reachLR-30-75 | PASS | PASS | PASS |
| new-reach3d-45-30 | PASS | PASS | PASS |
| new-cross-40 | PASS | PASS | PASS |
| new-absolute-forward | PASS | PASS | PASS |
| new-reachhand2-symmetric | PASS | PASS | PASS |
| new-visibility-gate | PASS | PASS | PASS |
| new-vis-hysteresis | PASS | PASS | PASS |
| new-calibration-feedback-handmissing | PASS | PASS | PASS |
| new-calibration-parallelism-gate | PASS | PASS | PASS |
| **new-calibration-ypose**(新規) | PASS | PASS | PASS |
| **new-calibration-frontlean-rejected**(新規) | PASS | PASS | PASS |
| **new-calibration-side-independent**(新規) | PASS | PASS | PASS |
| optional-fakedepth-sign | PASS | PASS | PASS |

- 新規3ケースは全て**PASS**(§11.4)。
- g1タスクまでの既存14ケース(回帰3件+新規9件+較正2件+任意1件)は全てPASS、
  g2タスクの変更(`manualCalBuf`のキー方式変更、`CAL_PLANAR_Z_THRESH`/`MANUAL_CAL_VIS_MIN`の
  追加、ボタンラベル/ヘルプ文言の変更)による回帰は観測されなかった。
- サンプル数(`samples.ua`/`fa`等)は実行ごとにブラウザのrAFフレームレートに依存して
  17→32→13のように変動するが(headless Chromiumの実行環境負荷による)、採否そのもの
  (`ok.bone`の真偽・`adopted.L_ua/L_fa`の理論値一致)は3回とも安定していることを確認した。
- 自動較正(`updateBoneCalibration`)の既存挙動(相対ゲートのみ・drift clamp等)には
  一切手を入れておらず、`new-calibration-frontlean-rejected`で観測された自動較正側の
  副作用(§11.4.2、`adopted.L_ua=0.2526`)も変更前から存在する仕様どおりの挙動である。

## 13. g3タスク: 独立検証で発見した回帰と修正(`.panel`のビューポート溢れ)

g1/g2タスクの独立検証(sim 3連続実行・敵対的コードレビュー・`probe-avatar.mjs`実測・
側面ビュー目視確認)の過程で、**sim/コードレビューでは検出できない実UI層の回帰**を
`test/tracking/probe-avatar.mjs`(viewport 1280×900)の実行時に発見した。

### 13.1 症状

`probe-avatar.mjs --media punch`が`page.click("#toggleCam")`で
`Timeout 30000ms exceeded ... element is outside of the viewport`により失敗。

### 13.2 原因

`avatar-depth.html`の`.panel`は`position: fixed; left:18px; bottom:18px`で
`max-height`/`overflow`指定が無い。g1(側面ビュー切替行+前後インジケータ行)・
g2(較正ヘルプ文言1行)がそれぞれ`.panel`内にDOM要素を追加した結果、`.panel`の
実測高さが**875px→992px**(+117px)に増加した。`bottom`固定パネルは内容が増えるほど
**上方向**に伸びるため、先頭の`#toggleCam`(構造上パネル最上部)がビューポート上端より
外に出てクリック不能になる。`html,body{overflow:hidden}`かつ`.panel`が
`position:fixed`のため、ページスクロールでは救済されない。

実測(`scratchpad/measure-panel.mjs`、`getBoundingClientRect`):

| viewport高さ | 修正前 `#toggleCam` top/bottom | 修正前 `.panel`高さ | 判定 |
|---|---|---|---|
| 900px(probe-avatar.mjs) | -93.2 / -46.2(完全に画面外) | 992.2px | ✗ クリック不能 |
| 800px | -193.2 / -146.2 | 992.2px | ✗ |
| 720px(test/sim/run.mjsの既定viewport) | -273.2 / -226.2 | 992.2px | ✗(ただし後述) |
| 1080px | +86.8 / +133.8 | 992.2px | ○ |

g1/g2適用前(HEAD)の同条件では900pxで`top=+23.9`(表示可能)・800pxで`top=-76.1`
(既に画面外)だったため、**900px viewportで動いていたものをこの2タスクの変更が壊した**
リグレッションであると確認した(800px以下は変更前から潜在していた別問題)。

`test/sim/run.mjs`はcontextにviewportを指定しておらずPlaywright既定の1280×720を使う。
720pxでは修正前でも`#calBtn`のクリックは(bottom内3px程度がぎりぎり viewport内に
残っていたため)たまたま成功しており、`node test/sim/run.mjs`のPASS結果だけでは
このリグレッションを検出できなかった(`scratchpad/test-calbtn-click.mjs`で実測・再現)。
CONTRACT.mdが指定するreach-testハーネス(probe-avatar.mjs)のviewport(900px)や、
多くのノートPCの実ブラウザウィンドウ高でも再現しうる実利用上の不具合であり、
「新しいUIが実カメラ経路の主要導線(カメラ開始ボタン)を押せなくする」という
高深刻度の回帰と判断した。

### 13.3 修正

```css
.panel {
  position: fixed; left: 18px; bottom: 18px; z-index: 6; width: 270px;
  max-height: calc(100vh - 36px); overflow-y: auto;
  ...
}
```
`.panel`自体をスクロール可能にし、ビューポートの高さに関わらず全コントロールに
到達できるようにした。見た目は内容が収まる限り従来と同一で、溢れた場合のみ
パネル内部にスクロールバーが出る(ページ全体やcanvasには影響しない)。

### 13.4 修正後の実測

| viewport高さ | `.panel`高さ | `#toggleCam` top/bottom |
|---|---|---|
| 900px | 864px(=900-36) | 35 / 82(画面内) |
| 800px | 764px | 35 / 82 |
| 720px | 684px | 35 / 82 |

修正後、`probe-avatar.mjs --media punch`は正常完了(70サンプル取得、NaN 0件、
`|zProbe|>0.78`の発散0件、最大`|z|`=0.4441m)。修正後に`node test/sim/run.mjs`を
2回追加実行し、いずれも**PASS=17 FAIL=0**(CSSのみの変更のためロジックへの影響なし)。

## 14. h1タスク: 正拳突き(punch)シミュレーションポーズの実装

### 14.1 静止ポーズ `buildPosePunch(side, extendDeg=85, handScale=1.4)`

`avatar-depth.html`の`__simVis`直後(`__armProbe`直前)に実装。突き腕・引き手(チャンバー)とも
「単位方向ベクトル×U/F」で座標を作るため、`dx²+dy²+dz²=U²`(上腕)/`F²`(前腕)が構成上厳密に
成り立つ(自己無矛盾)。

**突き腕(side側、既存`buildPoseReach`の片腕版と同一の数学)**:
```
punchDir(leftSide, θ) = ( (leftSide?+1:-1)·cosθ, 0, -sinθ )   (単位ベクトル)
elbow = shoulder + U·punchDir
wrist = elbow    + F·punchDir           (一直線に伸びる腕、方向は上腕と同じ)
```
`θ=extendDeg=85°`(既定)のとき:
```
理論値: elbowZ = -U·sin85° = -0.27×0.99619 = -0.26897
理論値: wristZ = -(U+F)·sin85° = -0.52×0.99619 = -0.51802
```
拳の高さ(y)は肩の高さのまま(`buildPoseReach`と同じ規約、「理論値を単純に保つ」という要件どおり)。

**引き手(チャンバー、反対側)— 閉形式の導出**:
上腕・前腕とも矢状面(y-z平面)内のみで構成し、x=肩のxのまま(体側から外へは張り出さない)。
```
CHAMBER_UA_DEG = 20°, CHAMBER_FA_DEG = 50°   (avatar-depth.htmlの定数)
chamberUaDir = (0,  cos(20°),  sin(20°))     (単位ベクトル。+y=下、+z=後方)
chamberFaDir = (0,  cos(50°), -sin(50°))     (単位ベクトル。+y=下、-z=前方)
elbow = shoulder + U·chamberUaDir
wrist = elbow    + F·chamberFaDir
```
数値(shoulder.y=-0.45, shoulder.z=0を基準):
```
elbow.z = U·sin20°  = 0.27×0.34202 =  0.09235   (>0 ＝ 体より後ろ)
elbow.y = -0.45 + U·cos20° = -0.45+0.27×0.93969 = -0.19628
wrist.z = elbow.z - F·sin50° = 0.09235-0.25×0.76604 = -0.09916
wrist.y = elbow.y + F·cos50° = -0.19628+0.25×0.64279 = -0.03558
```
`wrist.y≈-0.036`は腰の高さ(landmark 23/24のy=0)のすぐ上に来る(＝「腰脇」相当)。`wrist.z≈-0.099`は
肩面よりわずかに前だが小さい値であり、「拳が脇腹に収まる」という設計意図と矛盾しない
(絶対値が突き腕側のz変化量よりずっと小さいため、後述のboneWorldProbe判定`<+0.05`を十分満たす)。
角度20°/50°は「体側に沿って下向き+やや後方」「前下方で拳が腰の高さに来る」という定性的要件を
満たす値として選定した(前腕角50°は`elbow.y + F·cos(50°) ≈ 0`(腰の高さ)に近づく値から逆算)。
CHAMBER_UA_DEG/CHAMBER_FA_DEGを変えても閉形式の構造(dx²+dy²+dz²=U²/F²)自体は変わらない。

**手ランドマーク**: 突き腕の手首にのみ`makeHand`(fwd向き `f={0,0,-1}`、親指側は左右でミラー、
`scale=0.12×handScale`)を付与する。引き手側は手ランドマーク無し(実測でも検出されないという
d1診断と整合、`CONTRACT.md`該当節参照)。

### 14.2 動的サイクル `buildPosePunchFrame(elapsedMs, opts)` / `__simPunchCycle`

**方式**: 独自タイマーを持たず、`simAnimator`(モジュール変数、nullable関数)を`loop()`内で
`simResult`取得の直前に呼ぶ形に統合した(`avatar-depth.html`の`loop()`、
`if (simAnimator) simResult = simAnimator(now);`)。`cloneSimFrame`の意味論・実カメラ経路は不変。

**時間分割**: `periodMs`を1punchの周期とし、`beatIndex=floor(elapsedMs/periodMs)`の偶奇で
`alternate=true`(既定)なら左右を交互に切り替える(偶数=左が突き腕、奇数=右)。
ビート内ローカル時刻`t=elapsedMs - beatIndex*periodMs`から
`frac = (1-cos(2π·t/periodMs))/2`(半コサイン)を計算する。`frac`は`t=0`で0、
`t=periodMs/2`で1(伸展ピーク)、`t=periodMs`で0(元のチャンバーに戻る)と滑らかに往復する。

**アクティブ腕の方向補間(球面線形補間)**: アクティブ側(その瞬間の突き腕)は
`slerpUnit3(chamberDir, punchDir(extendDeg=85°), frac)`で「チャンバー方向」から
「伸展方向」まで単位ベクトルを球面線形補間する(`avatar-depth.html`の`slerpUnit3`)。
単位ベクトル同士のslerpは常に単位ベクトルを返すため、`U`/`F`を掛けた結果は
**アニメーション中の任意の瞬間で厳密に`dx²+dy²+dz²=U²/F²`を満たす**(静止時の2値だけでなく、
遷移の全区間で骨長が一定に保たれる、単純な線形補間より強い性質)。非アクティブ側(その瞬間は
突いていない側)は常にチャンバー方向で固定(`isActive`分岐、`avatar-depth.html`の`doSide`)。

**visibilityディップ**: `visDip`が真のとき、アクティブ側の肘・手首のvisibilityを
`vis = clamp(1 - 0.7·frac, 0.3, 1)`とし、frac(伸展位相)と完全に連動させて1.0→0.3→1.0と
滑らかに往復させる(d1診断の実測「突き腕の肘/手首visが0.25〜0.5に低下」の再現)。肩・非アクティブ側は
常に1.0のまま。手ランドマークもアクティブ側の手首にのみ付与し、ビート境界で自動的に付け替わる。

**構え(両腕チャンバー)の扱い**: 特別な初期フェーズを設けていない。`frac=0`のとき
`slerpUnit3(chamberDir, punchDir, 0) = chamberDir`となるため、各ビートの開始/終了の瞬間に
アクティブ側も自然にチャンバー姿勢へ一致し、非アクティブ側は常にチャンバーのままなので、
「構え(両腕チャンバー)→左伸展→引き戻し→右…」という時系列が式の構造から自動的に生まれる。

### 14.3 `--use-angle=metal`が必要な理由(実測)

`buildPosePunchFrame`のvisibilityディップは連続関数だが、実際にゲートへ反映されるのは
`loop()`が実際にレンダリングした**離散フレーム**でサンプルした値のみである。
headless Chromiumの既定ANGLE(software GL相当)では本ページのthree.js/VRM描画が**3〜5fps**
程度しか出ず(実測、`scratchpad/quickcheck4.mjs`)、`periodMs=600`のような速い往復に対し
サンプリングが疎になり、ビート境界とサンプル位相の対応が環境依存で暴れる
(実測: 3.5fps環境で`totalFlips=132`、同じシナリオを`--use-angle=metal`適用後の100fps超環境では
`22`に安定収束、3回連続実行しても`20〜22`の狭い範囲で再現)。`test/tracking/run.mjs`が
既に採用している対策と同じもの(macOS実機ではANGLEをMetalバックエンドに切り替えることで
実GPU相当の速度に戻る)を`test/sim/run.mjs`の`setupPage()`にも追加した。既存17ケースは
いずれも「収束を待つ」設計(`pollConverge`)でfpsに依存しないため、この変更による既存ケースへの
副作用は無い(3回連続実行で回帰なしを確認、§14.5参照)。

### 14.4 テスト実行順序に依存する符号ロックの罠(`new-punch-static`で発見・回避)

`resetAndCal(page)`(`__resetCalibration()`→`__setManualCal()`を**別々の**`page.evaluate()`
呼び出しで実行する既存ヘルパー)の直後に`__simPunch(...)`を**別の**`page.evaluate()`で呼ぶと、
直前のケースが残した`simResult`(例: `new-calibration-side-independent`が最後に設定した
「右腕=前方75°リーチ」のポーズ)に対して、2回の`evaluate()`呼び出しの合間にブラウザの
rAFループが割り込む余地がある。`__resetCalibration()`は`signState[idx].init`を`false`に
戻すため、この割り込みフレームで`resolveSign`が**まだ新しいポーズが来ていない古いstale姿勢**を
見て符号を確定させてしまう(`resolveSign`の「初回決定は無条件採用、以降はzMagが体側平面付近
(`FLIP_ZMAG_THRESH`未満)でない限り凍結」というヒステリシス設計により、一度誤って確定した
符号は静止ポーズでは二度と訂正されない)。

これは`optional-fakedepth-sign`(§5.1)で既に発見・対処されていたのと**全く同じ種類の競合**だが、
既存の全ケース(down/up/tpose/reach/cross等)は「正しい符号が常に`+1`」になる姿勢しか
使っていなかったため、たとえ同じ競合が起きても`signState`の既定値(`__resetCalibration`後は
`sign:1`)と偶然一致し、これまで顕在化していなかった。引き手(チャンバー)は本タスクで初めて
「正しい符号が`-1`(後方)」になる姿勢であり、この潜在的な競合を初めて可視化した。

**対応**: `new-punch-static`の各Phaseで、`__resetCalibration()`→`__setManualCal()`→
(Phase2のみ`__setHandCal()`/`__setHfov()`)→`__simPunch()`を**単一の`page.evaluate()`**に
まとめ、間にrAFフレームが挟まらないようにした(§5.1と同じ対処)。実測: 分離した状態では
`right.elbowZ=-0.0924`(符号反転、FAIL)、原子化後は`right.elbowZ=+0.0923`(理論値と一致、PASS)を
再現確認した。**製品コード(`resolveSign`等)は変更していない**(この種の初期化競合は
理論上どの`resetAndCal`利用ケースにも起こりうるが、今回はテスト側の呼び出し粒度で
確実に回避できるため、`resolveSign`自体への変更は本タスクのスコープ外とした)。

### 14.5 静止版の理論値検証(Phase分離の理由込み)

`__simPunch("left",85)`に`makeHand`で手ランドマークを付与すると、`HAND_ANCHOR_ENABLED`既定`true`の
手アンカー機構が(手較正済みなら)作動する。`extendDeg=85`ではリーチ度`ρ=1-(lE+lW)/(U+F)≈0.91`が
`HA.RHO_HI=0.65`を大きく超えるため、手アンカーは全重み(`w=1`)で作動し、`elbowZ`/`wristZ`を
プレーンなチェーン理論値から2ボーンIK再構成値へ**上書き**する(実測: 較正込みだと
`left.elbowZ=-0.194`/`wristZ=-0.286`となり理論値`-0.269`/`-0.518`と一致しない)。これは
`regression-handanchor-elbowdeg-monotonic`が`elbowZ`ではなく`elbowDeg`だけを検証しているのと
同じ理由による仕様上の帰結であり、バグではない。そのため`new-punch-static`は2フェーズに分割した:

- **Phase1(手較正なし)**: `computeHandAnchorSide`は`D0`(`currentD0()`)が未較正だと
  `quality=false`のままプレーンなチェーン値へフォールバックする(既存仕様、d2診断で検証済み)。
  この状態でチェーン理論値と`boneWorldProbe`(前後)を検証する。
- **Phase2(手較正あり、`HAND_CAL_FIXTURE`)**: `handAnchor.left.r≈handScale(1.4)`のみを検証する。

**実測(3回連続実行、いずれも同一値でPASS)**:
```
Phase1: left.elbowZ=-0.2690(理論-0.2690) left.wristZ=-0.5180(理論-0.5180)
        right.elbowZ=+0.0923(理論+0.0923, >0.03要求を満たす)
        boneWorldProbe: punchDz=+0.20〜+0.24(要>0.15) chamberDz=-0.32〜-0.45(要<0.05)
Phase2: handAnchor.left.r=1.4000(理論1.4)
```

### 14.6 動的サイクルの検証設計(`new-punch-cycle`)

`periodMs=600`で約3秒(実測elapsedMs≈3.1〜3.4秒、≈5〜6punch相当)実行し、100ms間隔で30回
`__zProbe()`をサンプルする。手アンカー(`HAND_ANCHOR_ENABLED`)はテスト開始時に一時的に
`__setHandAnchor(false)`で無効化し、終了時に`true`へ復元する: 有効なままだと`gatedFuseAxis`が
肘のx/y軸にも独立したゲートキー(`"13x"`/`"13y"`等)を追加するため、1punchあたりの
フリップ数が「肘・手首(z)各1キー×2」の理論値`4`から`8`に倍増し、`CONTRACT.md`が例示する
「1punchあたり≤4」との対応が付けにくくなるため(手アンカー自体の正しさは`new-punch-static`で
別途検証済み)。

**フリップ数の理論**: `vis=1→0.3→1`の半コサイン往復は`HZ.VIS_GATE_MIN(0.5)`を1回(凍結開始)・
`HZ.VIS_GATE_EXIT(0.6)`を1回(凍結解除)、合計2回横切る。手アンカー無効時はアクティブ側の
肘・手首(z)の2キーのみがこのvisを見るため、**1punchあたり正確に4フリップ**になる
(`--use-angle=metal`導入後の100fps超環境で3回連続実行し、いずれも`totalFlips=20`前後
(elapsedMs/600×4の理論値に近い値)で安定することを確認済み)。判定は
`0 < totalFlips ≤ ceil(elapsedMs/periodMs)×4×1.5`(ビート境界とサンプリングのずれの余裕として
1.5倍)。

**実測(3回連続実行)**:
```
run1: elapsedMs=3276 totalFlips=22 gateFlips={13:6,14:5,15:6,16:5}
run2: elapsedMs=3117 totalFlips=20 gateFlips={13:6,14:4,15:6,16:4}
run3: elapsedMs=3085 totalFlips=20 gateFlips={13:6,14:4,15:6,16:4}
```
いずれも`|elbowZ|,|wristZ|<0.78`で有界・NaN無し・`__simPunchStop()`後は
`__simAnimState()`が`{hasSimResult:false,hasAnimator:false}`(実カメラ経路へ復帰)を確認した。

### 14.7 `__resetCalibration`とアニメーション再生の独立性(検討・方針)

**方針(採用): 較正リセットとアニメ再生は独立の関心事とし、`__resetCalibration()`は
`simAnimator`を一切変更しない。停止は「解除」系(`setSim`経由の全ボタン)と`__simPunchStop()`の
2経路のみに限定する。**

理由:
1. 較正(骨長・手アンカー・フィルタ状態)とシミュレーション対象ポーズは直交する関心事であり、
   既存の`__sim*`系フック(`__simReach`等)も較正状態を変更しない/較正リセットもポーズを
   変更しない、という対称性が既に成り立っている。アニメーションだけ例外的に較正リセットで
   止まる仕様にすると、この対称性が崩れ「較正だけやり直したいがポーズ再生は続けたい」
   (例: サイクル再生中に手動較正をやり直すワークフロー)を阻害する。
2. 実測で確認した通り(`scratchpad/verify_resetcal_independence.mjs`)、`__resetCalibration()`を
   呼んでも`simAnimator`は生き続け、その後も`__zProbe().cal`が(較正リセット後の自動較正により)
   独立して更新され続けることを確認した。両者が独立していても副作用や矛盾は生じない
   (較正リセット後は単に`calStatus="default"`から自動較正が再開されるだけで、
   アニメーション自体の座標計算には一切影響しない)。
3. 停止経路を「解除」系+`__simPunchStop()`の2つに絞ることで、ユーザー/テストコードにとって
   「アニメを止めたいなら明示的に止める」という単純なメンタルモデルになる。
