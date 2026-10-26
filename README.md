# walk_room — ラティエラ武蔵小杉 312号室から街へ

実在する賃貸物件（川崎市中原区小杉町2-220、312号室）から、実在する周辺の街を歩いて、
建物の距離感・高さや、コンビニ・スーパー・駅までの道を確かめる Web アプリの試作です。

- 静的ファイルだけで動きます（専用バックエンドなし・ビルド不要）。iPad Safari 優先。
- 有料API・AI API は使いません。three.js は `vendor/` に同梱しています。
- 建物：PLATEAU（川崎市 2022年度 LOD1）。道路・店舗・駅・対象建物の外形：OpenStreetMap。
- 調査結果（確認済／推定／未取得）は [docs/RESEARCH.md](docs/RESEARCH.md)。

## 開き方
静的ホスティングに置いて `index.html` を開きます。iPad／iPhone だけで公開する方法の例：

1. **GitHub Pages**：リポジトリの Settings → Pages → Build and deployment を「Deploy from a branch」にし、
   ブランチ（例 `main`）とフォルダ `/ (root)` を選んで保存。数分後に表示される URL を Safari で開く。
   （無料プランではリポジトリを公開にする必要があります）
2. **Cloudflare Pages / Netlify（無料枠）**：Web 画面で GitHub リポジトリを接続し、ビルドコマンドなし・公開ディレクトリ `/` を指定。

パソコンがある場合は `python3 -m http.server` で起動して `http://localhost:8000/` を開けます
（`file://` では ES モジュールが読み込めないため HTTP サーバーが必要です）。

### データの取得
`data/manifest.json` の `bundled` が `false` の間は、初回表示時に**ブラウザから**公式 API へ対象範囲（半径約800m）だけを取得し、
端末内（IndexedDB）に30日保存します。2回目以降は通信しません。「出典」→「データを再取得」で更新できます。

通信できる PC で次を実行すると、取得結果を `data/area.json` として同梱でき、以後は外部 API を使いません。
```
npm i -D playwright && npx playwright install chromium
node tools/export-area.mjs
```

## 操作
- iPad／iPhone：左側を押して動かす＝移動スティック、右側をドラッグ＝見回し（同時操作可）。名札タップで施設詳細。
- 屋外は「俯瞰で見る」で上空から見下ろせます。移動速度は屋外 4m/秒・室内 1.3m/秒が初期値（設定で変更可）。
- PC：WASD／矢印で移動、Q・E で回転、ドラッグで見回し。
- ミニマップはタップで拡大。上部の「施設」「出典」「設定」「?」から各画面へ。

## 間取りの取り込み（Claude を利用・API 不要）
1. 「窓から見る」画面の「間取りを取り込む」（または 設定 → 間取り）を開く。
2. 「指示文をコピーして Claude を開く」を押し、Claude で指示文を貼り付けて間取り図の画像を添付・送信。
3. Claude の回答（JSON）をコピーしてアプリに貼り付け →「内容を確認」。
4. 形式・寸法の検査結果と平面図プレビューを元の図と見比べ、「この内容で室内を作る」。

取り込んだ間取りはその端末だけに保存されます（`localStorage`）。他の端末でも使うには「JSONをコピー」した内容を
`data/unit-312.json` に保存してください。指示文は `js/config.js` の `PROPERTY`（物件名・階・間取り・面積）から作るので、
物件を変えてもそのまま使えます。将来、不動産ページの画像から作る場合も同じ形式（`walk-room-floorplan/1`）を使います。

## 主なファイル
| ファイル | 内容 |
|---|---|
| `index.html`, `css/app.css` | 画面構成とスタイル |
| `js/app.js` | モード切替（窓からの眺め／室内／屋外）、描画ループ、各パネル |
| `js/config.js` | 物件情報（確認状況つき）、原点、範囲、推定値、データソース URL |
| `js/data/osm.js` | Overpass の問い合わせと解析、歩行可能な道路の判定 |
| `js/data/plateau.js` | PLATEAU 3D Tiles の範囲選択、b3dm 解析、外形と高さの抽出 |
| `js/data/loader.js` | 同梱データ／キャッシュ／取得の制御、対象敷地の重なり除外 |
| `js/nav.js` | 衝突判定（道路・建物・範囲・室内の壁）と道路経路（ダイクストラ） |
| `js/world/city.js` | 屋外の3D（地面・道路・建物・対象建物・施設マーカー・経路） |
| `js/world/interior.js` | 間取りデータからの室内生成と住戸の仮配置 |
| `js/plan/import.js` | 間取り取り込み：Claude への指示文、JSON の取り出し・検査・平面図プレビュー・端末内保存 |
| `js/ui/controls.js`, `js/ui/minimap.js` | タッチ／キー操作、ミニマップ |
| `data/unit-312.json` | 312号室の間取り（現在は未取得のため `pending`） |
| `data/poi-supplements.json` | OSM 未登録店舗の補足（店舗公式情報で確認したもの） |
| `tools/export-area.mjs` | 公開データを取得して `data/area.json` に書き出す |
| `tests/` | 合成データ生成と Playwright による動作確認 |

## 座標
対象物件付近（35.57927, 139.65560）を原点とする局所座標（x=東, y=上, z=南、単位 m）。
緯度経度・PLATEAU の地心直交座標（ECEF）はすべてこの座標へ変換してから描画するので、大きな座標値による揺れが起きません。
ミニマップも同じ座標を北上で描きます。

## テスト
```
python3 -m http.server 8765 &
node tests/make-fixtures.mjs   # テスト専用の合成データ（実データではない）
node tests/e2e.mjs
```
屋内外の往復、壁・建物・道路外・範囲端の衝突、同時タッチ操作、指を離す／フォーカス喪失での停止、
施設の絞り込みと目的地、ミニマップと3Dの方位一致、取得失敗→再試行、キャッシュ、同梱データ、WebGL 非対応時の表示、
iPhone 縦横・iPad 横での UI の重なりを確認します。

## 出典
- 3D都市モデル（Project PLATEAU）川崎市（2022年度）国土交通省 を加工して作成
- © OpenStreetMap contributors（ODbL）
