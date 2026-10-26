// テスト専用の合成データを生成する（実データではない。アプリ本体からは参照しない）。
// - Overpass API の応答（格子状の道路・対象建物・施設）
// - PLATEAU 風の 3D Tiles（tileset.json と b3dm。ECEF 座標・RTC_CENTER・Y-up glTF・_BATCHID）
import { writeFileSync, mkdirSync } from 'node:fs';
import { LocalFrame } from '../js/geo.js';
import { ORIGIN, TARGET_OSM_WAY } from '../js/config.js';

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

// ---- 室内エンジン検証用の間取り（架空。テストでのみ data/unit-312.json の代わりに配信） ----
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
