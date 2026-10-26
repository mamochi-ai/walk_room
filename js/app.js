// アプリ本体：モード（窓からの眺め／室内／屋外）、描画ループ、UI の結線
import * as THREE from 'three';
import {
  SOURCES, WALK_RADIUS, DATA_RADIUS, EYE_HEIGHT_DEFAULT, WALK_SPEED_DEFAULT, OUTDOOR_SPEED_DEFAULT, PLAYER_RADIUS,
  WALK_M_PER_MIN, TARGET_ESTIMATE, GEOCODERS,
} from './config.js';
import { loadArea, clearAreaCache, fetchFresh } from './data/loader.js';
import { CAT_LABEL } from './data/osm.js';
import { OutdoorNav, moveWithCollision } from './nav.js';
import { buildCity, buildPoiMarkers, buildRouteLine, COLORS } from './world/city.js';
import { computePlacement, buildInterior, yawLookingOut, BEARINGS, bearingLabel } from './world/interior.js';
import { Controls } from './ui/controls.js';
import { Minimap } from './ui/minimap.js';
import { closestOnSeg, fmtMeters, ringCentroid, LocalFrame } from './geo.js';
import { INFO_FIELDS, SOURCE_LABEL, fmtValue } from './plan/format.js';
import { putProject } from './store.js';
import { displayName, planOf, resolveFacing, migrateLegacy } from './project.js';
import { initWizard, showHome, openProject } from './ui/wizard.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- 設定（端末内に保存。保存できなくても動作する） ----
const SETTINGS_KEY = 'walk-room-settings-v2';
const defaults = {
  eye: EYE_HEIGHT_DEFAULT, speedIn: WALK_SPEED_DEFAULT, speedOut: OUTDOOR_SPEED_DEFAULT, view: 'eye',
  quality: 'normal', furniture: true, edges: true,
};
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* noop */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* noop */ } };

// ---- 状態 ----
const state = {
  mode: 'loading', // 'window' | 'indoor' | 'outdoor'
  pos: { x: 0, z: 0 }, yaw: 0, pitch: 0,
  project: null, data: null, nav: null, plan: null, placement: null, interior: null, facing: null,
  entrance: null, // {x,z,yaw,status:'osm'|'provisional'}
  filter: 'all', dest: null, route: null, routeFrom: null,
  lastBlockMsg: 0,
};

// ---- WebGL ----
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

let renderer, scene, camera, city, poiMarkers, routeLine, controls, minimap, avatar;

function initRenderer() {
  const canvas = $('view');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  applyQuality();
  renderer.setClearColor(COLORS.sky);
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(COLORS.sky, 350, 1150);
  camera = new THREE.PerspectiveCamera(70, 1, 0.05, 1600);
  camera.rotation.order = 'YXZ';
  // 模型のように影の少ない明るい照明
  scene.add(new THREE.HemisphereLight(0xffffff, 0xcfc8b8, 1.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(-0.5, 1, 0.35);
  scene.add(sun);
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('3D表示が一時停止しました。ページを再読み込みしてください。', 6000); });
}
function applyQuality() {
  const q = { low: 1, normal: 1.5, high: 2 }[settings.quality] || 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q));
}
// 横方向の視野角を約80°に保つ（縦画面で視野が狭いと、建物が実際より大きく迫って見えるため）
function fovFor(aspect) {
  const h = (80 * Math.PI) / 180;
  const v = (2 * Math.atan(Math.tan(h / 2) / aspect) * 180) / Math.PI;
  return Math.max(50, Math.min(90, v));
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = fovFor(w / h);
  camera.updateProjectionMatrix();
}

// ---- UI 補助 ----
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function fade(fn) {
  const f = $('fade');
  f.classList.add('on');
  setTimeout(() => { fn(); requestAnimationFrame(() => f.classList.remove('on')); }, 260);
}

// ---- 物件を開いて歩く ----
let abortCtl = null;
function emptyData(origin, note) {
  return {
    version: 2, origin, fetchedAt: null, walk: [], buildings: [], pois: [], target: null, excludedAtTarget: [],
    sources: { osm: { ok: false }, plateau: { ok: false } }, notes: note ? [note] : [], loadedFrom: 'none',
    frame: new LocalFrame(origin.lat, origin.lon),
  };
}

