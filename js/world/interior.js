// 室内（解析データから生成）と住戸の仮配置
// 間取りの座標（u=図の右, v=図の下, m）を、主な窓の外向きが「住戸の向き」に合うよう回転して建物の外壁に合わせる。
// 住戸の建物内の位置・向きは確認できないことが多いため、すべて調整可能な仮配置として扱う。
import * as THREE from 'three';
import { pointInRing } from '../geo.js';
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

const MAT = {
  floor: new THREE.MeshLambertMaterial({ color: 0xd8c6a8 }),
  wet: new THREE.MeshLambertMaterial({ color: 0xdfe5e8 }),
  hall: new THREE.MeshLambertMaterial({ color: 0xcdb99a }),
  wall: new THREE.MeshLambertMaterial({ color: 0xfbfaf7, emissive: 0x3a3936 }),
  ceil: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x3a3936, side: THREE.BackSide }),
  glass: new THREE.MeshBasicMaterial({ color: 0xbfd9ea, transparent: true, opacity: 0.18, depthWrite: false }),
  frame: new THREE.MeshLambertMaterial({ color: 0xc9b79c }),
  fixture: new THREE.MeshLambertMaterial({ color: 0xe8ecef }),
  storage: new THREE.MeshLambertMaterial({ color: 0xe9e1d2 }),
  struct: new THREE.MeshLambertMaterial({ color: 0xbfc3c6 }),
  furniture: new THREE.MeshLambertMaterial({ color: 0xb79c7d }),
  balcony: new THREE.MeshLambertMaterial({ color: 0xc9c7c0 }),
};

function boxBetween(d0, d1, a, b, thick, y0, y1, toWorld, mat) {
  // 線分 a→b 上の区間 [d0,d1]（a からの距離）に厚み thick の箱を置く
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const ws = toWorld(a[0] + ux * d0, a[1] + uy * d0), we = toWorld(a[0] + ux * d1, a[1] + uy * d1);
  const len = Math.hypot(we[0] - ws[0], we[1] - ws[1]);
  if (len < 0.005 || y1 - y0 < 0.005) return null;
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, thick), mat);
  m.position.set((ws[0] + we[0]) / 2, (y0 + y1) / 2, (ws[1] + we[1]) / 2);
  m.rotation.y = -Math.atan2(we[1] - ws[1], we[0] - ws[0]);
  return m;
}

const PASSABLE = new Set(['door', 'sliding', 'opening']);
const isWin = (t) => t === 'window' || t === 'window_door';

