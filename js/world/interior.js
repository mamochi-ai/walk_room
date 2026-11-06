// 室内（解析データから生成）と住戸の仮配置
// 間取りの座標（u=図の右, v=図の下, m）を、主な窓の外向きが「住戸の向き」に合うよう回転して建物の外壁に合わせる。
// 住戸の建物内の位置・向きは確認できないことが多いため、すべて調整可能な仮配置として扱う。
import * as THREE from 'three';
import { pointInRing, ringArea } from '../geo.js';
import { TARGET_ESTIMATE } from '../config.js';
import { IndoorNav } from '../nav.js';

export const BEARINGS = [[0, '北'], [45, '北東'], [90, '東'], [135, '南東'], [180, '南'], [225, '南西'], [270, '西'], [315, '北西']];
export const bearingLabel = (b) => BEARINGS.reduce((best, x) => (Math.abs(((b - x[0] + 540) % 360) - 180) < Math.abs(((b - best[0] + 540) % 360) - 180) ? x : best))[1];
const dirOf = (bearing) => [Math.sin((bearing * Math.PI) / 180), -Math.cos((bearing * Math.PI) / 180)]; // x=東, z=南

// ring: 対象建物の外形（無ければ null → 物件位置に置く）
// opt: { bearing, along, floor, storyHeight }
export function computePlacement(ring, opt) {
  const dir = dirOf(opt.bearing ?? 180);
  const floor = Number(opt.floor) || 1;
  const storyHeight = opt.storyHeight || TARGET_ESTIMATE.storyHeight;
  const floorY = TARGET_ESTIMATE.groundFloorRaise + (floor - 1) * storyHeight;
  if (!ring) {
    return { center: [0, 0], nOut: dir, nIn: [-dir[0], -dir[1]], t: [-dir[1], dir[0]], edgeLen: 0, floorY, onBuilding: false, floorKnown: !!opt.floor };
  }
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const len = Math.hypot(dx, dz);
    if (len < 3) continue;
    let nx = dz / len, nz = -dx / len;
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    if (pointInRing(mx + nx * 0.5, mz + nz * 0.5, ring)) { nx = -nx; nz = -nz; } // 外向きにそろえる
    const score = len * Math.max(0.001, nx * dir[0] + nz * dir[1]) ** 2;
    if (!best || score > best.score) best = { score, p, q, len, nx, nz, dx: dx / len, dz: dz / len };
  }
  if (!best) return computePlacement(null, opt);
  const along = Math.min(0.95, Math.max(0.05, opt.along ?? 0.5));
  const center = [best.p[0] + best.dx * best.len * along, best.p[1] + best.dz * best.len * along];
  return { center, nOut: [best.nx, best.nz], nIn: [-best.nx, -best.nz], t: [best.dx, best.dz], edgeLen: best.len, floorY, onBuilding: true, floorKnown: !!opt.floor };
}

// 間取り座標 → ワールド座標。主な窓の壁の中心を外壁上の配置点に、窓の外向きを外壁の外向きに合わせる。
export function makeToWorld(plan, pl) {
  const pw = plan.primaryWindow;
  const th = Math.atan2(pl.nOut[1], pl.nOut[0]) - Math.atan2(pw.normal[1], pw.normal[0]);
  const c = Math.cos(th), s = Math.sin(th);
  const off = (pw.thickness || 0.18) / 2;
  const C = [pl.center[0] + pl.nIn[0] * off, pl.center[1] + pl.nIn[1] * off];
  const f = (u, v) => {
    const du = u - pw.mid[0], dv = v - pw.mid[1];
    return [C[0] + du * c - dv * s, C[1] + du * s + dv * c];
  };
  f.angle = th;
  return f;
}