async function openWalk(project) {
  state.project = project;
  state.mode = 'loading';
  state.dest = null;
  for (const id of ['topbar', 'notices', 'minimap', 'bottombar']) $(id).hidden = true;
  $('start').hidden = false;
  $('start-title').textContent = displayName(project);
  $('btn-start').disabled = true;
  $('btn-skip').hidden = true;
  $('load-error').hidden = true;
  $('load-status').hidden = false;
  $('load-status').classList.remove('done');
  const loc = project.location?.confirmed && project.location.forAddress === project.info?.address?.value ? project.location : null;
  const plan = planOf(project);
  if (!loc) {
    setupWorld(emptyData({ lat: 0, lon: 0 }, '物件の位置が確定していないため、周辺の街は表示していません。'), plan);
    $('load-text').textContent = plan ? '位置が未確定のため、室内だけを表示します' : '間取りも位置もまだありません';
    $('load-status').classList.add('done');
    $('btn-start').disabled = !plan;
    return;
  }
  abortCtl?.abort();
  abortCtl = new AbortController();
  $('load-text').textContent = '周辺データを準備中…';
  if (plan) $('btn-skip').hidden = false;
  try {
    const data = await loadArea({ lat: loc.lat, lon: loc.lon }, project.info, { signal: abortCtl.signal, onProgress: (m) => ($('load-text').textContent = m) });
    if (state.project !== project) return;
    setupWorld(data, plan);
    const from = { bundled: '同梱データ', cache: '端末に保存済みのデータ', fresh: '公開データから取得' }[data.loadedFrom];
    $('load-text').textContent = `準備完了（${from}・取得日 ${data.fetchedAt.slice(0, 10)}）`;
    $('load-status').classList.add('done');
    $('btn-start').disabled = false;
    $('btn-skip').hidden = true;
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    $('load-status').hidden = true;
    $('load-error').hidden = false;
    $('load-error-text').textContent = (e.message || 'データを取得できませんでした。') + ' 通信状況を確認して再試行してください。' + (plan ? '室内だけ先に見ることもできます。' : '');
    $('load-error-detail').textContent = [e.cause?.message, ...(e.details || [])].filter(Boolean).join('\n') || String(e);
    setupWorld(emptyData({ lat: loc.lat, lon: loc.lon }, '周辺データを取得できなかったため、街は表示していません。'), plan);
    $('btn-start').disabled = !plan;
  }
}

function setupWorld(data, plan) {
  // 再読み込み時は作り直す
  if (city) { scene.remove(city.group); scene.remove(city.target); scene.remove(poiMarkers.group); scene.remove(routeLine.mesh); }
  if (state.interior) { scene.remove(state.interior.group); state.interior = null; }
  state.data = data;
  state.frame = data.frame;
  state.nav = new OutdoorNav(data);
  city = buildCity(scene, data);
  city.edgesGroup.visible = settings.edges;
  poiMarkers = buildPoiMarkers(scene, data.pois);
  routeLine = buildRouteLine(scene);
  if (!avatar) avatar = buildAvatar();
  minimap = new Minimap($('minimap'), data);
  state.plan = plan;
  state.entrance = data.walk.length ? computeEntrance() : null;
  rebuildPlacement();
  applyFilter();
}

// 俯瞰視点で現在地を示す人型（身長1.7m。周囲の建物の大きさの目安）
function buildAvatar() {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0x2f6fae });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.4, 12).translate(0, 0.7, 0), mat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8).translate(0, 1.55, 0), mat);
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.4, 3.2, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2f6fae, transparent: true, opacity: 0.6 }));
  ring.position.y = 0.06;
  g.add(body, head, ring);
  g.visible = false;
  scene.add(g);
  return g;
}

// 建物入口：OSM の entrance ノードがあれば使う。なければ道路側の仮位置。
function computeEntrance() {
  const { data, nav } = state;
  // 1) 利用者が地図で置いた入口ピン 2) OSM の入口ノード 3) 建物に最も近い道路上の仮位置
  const ue = state.project?.entrance;
  let from = null, status = 'provisional';
  if (ue) {
    const q = state.frame.toXZ(ue.lat, ue.lon);
    from = { x: q.x, z: q.z };
    status = 'user';
  } else if (data.target?.entrances?.length) {
    from = data.target.entrances.find((e) => e.kind === 'main') || data.target.entrances[0];
    status = 'osm';
  }
  const ring = data.target ? data.target.ring : [[0, 0], [0.01, 0], [0, 0.01]];
  const [cx, cz] = data.target ? ringCentroid(ring) : [0, 0];
  let best = null;
  if (from) {
    best = nav.nearestOnRoad(from.x, from.z, 200);
  } else {
    // 建物外周に最も近い道路上の点
    for (const s of nav.segGrid.query(cx, cz, 160)) {
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const c = closestOnSeg(p[0], p[1], s.ax, s.az, s.bx, s.bz);
        if (!best || c.d < best.d) best = { ...c, seg: s, ref: p };
      }
    }
  }
  if (!best) return null;
  // 埋まらない位置を探す（線分に沿って少しずつずらす）
  let pt = { x: best.x, z: best.z };
  if (state.nav.blockReason(pt.x, pt.z, PLAYER_RADIUS + 0.1)) {
    const s = best.seg;
    const L = Math.hypot(s.bx - s.ax, s.bz - s.az);
    for (let k = 1; k < 80; k++) {
      const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
      const t = Math.min(1, Math.max(0, best.t + off / L));
      const q = { x: s.ax + (s.bx - s.ax) * t, z: s.az + (s.bz - s.az) * t };
      if (!state.nav.blockReason(q.x, q.z, PLAYER_RADIUS + 0.1)) { pt = q; break; }
    }
  }
  // 建物を背にして道路側を向く
  const bx = from ? from.x : cx, bz = from ? from.z : cz;
  return { x: pt.x, z: pt.z, yaw: Math.atan2(-(pt.x - bx), -(pt.z - bz)), status };
}

function rebuildPlacement() {
  if (state.interior) { scene.remove(state.interior.group); state.interior = null; }
  const p = state.project;
  state.facing = resolveFacing(p, state.plan);
  state.placement = computePlacement(state.data.target ? state.data.target.ring : null, {
    bearing: state.facing.bearing, along: p.placement?.along ?? 0.5, floor: p.info?.floor?.value, storyHeight: p.placement?.storyHeight,
  });
  if (state.plan) {
    state.interior = buildInterior(scene, state.plan, state.placement);
    state.interior.setFurniture(settings.furniture);
    state.interior.group.visible = false;
  }
}

