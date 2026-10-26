// 物件・データソースの設定。
// status: 'confirmed'（確認済）/ 'estimated'（推定）/ 'missing'（未取得）
// 調査の詳細は docs/RESEARCH.md を参照。

export const PROPERTY = {
  id: 'latierra-musashikosugi-312', // 端末内に保存する間取りのキー
  name: 'ラティエラ武蔵小杉',
  unit: '312号室',
  address: '神奈川県川崎市中原区小杉町2丁目220',
  // 間取りの取り込み時に Claude へ渡す確認済み情報（物件を変えるときはここを変える）
  unitInfo: { floor: 3, layout: '1LDK+SIC', areaM2: 35.95 },
  facts: [
    { label: '所在地', value: '川崎市中原区小杉町2-220', status: 'confirmed', src: '三井の賃貸 掲載ページ／OSM' },
    { label: '規模・構造', value: '鉄筋コンクリート造 地上6階建', status: 'confirmed', src: '三井の賃貸 掲載ページ／東京ガス不動産 2023-01-19 発表' },
    { label: '竣工', value: '2022年11月30日', status: 'confirmed', src: '三井の賃貸 掲載ページ' },
    { label: '312号室', value: '3階・1LDK+SIC・35.95㎡', status: 'confirmed', src: '三井の賃貸 掲載ページ（検索結果の抜粋で確認）' },
    { label: '住戸の向き', value: '西の可能性（1階の同面積1LDK住戸が「西」と掲載）', status: 'estimated', src: '賃貸ポータル掲載（312号室自体の方位は未確認）' },
    { label: '間取り図', value: '未取得（添付なし・取得不可）', status: 'missing', src: '' },
    { label: '天井高・階高・窓寸法', value: '未取得', status: 'missing', src: '' },
    { label: '住戸の建物内位置', value: '未取得（仮配置）', status: 'missing', src: '' },
  ],
};

// 原点：OSM の建物 way 1350297048（ラティエラ武蔵小杉）の代表点。
// 実行時に OSM から外形を取得できた場合は、その重心で置き換える。
export const ORIGIN = { lat: 35.57927, lon: 139.6556 };
export const TARGET_OSM_WAY = 1350297048;

// 範囲：徒歩範囲（この外へは出られない）と、データ取得範囲
// 武蔵小杉駅・新丸子駅を含めるため 500m を 700m に拡張。
export const WALK_RADIUS = 700;
export const DATA_RADIUS = 800;

// 対象建物の概算（PLATEAU に竣工後の形状が無い場合に使う）
export const TARGET_ESTIMATE = {
  floors: 6,
  storyHeight: 3.0, // 推定（未確認）
  groundFloorRaise: 0.3, // 1階床の地面からの高さ（推定）
  parapet: 1.0, // 推定
};

// 住戸の仮配置（間取り図・位置が確認できるまで調整可能）
export const UNIT_PLACEMENT_DEFAULT = {
  floor: 3,
  facade: 'W', // 推定
  along: 0.5,
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
    // {area}-{type}-{lod}-{year}。川崎市は 2020・2022年度が公開。区コード/市コード/県コードの順に試す。
    tilesetCandidates: [
      'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/14133-bldg-lod1-2022/tileset.json',
      'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/14130-bldg-lod1-2022/tileset.json',
      'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/14-bldg-lod1-2022/tileset.json',
    ],
    year: 2022,
    attribution: '3D都市モデル（Project PLATEAU）川崎市（2022年度）国土交通省 を加工して作成',
    url: 'https://www.geospatial.jp/ckan/dataset/plateau-14130-kawasaki-shi-2022',
  },
};

export const CACHE_KEY = 'area-v1';
export const CACHE_DAYS = 30;
