// 座標変換と2D幾何ユーティリティ
// 3D空間の座標系: x = 東, y = 上, z = 南（北は -z）。単位はメートル。
// 原点は対象物件付近（config.origin）。大きな座標値による描画の揺れを避けるため、
// すべての地理座標はここでローカルな東北上（ENU）座標に変換してから使う。

const A = 6378137.0; // WGS84 長半径
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

export function geodeticToEcef(latDeg, lonDeg, h = 0) {
  const lat = latDeg * DEG, lon = lonDeg * DEG;
  const s = Math.sin(lat), c = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * s * s);
  return [(n + h) * c * Math.cos(lon), (n + h) * c * Math.sin(lon), (n * (1 - E2) + h) * s];
}

export function ecefToGeodetic(x, y, z) {
  // Bowring の反復（数回で mm 精度）
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 5; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - E2 * n / (n + h)));
  }
  return [lat / DEG, lon / DEG, h];
}

// 原点を中心とする局所座標系
export class LocalFrame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.o = geodeticToEcef(lat0, lon0, 0);
    const la = lat0 * DEG, lo = lon0 * DEG;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    // ECEF -> ENU の回転行列（行ベクトル）
    this.e = [-so, co, 0];
    this.n = [-sl * co, -sl * so, cl];
    this.u = [cl * co, cl * so, sl];
  }
  // ECEF -> ENU [east, north, up]
  ecefToEnu(x, y, z) {
    const dx = x - this.o[0], dy = y - this.o[1], dz = z - this.o[2];
    const e = this.e, n = this.n, u = this.u;
    return [
      e[0] * dx + e[1] * dy + e[2] * dz,
      n[0] * dx + n[1] * dy + n[2] * dz,
      u[0] * dx + u[1] * dy + u[2] * dz,
    ];
  }
  // 緯度経度 -> 3D平面座標 {x, z}
  toXZ(lat, lon) {
    const p = geodeticToEcef(lat, lon, 0);
    const [e, n] = this.ecefToEnu(p[0], p[1], p[2]);
    return { x: e, z: -n };
  }
  // 3D平面座標 -> 緯度経度（近似の逆変換。局所範囲では mm 精度）
  toLatLon(x, z) {
    const e = x, n = -z;
    const ex = this.o[0] + this.e[0] * e + this.n[0] * n;
    const ey = this.o[1] + this.e[1] * e + this.n[1] * n;
    const ez = this.o[2] + this.e[2] * e + this.n[2] * n;
    const [lat, lon] = ecefToGeodetic(ex, ey, ez);
    return { lat, lon };
  }
}

// 緯度経度の矩形（原点から半径 r[m] を含む）
export function bboxAround(lat, lon, r) {
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.cos(lat * DEG));
  return { s: lat - dLat, w: lon - dLon, n: lat + dLat, e: lon + dLon };
}

// ---- 2D 幾何（点は {x, z} または [x, z]） ----

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2; // 符号付き
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function ringCentroid(ring) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

// 点と線分の距離と最近点
export function closestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  return { x: cx, z: cz, t, d: Math.hypot(px - cx, pz - cz) };
}

// 境界辺（[[x,z],[x,z]] の配列）をつないで閉じたリングにする
export function chainEdges(edges, eps = 0.02) {
  const key = (p) => Math.round(p[0] / eps) + ',' + Math.round(p[1] / eps);
  const adj = new Map();
  edges.forEach((e, i) => {
    for (const k of [key(e[0]), key(e[1])]) {
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k).push(i);
    }
  });
  const used = new Uint8Array(edges.length);
  const rings = [];
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const ring = [edges[s][0], edges[s][1]];
    let cur = edges[s][1];
    const startKey = key(edges[s][0]);
    for (let guard = 0; guard < edges.length; guard++) {
      const k = key(cur);
      if (k === startKey) break;
      const next = (adj.get(k) || []).find((i) => !used[i]);
      if (next === undefined) break;
      used[next] = 1;
      const e = edges[next];
      cur = key(e[0]) === k ? e[1] : e[0];
      ring.push(cur);
    }
    if (key(ring[ring.length - 1]) === startKey) ring.pop();
    if (ring.length >= 3 && Math.abs(ringArea(ring)) > 0.5) rings.push(ring);
  }
  return rings;
}

// 一様グリッドによる空間インデックス
export class Grid {
  constructor(cell = 20) {
    this.cell = cell;
    this.map = new Map();
  }
  _k(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  insert(item, minx, minz, maxx, maxz) {
    const c = this.cell;
    for (let ix = Math.floor(minx / c); ix <= Math.floor(maxx / c); ix++) {
      for (let iz = Math.floor(minz / c); iz <= Math.floor(maxz / c); iz++) {
        const k = this._k(ix, iz);
        let a = this.map.get(k);
        if (!a) this.map.set(k, (a = []));
        a.push(item);
      }
    }
  }
  query(x, z, r, out = new Set()) {
    const c = this.cell;
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++) {
      for (let iz = Math.floor((z - r) / c); iz <= Math.floor((z + r) / c); iz++) {
        const a = this.map.get(this._k(ix, iz));
        if (a) for (const it of a) out.add(it);
      }
    }
    return out;
  }
}

export function fmtMeters(m) {
  if (m >= 1000) return (m / 1000).toFixed(2) + ' km';
  return Math.round(m) + ' m';
}
