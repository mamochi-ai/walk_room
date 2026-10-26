// データ取得の全体制御
// 優先順: 同梱データ(data/area.json) → 端末内キャッシュ(IndexedDB) → 公開APIから対象範囲だけ取得
import { ORIGIN, DATA_RADIUS, SOURCES, CACHE_KEY, CACHE_DAYS, TARGET_ESTIMATE } from '../config.js';
import { LocalFrame, bboxAround, pointInRing, ringCentroid, ringArea } from '../geo.js';
import { overpass, mainQuery, buildingQuery, parseMain, parseBuildings } from './osm.js';
import { loadPlateauBuildings } from './plateau.js';

export const frame = new LocalFrame(ORIGIN.lat, ORIGIN.lon);

// ---- IndexedDB（失敗しても動作は継続） ----
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('walk-room', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function cacheGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch { return null; }
}
async function cachePut(key, val) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res; tx.onerror = res;
    });
  } catch { /* 保存できなくても続行 */ }
}
export async function clearCache() {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(CACHE_KEY);
      tx.oncomplete = res; tx.onerror = res;
    });
  } catch { /* noop */ }
}

async function fetchBundled() {
  try {
    // data/manifest.json の bundled が true のときだけ同梱データを読む（不要な 404 を避ける）
    const man = await fetch(new URL('../../data/manifest.json', import.meta.url), { cache: 'no-cache' });
    if (!man.ok || !(await man.json()).bundled) return null;
    const res = await fetch(new URL('../../data/area.json', import.meta.url), { cache: 'no-cache' });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.version === 1 ? j : null;
  } catch { return null; }
}

async function fetchSupplements() {
  try {
    const res = await fetch(new URL('../../data/poi-supplements.json', import.meta.url), { cache: 'no-cache' });
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}

function areaBox() {
  const b = bboxAround(ORIGIN.lat, ORIGIN.lon, DATA_RADIUS);
  return { ...b, minX: -DATA_RADIUS, maxX: DATA_RADIUS, minZ: -DATA_RADIUS, maxZ: DATA_RADIUS };
}

function overlapsTarget(b, ring) {
  const outer = b.rings[0];
  const [cx, cz] = ringCentroid(outer);
  if (pointInRing(cx, cz, ring)) return true;
  const [tx, tz] = ringCentroid(ring);
  if (pointInRing(tx, tz, outer)) return true;
  let inside = 0;
  for (const p of outer) if (pointInRing(p[0], p[1], ring)) inside++;
  return inside / outer.length >= 0.5;
}

export async function fetchFresh({ onProgress, signal } = {}) {
  const area = areaBox();
  const now = new Date().toISOString();
  const notes = [];

  onProgress?.('OpenStreetMap から道路・店舗・駅を取得中…');
  let main;
  try {
    main = parseMain(await overpass(mainQuery(area), { signal }), frame);
  } catch (e) {
    if (signal?.aborted) throw e;
    const err = new Error('道路・店舗データ（OpenStreetMap）を取得できませんでした。通信状況を確認して再試行してください。');
    err.cause = e;
    throw err;
  }

  let buildings = [], plateau = { ok: false };
  try {
    const r = await loadPlateauBuildings(SOURCES.plateau, frame, area, { signal, onProgress });
    buildings = r.buildings;
    plateau = { ok: true, tilesetUrl: r.tilesetUrl, tiles: r.tiles, failedTiles: r.failedTiles, count: buildings.length, fetchedAt: now };
  } catch (e) {
    if (signal?.aborted) throw e;
    plateau = { ok: false, error: e.message, details: e.details || [] };
    notes.push('PLATEAU の建物データを取得できなかったため、OpenStreetMap の建物外形で代用しています（高さは推定）。');
    onProgress?.('PLATEAU を取得できないため OSM の建物外形を取得中…');
    try {
      buildings = parseBuildings(await overpass(buildingQuery(area), { signal }), frame);
    } catch (e2) {
      if (signal?.aborted) throw e2;
      notes.push('建物外形の代替データも取得できませんでした。');
    }
  }

  // 対象建物
  let target = null;
  const excluded = [];
  if (main.target && main.target.ring.length >= 3) {
    const ring = main.target.ring;
    const keep = [];
    for (const b of buildings) {
      if (b.src === 'osm' && b.id === `osm:way/${main.target.osmId}`) continue;
      if (overlapsTarget(b, ring)) excluded.push({ id: b.id, h: +b.h.toFixed(1), area: Math.round(Math.abs(ringArea(b.rings[0]))), src: b.src });
      else keep.push(b);
    }
    buildings = keep;
    const floors = main.target.levels || TARGET_ESTIMATE.floors;
    target = {
      ring,
      osmId: main.target.osmId,
      floors,
      h: TARGET_ESTIMATE.groundFloorRaise + floors * TARGET_ESTIMATE.storyHeight + TARGET_ESTIMATE.parapet,
      hStatus: 'estimated',
      entrances: main.target.entrances,
      footprintSource: 'OpenStreetMap',
    };
  } else {
    notes.push('OpenStreetMap で対象建物の外形を確認できませんでした。対象建物は位置マーカーのみ表示します。');
  }

  return {
    version: 1,
    origin: ORIGIN,
    radius: DATA_RADIUS,
    fetchedAt: now,
    sources: {
      osm: { ok: true, fetchedAt: now, ways: main.walk.length, pois: main.pois.length },
      plateau,
    },
    target,
    excludedAtTarget: excluded,
    buildings: buildings.map((b) => ({ ...b, rings: b.rings.map((r) => r.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)])), h: +b.h.toFixed(2) })),
    walk: main.walk.map((w) => ({ ...w, pts: w.pts.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]) })),
    pois: main.pois,
    notes,
  };
}

export async function loadArea({ onProgress, signal, force = false } = {}) {
  let data = null, origin = 'fresh';
  if (!force) {
    onProgress?.('同梱データを確認中…');
    data = await fetchBundled();
    if (data) origin = 'bundled';
  }
  if (!data && !force) {
    const c = await cacheGet(CACHE_KEY);
    if (c && c.version === 1 && Date.now() - Date.parse(c.fetchedAt) < CACHE_DAYS * 864e5) { data = c; origin = 'cache'; }
  }
  if (!data) {
    data = await fetchFresh({ onProgress, signal });
    await cachePut(CACHE_KEY, data);
  }
  // 店舗公式情報などによる補足（OSM 未登録の施設）
  const sup = await fetchSupplements();
  const pois = data.pois.filter((p) => p.source !== 'supplement');
  for (const s of sup) {
    if (!s.lat || !s.lon || !s.name || !s.category) continue;
    const p = frame.toXZ(s.lat, s.lon);
    const entrances = (s.entrances || []).map((e) => { const q = frame.toXZ(e.lat, e.lon); return { x: q.x, z: q.z, label: e.label || '入口' }; });
    pois.push({ id: `sup/${s.id || s.name}`, cat: s.category, name: s.name, x: p.x, z: p.z, lat: s.lat, lon: s.lon, hours: s.opening_hours || null, entrances, source: 'supplement', sourceTitle: s.source?.title || '', sourceUrl: s.source?.url || '', checked: s.source?.checked || '' });
  }
  return { ...data, pois, loadedFrom: origin };
}