// ---- 素材（画像素材を使わず、キャンバスで模様を描く） ----
const MAT = {
  wall: new THREE.MeshLambertMaterial({ color: 0xf6f4ef }),
  ceil: new THREE.MeshLambertMaterial({ color: 0xfbfaf8, side: THREE.BackSide }),
  base: new THREE.MeshLambertMaterial({ color: 0x8e7d68 }), // 幅木
  glass: new THREE.MeshBasicMaterial({ color: 0xcfe3ef, transparent: true, opacity: 0.14, depthWrite: false }),
  sash: new THREE.MeshLambertMaterial({ color: 0x8f969b }), // 窓枠（アルミ）
  frame: new THREE.MeshLambertMaterial({ color: 0xd8c7aa }), // 扉枠
  door: new THREE.MeshLambertMaterial({ color: 0xe6d9c3 }),
  fixture: new THREE.MeshLambertMaterial({ color: 0xf1f2f2 }),
  counter: new THREE.MeshLambertMaterial({ color: 0x9a9fa3 }),
  bath: new THREE.MeshLambertMaterial({ color: 0xeef4f7 }),
  storage: new THREE.MeshLambertMaterial({ color: 0xe5d8c2 }),
  struct: new THREE.MeshLambertMaterial({ color: 0xeceae5 }),
  furniture: new THREE.MeshLambertMaterial({ color: 0xb79c7d }),
  balcony: new THREE.MeshLambertMaterial({ color: 0xbdbab2 }),
  railGlass: new THREE.MeshBasicMaterial({ color: 0xd8e0e4, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }),
  rail: new THREE.MeshLambertMaterial({ color: 0x7d8387 }),
};
const EDGE = new THREE.LineBasicMaterial({ color: 0xb9b1a4 });

let texCache = null;
function textures() {
  if (texCache) return texCache;
  const make = (draw, metres) => {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    draw(c.getContext('2d'), 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / metres, 1 / metres);
    t.anisotropy = 4;
    return t;
  };
  // フローリング（2m 四方に幅 0.125m の板 16 枚、継ぎ目をずらす）
  const wood = make((g, S) => {
    const rows = 16, h = S / rows;
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * S * 0.6;
      while (x < S) {
        const len = S * (0.45 + rnd() * 0.35);
        const l = 70 + rnd() * 10;
        g.fillStyle = `hsl(34, 38%, ${l}%)`;
        g.fillRect(x, r * h, len, h);
        g.fillStyle = 'rgba(90,60,30,0.35)';
        g.fillRect(x, r * h, 1.5, h);
        x += len;
      }
      g.fillStyle = 'rgba(90,60,30,0.28)';
      g.fillRect(0, r * h, S, 1.5);
    }
  }, 2);
  // タイル（0.3m 角）
  const tile = (base, line) => make((g, S) => {
    g.fillStyle = base; g.fillRect(0, 0, S, S);
    g.strokeStyle = line; g.lineWidth = 2;
    const n = 6;
    for (let i = 0; i <= n; i++) { const p = (i * S) / n; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.moveTo(0, p); g.lineTo(S, p); g.stroke(); }
  }, 1.8);
  texCache = { wood, wet: tile('#e7ecee', '#c9d1d5'), stone: tile('#b9b5ad', '#9a958c') };
  return texCache;
}

function boxBetween(d0, d1, a, b, thick, y0, y1, toWorld, mat, offset = 0) {
  // 線分 a→b 上の区間 [d0,d1]（a からの距離）に厚み thick の箱を置く。offset は壁の法線方向へのずらし
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const nx = uy, ny = -ux;
  const ws = toWorld(a[0] + ux * d0 + nx * offset, a[1] + uy * d0 + ny * offset), we = toWorld(a[0] + ux * d1 + nx * offset, a[1] + uy * d1 + ny * offset);
  const len = Math.hypot(we[0] - ws[0], we[1] - ws[1]);
  if (len < 0.005 || y1 - y0 < 0.005) return null;
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, thick), mat);
  m.position.set((ws[0] + we[0]) / 2, (y0 + y1) / 2, (ws[1] + we[1]) / 2);
  m.rotation.y = -Math.atan2(we[1] - ws[1], we[0] - ws[0]);
  return m;
}
function withEdges(m) {
  if (m) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 20), EDGE));
  return m;
}

const isWin = (t) => t === 'window' || t === 'window_door';
const FIXTURE_MAT = {
  kitchen: 'fixture', washbasin: 'fixture', toilet: 'fixture', washer: 'fixture', bath: 'bath',
  storage: 'storage', closet: 'storage', shoebox: 'storage', ps: 'struct', column: 'struct',
};