// ---- モード切り替え ----
function enterRoom() {
  if (state.interior) {
    state.mode = 'indoor';
    state.interior.group.visible = true;
    state.pos = { x: state.interior.spawn.x, z: state.interior.spawn.z };
    state.yaw = state.interior.spawn.yaw;
  } else {
    // 間取り図が未取得：推定した高さ・外壁から外を眺めるだけ（室内は作らない）
    state.mode = 'window';
    const pl = state.placement;
    state.pos = { x: pl.center[0] + pl.nIn[0] * 0.6, z: pl.center[1] + pl.nIn[1] * 0.6 };
    state.yaw = yawLookingOut(pl);
  }
  state.pitch = 0;
  if (city.target) city.target.visible = false;
  updateModeUi();
}

function enterOutdoor() {
  if (!state.entrance) {
    toast('周辺の道路データが無いため、屋外には出られません。', 4000);
    return;
  }
  state.mode = 'outdoor';
  if (state.interior) state.interior.group.visible = false;
  if (city.target) city.target.visible = true;
  state.pos = { x: state.entrance.x, z: state.entrance.z };
  state.yaw = state.entrance.yaw;
  state.pitch = 0;
  state.routeFrom = null;
  updateModeUi();
  if (state.entrance.status === 'provisional') toast('建物入口の位置は未確認のため、道路側の仮位置に出ました。', 4000);
  else if (state.entrance.status === 'user') toast('地図で指定した建物入口の近くの道路に出ました。', 3000);
}

function resetPosition() {
  if (state.mode === 'outdoor') enterOutdoor();
  else enterRoom();
  toast('位置をリセットしました');
}

function floorY() {
  if (state.mode === 'indoor') return state.interior.floorY;
  if (state.mode === 'window') return state.placement.floorY;
  return 0;
}

function updateModeUi() {
  const m = state.mode;
  $('mode-chip').textContent = { outdoor: '屋外', indoor: '室内', window: '窓から見る' }[m] || '';
  $('btn-room').hidden = m !== 'outdoor';
  $('btn-action').hidden = m === 'outdoor' || !state.entrance;
  $('btn-action').textContent = '建物の外へ';
  $('btn-plan').hidden = m !== 'window';
  $('btn-reset').hidden = m === 'window';
  $('btn-view').hidden = m !== 'outdoor';
  $('btn-view').textContent = settings.view === 'bird' ? '目線に戻す' : '俯瞰で見る';
  const bird = m === 'outdoor' && settings.view === 'bird';
  avatar.visible = bird;
  // 俯瞰では対象建物を半透明にして、手前で視界を遮らないようにする
  city.target?.traverse((o) => { if (o.material) { o.material.transparent = bird; o.material.opacity = bird ? 0.45 : 1; o.material.depthWrite = !bird; o.material.needsUpdate = true; } });
  updateNotices();
  updateDestHud(true);
}

function updateNotices() {
  const m = state.mode, d = state.data;
  const chips = [];
  if (m === 'outdoor') {
    chips.push(['地形は簡略化（平坦）', 'est']);
    if (d.target && d.target.hStatus !== 'plateau') chips.push(['対象建物の高さは推定', 'est']);
    if (state.entrance && state.entrance.status === 'provisional') chips.push(['建物入口は仮位置', 'est']);
    if (!d.sources.plateau.ok) chips.push([d.sources.plateau.outOfArea ? 'PLATEAU対象外・建物高さ推定' : '建物はOSM外形・高さ推定', 'miss']);
  } else {
    chips.push(['住戸の位置・向きは仮配置', 'est']);
    if (!state.placement.floorKnown) chips.push(['所在階が不明（1階として表示）', 'miss']);
    if (m === 'window') chips.push(['間取り未取り込み', 'miss']);
    if (m === 'indoor') chips.push(['間取りはClaude読み取り（寸法推定）', 'est']);
    if (!d.walk.length && !d.buildings.length) chips.push(['周辺の街は未表示', 'miss']);
  }
  $('notices').innerHTML = chips.map(([t, c]) => `<span class="chip ${c}">${esc(t)}</span>`).join('');
}

// ---- 目的地・経路 ----
function setDest(poi) {
  state.dest = poi;
  state.route = null;
  state.routeFrom = null;
  updateRoute(true);
  updateDestHud(true);
}

function routeStart() {
  return state.mode === 'outdoor' || !state.entrance ? state.pos : state.entrance;
}
function entranceLabel() {
  return { user: '建物入口（地図で指定）', osm: '建物入口', provisional: '建物入口（仮位置）' }[state.entrance?.status] || '建物入口';
}
function destPoint(p) {
  if (p.entrances && p.entrances.length) {
    const s = routeStart();
    return p.entrances.reduce((a, b) => (Math.hypot(a.x - s.x, a.z - s.z) <= Math.hypot(b.x - s.x, b.z - s.z) ? a : b));
  }
  return p;
}
function updateRoute(force = false) {
  if (!state.dest) { routeLine.set(null); state.route = null; return; }
  const s = routeStart();
  if (!force && state.routeFrom && Math.hypot(state.routeFrom.x - s.x, state.routeFrom.z - s.z) < 6) return;
  state.routeFrom = { x: s.x, z: s.z };
  const r = state.nav.route(s, destPoint(state.dest));
  state.route = r;
  routeLine.set(r && r.reliable ? r.path : null);
}

