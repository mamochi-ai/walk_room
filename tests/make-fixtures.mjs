// テスト専用の合成データを生成する（実データではない。アプリ本体からは参照しない）。
// - Overpass API の応答（格子状の道路・対象建物・施設）
// - PLATEAU 風の 3D Tiles（tileset.json と b3dm。ECEF 座標・RTC_CENTER・Y-up glTF・_BATCHID）
import { writeFileSync, mkdirSync } from 'node:fs';
import { LocalFrame } from '../js/geo.js';
// サンプル物件（ラティエラ武蔵小杉）の位置。合成データはこの位置を基準に作る
const ORIGIN = { lat: 35.57927, lon: 139.6556 };
const TARGET_OSM_WAY = 1350297048;

const OUT = new URL('./fixtures/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const frame = new LocalFrame(ORIGIN.lat, ORIGIN.lon);

// ---- Overpass ----
let nid = 1000;
const nodes = [];
const ways = [];
const node = (x, z, tags) => {
  const { lat, lon } = frame.toLatLon(x, z);
  const n = { type: 'node', id: nid++, lat, lon };
  if (tags) n.tags = tags;
  nodes.push(n);
  return n.id;
};
let wid = 5000;
const way = (ids, tags, id) => ways.push({ type: 'way', id: id ?? wid++, nodes: ids, tags });

// 格子状の道路（x, z = ±40, ±120, …）
const lines = [];
for (let v = -760; v <= 760; v += 80) lines.push(v);
const grid = new Map();
for (const x of lines) for (const z of lines) grid.set(`${x},${z}`, node(x, z));
for (const x of lines) way(lines.map((z) => grid.get(`${x},${z}`)), { highway: x === 40 ? 'secondary' : 'residential' });
for (const z of lines) way(lines.map((x) => grid.get(`${x},${z}`)), { highway: 'residential' });
// 私道（除外されるべき）
way([node(-30, 40), node(-30, 25)], { highway: 'service', service: 'driveway' });

// 対象建物（60m × 40m、入口ノードなし）
const t = [node(-30, -20), node(30, -20), node(30, 20), node(-30, 20)];
way([...t, t[0]], { building: 'apartments', 'building:levels': '6', name: 'ラティエラ武蔵小杉' }, TARGET_OSM_WAY);

// 施設
node(160, -60, { shop: 'convenience', name: 'テスト用コンビニ', opening_hours: '24/7' });
const s = [node(-150, -100), node(-110, -100), node(-110, -60), node(-150, -60)];
const sEnt = node(-130, -60, { entrance: 'main' });
way([s[0], s[1], s[2], sEnt, s[3], s[0]], { shop: 'supermarket', name: 'テスト用スーパー', building: 'retail' });
node(400, 300, { railway: 'station', public_transport: 'station', name: 'テスト', operator: '東急電鉄' });
node(390, 280, { railway: 'train_station_entrance', name: 'テスト駅 南口' });

writeFileSync(new URL('overpass-main.json', OUT), JSON.stringify({ version: 0.6, generator: 'TEST FIXTURE', elements: [...nodes, ...ways] }));

// ---- 3D Tiles ----
const groundH = 40; // 楕円体高（ジオイド高＋標高の想定）
const buildings = [
  { id: 'TEST_bldg_A', poly: [[55, -25], [105, -25], [105, 25], [55, 25]], h: 20 },
  // L字（反凹頂点 [ -60, 100 ] からの扇形分割で正しく三角形化できる）
  { id: 'TEST_bldg_L', poly: [[-60, 100], [-60, 60], [-100, 60], [-100, 110], [-40, 110], [-40, 100]], h: 12 },
  { id: 'TEST_bldg_OLD_AT_TARGET', poly: [[-20, -15], [20, -15], [20, 15], [-20, 15]], h: 8 },
  { id: 'TEST_bldg_B', poly: [[135, 55], [185, 55], [185, 105], [135, 105]], h: 45 },
];
const enuToEcef = (e, n, u) => [
  frame.o[0] + frame.e[0] * e + frame.n[0] * n + frame.u[0] * u,
  frame.o[1] + frame.e[1] * e + frame.n[1] * n + frame.u[1] * u,
  frame.o[2] + frame.e[2] * e + frame.n[2] * n + frame.u[2] * u,
];
const rtc = enuToEcef(0, 0, groundH);
const pos = [], bid = [], idx = [];
buildings.forEach((b, bi) => {
  const base = pos.length / 3;
  const P = b.poly.map(([x, z]) => ({ e: x, n: -z }));
  const push = (e, n, u) => {
    const [X, Y, Z] = enuToEcef(e, n, u);
    const x = X - rtc[0], y = Y - rtc[1], z = Z - rtc[2];
    pos.push(x, z, -y); // Z-up → glTF の Y-up
    bid.push(bi);
  };
  for (const p of P) push(p.e, p.n, groundH);
  for (const p of P) push(p.e, p.n, groundH + b.h);
  const k = P.length;
  for (let i = 1; i < k - 1; i++) { idx.push(base, base + i + 1, base + i); idx.push(base + k, base + k + i, base + k + i + 1); }
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    idx.push(base + i, base + j, base + k + j, base + i, base + k + j, base + k + i);
  }
});
function glb() {
  const posBuf = Buffer.from(new Float32Array(pos).buffer);
  const bidBuf = Buffer.from(new Float32Array(bid).buffer);
  const idxBuf = Buffer.from(new Uint16Array(idx).buffer);
  const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const bin = Buffer.concat([pad4(posBuf), pad4(bidBuf), pad4(idxBuf)]);
  const mins = [0, 1, 2].map((c) => Math.min(...pos.filter((_, i) => i % 3 === c)));
  const maxs = [0, 1, 2].map((c) => Math.max(...pos.filter((_, i) => i % 3 === c)));
  const o1 = pad4(posBuf).length, o2 = o1 + pad4(bidBuf).length;
  const json = {
    asset: { version: '2.0', generator: 'TEST FIXTURE' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 }, indices: 2, mode: 4 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: o1, byteLength: bidBuf.length, target: 34962 },
      { buffer: 0, byteOffset: o2, byteLength: idxBuf.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mins, max: maxs },
      { bufferView: 1, componentType: 5126, count: bid.length, type: 'SCALAR' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  };
  let jb = Buffer.from(JSON.stringify(json));
  jb = Buffer.concat([jb, Buffer.alloc((4 - (jb.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4); return b; };
  return Buffer.concat([header, ch(jb.length, 'JSON'), jb, ch(bin.length, 'BIN\0'), bin]);
}
function b3dm(glbBuf) {
  const pad8 = (s) => { let b = Buffer.from(s); return Buffer.concat([b, Buffer.alloc((8 - ((28 + b.length) % 8)) % 8, 0x20)]); };
  const ft = pad8(JSON.stringify({ BATCH_LENGTH: buildings.length, RTC_CENTER: rtc }));
  let bt = Buffer.from(JSON.stringify({ gml_id: buildings.map((b) => b.id) }));
  bt = Buffer.concat([bt, Buffer.alloc((8 - ((28 + ft.length + bt.length) % 8)) % 8, 0x20)]);
  const h = Buffer.alloc(28);
  h.write('b3dm', 0); h.writeUInt32LE(1, 4);
  h.writeUInt32LE(28 + ft.length + bt.length + glbBuf.length, 8);
  h.writeUInt32LE(ft.length, 12); h.writeUInt32LE(0, 16); h.writeUInt32LE(bt.length, 20); h.writeUInt32LE(0, 24);
  return Buffer.concat([h, ft, bt, glbBuf]);
}
writeFileSync(new URL('bldg.b3dm', OUT), b3dm(glb()));
const R = Math.PI / 180;
const d = 0.02;
writeFileSync(new URL('tileset.json', OUT), JSON.stringify({
  asset: { version: '1.0', generator: 'TEST FIXTURE' },
  geometricError: 500,
  root: {
    boundingVolume: { region: [(ORIGIN.lon - d) * R, (ORIGIN.lat - d) * R, (ORIGIN.lon + d) * R, (ORIGIN.lat + d) * R, 0, 200] },
    geometricError: 100, refine: 'REPLACE',
    children: [
      { boundingVolume: { region: [(ORIGIN.lon - d) * R, (ORIGIN.lat - d) * R, (ORIGIN.lon + d) * R, (ORIGIN.lat + d) * R, 0, 200] }, geometricError: 0, content: { uri: 'bldg.b3dm' } },
      // 範囲外のタイル（取得されないこと）
      { boundingVolume: { region: [(ORIGIN.lon + 1) * R, (ORIGIN.lat + 1) * R, (ORIGIN.lon + 1.1) * R, (ORIGIN.lat + 1.1) * R, 0, 200] }, geometricError: 0, content: { uri: 'far.b3dm' } },
    ],
  },
}));

// ---- 旧形式（v1）の間取り（架空。旧版の保存データの移行テストに使う） ----
writeFileSync(new URL('test-floorplan.json', OUT), JSON.stringify({
  status: 'draft', note: 'TEST FIXTURE — 架空の間取り。本番データではない',
  ceilingHeight: { value: 2.5, status: 'estimated' },
  outline: [[0, 0], [5, 0], [5, 7], [0, 7]],
  walls: [
    { a: [0, 0], b: [5, 0], thickness: 0.15, openings: [{ type: 'window', at: 2.5, width: 2.0, sill: 0.4, head: 2.1 }] },
    { a: [5, 0], b: [5, 7], thickness: 0.15 },
    { a: [5, 7], b: [0, 7], thickness: 0.15 },
    { a: [0, 7], b: [0, 0], thickness: 0.15 },
    { a: [0, 4], b: [5, 4], thickness: 0.1, openings: [{ type: 'door', at: 1.0, width: 0.8, head: 2.0 }] },
  ],
  rooms: [{ name: '洋室', poly: [[0, 0], [5, 0], [5, 4], [0, 4]], labelAt: [2.5, 2] }],
  fixtures: [{ type: 'kitchen', x: 4.0, y: 5.5, w: 1.8, d: 0.6, h: 0.85, rot: 90, label: 'キッチン' }],
  furniture: [{ type: 'bed', x: 1.0, y: 1.6, w: 1.0, d: 2.0, h: 0.45 }],
  entrance: [0.6, 6.5],
  spawn: { at: [2.5, 2.5], yawDeg: 0 },
}));
console.log('fixtures written', { nodes: nodes.length, ways: ways.length, b3dmBuildings: buildings.length });

// ---- v2 形式の解析結果（架空。Claude の回答を模したテスト用データ） ----
const v2 = {
  format: 'walk-room-floorplan/2',
  images: [{ index: 1, role: 'floorplan', content: 'TEST 間取り図' }, { index: 2, role: 'overview', content: 'TEST 物件概要' }],
  consistency: { sameProperty: true, notes: null },
  property: {
    name: { value: 'テスト用マンション', source: 'image', evidence: '画像2 上部' },
    unit: { value: '101', source: 'image', evidence: '画像1 右上' },
    address: { value: null, source: null, evidence: '住所の記載なし' },
    floor: { value: 3, source: 'image', evidence: '画像2' },
    areaM2: { value: 45.0, source: 'image', evidence: '画像1 右下' },
    layout: { value: '1LDK', source: 'image', evidence: '画像1' },
    orientation: { value: '南', source: 'image', evidence: '画像1 方位記号' },
    buildingFloors: { value: 6, source: 'image', evidence: '画像2' },
    stations: { value: [{ name: 'テスト駅', line: 'テスト線', walkMin: 7 }], source: 'image', evidence: '画像2 交通' },
  },
  drawing: { units: 'm', scale: { method: 'area', source: 'estimated', evidence: 'TEST' }, north: { imageUpBearingDeg: null, source: null, evidence: null }, imageBox: { imageIndex: 1, box: [0.1, 0.1, 0.9, 0.9] } },
  outline: [[0, 0], [6.4, 0], [6.4, 6.6], [0, 6.6]],
  rooms: [
    { id: 'ld', name: 'LD', type: 'living', area: { value: '12帖', source: 'image' }, poly: [[0, 0], [6.4, 0], [6.4, 3.6], [0, 3.6]] },
    { id: 'hall', name: '廊下', type: 'hall', poly: [[0, 3.6], [1.6, 3.6], [1.6, 6.6], [0, 6.6]] },
    { id: 'wash', name: '洗面・浴室', type: 'washroom', poly: [[1.6, 3.6], [3.6, 3.6], [3.6, 6.6], [1.6, 6.6]] },
    { id: 'br', name: '洋室', type: 'bedroom', area: { value: '6帖', source: 'image' }, poly: [[3.6, 3.6], [6.4, 3.6], [6.4, 6.6], [3.6, 6.6]] },
  ],
  walls: [
    { id: 'w1', a: [0, 0], b: [6.4, 0], exterior: true, thickness: { value: 0.18, source: 'estimated' }, openings: [{ type: 'window_door', at: 3.2, width: 1.8 }] },
    { id: 'w2', a: [6.4, 0], b: [6.4, 6.6], exterior: true, thickness: 0.18, openings: [{ type: 'window', at: 1.8, width: 1.2 }] },
    { id: 'w3', a: [6.4, 6.6], b: [0, 6.6], exterior: true, thickness: 0.18, openings: [{ type: 'door', at: 5.6, width: 0.8 }] },
    { id: 'w4', a: [0, 6.6], b: [0, 0], exterior: true, thickness: 0.18, openings: [{ type: 'window', at: 4.9, width: 1.0 }] },
    { id: 'w5', a: [0, 3.6], b: [6.4, 3.6], thickness: 0.1, openings: [{ type: 'door', at: 1.0, width: 0.8 }, { type: 'door', at: 5.0, width: 0.8 }] },
    { id: 'w6', a: [1.6, 3.6], b: [1.6, 6.6], thickness: 0.1, openings: [{ type: 'sliding', at: 1.5, width: 0.7 }] },
    { id: 'w7', a: [3.6, 3.6], b: [3.6, 6.6], thickness: 0.1, openings: [] },
  ],
  fixtures: [
    { type: 'kitchen', label: 'キッチン', poly: [[4.6, 2.9], [6.3, 2.9], [6.3, 3.5], [4.6, 3.5]] },
    { type: 'ps', label: 'PS', poly: [[1.65, 6.2], [2.0, 6.2], [2.0, 6.55], [1.65, 6.55]] },
  ],
  balconies: [{ poly: [[0, -1.2], [6.4, -1.2], [6.4, 0], [0, 0]] }],
  furniture: [],
  connections: [['hall', 'ld'], ['ld', 'br'], ['hall', 'wash']],
  entrance: { at: [0.8, 6.1], source: 'image' },
  spawn: { at: [3.2, 1.8], lookAt: [3.2, 0] },
  heights: { ceiling: { value: 2.4, source: 'estimated' } },
  dimensions: [{ label: '全体幅', value: 6.4, source: 'estimated', evidence: 'TEST' }],
  checks: { roomsInsideOutline: true, noOverlap: true, openingsOnWalls: true, reachableFromEntrance: true, areaConsistent: true },
  uncertain: [],
  toConfirm: [],
};
writeFileSync(new URL('analysis-v2.json', OUT), JSON.stringify(v2, null, 2));

// ---- テスト用 PNG（無地に枠線） ----
import { deflateSync } from 'node:zlib';
function png(w, h, draw) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = draw(x, y) ? 30 : 250; }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 0; ih[10] = 0; ih[11] = 0; ih[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(new URL('floorplan.png', OUT), png(400, 400, (x, y) => (x > 40 && x < 360 && (Math.abs(y - 40) < 3 || Math.abs(y - 360) < 3)) || (y > 40 && y < 360 && (Math.abs(x - 40) < 3 || Math.abs(x - 360) < 3)) || (Math.abs(y - 198) < 2 && x > 40 && x < 360)));
writeFileSync(new URL('overview.png', OUT), png(300, 200, (x, y) => y % 20 < 2 && x > 20 && x < 280));

// ---- 住所検索（国土地理院形式）の応答：候補2件。2件目が物件位置 ----
const far = frame.toLatLon(300, -200);
writeFileSync(new URL('gsi-geocode.json', OUT), JSON.stringify([
  { geometry: { coordinates: [far.lon, far.lat], type: 'Point' }, type: 'Feature', properties: { title: 'TEST 候補A（別の場所）' } },
  { geometry: { coordinates: [ORIGIN.lon, ORIGIN.lat], type: 'Point' }, type: 'Feature', properties: { title: 'TEST 候補B' } },
]));

// ---- PLATEAU 整備範囲外を再現するタイルセット（範囲外の子だけ） ----
writeFileSync(new URL('tileset-far.json', OUT), JSON.stringify({
  asset: { version: '1.0' }, geometricError: 500,
  root: { boundingVolume: { region: [(ORIGIN.lon + 1) * R, (ORIGIN.lat + 1) * R, (ORIGIN.lon + 1.1) * R, (ORIGIN.lat + 1.1) * R, 0, 200] }, geometricError: 0, children: [
    { boundingVolume: { region: [(ORIGIN.lon + 1) * R, (ORIGIN.lat + 1) * R, (ORIGIN.lon + 1.1) * R, (ORIGIN.lat + 1.1) * R, 0, 200] }, geometricError: 0, content: { uri: 'far.b3dm' } }] },
}));
// OSM 建物（PLATEAU 範囲外のときの代替）
writeFileSync(new URL('overpass-buildings.json', OUT), JSON.stringify({ elements: [
  ...[[60, -20], [100, -20], [100, 20], [60, 20]].map(([x, z], i) => { const { lat, lon } = frame.toLatLon(x, z); return { type: 'node', id: 90000 + i, lat, lon }; }),
  { type: 'way', id: 99000, nodes: [90000, 90001, 90002, 90003, 90000], tags: { building: 'yes', 'building:levels': '4' } },
] }));
console.log('v2 fixtures written');