export function buildInterior(scene, plan, pl) {
  const group = new THREE.Group();
  const H = plan.ceilingHeight?.value ?? 2.4;
  const toWorld = makeToWorld(plan, pl);
  const Y = pl.floorY;
  const walls = [];
  const tex = textures();
  const shapeOf = (poly) => new THREE.Shape(poly.map(([u, v]) => { const w = toWorld(u, v); return new THREE.Vector2(w[0], -w[1]); }));
  const inOutline = (p) => pointInRing(p[0], p[1], plan.outline);
  const flat = (poly, mat, y) => {
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(poly)).rotateX(-Math.PI / 2), mat);
    m.position.y = y;
    group.add(m);
    return m;
  };
  // 床の模様を間取りの向きにそろえる
  const floorMat = (t) => {
    const tt = t.clone();
    tt.needsUpdate = true;
    tt.rotation = -toWorld.angle;
    return new THREE.MeshLambertMaterial({ map: tt });
  };

  // 床・天井
  flat(plan.outline, floorMat(tex.wood), Y + 0.001);
  for (const r of plan.rooms || []) {
    if (r.wet) flat(r.poly, floorMat(tex.wet), Y + 0.004);
    else if (r.type === 'entrance') flat(r.poly, floorMat(tex.stone), Y + 0.004);
  }
  flat(plan.outline, MAT.ceil, Y + H);

  // 照明：部屋ごとに天井灯（減衰する点光源）。多すぎると iPad で重いので広い部屋から最大4つ
  const rooms = [...(plan.rooms || [])].sort((a, b) => Math.abs(ringArea(b.poly)) - Math.abs(ringArea(a.poly))).slice(0, 4);
  const lightSpots = rooms.length ? rooms.map((r) => r.labelAt) : [plan.outline.reduce((s, p) => [s[0] + p[0] / plan.outline.length, s[1] + p[1] / plan.outline.length], [0, 0])];
  for (const at of lightSpots) {
    const w = toWorld(at[0], at[1]);
    const lamp = new THREE.PointLight(0xfffaf2, 1.1, 8, 1.8);
    lamp.position.set(w[0], Y + H - 0.45, w[1]);
    group.add(lamp);
  }

  // バルコニー：床・半透明の手すりパネル・笠木
  for (const b of plan.balconies || []) {
    flat(b.poly, MAT.balcony, Y - 0.08);
    for (let i = 0; i < b.poly.length; i++) {
      const p = b.poly[i], q = b.poly[(i + 1) % b.poly.length];
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const onWall = plan.outline.some((o, k) => {
        const o2 = plan.outline[(k + 1) % plan.outline.length];
        const L = Math.hypot(o2[0] - o[0], o2[1] - o[1]) || 1;
        const t = Math.max(0, Math.min(1, ((m[0] - o[0]) * (o2[0] - o[0]) + (m[1] - o[1]) * (o2[1] - o[1])) / (L * L)));
        return Math.hypot(m[0] - (o[0] + t * (o2[0] - o[0])), m[1] - (o[1] + t * (o2[1] - o[1]))) < 0.25;
      });
      if (onWall) continue;
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const panel = boxBetween(0, L, p, q, 0.02, Y + 0.05, Y + 1.0, toWorld, MAT.railGlass);
      if (panel) { panel.renderOrder = 3; group.add(panel); }
      const top = boxBetween(0, L, p, q, 0.06, Y + 1.0, Y + 1.1, toWorld, MAT.rail);
      if (top) group.add(top);
    }
  }

  // 壁と開口
  const solidWall = (d0, d1, w, t, y0, y1) => {
    const m = withEdges(boxBetween(d0, d1, w.a, w.b, t, y0, y1, toWorld, MAT.wall));
    if (m) group.add(m);
    return m;
  };
  for (const w of plan.walls) {
    const t = w.thickness ?? 0.12;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.01) continue;
    const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
    const nx = uy, ny = -ux;
    const ops = (w.openings || []).map((o) => ({ ...o, s: Math.max(0, o.at - o.width / 2), e: Math.min(L, o.at + o.width / 2) })).sort((x, y) => x.s - y.s);
    let cur = 0;
    const blocked = []; // 当たり判定の区間
    const baseboard = (d0, d1) => { const m = boxBetween(d0, d1, w.a, w.b, t + 0.024, Y, Y + 0.06, toWorld, MAT.base); if (m) group.add(m); };
    for (const o of ops) {
      if (o.s > cur) { solidWall(cur, o.s, w, t, Y, Y + H); baseboard(cur, o.s); blocked.push([cur, o.s]); }
      const head = Math.min(H - 0.02, o.head ?? 2.0);
      solidWall(o.s, o.e, w, t, Y + head, Y + H);
      if (isWin(o.type)) {
        const sill = o.type === 'window_door' ? 0 : o.sill ?? 0.9;
        if (sill > 0) { solidWall(o.s, o.e, w, t, Y, Y + sill); baseboard(o.s, o.e); }
        const glass = boxBetween(o.s, o.e, w.a, w.b, 0.015, Y + sill, Y + head, toWorld, MAT.glass);
        if (glass) { glass.renderOrder = 3; group.add(glass); }
        // サッシ：周囲の枠と、幅のある窓は中央の召し合わせ
        const ft = Math.min(t, 0.07), fw = 0.045;
        for (const m of [
          boxBetween(o.s, o.s + fw, w.a, w.b, ft, Y + sill, Y + head, toWorld, MAT.sash),
          boxBetween(o.e - fw, o.e, w.a, w.b, ft, Y + sill, Y + head, toWorld, MAT.sash),
          boxBetween(o.s, o.e, w.a, w.b, ft, Y + head - fw, Y + head, toWorld, MAT.sash),
          boxBetween(o.s, o.e, w.a, w.b, ft, Y + sill, Y + sill + fw, toWorld, MAT.sash),
          o.e - o.s > 0.9 ? boxBetween(o.at - fw, o.at + fw, w.a, w.b, ft, Y + sill, Y + head, toWorld, MAT.sash) : null,
        ]) if (m) group.add(m);
        blocked.push([o.s, o.e]); // 窓は通れない
      } else {
        // 扉枠（両側の縦枠と上枠）
        const jt = t + 0.02, jw = 0.035;
        if (o.type !== 'opening') {
          for (const m of [
            boxBetween(o.s, o.s + jw, w.a, w.b, jt, Y, Y + head, toWorld, MAT.frame),
            boxBetween(o.e - jw, o.e, w.a, w.b, jt, Y, Y + head, toWorld, MAT.frame),
            boxBetween(o.s, o.e, w.a, w.b, jt, Y + head - jw, Y + head, toWorld, MAT.frame),
          ]) if (m) group.add(m);
        }
        const leafW = o.e - o.s - 2 * jw;
        // 開く側：外周の内側で、空いている方
        const side = (sgn) => inOutline([w.a[0] + ux * o.at + nx * sgn * 0.5, w.a[1] + uy * o.at + ny * sgn * 0.5]);
        const sgn = /内|手前|奥/.test(o.swing || '') ? 1 : side(1) ? 1 : -1;
        if (o.type === 'door' && leafW > 0.2) {
          // 開いた扉（蝶番側から部屋側へ90°）。見た目のみで当たり判定は付けない
          const hinge = [w.a[0] + ux * (o.s + jw) + nx * sgn * (t / 2), w.a[1] + uy * (o.s + jw) + ny * sgn * (t / 2)];
          const tip = [hinge[0] + nx * sgn * leafW, hinge[1] + ny * sgn * leafW];
          const leaf = boxBetween(0, leafW, hinge, tip, 0.035, Y + 0.01, Y + head - jw - 0.01, toWorld, MAT.door);
          if (leaf) group.add(withEdges(leaf));
        } else if (o.type === 'sliding' && leafW > 0.2) {
          // 引き戸：開口の横の壁に沿って引き込んだ状態
          const room = L - o.e >= o.s ? [o.e, Math.min(L, o.e + leafW)] : [Math.max(0, o.s - leafW), o.s];
          const panel = boxBetween(room[0], room[1], w.a, w.b, 0.03, Y + 0.01, Y + head - jw - 0.01, toWorld, MAT.door, sgn * (t / 2 + 0.02));
          if (panel) group.add(withEdges(panel));
        }
      }
      cur = Math.max(cur, o.e);
    }
    if (cur < L) { solidWall(cur, L, w, t, Y, Y + H); baseboard(cur, L); blocked.push([cur, L]); }
    for (const [s, e] of blocked) {
      const A = toWorld(w.a[0] + ux * s, w.a[1] + uy * s), B = toWorld(w.a[0] + ux * e, w.a[1] + uy * e);
      walls.push({ ax: A[0], az: A[1], bx: B[0], bz: B[1], half: t / 2 });
    }
  }

  // 固定設備（多角形または矩形）と家具
  const furnitureGroup = new THREE.Group();
  const addSolid = (poly, h, mat, target, isFurniture, label, top) => {
    const hh = Math.min(h, H);
    const g = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: hh, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const m = withEdges(new THREE.Mesh(g, mat));
    m.position.y = Y;
    target.add(m);
    if (top) {
      // キッチンの天板など
      const tg = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: 0.03, bevelEnabled: false });
      tg.rotateX(-Math.PI / 2);
      const tm = new THREE.Mesh(tg, top);
      tm.position.y = Y + hh;
      target.add(tm);
    }
    const P = poly.map(([u, v]) => toWorld(u, v));
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      walls.push({ ax: p[0], az: p[1], bx: q[0], bz: q[1], half: 0.02, furniture: isFurniture });
    }
    if (label) {
      const c = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length], [0, 0]);
      const sp = textSprite(label, 0.8);
      sp.position.set(c[0], Y + Math.min(hh, 1.7) + 0.08, c[1]);
      target.add(sp);
    }
  };
  const rectPoly = (f) => {
    const r = ((f.rot || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [[-f.w / 2, -f.d / 2], [f.w / 2, -f.d / 2], [f.w / 2, f.d / 2], [-f.w / 2, f.d / 2]].map(([x, y]) => [f.x + x * c - y * s, f.y + x * s + y * c]);
  };
  for (const f of plan.fixtures || []) {
    if (f.solid === false) continue;
    const poly = f.poly || rectPoly(f);
    const h = f.type === 'washer' ? 0.08 : f.h ?? 0.9;
    addSolid(poly, h, MAT[FIXTURE_MAT[f.type] || 'fixture'], group, false, f.label, f.type === 'kitchen' ? MAT.counter : null);
  }
  for (const f of plan.furniture || []) addSolid(f.poly || rectPoly(f), f.h ?? 0.6, MAT.furniture, furnitureGroup, true, null);
  group.add(furnitureGroup);
  for (const r of plan.rooms || []) {
    if (!r.name || !r.labelAt) continue;
    const c = toWorld(r.labelAt[0], r.labelAt[1]);
    const s = textSprite(r.name + (r.area ? `  ${r.area}` : ''), 1);
    s.position.set(c[0], Y + 0.02, c[1]);
    group.add(s);
  }

  scene.add(group);
  const bounds = plan.outline.map(([u, v]) => toWorld(u, v));
  const nav = new IndoorNav(walls, bounds);
  const setFurniture = (on) => {
    furnitureGroup.visible = on;
    nav.walls = on ? walls : walls.filter((w) => !w.furniture);
  };
  // 初期位置と向き
  const cx = plan.outline.reduce((s, p) => s + p[0], 0) / plan.outline.length, cy = plan.outline.reduce((s, p) => s + p[1], 0) / plan.outline.length;
  const at = plan.spawn?.at || [cx, cy];
  const sp = toWorld(at[0], at[1]);
  let spawnYaw;
  if (plan.spawn?.lookAt) {
    const q = toWorld(plan.spawn.lookAt[0], plan.spawn.lookAt[1]);
    spawnYaw = Math.atan2(-(q[0] - sp[0]), -(q[1] - sp[1]));
  } else if (plan.spawn?.yawDeg !== undefined) {
    const r = (plan.spawn.yawDeg * Math.PI) / 180;
    const right = [-pl.nOut[1], pl.nOut[0]]; // 窓を向いて右（v1 の u 方向）
    spawnYaw = Math.atan2(-(pl.nOut[0] * Math.cos(r) + right[0] * Math.sin(r)), -(pl.nOut[1] * Math.cos(r) + right[1] * Math.sin(r)));
  } else spawnYaw = yawLookingOut(pl);
  const entrance = plan.entrance ? toWorld(plan.entrance[0], plan.entrance[1]) : null;
  return { group, nav, spawn: { x: sp[0], z: sp[1], yaw: spawnYaw }, entrance, floorY: Y, setFurniture, toWorld };
}

export function yawLookingOut(pl) {
  return Math.atan2(-pl.nOut[0], -pl.nOut[1]);
}

function textSprite(text, scale = 1) {
  const lines = text.split('\n');
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 28px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.font = font;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  c.width = Math.ceil(w + 28); c.height = 40 * lines.length + 10;
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  const r = 10;
  ctx.beginPath(); ctx.moveTo(r, 0); ctx.arcTo(c.width, 0, c.width, c.height, r); ctx.arcTo(c.width, c.height, 0, c.height, r); ctx.arcTo(0, c.height, 0, 0, r); ctx.arcTo(0, 0, c.width, 0, r); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#3a3630';
  ctx.font = font;
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 14, 7 + i * 40));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  s.center.set(0.5, 0);
  const k = 0.0028 * scale;
  s.scale.set(c.width * k, c.height * k, 1);
  return s;
}