function updateDestHud(textToo = false) {
  const hud = $('dest-hud');
  if (!state.dest) { hud.hidden = true; return; }
  hud.hidden = false;
  const p = state.dest;
  const dx = p.x - state.pos.x, dz = p.z - state.pos.z;
  const targetYaw = Math.atan2(-dx, -dz);
  const rel = targetYaw - state.yaw;
  $('dest-arrow').style.transform = `rotate(${-rel}rad)`;
  if (textToo || !updateDestHud.t || performance.now() - updateDestHud.t > 250) {
    updateDestHud.t = performance.now();
    $('dest-name').textContent = p.name;
    $('dest-straight').textContent = `直線距離 ${fmtMeters(Math.hypot(dx, dz))}（現在地から）`;
    const r = state.route;
    const fromLabel = state.mode === 'outdoor' ? '現在地から' : `${entranceLabel()}から`;
    if (r && r.reliable) {
      $('dest-walk').textContent = `徒歩 ${fmtMeters(r.dist)}・約${Math.max(1, Math.ceil(r.dist / WALK_M_PER_MIN))}分（${fromLabel}・道路経路）`;
    } else {
      $('dest-walk').textContent = '徒歩経路：道路網で計算できないため表示しません';
    }
  }
}

// ---- 施設の表示切り替え ----
function applyFilter() {
  for (const it of poiMarkers.items) it.obj.visible = state.filter === 'all' || it.poi.cat === state.filter;
}
function visiblePois() {
  return state.data.pois.filter((p) => state.filter === 'all' || p.cat === state.filter);
}

// ---- パネル ----
function openPanel(title, html, onMount) {
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  $('panel').hidden = false;
  controls.stopAll();
  onMount?.($('panel-body'));
}
function closePanel() { $('panel').hidden = true; }

function showPoiList() {
  const pois = visiblePois().map((p) => ({ p, d: Math.hypot(p.x - state.pos.x, p.z - state.pos.z) })).sort((a, b) => a.d - b.d);
  const f = state.filter;
  const btn = (k, l) => `<button type="button" data-f="${k}" aria-pressed="${f === k}">${l}</button>`;
  const html = `
    <div class="filters">${btn('all', 'すべて')}${btn('convenience', 'コンビニ')}${btn('supermarket', 'スーパー')}${btn('station', '駅')}</div>
    <p class="note">距離は現在地からの直線距離です。タップで詳細・目的地設定。</p>
    ${pois.length ? `<ul class="poi-list">${pois.map(({ p, d }) => `<li><button type="button" data-id="${esc(p.id)}"><span class="cat ${p.cat}">${CAT_LABEL[p.cat]}</span><span class="nm">${esc(p.name)}</span><span class="dist">直線 ${fmtMeters(d)}</span></button></li>`).join('')}</ul>` : '<p>この範囲のデータに該当する施設はありません。</p>'}
    <p class="note">OpenStreetMap に未登録の店舗は表示されません。店舗公式情報で確認した施設は data/poi-supplements.json に追加できます。</p>`;
  openPanel('コンビニ・スーパー・駅', html, (el) => {
    el.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { state.filter = b.dataset.f; applyFilter(); showPoiList(); }));
    el.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => showPoi(state.data.pois.find((p) => p.id === b.dataset.id))));
  });
}

function showPoi(p) {
  if (!p) return;
  const d = Math.hypot(p.x - state.pos.x, p.z - state.pos.z);
  const isDest = state.dest?.id === p.id;
  // 建物入口からの道路経路
  const r = state.entrance ? state.nav.route(state.entrance, destPoint(p)) : null;
  const walk = r && r.reliable
    ? `${fmtMeters(r.dist)}・約${Math.max(1, Math.ceil(r.dist / WALK_M_PER_MIN))}分 <span class="note">（${entranceLabel()}から道路経路、${WALK_M_PER_MIN}m/分で換算。信号待ちは含まず）</span>`
    : '<span class="note">道路網で経路を計算できないため表示しません</span>';
  const ents = p.entrances?.length
    ? p.entrances.map((e) => esc(e.label)).join('、') + ' <span class="note">（OSMの入口ノード）</span>'
    : '<span class="warn">入口位置未確認</span> <span class="note">（施設の中心位置を表示）</span>';
  const hours = p.hours ? `${esc(p.hours)} <span class="note">（${p.source === 'supplement' ? '補足情報' : 'OSM登録値'}）</span>` : '<span class="note">未取得</span>';
  const src = p.source === 'supplement'
    ? `${esc(p.sourceTitle || '店舗公式情報')} ${p.checked ? `（確認日 ${esc(p.checked)}）` : ''}<br><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${esc(p.sourceUrl)}</a>`
    : `OpenStreetMap <a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener">${esc(p.id)}</a>`;
  const html = `
    <p><span class="cat ${p.cat}">${CAT_LABEL[p.cat]}</span></p>
    <dl class="kv">
      <dt>直線距離</dt><dd>${fmtMeters(d)}（現在地から）</dd>
      <dt>徒歩</dt><dd>${walk}</dd>
      <dt>営業時間</dt><dd>${hours}</dd>
      <dt>入口</dt><dd>${ents}</dd>
      <dt>中心座標</dt><dd>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</dd>
      <dt>情報源</dt><dd>${src}</dd>
    </dl>
    <div class="row">
      <button type="button" id="poi-dest" class="primary">${isDest ? '目的地を解除' : '目的地に設定'}</button>
      <button type="button" id="poi-back">一覧へ</button>
    </div>`;
  openPanel(p.name, html, (el) => {
    el.querySelector('#poi-dest').addEventListener('click', () => { setDest(isDest ? null : p); closePanel(); if (!isDest) toast(`目的地：${p.name}`); });
    el.querySelector('#poi-back').addEventListener('click', showPoiList);
  });
}