export function buildInterior(scene, plan, pl) {
  const group = new THREE.Group();
  const H = plan.ceilingHeight?.value ?? 2.4;
  const toWorld = makeToWorld(plan, pl);
  const Y = pl.floorY;
  const walls = [];
  const shapeOf = (poly) => new THREE.Shape(poly.map(([u, v]) => { const w = toWorld(u, v); return new THREE.Vector2(w[0], -w[1]); }));
  const flat = (poly, mat, y) => {
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(poly)).rotateX(-Math.PI / 2), mat);
    m.position.y = y;
    group.add(m);
    return m;
  };

  // 床・天井・バルコニー
  flat(plan.outline, MAT.floor, Y + 0.001);
  for (const r of plan.rooms || []) {
    if (r.wet) flat(r.poly, MAT.wet, Y + 0.004);
    else if (['entrance', 'hall'].includes(r.type)) flat(r.poly, MAT.hall, Y + 0.003);
  }
  const ceil = flat(plan.outline, MAT.ceil, Y + H);
  ceil.renderOrder = 0;
  for (const b of plan.balconies || []) {
    flat(b.poly, MAT.balcony, Y - 0.08);
    // 手すり（外周の壁と重ならない辺だけ）
    for (let i = 0; i < b.poly.length; i++) {
      const p = b.poly[i], q = b.poly[(i + 1) % b.poly.length];
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (plan.outline.some((o, k) => {
        const o2 = plan.outline[(k + 1) % plan.outline.length];
        const L = Math.hypot(o2[0] - o[0], o2[1] - o[1]) || 1;
        const t = Math.max(0, Math.min(1, ((m[0] - o[0]) * (o2[0] - o[0]) + (m[1] - o[1]) * (o2[1] - o[1])) / (L * L)));
        return Math.hypot(m[0] - (o[0] + t * (o2[0] - o[0])), m[1] - (o[1] + t * (o2[1] - o[1]))) < 0.25;
      })) continue;
      const rail = boxBetween(0, Math.hypot(q[0] - p[0], q[1] - p[1]), p, q, 0.05, Y - 0.08, Y + 1.1, toWorld, MAT.struct);
      if (rail) group.add(rail);
    }
  }

  // 壁と開口
  for (const w of plan.walls) {
    const t = w.thickness ?? 0.12;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.01) continue;
    const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
    const ops = (w.openings || []).map((o) => ({ ...o, s: Math.max(0, o.at - o.width / 2), e: Math.min(L, o.at + o.width / 2) })).sort((x, y) => x.s - y.s);
    let cur = 0;
    const blocked = []; // 当たり判定の区間
    for (const o of ops) {
      if (o.s > cur) { const m = boxBetween(cur, o.s, w.a, w.b, t, Y, Y + H, toWorld, MAT.wall); if (m) group.add(m); blocked.push([cur, o.s]); }
      const head = Math.min(H, o.head ?? 2.0);
      const top = boxBetween(o.s, o.e, w.a, w.b, t, Y + head, Y + H, toWorld, MAT.wall);
      if (top) group.add(top);
      if (isWin(o.type)) {
        const sill = o.type === 'window_door' ? 0 : o.sill ?? 0.9;
        const low = boxBetween(o.s, o.e, w.a, w.b, t, Y, Y + sill, toWorld, MAT.wall);
        if (low) group.add(low);
        const glass = boxBetween(o.s, o.e, w.a, w.b, 0.02, Y + sill, Y + head, toWorld, MAT.glass);
        if (glass) { glass.renderOrder = 3; group.add(glass); }
        blocked.push([o.s, o.e]); // 窓は通れない
      } else if (o.type === 'door' || o.type === 'sliding') {
        // 枠（開いた状態として表示）
        const fr = boxBetween(o.s, o.e, w.a, w.b, t + 0.01, Y + head - 0.04, Y + head, toWorld, MAT.frame);
        if (fr) group.add(fr);
      }
      cur = Math.max(cur, o.e);
    }
    if (cur < L) { const m = boxBetween(cur, L, w.a, w.b, t, Y, Y + H, toWorld, MAT.wall); if (m) group.add(m); blocked.push([cur, L]); }
    for (const [s, e] of blocked) {
      const A = toWorld(w.a[0] + ux * s, w.a[1] + uy * s), B = toWorld(w.a[0] + ux * e, w.a[1] + uy * e);
      walls.push({ ax: A[0], az: A[1], bx: B[0], bz: B[1], half: t / 2 });
    }
    void PASSABLE;
  }

  // 固定設備（多角形または矩形）と家具
  const furnitureGroup = new THREE.Group();
  const addSolid = (poly, h, mat, target, isFurniture, label) => {
    const hh = Math.min(h, H);
    const g = new THREE.ExtrudeGeometry(shapeOf(poly), { depth: hh, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.y = Y;
    target.add(m);
    const P = poly.map(([u, v]) => toWorld(u, v));
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      walls.push({ ax: p[0], az: p[1], bx: q[0], bz: q[1], half: 0.02, furniture: isFurniture });
    }
    if (label) {
      const c = P.reduce((s, p) => [s[0] + p[0] / P.length, s[1] + p[1] / P.length], [0, 0]);
      const sp = textSprite(label);
      sp.position.set(c[0], Y + Math.min(hh, 1.6) + 0.2, c[1]);
      target.add(sp);
    }
  };
  const rectPoly = (f) => {
    const r = ((f.rot || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    return [[-f.w / 2, -f.d / 2], [f.w / 2, -f.d / 2], [f.w / 2, f.d / 2], [-f.w / 2, f.d / 2]].map(([x, y]) => [f.x + x * c - y * s, f.y + x * s + y * c]);
  };
  for (const f of plan.fixtures || []) {
    const poly = f.poly || rectPoly(f);
    const mat = ['ps', 'column'].includes(f.type) ? MAT.struct : ['storage', 'closet', 'shoebox'].includes(f.type) ? MAT.storage : MAT.fixture;
    if (f.solid === false) continue;
    addSolid(poly, f.h ?? 0.9, mat, group, false, f.label);
  }
  for (const f of plan.furniture || []) addSolid(f.poly || rectPoly(f), f.h ?? 0.6, MAT.furniture, furnitureGroup, true, null);
  group.add(furnitureGroup);
  for (const r of plan.rooms || []) {
    if (!r.name || !r.labelAt) continue;
    const c = toWorld(r.labelAt[0], r.labelAt[1]);
    const s = textSprite(r.name + (r.area ? `\n${r.area}` : ''));
    s.position.set(c[0], Y + 0.05, c[1]);
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

function textSprite(text) {
  const lines = text.split('\n');
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = '600 28px -apple-system, "Hiragino Sans", sans-serif';
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  c.width = Math.ceil(w + 24); c.height = 40 * lines.length + 8;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#333';
  ctx.font = '600 28px -apple-system, "Hiragino Sans", sans-serif';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 12, 6 + i * 40));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  s.center.set(0.5, 0);
  const k = 0.006;
  s.scale.set(c.width * k * 0.5, c.height * k * 0.5, 1);
  return s;
}
