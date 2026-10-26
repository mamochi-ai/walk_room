// 共通設定。物件ごとの情報は端末内の「物件」データ（js/project.js）で管理する。
// 調査の詳細は docs/RESEARCH.md を参照。

// 範囲：徒歩範囲（この外へは出られない）、建物・道路の取得範囲、駅だけ広めに取得する範囲
export const WALK_RADIUS = 500;
export const DATA_RADIUS = 600;
export const STATION_RADIUS = 1500;

// 対象建物の高さが実データで得られないときの概算
export const TARGET_ESTIMATE = {
  storyHeight: 3.0, // 推定（未確認）
  groundFloorRaise: 0.3, // 1階床の地面からの高さ（推定）
  parapet: 1.0, // 推定
};

export const EYE_HEIGHT_DEFAULT = 1.6;
export const WALK_SPEED_DEFAULT = 1.3; // 室内 m/s（80m/分 ≒ 1.33m/s）
export const OUTDOOR_SPEED_DEFAULT = 4.0; // 屋外 m/s（実際の徒歩の約3倍。設定で変更可）
export const PLAYER_RADIUS = 0.25;
export const WALK_M_PER_MIN = 80; // 不動産の表示に関する公正競争規約の徒歩所要時間の基準

// ---- データソース（公式資料で確認したエンドポイント） ----
export const SOURCES = {
  overpass: {
    // https://wiki.openstreetmap.org/wiki/Overpass_API （メインインスタンス）
    endpoints: ['https://overpass-api.de/api/interpreter'],
    attribution: '© OpenStreetMap contributors（ODbL）',
    url: 'https://www.openstreetmap.org/copyright',
  },
  plateau: {
    // https://docs.plateauview.mlit.go.jp/datasets/3d-tiles/ 「4.2 複合 tileset.json」
    // 全国（all）の複合タイルセット。各自治体の最新整備年度を採用。範囲内の自治体・タイルだけを取得する。
    tilesetCandidates: [
      'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-lod1-latest/tileset.json',
      'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/all-bldg-maxlod1-latest/tileset.json',
    ],
    attribution: '3D都市モデル（Project PLATEAU）国土交通省 を加工して作成',
    url: 'https://www.mlit.go.jp/plateau/open-data/',
  },
  gsiTiles: {
    // 地理院タイル（淡色地図）。出典明示でリアルタイム読み込みは申請不要。
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
    maxZoom: 18,
  },
};

// 住所検索。どちらも利用者が明示的に選んだときだけ使う（既定は未選択）。
// エンドポイントを変える必要が出たら、ここを書き換える。
export const GEOCODERS = {
  nominatim: {
    label: 'OpenStreetMap Nominatim',
    url: 'https://nominatim.openstreetmap.org/search',
    policy: 'https://operations.osmfoundation.org/policies/nominatim/',
    terms: '利用者の操作による検索のみ・最大1秒に1回・自動補完は禁止・出典表示が必要。利用者が規約を確認して選ぶことが条件です。日本の住所は町丁目までしか当たらないことがあります。',
    attribution: '© OpenStreetMap contributors（Nominatim）',
  },
  gsi: {
    label: '国土地理院 地理院地図の住所検索',
    url: 'https://msearch.gsi.go.jp/address-search/AddressSearch',
    policy: 'https://maps.gsi.go.jp/help/termsofuse.html',
    terms: '地理院地図で使われている住所検索です。この検索機能自体の利用規約は公開されておらず、提供元・提供条件が明確ではありません。継続利用する場合は提供元に確認してください。',
    attribution: '住所検索：国土地理院（地理院地図）',
  },
};

export const CACHE_DAYS = 30;
