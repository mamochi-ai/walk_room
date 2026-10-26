// PLATEAU 3D Tiles（建築物 LOD1）を、対象範囲のタイルだけ取得して
// 「外形リング＋高さ」の軽量な形式に変換する。
// 公式資料: https://docs.plateauview.mlit.go.jp/datasets/3d-tiles/
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { chainEdges, ringArea, ringCentroid, pointInRing, ecefToGeodetic } from '../geo.js';

const DEG = Math.PI / 180;

let loader = null;
function getLoader() {
  if (loader) return loader;
  loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(new URL('../../vendor/three/examples/jsm/libs/draco/gltf/', import.meta.url).href);
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

async function fetchOk(url, type, signal) {
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return type === 'json' ? res.json() : res.arrayBuffer();
}

// 最初に取得できた tileset.json を使う
export async function findTileset(candidates, signal) {
  const errors = [];
  for (const url of candidates) {
    try {
      const json = await fetchOk(url, 'json', signal);
      if (json && json.root) return { url, json };
      errors.push(`${url}: root がありません`);
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${url}: ${e.message}`);
    }
  }
  const err = new Error('PLATEAU の tileset.json を取得できませんでした');
  err.details = errors;
  throw err;
}

// ---- バウンディングボリューム判定 ----
function volumeIntersects(bv, transform, area) {
  if (!bv) return true;
  if (bv.region) {
    const [w, s, e, n] = bv.region;
    return !(e < area.w * DEG || w > area.e * DEG || n < area.s * DEG || s > area.n * DEG);
  }
  let c, r;
  if (bv.box) {
    const b = bv.box;
    c = new THREE.Vector3(b[0], b[1], b[2]).applyMatrix4(transform);
    const ax = [3, 6, 9].map((i) => new THREE.Vector3(b[i], b[i + 1], b[i + 2]).transformDirection(transform).multiplyScalar(Math.hypot(b[i], b[i + 1], b[i + 2])));
    r = ax.reduce((s, v) => s + v.length(), 0);
  } else if (bv.sphere) {
    const b = bv.sphere;
    c = new THREE.Vector3(b[0], b[1], b[2]).applyMatrix4(transform);
    r = b[3];
  } else return true;
  const [lat, lon] = ecefToGeodetic(c.x, c.y, c.z);
  const dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * DEG));
  return !(lon + dLon < area.w || lon - dLon > area.e || lat + dLat < area.s || lat - dLat > area.n);
}

// 対象範囲にかかるコンテンツ（b3dm/glb/cmpt）の URL と座標変換を列挙
export async function collectContents(tilesetUrl, tilesetJson, area, { signal, onProgress, depth = 0 } = {}) {
  const out = [];
  const upAxis = tilesetJson.asset?.gltfUpAxis || 'Y';
  async function walk(tile, parentM, parentRefine, baseUrl) {
    const m = parentM.clone();
    if (tile.transform) m.multiply(new THREE.Matrix4().fromArray(tile.transform));
    if (!volumeIntersects(tile.boundingVolume, m, area)) return;
    const refine = (tile.refine || parentRefine || 'REPLACE').toUpperCase();
    const kids = tile.children || [];
    const contents = tile.contents || (tile.content ? [tile.content] : []);
    for (const c of contents) {
      const uri = c.uri || c.url;
      if (!uri) continue;
      if (c.boundingVolume && !volumeIntersects(c.boundingVolume, m, area)) continue;
      const abs = new URL(uri, baseUrl).href;
      if (/\.json(\?|$)/i.test(uri)) {
        if (depth > 6) continue;
        const sub = await fetchOk(abs, 'json', signal);
        onProgress?.(`外部タイルセットを確認中…`);
        const subOut = await collectContents(abs, sub, area, { signal, onProgress, depth: depth + 1, parentMatrix: m });
        // 外部タイルセットはルートの transform を親に連結する
        for (const s of subOut) s.matrix.premultiply(m);
        out.push(...subOut);
      } else if (refine === 'ADD' || kids.length === 0) {
        out.push({ url: abs, matrix: m.clone(), upAxis });
      }
    }
    for (const k of kids) await walk(k, m, refine, baseUrl);
  }
  await walk(tilesetJson.root, new THREE.Matrix4(), null, tilesetUrl);
  return out;
}

// ---- b3dm / glb / cmpt の解析 ----
function readJson(buf, off, len) {
  if (!len) return {};
  const txt = new TextDecoder().decode(new Uint8Array(buf, off, len)).replace(/\0+$/, '').trim();
  return txt ? JSON.parse(txt) : {};
}

export function parseB3dm(buf) {
  const dv = new DataView(buf);
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'b3dm') throw new Error('b3dm ではありません');
  let ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true), btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
  let hdr = 28;
  if (btJ >= 570425344) { // 旧形式ヘッダ
    hdr = 20; btJ = ftJ; btB = ftB; ftJ = 0; ftB = 0;
  }
  const ft = readJson(buf, hdr, ftJ);
  const ftBinOff = hdr + ftJ;
  let rtc = null;
  if (Array.isArray(ft.RTC_CENTER)) rtc = ft.RTC_CENTER;
  else if (ft.RTC_CENTER && ft.RTC_CENTER.byteOffset !== undefined) {
    const o = ftBinOff + ft.RTC_CENTER.byteOffset;
    rtc = [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)];
  }
  const bt = readJson(buf, hdr + ftJ + ftB, btJ);
  const glbOff = hdr + ftJ + ftB + btJ + btB;
  return { glb: buf.slice(glbOff), rtc, batchTable: bt, batchLength: ft.BATCH_LENGTH || 0 };
}

function glbExtensionsRtc(glb) {
  try {
    const dv = new DataView(glb);
    const len = dv.getUint32(12, true);
    const json = readJson(glb, 20, len);
    return json.extensions?.CESIUM_RTC?.center || null;
  } catch { return null; }
}

function parseGltf(glb) {
  return new Promise((resolve, reject) => getLoader().parse(glb, '', resolve, reject));
}

// 1コンテンツ分を解析し、建物ごとの三角形（ローカル ENU）を返す
export async function contentToBuildings(buf, matrix, upAxis, frame, area) {
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic === 'cmpt') {
    const dv = new DataView(buf);
    const n = dv.getUint32(12, true);
    let off = 16;
    const res = [];
    for (let i = 0; i < n; i++) {
      const len = dv.getUint32(off + 8, true);
      res.push(...(await contentToBuildings(buf.slice(off, off + len), matrix, upAxis, frame, area)));
      off += len;
    }
    return res;
  }
  let glb, rtc = null, bt = {};
  if (magic === 'b3dm') {
    const p = parseB3dm(buf);
    glb = p.glb; rtc = p.rtc; bt = p.batchTable;
  } else if (magic === 'glTF') {
    glb = buf; upAxis = 'Y';
  } else {
    return []; // i3dm / pnts は対象外
  }
  rtc = rtc || glbExtensionsRtc(glb);
  const gltf = await parseGltf(glb);
  gltf.scene.updateMatrixWorld(true);

  const groups = new Map(); // batchId -> {tris: number[] (e,n,u ×3 per tri)}
  const v = new THREE.Vector3();
  const yUp = upAxis.toUpperCase() === 'Y';
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const g = obj.geometry;
    const pos = g.attributes.position;
    const bid = g.attributes._batchid || g.attributes._feature_id_0 || g.attributes._feature_id || null;
    const idx = g.index;
    const count = idx ? idx.count : pos.count;
    const enu = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      let x = v.x, y = v.y, z = v.z;
      if (yUp) { const t = y; y = -z; z = t; }
      if (rtc) { x += rtc[0]; y += rtc[1]; z += rtc[2]; }
      v.set(x, y, z).applyMatrix4(matrix);
      const r = frame.ecefToEnu(v.x, v.y, v.z);
      enu[i * 3] = r[0]; enu[i * 3 + 1] = r[1]; enu[i * 3 + 2] = r[2];
    }
    let comp = null;
    if (!bid) comp = connectedComponents(enu, idx, count);
    for (let t = 0; t < count; t += 3) {
      const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
      const key = bid ? `${obj.uuid}:${Math.round(bid.getX(a))}` : `${obj.uuid}:c${comp[a]}`;
      const batch = bid ? Math.round(bid.getX(a)) : -1;
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { batch, tris: [] }));
      gr.tris.push(enu[a * 3], enu[a * 3 + 1], enu[a * 3 + 2], enu[b * 3], enu[b * 3 + 1], enu[b * 3 + 2], enu[c * 3], enu[c * 3 + 1], enu[c * 3 + 2]);
    }
  });

  const ids = bt.gml_id || bt['gml:id'] || bt.id || null;
  const mh = bt['bldg:measuredHeight'] || bt['計測高さ'] || bt.measuredHeight || null;
  const out = [];
  for (const gr of groups.values()) {
    const b = trisToBuilding(gr.tris);
    if (!b) continue;
    const [cx, cz] = ringCentroid(b.rings[0]);
    if (cx < area.minX || cx > area.maxX || cz < area.minZ || cz > area.maxZ) continue;
    b.id = ids && gr.batch >= 0 && Array.isArray(ids) ? String(ids[gr.batch]) : null;
    const m = mh && gr.batch >= 0 && Array.isArray(mh) ? parseFloat(mh[gr.batch]) : NaN;
    if (isFinite(m) && m > 0) b.hMeasured = m;
    b.src = 'plateau';
    out.push(b);
  }
  return out;
}

function connectedComponents(enu, idx, count) {
  const n = enu.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const byPos = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(enu[i * 3] * 100)},${Math.round(enu[i * 3 + 1] * 100)},${Math.round(enu[i * 3 + 2] * 100)}`;
    if (byPos.has(k)) union(i, byPos.get(k)); else byPos.set(k, i);
  }
  for (let t = 0; t < count; t += 3) {
    const a = idx ? idx.getX(t) : t, b = idx ? idx.getX(t + 1) : t + 1, c = idx ? idx.getX(t + 2) : t + 2;
    union(a, b); union(b, c);
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}

// LOD1（押し出し形状）の三角形群から外形と高さを求める
export function trisToBuilding(tris) {
  let minU = Infinity, maxU = -Infinity;
  for (let i = 2; i < tris.length; i += 3) { if (tris[i] < minU) minU = tris[i]; if (tris[i] > maxU) maxU = tris[i]; }
  const h = maxU - minU;
  if (!(h > 0.5)) return null;
  const mid = (minU + maxU) / 2;
  const q = (x) => Math.round(x * 50);
  const edgeCount = new Map();
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-9) continue;
    if (Math.abs(nz / nl) < 0.85 || (az + bz + cz) / 3 < mid) continue; // 上面のみ（向きは問わない）
    const P = [[ax, ay], [bx, by], [cx, cy]];
    for (let k = 0; k < 3; k++) {
      const p = P[k], r = P[(k + 1) % 3];
      const kp = q(p[0]) + ',' + q(p[1]), kr = q(r[0]) + ',' + q(r[1]);
      if (kp === kr) continue;
      const key = kp < kr ? kp + '|' + kr : kr + '|' + kp;
      const e = edgeCount.get(key);
      if (e) e.n++; else edgeCount.set(key, { n: 1, a: p, b: r });
    }
  }
  const edges = [];
  for (const e of edgeCount.values()) if (e.n === 1) edges.push([[e.a[0], -e.a[1]], [e.b[0], -e.b[1]]]);
  const rings = chainEdges(edges, 0.02);
  if (!rings.length) return null;
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  const outer = rings[0];
  const holes = rings.slice(1).filter((r) => pointInRing(r[0][0], r[0][1], outer));
  return { rings: [outer, ...holes], h, base: 0 };
}

export async function loadPlateauBuildings(cfg, frame, area, { signal, onProgress } = {}) {
  onProgress?.('PLATEAU タイルセットを確認中…');
  const ts = await findTileset(cfg.tilesetCandidates, signal);
  const contents = await collectContents(ts.url, ts.json, area, { signal, onProgress });
  if (!contents.length) throw new Error('対象範囲に PLATEAU の建物タイルが見つかりません');
  const seen = new Set();
  const buildings = [];
  let done = 0, failed = 0;
  const queue = contents.slice();
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      try {
        const buf = await fetchOk(c.url, 'buf', signal);
        const bs = await contentToBuildings(buf, c.matrix, c.upAxis, frame, area);
        for (const b of bs) {
          if (b.id) { if (seen.has(b.id)) continue; seen.add(b.id); }
          buildings.push(b);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
        failed++;
        console.warn('PLATEAU タイル取得失敗', c.url, e);
      }
      done++;
      onProgress?.(`PLATEAU 建物タイル ${done}/${contents.length}`);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (!buildings.length) throw new Error(`PLATEAU タイルを解析できませんでした（失敗 ${failed}件）`);
  return { buildings, tilesetUrl: ts.url, tiles: contents.length, failedTiles: failed };
}
