// 屋外の3D表示（建築模型風）：地面・道路・建物・対象建物・施設マーカー
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WALK_RADIUS, DATA_RADIUS } from '../config.js';
import { ringArea } from '../geo.js';

export const COLORS = {
  sky: 0xdfe6ea,
  ground: 0xd9d5c9,
  road: 0xf7f6f1,
  building: 0xf2f1ee,
  buildingOsm: 0xe4e2dc,
  edge: 0x8a8f94,
  target: 0xe8874a,
  route: 0x2f7fd0,
  conv: '#2e8b57',
  super: '#c2602b',
  station: '#2f6db5',
};

function shapeFromRings(rings) {
  // 3D の z（南）を Shape の y にする（後で X 軸 -90° 回転で地面に寝かせる → y が -z になるため符号反転）
  const toV = (p) => new THREE.Vector2(p[0], -p[1]);
  const outer = rings[0].slice();
  const pts = outer.map(toV);
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const shape = new THREE.Shape(pts);
  for (const h of rings.slice(1)) {
    const hp = h.map(toV);
    if (!THREE.ShapeUtils.isClockWise(hp)) hp.reverse();
    shape.holes.push(new THREE.Path(hp));
  }
  return shape;
}

function prismGeometry(rings, h, base = 0) {
  const g = new THREE.ExtrudeGeometry(shapeFromRings(rings), { depth: h, bevelEnabled: false, steps: 1 });
  g.rotateX(-Math.PI / 2); // 押し出し方向(+z) → 上(+y)、shape の y → -z
  g.translate(0, base, 0);
  return g;
}

export function buildCity(scene, data) {
  const group = new THREE.Group();
  scene.add(group);

  // 地面（地形は簡略化：平坦）
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(DATA_RADIUS * 1.6, 64).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: COLORS.ground })
  );
  ground.position.y = -0.02;
  group.add(ground);

  // 道路（歩行可能範囲＝推定幅の帯）
  const roadGeoms = [];
  for (const w of data.walk) {
    for (let i = 0; i < w.pts.length - 1; i++) {
      const [ax, az] = w.pts[i], [bx, bz] = w.pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const g = new THREE.PlaneGeometry(len, w.half * 2).rotateX(-Math.PI / 2);
      g.rotateY(-Math.atan2(bz - az, bx - ax));
      g.translate((ax + bx) / 2, 0, (az + bz) / 2);
      roadGeoms.push(g);
    }
    for (const p of w.pts) roadGeoms.push(new THREE.CircleGeometry(w.half, 8).rotateX(-Math.PI / 2).translate(p[0], 0, p[1]));
  }
  if (roadGeoms.length) {
    const roads = new THREE.Mesh(
      mergeGeometries(roadGeoms.map((g) => (g.index ? g.toNonIndexed() : g))),
      new THREE.MeshLambertMaterial({ color: COLORS.road, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
    );
    roads.position.y = 0.01;
    group.add(roads);
  }

  // 範囲の境界（円）
  const ringGeo = new THREE.RingGeometry(WALK_RADIUS - 0.6, WALK_RADIUS + 0.6, 180).rotateX(-Math.PI / 2);
  const boundary = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xc0392b, transparent: true, opacity: 0.45 }));
  boundary.position.y = 0.05;
  group.add(boundary);

  // 建物：すべて結合して1つのメッシュにする（描画負荷を抑える）
  const plateauGeoms = [], osmGeoms = [];
  for (const b of data.buildings) {
    if (!b.rings?.[0] || b.rings[0].length < 3 || Math.abs(ringArea(b.rings[0])) < 1) continue;
    try {
      const g = prismGeometry(b.rings, Math.max(b.h, 2));
      (b.src === 'plateau' ? plateauGeoms : osmGeoms).push(g.index ? g.toNonIndexed() : g);
    } catch { /* 不正形状は除外 */ }
  }
  const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.55 });
  const edgesGroup = new THREE.Group();
  const addMerged = (geoms, color) => {
    if (!geoms.length) return null;
    // 大量結合は分割（iPad のバッファ上限対策）
    const meshes = [];
    for (let i = 0; i < geoms.length; i += 800) {
      const merged = mergeGeometries(geoms.slice(i, i + 800), false);
      merged.computeVertexNormals();
      const m = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color }));
      group.add(m);
      meshes.push(m);
      edgesGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30), edgeMat));
    }
    return meshes;
  };
  addMerged(plateauGeoms, COLORS.building);
  addMerged(osmGeoms, COLORS.buildingOsm);
  group.add(edgesGroup);

  // 対象建物（概算モデル）
  let target = null;
  if (data.target) {
    const g = prismGeometry([data.target.ring], data.target.h);
    target = new THREE.Group();
    target.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: COLORS.target })));
    target.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: 0x7a3c16 })));
    // 階の目安線（推定階高）
    group.add(target);
  }

  return { group, target, edgesGroup };
}

