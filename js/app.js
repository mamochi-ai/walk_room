// アプリ本体：モード（窓からの眺め／室内／屋外）、描画ループ、UI の結線
import * as THREE from 'three';
import {
  PROPERTY, SOURCES, WALK_RADIUS, EYE_HEIGHT_DEFAULT, WALK_SPEED_DEFAULT, PLAYER_RADIUS,
  WALK_M_PER_MIN, UNIT_PLACEMENT_DEFAULT, TARGET_ESTIMATE,
} from './config.js';
import { loadArea, clearCache, fetchFresh, frame } from './data/loader.js';
import { CAT_LABEL } from './data/osm.js';
import { OutdoorNav, moveWithCollision } from './nav.js';
import { buildCity, buildPoiMarkers, buildRouteLine, COLORS } from './world/city.js';
import { computePlacement, buildInterior, yawLookingOut, FACADE_LABEL } from './world/interior.js';
import { Controls } from './ui/controls.js';
import { Minimap } from './ui/minimap.js';
import { closestOnSeg, fmtMeters, ringCentroid } from './geo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- 設定（端末内に保存。保存できなくても動作する） ----
const SETTINGS_KEY = 'walk-room-settings-v1';
const defaults = {
  eye: EYE_HEIGHT_DEFAULT, speed: WALK_SPEED_DEFAULT, quality: 'normal', furniture: true, edges: true,
  facade: UNIT_PLACEMENT_DEFAULT.facade, along: UNIT_PLACEMENT_DEFAULT.along, storyHeight: TARGET_ESTIMATE.storyHeight,
};
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* noop */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* noop */ } };

