// 衝突判定（歩ける範囲・建物・室内の壁）と道路経路の計算
import { Grid, closestOnSeg, pointInRing } from './geo.js';
import { WALK_RADIUS } from './config.js';

export class OutdoorNav {
  constructor(data) {
    this.radius = WALK_RADIUS;
    // 歩行可能な道路の線分（推定幅つき）
    this.segs = [];
    this.segGrid = new Grid(25);
    for (const w of data.walk) {
      for (let i = 0; i < w.pts.length - 1; i++) {
        const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
        const s = { ax, az, bx, bz, half: w.half, a: w.nodeIds[i], b: w.nodeIds[i + 1], way: w };
        this.segs.push(s);
        this.segGrid.insert(s, Math.min(ax, bx) - s.half, Math.min(az, bz) - s.half, Math.max(ax, bx) + s.half, Math.max(az, bz) + s.half);
      }
    }
    // 建物（対象建物を含む）
    this.blds = [];
    this.bGrid = new Grid(25);
    const add = (rings) => {
      let minx = Infinity, minz = Infinity, maxx = -Infinity, maxz = -Infinity;
      for (const p of rings[0]) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); minz = Math.min(minz, p[1]); maxz = Math.max(maxz, p[1]); }
      const b = { rings, minx, minz, maxx, maxz };
      this.blds.push(b);
      this.bGrid.insert(b, minx, minz, maxx, maxz);
    };
    for (const b of data.buildings) add(b.rings);
    if (data.target) add([data.target.ring]);

    // 経路グラフ
    this.nodes = new Map(); // id -> [x,z]
    this.adj = new Map(); // id -> [{to, d}]
    for (const w of data.walk) {
      for (let i = 0; i < w.pts.length; i++) this.nodes.set(w.nodeIds[i], w.pts[i]);
    }
    for (const s of this.segs) {
      const d = Math.hypot(s.bx - s.ax, s.bz - s.az);
      if (!this.adj.has(s.a)) this.adj.set(s.a, []);
      if (!this.adj.has(s.b)) this.adj.set(s.b, []);
      this.adj.get(s.a).push({ to: s.b, d });
      this.adj.get(s.b).push({ to: s.a, d });
    }
  }

  walkableAt(x, z) {
    for (const s of this.segGrid.query(x, z, 0)) {
      if (closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz).d <= s.half) return true;
    }
    return false;
  }

  buildingAt(x, z, r) {
    for (const b of this.bGrid.query(x, z, r)) {
      if (x < b.minx - r || x > b.maxx + r || z < b.minz - r || z > b.maxz + r) continue;
      const outer = b.rings[0];
      if (pointInRing(x, z, outer) && !b.rings.slice(1).some((h) => pointInRing(x, z, h))) return true;
      for (const ring of b.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          if (closestOnSeg(x, z, ring[j][0], ring[j][1], ring[i][0], ring[i][1]).d < r) return true;
        }
      }
    }
    return false;
  }

  // 理由つきの判定: null（通行可）/ 'range' / 'road' / 'building'
  blockReason(x, z, r) {
    if (Math.hypot(x, z) > this.radius) return 'range';
    if (!this.walkableAt(x, z)) return 'road';
    if (this.buildingAt(x, z, r)) return 'building';
    return null;
  }

  nearestOnRoad(x, z, maxR = 150) {
    let best = null;
    for (let r = 20; r <= maxR && !best; r *= 2) {
      for (const s of this.segGrid.query(x, z, r)) {
        const c = closestOnSeg(x, z, s.ax, s.az, s.bx, s.bz);
        if (!best || c.d < best.d) best = { ...c, seg: s };
      }
    }
    return best;
  }

  // 道路網上の最短経路（ダイクストラ法）。端点は最寄りの道路へ吸着する。
  route(from, to, maxSnap = 60) {
    const a = this.nearestOnRoad(from.x, from.z, 160);
    const b = this.nearestOnRoad(to.x, to.z, 160);
    if (!a || !b) return null;
    const S = 's', T = 't';
    const extra = new Map([[S, []], [T, []]]);
    const link = (vid, snap) => {
      const s = snap.seg;
      const pa = this.nodes.get(s.a), pb = this.nodes.get(s.b);
      extra.get(vid).push({ to: s.a, d: Math.hypot(snap.x - pa[0], snap.z - pa[1]) });
      extra.get(vid).push({ to: s.b, d: Math.hypot(snap.x - pb[0], snap.z - pb[1]) });
    };
    link(S, a); link(T, b);
    const toT = new Map(extra.get(T).map((e) => [e.to, e.d]));
    const pos = (id) => (id === S ? [a.x, a.z] : id === T ? [b.x, b.z] : this.nodes.get(id));
    const dist = new Map([[S, 0]]);
    const prev = new Map();
    const heap = new MinHeap();
    heap.push(0, S);
    // 同じ線分上に両端がある場合の直結
    if (a.seg === b.seg) {
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      dist.set(T, d); prev.set(T, S); heap.push(d, T);
    }
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > (dist.get(u) ?? Infinity)) continue;
      if (u === T) break;
      const edges = u === S ? extra.get(S) : this.adj.get(u) || [];
      for (const e of edges) {
        const nd = d + e.d;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, u); heap.push(nd, e.to); }
      }
      if (toT.has(u)) {
        const nd = d + toT.get(u);
        if (nd < (dist.get(T) ?? Infinity)) { dist.set(T, nd); prev.set(T, u); heap.push(nd, T); }
      }
    }
    if (!dist.has(T)) return null;
    const path = [];
    for (let v = T; v !== undefined; v = prev.get(v)) path.push(pos(v));
    path.reverse();
    return { dist: dist.get(T), path, startSnap: a.d, endSnap: b.d, reliable: a.d <= maxSnap && b.d <= maxSnap };
  }
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

// 室内: 壁の線分（厚み付き）との距離で判定
export class IndoorNav {
  constructor(walls, bounds) {
    this.walls = walls; // [{ax,az,bx,bz,half}]
    this.bounds = bounds; // 住戸外形 [[x,z],...]（ワールド座標）
  }
  blockReason(x, z, r) {
    if (this.bounds && !pointInRing(x, z, this.bounds)) return 'wall';
    for (const w of this.walls) {
      if (closestOnSeg(x, z, w.ax, w.az, w.bx, w.bz).d < r + w.half) return 'wall';
    }
    return null;
  }
}

// 小刻みに移動し、ぶつかったら壁に沿って滑らせる
export function moveWithCollision(nav, pos, dx, dz, r) {
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return { moved: false, reason: null };
  const steps = Math.ceil(len / 0.08);
  const sx = dx / steps, sz = dz / steps;
  let reason = null, moved = false;
  for (let i = 0; i < steps; i++) {
    let r1 = nav.blockReason(pos.x + sx, pos.z + sz, r);
    if (!r1) { pos.x += sx; pos.z += sz; moved = true; continue; }
    reason = r1;
    if (!nav.blockReason(pos.x + sx, pos.z, r)) { pos.x += sx; moved = true; continue; }
    if (!nav.blockReason(pos.x, pos.z + sz, r)) { pos.z += sz; moved = true; continue; }
    break;
  }
  return { moved, reason };
}
