// 室内（間取りデータ data/unit-312.json から生成）と住戸の仮配置
import * as THREE from 'three';
import { pointInRing } from '../geo.js';
import { TARGET_ESTIMATE } from '../config.js';
import { IndoorNav } from '../nav.js';

const DIRS = { W: [-1, 0], N: [0, -1], E: [1, 0], S: [0, 1] };
export const FACADE_LABEL = { W: '西', N: '北', E: '東', S: '南' };

// 指定方位を向く外壁を選び、住戸の基準座標系を返す（すべて推定・仮配置）
export function computePlacement(ring, placement, storyHeight = TARGET_ESTIMATE.storyHeight) {
  const dir = DIRS[placement.facade] || DIRS.W;
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const len = Math.hypot(dx, dz);
    if (len < 4) continue;
    let nx = dz / len, nz = -dx / len;
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    if (pointInRing(mx + nx * 0.5, mz + nz * 0.5, ring)) { nx = -nx; nz = -nz; } // 外向きにそろえる
    const score = len * Math.max(0, nx * dir[0] + nz * dir[1]) ** 2;
    if (!best || score > best.score) best = { score, p, q, len, nx, nz, dx: dx / len, dz: dz / len };
  }
  if (!best) return null;
  // u 方向 = 室内から窓（この外壁）を向いたときの右方向。
  // 間取り図を「窓側を上」にして置いたとき、u は図の右方向、v は図の下方向（窓から奥へ）になる。
  let t = [best.dx, best.dz], a = best.p;
  if (t[0] * best.nz - t[1] * best.nx > 0) { t = [-t[0], -t[1]]; a = best.q; }
  const along = Math.min(0.95, Math.max(0.05, placement.along ?? 0.5));
  const center = [a[0] + t[0] * best.len * along, a[1] + t[1] * best.len * along];
  const floorY = TARGET_ESTIMATE.groundFloorRaise + (placement.floor - 1) * storyHeight;
  return { center, t, nIn: [-best.nx, -best.nz], nOut: [best.nx, best.nz], edgeLen: best.len, floorY, facade: placement.facade };
}

// 室内ローカル座標 (u: 窓側を向いて右方向, v: 窓側の外壁面から奥へ) → ワールド
export function makeToWorld(pl, unitWidth) {
  return (u, v) => [
    pl.center[0] + pl.t[0] * (u - unitWidth / 2) + pl.nIn[0] * v,
    pl.center[1] + pl.t[1] * (u - unitWidth / 2) + pl.nIn[1] * v,
  ];
}

const MAT = {
  floor: new THREE.MeshLambertMaterial({ color: 0xd8c6a8 }),
  wet: new THREE.MeshLambertMaterial({ color: 0xdfe5e8 }),
  wall: new THREE.MeshLambertMaterial({ color: 0xfbfaf7, emissive: 0x3a3936 }),
  ceil: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x3a3936, side: THREE.BackSide }),
  glass: new THREE.MeshBasicMaterial({ color: 0xbfd9ea, transparent: true, opacity: 0.18, depthWrite: false }),
  frame: new THREE.MeshLambertMaterial({ color: 0x9aa3a8 }),
  fixture: new THREE.MeshLambertMaterial({ color: 0xe8ecef }),
  furniture: new THREE.MeshLambertMaterial({ color: 0xb79c7d }),
  door: new THREE.MeshLambertMaterial({ color: 0xc9b79c }),
};

function boxBetween(u0, u1, a, b, thick, y0, y1, toWorld, mat) {
  // 線分 a→b 上の区間 [u0,u1]（a からの距離）に厚み thick の箱を置く
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const s = [a[0] + ux * u0, a[1] + uy * u0], e = [a[0] + ux * u1, a[1] + uy * u1];
  const ws = toWorld(s[0], s[1]), we = toWorld(e[0], e[1]);
  const len = Math.hypot(we[0] - ws[0], we[1] - ws[1]);
  if (len < 0.005 || y1 - y0 < 0.005) return null;
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, y1 - y0, thick), mat);
  m.position.set((ws[0] + we[0]) / 2, (y0 + y1) / 2, (ws[1] + we[1]) / 2);
  m.rotation.y = -Math.atan2(we[1] - ws[1], we[0] - ws[0]);
  return m;
}