// 手順画面へ戻る
function backToWizard(step) {
  closePanel();
  controls.stopAll();
  state.mode = 'loading';
  for (const id of ['topbar', 'notices', 'minimap', 'bottombar', 'dest-hud']) $(id).hidden = true;
  if (step === 'home') showHome(); else openProject(state.project.id, step);
}

const STATUS = { confirmed: ['確認済', 'ok'], estimated: ['推定', 'est'], missing: ['未取得', 'miss'] };
function showData() {
  const d = state.data, p = state.project;
  const pl = d.sources.plateau;
  const fact = (label, value, st, src) => `<li><span class="chip ${STATUS[st][1]}">${STATUS[st][0]}</span><div><strong>${esc(label)}</strong>：${esc(value)}${src ? `<small>${esc(src)}</small>` : ''}</div></li>`;
  const infoCls = { image: 'ok', user: 'ok', listing: 'ok', estimated: 'est' };
  const info = INFO_FIELDS.map(([k, label]) => {
    const f = p.info?.[k] || {};
    const has = f.value != null && f.value !== '';
    const src = has ? f.source || 'estimated' : null;
    return `<li><span class="chip ${infoCls[src] || 'miss'}">${SOURCE_LABEL[src] || SOURCE_LABEL.null}</span><div><strong>${label}</strong>：${has ? esc(fmtValue(k, f.value)) : '—'}${f.evidence ? `<small>${esc(f.evidence)}</small>` : ''}</div></li>`;
  });
  const loc = p.location;
  const ex = d.excludedAtTarget || [];
  const t = d.target;
  const tH = !t ? null : t.hStatus === 'plateau' ? `約${t.h.toFixed(1)}m（PLATEAU の実データ）` : t.hStatus === 'osm-height' ? `約${t.h.toFixed(1)}m（OSM の height タグ）` : t.hStatus === 'estimated' ? `約${t.h.toFixed(1)}m（${t.floors}階×階高${TARGET_ESTIMATE.storyHeight}m などの概算）` : `${t.h}m（階数不明のため仮置き）`;
  const html = `
    <h3>物件情報</h3>
    <ul class="facts">${info.join('')}</ul>
    <h3>位置と配置</h3>
    <ul class="facts">
      ${loc?.confirmed ? fact('物件の位置', `${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}（${loc.label || ''}）`, 'confirmed', `${loc.provider === 'manual' ? '地図で指定' : loc.provider === 'preset' ? 'サンプルの既定値' : (GEOCODERS[loc.provider]?.label || '') + 'の候補から選択'}・${loc.precision?.label || ''}`) : fact('物件の位置', '未確定', 'missing')}
      ${fact('建物入口', { user: '地図で指定した位置の近くの道路', osm: 'OSM の入口ノード付近の道路', provisional: '未確認（建物に最も近い道路上の仮位置）' }[state.entrance?.status] || '道路データなし', state.entrance?.status === 'provisional' || !state.entrance ? 'estimated' : 'confirmed')}
      ${fact('住戸の向き', `${bearingLabel(state.facing.bearing)}向きとして配置（${state.facing.basis}）`, state.facing.status === 'image' || state.facing.status === 'user' ? 'confirmed' : 'estimated')}
      ${fact('住戸の建物内の位置・高さ', `仮配置：外壁上の${Math.round((p.placement?.along ?? 0.5) * 100)}%、${state.placement.floorKnown ? `${p.info.floor.value}階` : '所在階不明（1階）'}・階高${(p.placement?.storyHeight ?? 3).toFixed(2)}m（推定）`, 'estimated')}
    </ul>
    <h3>周辺データ</h3>
    <ul class="facts">
      ${d.fetchedAt ? fact('読み込み元', { bundled: '同梱データ', cache: '端末内に保存したデータ', fresh: '公開データから取得' }[d.loadedFrom] + `（取得日時 ${d.fetchedAt.replace('T', ' ').slice(0, 16)} UTC・半径約${DATA_RADIUS}m）`, 'confirmed') : fact('周辺データ', '未取得', 'missing')}
      ${d.fetchedAt ? (pl.ok ? fact('建物の形状・高さ', `PLATEAU LOD1：${pl.count}棟（${(pl.datasets || []).join('、') || '自治体名不明'}）`, 'confirmed', pl.tilesetUrl)
        : fact('建物の形状・高さ', pl.outOfArea ? 'この地点は PLATEAU の整備範囲外。OSM の建物外形で代用（高さは階数×3m などの推定、不明なら7m）' : `PLATEAU を取得できませんでした（${pl.error || '原因不明'}）。OSM の建物外形で代用（高さは推定）`, 'missing', (pl.details || []).join(' / '))) : ''}
      ${t ? fact('対象建物の外形', t.footprintSource === 'PLATEAU' ? 'PLATEAU（物件位置を含む建物）' : `OpenStreetMap way ${t.osmId}${t.containsPin ? '' : '（物件位置の近くの建物）'}`, t.containsPin === false ? 'estimated' : 'confirmed') : fact('対象建物の外形', 'なし（物件位置に住戸を仮配置）', 'missing')}
      ${t ? fact('対象建物の高さ', tH, t.hStatus === 'plateau' ? 'confirmed' : 'estimated') : ''}
      ${ex.length ? fact('対象敷地に重なる既存データ', `${ex.length}件を非表示（${ex.map((e) => `${e.src} 高さ${e.h}m・${e.area}㎡`).join('、')}）。建て替え前の形状などの可能性があるため`, 'estimated') : ''}
      ${d.fetchedAt ? fact('道路・歩道', `OSM の歩行可能な道路 ${d.walk.length}本。私道・通行制限のある道は除外。道路の幅は種別から推定`, 'estimated') : ''}
      ${d.fetchedAt ? fact('施設', `OSM のコンビニ・スーパー・駅 ${d.pois.length}件（駅は半径1.5kmまで）`, 'confirmed') : ''}
      ${fact('地形', '高低差は反映せず平坦として表示（地形は簡略化）', 'estimated')}
    </ul>
    ${(d.notes || []).map((n) => `<p class="warn">${esc(n)}</p>`).join('')}
    <h3>出典</h3>
    <p>${esc(SOURCES.plateau.attribution)}<br><a href="${SOURCES.plateau.url}" target="_blank" rel="noopener">${SOURCES.plateau.url}</a></p>
    <p>道路・店舗・駅・建物外形：${esc(SOURCES.overpass.attribution)}<br><a href="${SOURCES.overpass.url}" target="_blank" rel="noopener">${SOURCES.overpass.url}</a></p>
    <p>位置確認の地図：地理院タイル（国土地理院）<br><a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">https://maps.gsi.go.jp/development/ichiran.html</a></p>
    ${loc?.provider && GEOCODERS[loc.provider] ? `<p>${esc(GEOCODERS[loc.provider].attribution)}</p>` : ''}
    <p class="note">間取り・物件情報は利用者が登録した画像を Claude で読み取った結果です。画像は端末内にだけ保存しています。周辺データは端末内に30日間保存されます。</p>
    ${d.fetchedAt ? '<div class="row"><button type="button" id="btn-refetch">周辺データを再取得</button></div>' : ''}`;
  openPanel('データと出典', html, (el) => {
    el.querySelector('#btn-refetch')?.addEventListener('click', async () => {
      closePanel();
      await clearAreaCache(d.origin);
      openWalk(state.project);
    });
  });
}