// ---- 状態 ----
const state = {
  mode: 'loading', // 'window' | 'indoor' | 'outdoor'
  pos: { x: 0, z: 0 }, yaw: 0, pitch: 0,
  data: null, nav: null, plan: null, placement: null, interior: null,
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

let renderer, scene, camera, city, poiMarkers, routeLine, controls, minimap;

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
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.fov = w < h ? 75 : 65;
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

// ---- 読み込み ----
let abortCtl = null;
async function startLoading(force = false) {
  $('load-error').hidden = true;
  $('load-status').hidden = false;
  $('load-status').classList.remove('done');
  $('btn-start').disabled = true;
  abortCtl?.abort();
  abortCtl = new AbortController();
  try {
    if (force) await clearCache();
    const data = await loadArea({ force, signal: abortCtl.signal, onProgress: (m) => ($('load-text').textContent = m) });
    let plan = null;
    try {
      const r = await fetch('data/unit-312.json', { cache: 'no-cache' });
      if (r.ok) plan = await r.json();
    } catch { /* 間取りなしで続行 */ }
    setupWorld(data, plan);
    const from = { bundled: '同梱データ', cache: '端末に保存済みのデータ', fresh: '公開データから取得' }[data.loadedFrom];
    $('load-text').textContent = `準備完了（${from}・取得日 ${data.fetchedAt.slice(0, 10)}）`;
    $('load-status').classList.add('done');
    $('btn-start').disabled = false;
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    $('load-status').hidden = true;
    $('load-error').hidden = false;
    $('load-error-text').textContent = e.message || 'データを取得できませんでした。';
    $('load-error-detail').textContent = [e.cause?.message, ...(e.details || [])].filter(Boolean).join('\n') || String(e);
  }
}

function setupWorld(data, plan) {
  // 再読み込み時は作り直す
  if (city) { scene.remove(city.group); scene.remove(poiMarkers.group); scene.remove(routeLine.mesh); }
  if (state.interior) { scene.remove(state.interior.group); state.interior = null; }
  state.data = data;
  state.nav = new OutdoorNav(data);
  city = buildCity(scene, data);
  city.edgesGroup.visible = settings.edges;
  poiMarkers = buildPoiMarkers(scene, data.pois);
  routeLine = buildRouteLine(scene);
  minimap = new Minimap($('minimap'), data);
  state.plan = plan && plan.status !== 'pending' && Array.isArray(plan.walls) && plan.walls.length ? plan : null;
  state.planRaw = plan;
  state.entrance = computeEntrance();
  rebuildPlacement();
  applyFilter();
}

// 建物入口：OSM の entrance ノードがあれば使う。なければ道路側の仮位置。
function computeEntrance() {
  const { data, nav } = state;
  if (!data.target) {
    const p = nav.nearestOnRoad(0, 0, 400);
    return p ? { x: p.x, z: p.z, yaw: 0, status: 'none' } : { x: 0, z: 0, yaw: 0, status: 'none' };
  }
  const ring = data.target.ring;
  const [cx, cz] = ringCentroid(ring);
  let from = null, status = 'provisional';
  const ent = data.target.entrances || [];
  if (ent.length) {
    from = ent.find((e) => e.kind === 'main') || ent[0];
    status = 'osm';
  }
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
  if (!best) return { x: cx, z: cz + 30, yaw: 0, status: 'none' };
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
  state.placement = state.data.target
    ? computePlacement(state.data.target.ring, { floor: UNIT_PLACEMENT_DEFAULT.floor, facade: settings.facade, along: settings.along }, settings.storyHeight)
    : null;
  if (state.plan && state.placement) {
    state.interior = buildInterior(scene, state.plan, state.placement);
    state.interior.setFurniture(settings.furniture);
    state.interior.group.visible = false;
  }
}

// ---- モード切り替え ----
function enterRoom() {
  if (!state.placement) {
    toast('対象建物の外形が取得できないため、部屋の位置を表示できません。');
    return enterOutdoor();
  }
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
  state.mode = 'outdoor';
  if (state.interior) state.interior.group.visible = false;
  if (city.target) city.target.visible = true;
  state.pos = { x: state.entrance.x, z: state.entrance.z };
  state.yaw = state.entrance.yaw;
  state.pitch = 0;
  state.routeFrom = null;
  updateModeUi();
  if (state.entrance.status === 'provisional') toast('建物入口の位置は未確認のため、道路側の仮位置に出ました。', 4000);
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
  $('mode-chip').textContent = { outdoor: '屋外', indoor: '室内', window: '窓からの眺め（推定）' }[m] || '';
  $('btn-room').hidden = m !== 'outdoor';
  $('btn-action').hidden = m === 'outdoor';
  $('btn-action').textContent = '建物の外へ';
  updateNotices();
  updateDestHud(true);
}

function updateNotices() {
  const m = state.mode, d = state.data;
  const chips = [];
  if (m === 'outdoor') {
    chips.push(['地形は簡略化（平坦）', 'est']);
    if (d.target) chips.push(['対象建物の高さは概算', 'est']);
    if (state.entrance.status !== 'osm') chips.push(['建物入口は仮位置', 'est']);
    if (!d.sources.plateau.ok) chips.push(['建物はOSM外形・高さ推定', 'miss']);
  } else {
    chips.push(['住戸位置は仮配置', 'est']);
    chips.push([`高さ推定（階高${settings.storyHeight.toFixed(1)}m）`, 'est']);
    if (m === 'window') chips.push(['間取り図未取得・室内は保留', 'miss']);
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
  return state.mode === 'outdoor' ? state.pos : state.entrance;
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
    const fromLabel = state.mode === 'outdoor' ? '現在地から' : `建物入口${state.entrance.status === 'osm' ? '' : '（仮位置）'}から`;
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
  const r = state.nav.route(state.entrance, destPoint(p));
  const walk = r && r.reliable
    ? `${fmtMeters(r.dist)}・約${Math.max(1, Math.ceil(r.dist / WALK_M_PER_MIN))}分 <span class="note">（建物入口${state.entrance.status === 'osm' ? '' : '仮位置'}から道路経路、${WALK_M_PER_MIN}m/分で換算。信号待ちは含まず）</span>`
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

const STATUS = { confirmed: ['確認済', 'ok'], estimated: ['推定', 'est'], missing: ['未取得', 'miss'] };
function showData() {
  const d = state.data;
  const pl = d.sources.plateau;
  const fact = (label, value, st, src) => `<li><span class="chip ${STATUS[st][1]}">${STATUS[st][0]}</span><div><strong>${esc(label)}</strong>：${esc(value)}${src ? `<small>${esc(src)}</small>` : ''}</div></li>`;
  const facts = PROPERTY.facts.map((f) => fact(f.label, f.value, f.status, f.src));
  const ex = d.excludedAtTarget || [];
  const html = `
    <h3>物件情報</h3>
    <ul class="facts">${facts.join('')}</ul>
    <h3>表示データの状態</h3>
    <ul class="facts">
      ${fact('読み込み元', { bundled: '同梱データ', cache: '端末内に保存したデータ', fresh: '公開データから取得' }[d.loadedFrom] + `（取得日時 ${d.fetchedAt.replace('T', ' ').slice(0, 16)} UTC）`, 'confirmed')}
      ${pl.ok ? fact('建物の形状・高さ', `PLATEAU 川崎市 ${SOURCES.plateau.year}年度 LOD1：${pl.count}棟（タイル${pl.tiles}件${pl.failedTiles ? `、失敗${pl.failedTiles}件` : ''}）`, 'confirmed', pl.tilesetUrl)
        : fact('建物の形状・高さ', `PLATEAU を取得できませんでした（${pl.error || '原因不明'}）。OSM の建物外形で代用（高さは階数×3m などの推定）`, 'missing', (pl.details || []).join(' / '))}
      ${d.target ? fact('対象建物の外形', `OpenStreetMap way ${d.target.osmId}`, 'confirmed') : fact('対象建物の外形', '取得できませんでした', 'missing')}
      ${d.target ? fact('対象建物の高さ', `約${d.target.h.toFixed(1)}m（${d.target.floors}階×階高${TARGET_ESTIMATE.storyHeight}m＋1階床${TARGET_ESTIMATE.groundFloorRaise}m＋屋上${TARGET_ESTIMATE.parapet}m の概算）`, 'estimated') : ''}
      ${fact('対象敷地に重なる既存データ', ex.length ? `${ex.length}件を非表示（${ex.map((e) => `${e.src} 高さ${e.h}m・${e.area}㎡`).join('、')}）。竣工（2022年11月）前の調査による旧建物・工事中形状の可能性があるため` : 'なし（PLATEAU 2022年度に対象建物の形状は見つかりませんでした）', ex.length ? 'estimated' : 'confirmed')}
      ${fact('建物入口', state.entrance.status === 'osm' ? 'OSM の入口ノード付近の道路' : '未確認（建物に最も近い道路上の仮位置）', state.entrance.status === 'osm' ? 'confirmed' : 'estimated')}
      ${fact('道路・歩道', `OSM の歩行可能な道路 ${d.walk.length}本。私道・通行制限のある道は除外。道路の幅は種別から推定`, 'estimated')}
      ${fact('施設', `OSM のコンビニ・スーパー・駅 ${d.pois.length}件`, 'confirmed')}
      ${fact('地形', '高低差は反映せず平坦として表示（地形は簡略化）', 'estimated')}
      ${fact('間取り・室内', state.plan ? `data/unit-312.json（${esc(state.plan.status)}）` : '間取り図が未取得のため室内は保留。「窓からの眺め（推定）」のみ', state.plan ? 'estimated' : 'missing')}
    </ul>
    ${(d.notes || []).map((n) => `<p class="warn">${esc(n)}</p>`).join('')}
    <h3>出典</h3>
    <p>${esc(SOURCES.plateau.attribution)}<br><a href="${SOURCES.plateau.url}" target="_blank" rel="noopener">${SOURCES.plateau.url}</a></p>
    <p>道路・店舗・駅・対象建物の外形：${esc(SOURCES.overpass.attribution)}<br><a href="${SOURCES.overpass.url}" target="_blank" rel="noopener">${SOURCES.overpass.url}</a></p>
    <p>物件情報：三井の賃貸 掲載ページ（<a href="https://www.mitsui-chintai.co.jp/rf/tatemono/10355" target="_blank" rel="noopener">mitsui-chintai.co.jp/rf/tatemono/10355</a>）ほか。画像は転載していません。</p>
    <p class="note">取得日：${d.fetchedAt.slice(0, 10)}。データは端末内に${30}日間保存されます。</p>
    <div class="row"><button type="button" id="btn-refetch">データを再取得</button></div>`;
  openPanel('データと出典', html, (el) => {
    el.querySelector('#btn-refetch').addEventListener('click', () => {
      closePanel();
      $('start').hidden = false;
      startLoading(true);
    });
  });
}

function showSettings() {
  const seg = (name, val, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${String(val) === String(v)}">${l}</button>`).join('')}</div>`;
  const html = `
    <div class="setting"><label for="s-eye">目線の高さ <output id="o-eye">${settings.eye.toFixed(2)} m</output></label>
      <input id="s-eye" type="range" min="1.0" max="2.0" step="0.05" value="${settings.eye}"></div>
    <div class="setting"><label for="s-speed">移動速度 <output id="o-speed">${settings.speed.toFixed(1)} m/秒</output></label>
      <input id="s-speed" type="range" min="0.5" max="4" step="0.1" value="${settings.speed}">
      <span class="note">徒歩の目安は約1.3m/秒（80m/分）。</span></div>
    <div class="setting"><label>画質（重い場合は「低」）</label>${seg('quality', settings.quality, [['low', '低'], ['normal', '標準'], ['high', '高']])}</div>
    <div class="setting"><label>建物の輪郭線</label>${seg('edges', settings.edges, [[true, '表示'], [false, '非表示']])}</div>
    <div class="setting"><label>家具</label>${seg('furniture', settings.furniture, [[true, '表示'], [false, '非表示']])}
      ${state.plan ? '' : '<span class="note">間取り図が未取得のため室内はまだありません。</span>'}</div>
    <h3>住戸の仮配置（未確認のため調整可能）</h3>
    <p class="note">312号室の建物内の位置・向きは確認できていません。初期値は、同じ面積の1階住戸が「西向き」と掲載されていることからの推定です。</p>
    <div class="setting"><label>窓の向き</label>${seg('facade', settings.facade, Object.entries(FACADE_LABEL))}</div>
    <div class="setting"><label for="s-along">外壁上の位置 <output id="o-along">${Math.round(settings.along * 100)}%</output></label>
      <input id="s-along" type="range" min="0.05" max="0.95" step="0.01" value="${settings.along}"></div>
    <div class="setting"><label for="s-story">階高（推定） <output id="o-story">${settings.storyHeight.toFixed(2)} m</output></label>
      <input id="s-story" type="range" min="2.7" max="3.6" step="0.05" value="${settings.storyHeight}">
      <span class="note">3階の床の高さ ≒ 1階床${TARGET_ESTIMATE.groundFloorRaise}m＋階高×2。実測値ではありません。</span></div>
    <div class="row"><button type="button" id="s-reset">初期値に戻す</button></div>`;
  openPanel('設定', html, (el) => {
    const bindRange = (id, key, fmt, after) => {
      const i = el.querySelector('#s-' + id);
      i.addEventListener('input', () => {
        settings[key] = parseFloat(i.value);
        el.querySelector('#o-' + id).textContent = fmt(settings[key]);
        saveSettings();
        after?.();
      });
    };
    bindRange('eye', 'eye', (v) => `${v.toFixed(2)} m`);
    bindRange('speed', 'speed', (v) => `${v.toFixed(1)} m/秒`);
    const replace = () => { const inRoom = state.mode !== 'outdoor'; rebuildPlacement(); if (inRoom) enterRoom(); updateNotices(); };
    bindRange('along', 'along', (v) => `${Math.round(v * 100)}%`, replace);
    bindRange('story', 'storyHeight', (v) => `${v.toFixed(2)} m`, replace);
    el.querySelectorAll('[data-seg]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = g.dataset.seg;
      let v = b.dataset.v;
      if (v === 'true' || v === 'false') v = v === 'true';
      settings[k] = v;
      saveSettings();
      g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (k === 'quality') { applyQuality(); resize(); }
      if (k === 'edges') city.edgesGroup.visible = v;
      if (k === 'furniture') state.interior?.setFurniture(v);
      if (k === 'facade') replace();
    })));
    el.querySelector('#s-reset').addEventListener('click', () => {
      settings = { ...defaults };
      saveSettings();
      applyQuality(); resize();
      city.edgesGroup.visible = settings.edges;
      replace();
      showSettings();
    });
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
    <p>部屋（窓からの眺め）→「建物の外へ」で建物入口付近の道路へ →「施設」から目的地を選ぶと、方向・直線距離と、道路で経路を計算できた場合だけ徒歩距離を表示します。「部屋へ戻る」でいつでも戻れます。</p>
    <h3>表示について</h3>
    <p>グレーの箱は PLATEAU の建物（位置・外形・高さ）、オレンジは対象建物（外形は OSM、高さは概算）です。白っぽい帯は歩ける道路（幅は推定）で、道路の外や建物の中には入れません。赤い円の外は範囲外です（中心から${WALK_RADIUS}m）。</p>
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
    const sp = settings.speed * dt;
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
  camera.position.set(state.pos.x, floorY() + settings.eye, state.pos.z);
  camera.rotation.set(state.pitch, state.yaw, 0);
  if (state.dest) {
    if (state.mode === 'outdoor') updateRoute();
    updateDestHud();
  }
  renderer.render(scene, camera);
  minimap.draw({ x: state.pos.x, z: state.pos.z, yaw: state.yaw, pois: visiblePois(), dest: state.dest, route: state.route?.reliable ? state.route.path : null });
}

// ---- 起動 ----
async function exportMode() {
  // tools/export-area.mjs から呼ばれる：公開データを取得して JSON を返す
  try {
    window.__exportResult = { ok: true, data: await fetchFresh({ onProgress: (m) => console.log(m) }) };
  } catch (e) {
    window.__exportResult = { ok: false, error: e.message, details: e.details || [], cause: e.cause?.message };
  }
}

function main() {
  if (new URLSearchParams(location.search).has('export')) { exportMode(); return; }
  if (!webglAvailable()) { $('start').hidden = true; $('nowebgl').hidden = false; return; }
  initRenderer();
  controls = new Controls($('stage'), $('stick'), $('knob'));
  controls.onTap = onTap;
  $('btn-retry').addEventListener('click', () => startLoading(false));
  $('btn-start').addEventListener('click', () => {
    $('start').hidden = true;
    for (const id of ['topbar', 'notices', 'minimap', 'bottombar']) $(id).hidden = false;
    fade(() => enterRoom());
  });
  $('btn-action').addEventListener('click', () => fade(enterOutdoor));
  $('btn-room').addEventListener('click', () => fade(enterRoom));
  $('btn-reset').addEventListener('click', resetPosition);
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
  window.__app = { state, settings, enterRoom, enterOutdoor, setDest, frame, camera };
  tick();
  startLoading(false);
}
main();
