# walk_room — 間取りウォーク

物件の間取り画像を起点に、室内と周辺の街（道路・建物・コンビニ・スーパー・駅）を3Dで歩いて確かめる Web アプリです。

- 静的ファイルだけで動きます（専用バックエンドなし・ビルド不要）。iPad／iPhone の Safari だけで全工程を操作できます。
- 有料API・AI API は使いません。画像の解析は、利用者が Claude に画像と依頼文を渡し、返ってきた JSON を貼り付ける方式です。
- three.js・Leaflet は `vendor/` に同梱しています。
- 調査結果・利用条件は [docs/RESEARCH.md](docs/RESEARCH.md)。

## 使い方（iPad／iPhone）
1. **画像を登録**：「新しい物件を登録」→「画像を追加」で間取り図を選ぶ。住所などが載っていなければ、物件概要・募集ページのスクリーンショットも追加する。
2. **Claude に依頼**：「依頼文をコピー」→「Claude を開く」→ 新しい会話に貼り付け、画像を表示された順番で添付して送信。
   Claude を開いても依頼文や画像は自動では送られません。
3. **貼り付け**：Claude の回答（JSON のコードブロック）をコピーし、アプリに戻って貼り付け →「読み込む」。
   JSON が壊れていても入力は消えず、何行目のどこが問題かを表示します。内容に問題があれば、問題点を添えた再依頼文をコピーできます。
4. **確認**：2D 図／元画像／並べる／重ねる（透明度・縮尺・回転・ドラッグで位置合わせ）で見比べる。
   物件名・住所・階数・面積・方位などは「画像記載」「推定」「入力・修正」「未入力」に分けて表示し、その場で修正できます。
   誤りは短く書いて「再依頼文をコピー」すると、前回の解析結果と一緒に Claude に直してもらえます（最初から解析し直さない）。
5. **位置**：住所から候補を探す（住所検索サービスは利用条件を確認して選ぶ）か、地図をタップしてピンを置く。
   候補が複数あっても自動では選びません。物件の位置と建物入口は別のピンで、どちらもドラッグで直せます。
6. **歩いてみる**：確定した位置を中心に半径約500m（取得は600m、駅は1.5km）の道路・建物・施設を表示し、室内から歩き出せます。

周辺データの取得に失敗しても、室内だけで歩けます。住所を変えると位置の再確認が必要になり、確定し直した位置で周辺データを取り直します。
画像・解析結果・物件情報はその端末のブラウザ内（IndexedDB）にだけ保存されます。

## 公開方法
静的ホスティングに置いて `index.html` を開きます（`file://` では動きません）。
- **GitHub Pages**：Settings → Pages →「Deploy from a branch」でブランチとフォルダ `/ (root)` を選ぶ（無料プランでは公開リポジトリが必要）。
- **Cloudflare Pages / Netlify（無料枠）**：GitHub リポジトリを接続し、ビルドコマンドなし・公開ディレクトリ `/`。

## 解析データの形式（`walk-room-floorplan/2`）
Claude への依頼文（`js/plan/format.js` の `buildAnalysisPrompt`）に出力例があります。主な項目：

| 項目 | 内容 |
|---|---|
| `property.*` | 物件名・部屋番号・住所・所在階・専有面積・間取り・方位・建物の階数・最寄り駅。各項目 `{value, source: "image"\|"estimated"\|null, evidence}` |
| `consistency` | 複数画像が同じ物件・住戸か（違う可能性があれば理由） |
| `drawing` | 座標系（u=画像右, v=画像下, m）、縮尺の根拠、方位記号（`north.imageUpBearingDeg`）、外周が画像のどこか（`imageBox`） |
| `outline` | 外周の多角形（バルコニーを含めない） |
| `rooms` | 部屋の名前・種類・多角形・帖数 |
| `walls` | 壁の中心線と厚さ、壁に紐づく開口（door／sliding／opening／window／window_door） |
| `fixtures` / `balconies` | 固定設備・収納・PS・柱（多角形）、バルコニー |
| `entrance` / `spawn` | 玄関、最初に立つ位置と向き |
| `heights` / `dimensions` | 天井高などの仮値、主な寸法（記載値か推定か） |
| `checks` / `uncertain` / `toConfirm` | Claude の自己検証、読めなかった点、要確認事項 |

旧形式（v1）の解析データや旧版の保存データ（サンプル物件として引き継ぎ）も読み込めます。

## 主なファイル
| ファイル | 内容 |
|---|---|
| `index.html`, `css/app.css` | 画面構成とスタイル |
| `js/app.js` | 歩行画面：モード切替（窓から見る／室内／屋外）、描画ループ、パネル |
| `js/ui/wizard.js` | 物件一覧と登録手順（画像・依頼・貼り付け・確認・位置） |
| `js/plan/format.js` | 依頼文・再依頼文、JSON の取り出しと誤り位置、検証、正規化、2D 図 |
| `js/project.js`, `js/store.js` | 物件データ・画像の端末内保存、住戸の向きの判定、旧データの移行 |
| `js/geocode.js`, `js/ui/mappicker.js` | 住所検索（選択式）と位置確認の地図（地理院タイル） |
| `js/config.js` | 範囲、推定値、データソース・住所検索の URL と利用条件 |
| `js/data/osm.js`, `js/data/plateau.js`, `js/data/loader.js` | OSM・PLATEAU の取得と解析、対象建物の決定、キャッシュ |
| `js/nav.js` | 衝突判定と道路経路 |
| `js/world/city.js`, `js/world/interior.js` | 屋外の3D、室内の生成と住戸の仮配置 |
| `data/poi-supplements.json` | OSM 未登録店舗の補足（店舗公式情報で確認したもの） |
| `tools/export-area.mjs` | 周辺データを `data/area.json` として同梱するためのスクリプト |
| `tests/` | 合成データ生成と Playwright による動作確認 |

## テスト
```
python3 -m http.server 8765 &
node tests/make-fixtures.mjs   # テスト専用の合成データ（実データではない）
node tests/e2e.mjs
```

## 出典
- 3D都市モデル（Project PLATEAU）国土交通省 を加工して作成
- © OpenStreetMap contributors（ODbL）
- 地理院タイル（国土地理院）