export function buildInterior(scene, plan, pl) {
  const group = new THREE.Group();
  const H = plan.ceilingHeight?.value ?? 2.5;
  const W = Math.max(...plan.outline.map((p) => p[0]));
  const toWorld = makeToWorld(pl, W);
  const Y = pl.floorY;
  const walls = [];

  // 床（部屋ごとに色分け）・天井
  const shapeOf = (poly) => {
    const pts = poly.map(([u, v]) => { const w = toWorld(u, v); return new THREE.Vector2(w[0], -w[1]); });
    return new THREE.Shape(pts);
  };
  const floorGeo = new THREE.ShapeGeometry(shapeOf(plan.outline)).rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, MAT.floor);
  floor.position.y = Y + 0.001;
  group.add(floor);
  for (const r of plan.rooms || []) {
    if (!r.wet) continue;
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(r.poly)).rotateX(-Math.PI / 2), MAT.wet);
    m.position.y = Y + 0.004;
    group.add(m);
  }
  const ceil = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(plan.outline)).rotateX(-Math.PI / 2), MAT.ceil);
  ceil.position.y = Y + H;
  group.add(ceil);

  // 壁と開口
  for (const w of plan.walls) {
    const t = w.thickness ?? 0.12;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const ops = (w.openings || []).map((o) => ({ ...o, s: o.at - o.width / 2, e: o.at + o.width / 2 })).sort((x, y) => x.s - y.s);
    let cur = 0;
    const solid = [];
    for (const o of ops) {
      if (o.s > cur) solid.push([cur, o.s]);
      const head = Math.min(H, o.head ?? (o.type === 'window' ? 2.0 : 2.0));
      const sill = o.type === 'window' ? (o.sill ?? 0.9) : 0;
      const top = boxBetween(o.s, o.e, w.a, w.b, t, Y + head, Y + H, toWorld, MAT.wall);
      if (top) group.add(top);
      if (o.type === 'window') {
        const low = boxBetween(o.s, o.e, w.a, w.b, t, Y, Y + sill, toWorld, MAT.wall);
        if (low) group.add(low);
        const glass = boxBetween(o.s, o.e, w.a, w.b, 0.02, Y + sill, Y + head, toWorld, MAT.glass);
        if (glass) { glass.renderOrder = 3; group.add(glass); }
        solid.push([o.s, o.e]); // 窓は通れない
      }
      cur = Math.max(cur, o.e);
    }
    if (cur < L) solid.push([cur, L]);
    for (const [s, e] of solid) {
      const isWin = ops.some((o) => o.type === 'window' && Math.abs(o.s - s) < 1e-6 && Math.abs(o.e - e) < 1e-6);
      if (!isWin) {
        const m = boxBetween(s, e, w.a, w.b, t, Y, Y + H, toWorld, MAT.wall);
        if (m) group.add(m);
      }
      const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
      const A = toWorld(w.a[0] + ux * s, w.a[1] + uy * s), B = toWorld(w.a[0] + ux * e, w.a[1] + uy * e);
      walls.push({ ax: A[0], az: A[1], bx: B[0], bz: B[1], half: t / 2 });
    }
  }

  // 水回り・家具（直方体）
  const furnitureGroup = new THREE.Group();
  const addBox = (f, mat, target, solid) => {
    const c = toWorld(f.x, f.y);
    const m = new THREE.Mesh(new THREE.BoxGeometry(f.w, f.h ?? 0.8, f.d), mat);
    const rot = Math.atan2(pl.t[1], pl.t[0]);
    m.position.set(c[0], Y + (f.h ?? 0.8) / 2, c[1]);
    m.rotation.y = -rot - ((f.rot || 0) * Math.PI) / 180;
    target.add(m);
    if (solid) {
      m.updateMatrix();
      const hw = f.w / 2, hd = f.d / 2;
      const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => new THREE.Vector3(x, 0, z).applyMatrix4(m.matrix));
      for (let i = 0; i < 4; i++) {
        const p = corners[i], q = corners[(i + 1) % 4];
        walls.push({ ax: p.x, az: p.z, bx: q.x, bz: q.z, half: 0.02, furniture: target === furnitureGroup });
      }
    }
    if (f.label) {
      const s = textSprite(f.label);
      s.position.set(c[0], Y + (f.h ?? 0.8) + 0.25, c[1]);
      target.add(s);
    }
  };
  for (const f of plan.fixtures || []) addBox(f, MAT.fixture, group, f.solid !== false);
  for (const f of plan.furniture || []) addBox(f, MAT.furniture, furnitureGroup, f.solid !== false);
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
  const sp = plan.spawn?.at ? toWorld(plan.spawn.at[0], plan.spawn.at[1]) : toWorld(W / 2, 1.5);
  const spawnYaw = plan.spawn?.yawDeg !== undefined ? yawFromLocal(pl, plan.spawn.yawDeg) : yawLookingOut(pl);
  const entrance = plan.entrance ? toWorld(plan.entrance[0], plan.entrance[1]) : null;
  return { group, nav, spawn: { x: sp[0], z: sp[1], yaw: spawnYaw }, entrance, floorY: Y, setFurniture, toWorld };
}

// 室内ローカルの向き（度、0=窓側、90=u+方向）→ カメラの yaw
function yawFromLocal(pl, deg) {
  const r = (deg * Math.PI) / 180;
  const dx = pl.nOut[0] * Math.cos(r) + pl.t[0] * Math.sin(r);
  const dz = pl.nOut[1] * Math.cos(r) + pl.t[1] * Math.sin(r);
  return Math.atan2(-dx, -dz);
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