// ---- 施設マーカー ----
const CAT_COLOR = { convenience: COLORS.conv, supermarket: COLORS.super, station: COLORS.station };
const CAT_SHORT = { convenience: 'コンビニ', supermarket: 'スーパー', station: '駅' };

function labelTexture(text, cat, dim = false) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = '600 30px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.font = font;
  const tag = CAT_SHORT[cat];
  const tw = ctx.measureText(text).width;
  ctx.font = '600 22px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  const gw = ctx.measureText(tag).width;
  c.width = Math.ceil(gw + tw + 64);
  c.height = 56;
  ctx.fillStyle = dim ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.96)';
  roundRect(ctx, 0, 0, c.width, c.height, 12); ctx.fill();
  ctx.fillStyle = CAT_COLOR[cat];
  roundRect(ctx, 8, 9, gw + 20, 38, 9); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '600 22px -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(tag, 18, 29);
  ctx.fillStyle = dim ? '#6b6f73' : '#22262a';
  ctx.font = font;
  ctx.fillText(text, gw + 40, 30);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: c.width / c.height };
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function buildPoiMarkers(scene, pois) {
  const group = new THREE.Group();
  scene.add(group);
  const items = [];
  for (const p of pois) {
    const g = new THREE.Group();
    g.position.set(p.x, 0, p.z);
    const color = new THREE.Color(CAT_COLOR[p.cat]);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 12, 6).translate(0, 6, 0), new THREE.MeshBasicMaterial({ color }));
    g.add(pole);
    const { tex, aspect } = labelTexture(p.name, p.cat);
    // 手前に見えている部分
    const front = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, sizeAttenuation: false }));
    // 建物に隠れている部分は薄く表示（裏側の施設が目の前にあるように見えないように）
    const behindMat = new THREE.SpriteMaterial({ map: tex, depthTest: true, depthFunc: THREE.GreaterDepth, depthWrite: false, transparent: true, opacity: 0.28, sizeAttenuation: false });
    const behind = new THREE.Sprite(behindMat);
    for (const s of [front, behind]) {
      s.center.set(0.5, 0);
      s.position.y = 12.5;
      s.scale.set(0.05 * aspect, 0.05, 1);
      s.userData.poi = p;
      g.add(s);
    }
    behind.renderOrder = 2;
    group.add(g);
    items.push({ poi: p, obj: g, front, behind, aspect });
  }
  return { group, items };
}

export function buildRouteLine(scene) {
  const mat = new THREE.MeshBasicMaterial({ color: COLORS.route, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.position.y = 0.04;
  mesh.visible = false;
  scene.add(mesh);
  return {
    mesh,
    set(path) {
      if (!path || path.length < 2) { mesh.visible = false; return; }
      const geoms = [];
      for (let i = 0; i < path.length - 1; i++) {
        const [ax, az] = path[i], [bx, bz] = path[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.01) continue;
        geoms.push(new THREE.PlaneGeometry(len, 0.9).rotateX(-Math.PI / 2).rotateY(-Math.atan2(bz - az, bx - ax)).translate((ax + bx) / 2, 0, (az + bz) / 2).toNonIndexed());
      }
      mesh.geometry.dispose();
      mesh.geometry = geoms.length ? mergeGeometries(geoms) : new THREE.BufferGeometry();
      mesh.visible = geoms.length > 0;
    },
  };
}