function showSettings() {
  const p = state.project;
  const seg = (name, val, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
  const facade = p.placement?.facade ?? 'auto';
  const html = `
    <div class="setting"><label for="s-eye">目線の高さ <output id="o-eye">${settings.eye.toFixed(2)} m</output></label>
      <input id="s-eye" type="range" min="1.0" max="2.0" step="0.05" value="${settings.eye}">
      <span class="note">人の目の高さ（約1.6m）です。街全体の大きさをつかむには屋外の「俯瞰で見る」を使ってください。</span></div>
    <div class="setting"><label for="s-speedOut">屋外の移動速度 <output id="o-speedOut">${settings.speedOut.toFixed(1)} m/秒</output></label>
      <input id="s-speedOut" type="range" min="1" max="12" step="0.5" value="${settings.speedOut}">
      <span class="note">実際の徒歩は約1.3m/秒（80m/分）。徒歩時間の表示は速度に関係なく80m/分で計算します。</span></div>
    <div class="setting"><label for="s-speedIn">室内の移動速度 <output id="o-speedIn">${settings.speedIn.toFixed(1)} m/秒</output></label>
      <input id="s-speedIn" type="range" min="0.5" max="2.5" step="0.1" value="${settings.speedIn}"></div>
    <div class="setting"><label>屋外の視点</label>${seg('view', settings.view, [['eye', '目線（人の高さ）'], ['bird', '俯瞰（上空から）']])}</div>
    <div class="setting"><label>画質（重い場合は「低」）</label>${seg('quality', settings.quality, [['low', '低'], ['normal', '標準'], ['high', '高']])}</div>
    <div class="setting"><label>建物の輪郭線</label>${seg('edges', settings.edges, [[true, '表示'], [false, '非表示']])}</div>
    <div class="setting"><label>家具（解析データにある場合のみ）</label>${seg('furniture', settings.furniture, [[true, '表示'], [false, '非表示']])}</div>
    <h3>住戸の仮配置（${esc(displayName(p))}）</h3>
    <p class="note">住所の緯度経度だけでは、住戸の建物内の位置や窓の向きは決まりません。現在：${bearingLabel(state.facing.bearing)}向き（${esc(state.facing.basis)}）。</p>
    <div class="setting"><label>窓の向き</label>${seg('facade', facade, [['auto', '自動'], ...BEARINGS.map(([b, l]) => [b, l])])}</div>
    <div class="setting"><label for="s-along">外壁上の位置 <output id="o-along">${Math.round((p.placement?.along ?? 0.5) * 100)}%</output></label>
      <input id="s-along" type="range" min="0.05" max="0.95" step="0.01" value="${p.placement?.along ?? 0.5}"></div>
    <div class="setting"><label for="s-story">階高（推定） <output id="o-story">${(p.placement?.storyHeight ?? 3).toFixed(2)} m</output></label>
      <input id="s-story" type="range" min="2.7" max="3.6" step="0.05" value="${p.placement?.storyHeight ?? 3}">
      <span class="note">床の高さ ≒ 1階床${TARGET_ESTIMATE.groundFloorRaise}m＋階高×（所在階−1）。実測値ではありません。</span></div>
    <h3>物件</h3>
    <div class="row"><button type="button" id="s-edit">間取り・物件情報を確認・修正</button><button type="button" id="s-loc">位置を変更</button><button type="button" id="s-home">物件一覧へ</button></div>`;
  openPanel('設定', html, (el) => {
    const replace = () => { const inRoom = state.mode !== 'outdoor'; rebuildPlacement(); if (inRoom) enterRoom(); updateNotices(); putProject(p); };
    const bindRange = (id, fmt, set) => {
      const i = el.querySelector('#s-' + id);
      i.addEventListener('input', () => { const v = parseFloat(i.value); el.querySelector('#o-' + id).textContent = fmt(v); set(v); });
    };
    bindRange('eye', (v) => `${v.toFixed(2)} m`, (v) => { settings.eye = v; saveSettings(); });
    bindRange('speedOut', (v) => `${v.toFixed(1)} m/秒`, (v) => { settings.speedOut = v; saveSettings(); });
    bindRange('speedIn', (v) => `${v.toFixed(1)} m/秒`, (v) => { settings.speedIn = v; saveSettings(); });
    bindRange('along', (v) => `${Math.round(v * 100)}%`, (v) => { p.placement.along = v; replace(); });
    bindRange('story', (v) => `${v.toFixed(2)} m`, (v) => { p.placement.storyHeight = v; replace(); });
    el.querySelectorAll('[data-seg]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = g.dataset.seg;
      let v = b.dataset.v;
      if (v === 'true' || v === 'false') v = v === 'true';
      g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (k === 'facade') { p.placement.facade = v; replace(); showSettings(); return; }
      settings[k] = v;
      saveSettings();
      if (k === 'quality') { applyQuality(); resize(); }
      if (k === 'edges') city.edgesGroup.visible = v;
      if (k === 'furniture') state.interior?.setFurniture(v);
      if (k === 'view') updateModeUi();
    })));
    el.querySelector('#s-edit').addEventListener('click', () => backToWizard('review'));
    el.querySelector('#s-loc').addEventListener('click', () => backToWizard('location'));
    el.querySelector('#s-home').addEventListener('click', () => backToWizard('home'));
  });
}

function showHelp() {
  openPanel('操作説明', `
    <h3>iPad／iPhone</h3>
    <p>画面の<strong>左側</strong>を押したまま動かすと、その場所にスティックが出て移動します。<br>
    画面の<strong>右側</strong>をドラッグすると見回せます。両方を同時に操作できます。<br>
    指を離すと止まります。施設の名札をタップすると詳細を表示します。</p>
    <h3>パソコン</h3>
    <p>W A S D／矢印キーで移動、Q・E で向きを変える、マウスのドラッグで見回し。</p>
    <h3>流れ</h3>
    <p>物件の登録：画像を登録 → 依頼文をコピーして Claude に画像と一緒に渡す → 回答（JSON）を貼り付け → 2D 図と物件情報を確認 → 住所から位置を確定。<br>
    室内 →（玄関に近づくと）「建物の外へ」で建物入口付近の道路へ →「施設」から目的地を選ぶと、方向・直線距離と、道路で経路を計算できた場合だけ徒歩距離を表示します。「部屋へ戻る」でいつでも戻れます。</p>
    <h3>表示について</h3>
    <p>グレーの箱は PLATEAU の建物（位置・外形・高さ）、オレンジは対象建物です（PLATEAU が無い場合は OSM の外形で、高さは推定）。白っぽい帯は歩ける道路（幅は推定）で、道路の外や建物の中には入れません。赤い円の外は範囲外です（中心から${WALK_RADIUS}m）。</p>
    <p>名札が薄く見えるときは、その施設が建物の向こう側にあります。</p>
    <p class="note">ミニマップをタップすると拡大します（拡大中に施設の点をタップすると詳細）。</p>`);
}

// ---- 3D 上のタップ（施設名札） ----
const raycaster = new THREE.Raycaster();
function onTap(x, y) {
  if (!poiMarkers) return;
  const ndc = new THREE.Vector2((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  raycaster.camera = camera;
  const sprites = poiMarkers.items.filter((it) => it.obj.visible).map((it) => it.front);
  const hit = raycaster.intersectObjects(sprites, false)[0];
  if (hit) showPoi(hit.object.userData.poi);
}

// ---- メインループ ----
const clock = new THREE.Clock();
let hintsHidden = false;
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!state.data || state.mode === 'loading') { renderer.render(scene, camera); return; }
  const inp = controls.read();
  // 視点
  state.yaw -= inp.look.x * 0.0045 + inp.turn * 1.6 * dt;
  state.pitch -= inp.look.y * 0.0045;
  state.pitch = Math.max(-1.25, Math.min(1.25, state.pitch));
  // 移動
  if ((inp.x || inp.y) && state.mode !== 'window') {
    if (!hintsHidden) { hintsHidden = true; $('hint-move').classList.add('gone'); $('hint-look').classList.add('gone'); }
    const sp = (state.mode === 'outdoor' ? settings.speedOut : settings.speedIn) * dt;
    const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
    const rx = Math.cos(state.yaw), rz = -Math.sin(state.yaw);
    const dx = (fx * inp.y + rx * inp.x) * sp, dz = (fz * inp.y + rz * inp.x) * sp;
    const nav = state.mode === 'indoor' ? state.interior.nav : state.nav;
    const res = moveWithCollision(nav, state.pos, dx, dz, PLAYER_RADIUS);
    if (res.reason && performance.now() - state.lastBlockMsg > 2500) {
      const msg = { range: `ここから先は範囲外です（中心から${WALK_RADIUS}m）`, road: '道路・歩道として確認できない場所には進めません', building: '', wall: '' }[res.reason];
      if (msg) { toast(msg); state.lastBlockMsg = performance.now(); }
    }
  } else if ((inp.x || inp.y) && state.mode === 'window' && performance.now() - state.lastBlockMsg > 4000) {
    toast('間取り図が未取得のため室内は歩けません。「建物の外へ」で屋外に出られます。', 3500);
    state.lastBlockMsg = performance.now();
  }
  // 玄関付近の案内
  if (state.mode === 'indoor') {
    const e = state.interior.entrance;
    const near = e && Math.hypot(e[0] - state.pos.x, e[1] - state.pos.z) < 1.6;
    $('btn-action').hidden = !near;
  }
  if (state.mode === 'outdoor' && settings.view === 'bird') {
    // 俯瞰：現在地の後方上空から見下ろす（人型の印で大きさの目安を示す）
    const back = 40, up = 55;
    const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw);
    camera.position.set(state.pos.x - fx * back, up, state.pos.z - fz * back);
    camera.rotation.set(-0.9 + state.pitch * 0.5, state.yaw, 0);
    avatar.position.set(state.pos.x, 0, state.pos.z);
    avatar.rotation.y = state.yaw;
  } else {
    camera.position.set(state.pos.x, floorY() + settings.eye, state.pos.z);
    camera.rotation.set(state.pitch, state.yaw, 0);
  }
  if (state.dest) {
    if (state.mode === 'outdoor') updateRoute();
    updateDestHud();
  }
  renderer.render(scene, camera);
  minimap.draw({ x: state.pos.x, z: state.pos.z, yaw: state.yaw, pois: visiblePois(), dest: state.dest, route: state.route?.reliable ? state.route.path : null });
}

// ---- 起動 ----
async function exportMode() {
  // tools/export-area.mjs から呼ばれる：?export=1&lat=..&lon=.. の位置の公開データを取得して JSON を返す
  const q = new URLSearchParams(location.search);
  const origin = { lat: parseFloat(q.get('lat')), lon: parseFloat(q.get('lon')) };
  try {
    if (!isFinite(origin.lat) || !isFinite(origin.lon)) throw new Error('lat・lon を指定してください');
    window.__exportResult = { ok: true, data: await fetchFresh(origin, { buildingFloors: { value: q.get('floors') ? +q.get('floors') : null } }, { onProgress: (m) => console.log(m) }) };
  } catch (e) {
    window.__exportResult = { ok: false, error: e.message, details: e.details || [], cause: e.cause?.message };
  }
}

function startWalking() {
  $('start').hidden = true;
  for (const id of ['topbar', 'notices', 'minimap', 'bottombar']) $(id).hidden = false;
  $('title-name').textContent = state.project.info?.name?.value || '名称未入力';
  $('title-unit').textContent = state.project.info?.unit?.value || '';
  fade(() => enterRoom());
}

async function main() {
  if (new URLSearchParams(location.search).has('export')) { exportMode(); return; }
  if (!webglAvailable()) { $('home').hidden = true; $('nowebgl').hidden = false; return; }
  initRenderer();
  controls = new Controls($('stage'), $('stick'), $('knob'));
  controls.onTap = onTap;
  initWizard({ onWalk: openWalk, toast });
  $('btn-retry').addEventListener('click', () => openWalk(state.project));
  $('btn-start').addEventListener('click', startWalking);
  $('btn-skip').addEventListener('click', () => { abortCtl?.abort(); setupWorld(emptyData(state.project.location || { lat: 0, lon: 0 }, '周辺データの取得を中断したため、街は表示していません。'), planOf(state.project)); startWalking(); });
  $('btn-back').addEventListener('click', () => { abortCtl?.abort(); $('start').hidden = true; openProject(state.project.id); });
  $('btn-action').addEventListener('click', () => fade(enterOutdoor));
  $('btn-room').addEventListener('click', () => fade(enterRoom));
  $('btn-reset').addEventListener('click', resetPosition);
  $('btn-plan').addEventListener('click', () => backToWizard(state.project.images?.length ? 'request' : 'images'));
  $('btn-proj').addEventListener('click', () => backToWizard('home'));
  $('btn-view').addEventListener('click', () => {
    settings.view = settings.view === 'bird' ? 'eye' : 'bird';
    saveSettings();
    updateModeUi();
  });
  $('btn-poi').addEventListener('click', showPoiList);
  $('btn-data').addEventListener('click', showData);
  $('btn-settings').addEventListener('click', showSettings);
  $('btn-help').addEventListener('click', showHelp);
  $('panel-close').addEventListener('click', closePanel);
  $('dest-clear').addEventListener('click', () => setDest(null));
  $('minimap').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (minimap.big) {
      const p = minimap.hit(e.clientX - r.left, e.clientY - r.top);
      if (p) { showPoi(p); return; }
    }
    minimap.setBig(!minimap.big);
  });
  window.__app = { state, get settings() { return settings; }, enterRoom, enterOutdoor, setDest, camera, openWalk };
  tick();
  await migrateLegacy();
  showHome();
}
main();
