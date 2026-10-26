// 周辺データの取得制御（物件ごとに、確定した物件位置を中心に取得）
// 優先順: 端末内キャッシュ（物件位置ごと） → 公開APIから対象範囲だけ取得
// サンプル物件は data/area.json（同梱）があればそれを使う。
import { DATA_RADIUS, STATION_RADIUS, SOURCES, CACHE_DAYS, TARGET_ESTIMATE } from '../config.js';
import { LocalFrame, bboxAround, pointInRing, ringCentroid, ringArea } from '../geo.js';
import { overpass, mainQuery, buildingQuery, parseMain, parseBuildings } from './osm.js';
import { loadPlateauBuildings } from './plateau.js';
import { kvGet, kvPut, kvDel } from '../store.js';

async function fetchBundled(origin) {
  try {
    // data/manifest.json の bundled が true で、同じ位置のデータのときだけ同梱データを読む
    const man = await fetch(new URL('../../data/manifest.json', import.meta.url), { cache: 'no-cache' });
    if (!man.ok) return null;
    const m = await man.json();
    if (!m.bundled) return null;
    const res = await fetch(new URL('../../data/area.json', import.meta.url), { cache: 'no-cache' });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || j.version !== 2) return null;
    return Math.abs(j.origin.lat - origin.lat) < 1e-6 && Math.abs(j.origin.lon - origin.lon) < 1e-6 ? j : null;
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

function areaBox(origin) {
  const b = bboxAround(origin.lat, origin.lon, DATA_RADIUS);
  return { ...b, minX: -DATA_RADIUS, maxX: DATA_RADIUS, minZ: -DATA_RADIUS, maxZ: DATA_RADIUS };
}

function overlaps(b, ring) {
  const outer = b.rings[0];
  const [cx, cz] = ringCentroid(outer);
  if (pointInRing(cx, cz, ring)) return true;
  const [tx, tz] = ringCentroid(ring);
  if (pointInRing(tx, tz, outer)) return true;
  let inside = 0;
  for (const p of outer) if (pointInRing(p[0], p[1], ring)) inside++;
  return inside / outer.length >= 0.5;
}

const r2 = (b) => ({ ...b, rings: b.rings.map((r) => r.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)])), h: +b.h.toFixed(2) });

// origin: {lat, lon}（確定した物件位置）, info: 物件情報（建物の階数など）
export async function fetchFresh(origin, info = {}, { onProgress, signal } = {}) {
  const frame = new LocalFrame(origin.lat, origin.lon);
  const area = areaBox(origin);
  const sbox = bboxAround(origin.lat, origin.lon, STATION_RADIUS);
  const now = new Date().toISOString();
  const notes = [];

  onProgress?.('OpenStreetMap から道路・店舗・駅を取得中…');
  let main;
  try {
    main = parseMain(await overpass(mainQuery(area, sbox, origin), { signal }), frame);
  } catch (e) {
    if (signal?.aborted) throw e;
    const err = new Error('道路・店舗データ（OpenStreetMap）を取得できませんでした。');
    err.cause = e;
    throw err;
  }
  if (!main.walk.length) notes.push('この範囲に OpenStreetMap の道路データがありません。屋外は歩けません。');

  let buildings = [], plateau = { ok: false };
  try {
    const r = await loadPlateauBuildings(SOURCES.plateau, frame, area, { signal, onProgress });
    buildings = r.buildings;
    plateau = { ok: true, tilesetUrl: r.tilesetUrl, datasets: r.datasets, tiles: r.tiles, failedTiles: r.failedTiles, count: buildings.length, fetchedAt: now };
  } catch (e) {
    if (signal?.aborted) throw e;
    plateau = { ok: false, outOfArea: !!e.outOfArea, error: e.message, details: e.details || [] };
    notes.push(e.outOfArea
      ? 'この地点は PLATEAU（3D都市モデル）の整備範囲外です。OpenStreetMap の建物外形を使い、高さは推定で表示します。'
      : 'PLATEAU の建物データを取得できなかったため、OpenStreetMap の建物外形で代用しています（高さは推定）。');
    onProgress?.('OpenStreetMap の建物外形を取得中…');
    try {
      buildings = parseBuildings(await overpass(buildingQuery(area), { signal }), frame);
    } catch (e2) {
      if (signal?.aborted) throw e2;
      notes.push('建物外形の代替データも取得できませんでした。');
    }
  }

  // 対象建物の決定
  //  1) 物件位置を含む PLATEAU の建物（高さは実データ）。ただし階数と高さが大きく食い違う場合は旧建物等の可能性として使わない
  //  2) 物件位置を含む（または近い）OSM の建物外形＋高さは OSM の height / 階数から推定
  const floors = Number(info.buildingFloors?.value) || null;
  const plateauAt = buildings.find((b) => b.src === 'plateau' && pointInRing(0, 0, b.rings[0]));
  let target = null;
  const excluded = [];
  const plausible = (h) => !floors || (h > floors * 2.4 && h < floors * 4.8 + 6);
  if (plateauAt && plausible(plateauAt.hMeasured || plateauAt.h)) {
    buildings = buildings.filter((b) => b !== plateauAt);
    target = {
      ring: plateauAt.rings[0], h: plateauAt.hMeasured || plateauAt.h, hStatus: 'plateau', footprintSource: 'PLATEAU', plateauId: plateauAt.id,
      floors, entrances: main.target?.containsPin ? main.target.entrances : [],
    };
  } else if (main.target && main.target.ring.length >= 3) {
    if (plateauAt) notes.push(`物件位置の PLATEAU 建物は高さ ${plateauAt.h.toFixed(1)}m で、建物の階数（${floors}階）と食い違うため、建て替え前の形状などの可能性があるとして使っていません。`);
    const ring = main.target.ring;
    buildings = buildings.filter((b) => {
      if (b.src === 'osm' && b.id === `osm:way/${main.target.osmId}`) return false;
      if (overlaps(b, ring)) { excluded.push({ id: b.id, h: +b.h.toFixed(1), area: Math.round(Math.abs(ringArea(b.rings[0]))), src: b.src }); return false; }
      return true;
    });
    const fl = floors || main.target.levels;
    const h = main.target.height || (fl ? TARGET_ESTIMATE.groundFloorRaise + fl * TARGET_ESTIMATE.storyHeight + TARGET_ESTIMATE.parapet : null);
    target = {
      ring, osmId: main.target.osmId, floors: fl, h: h || 10, hStatus: main.target.height ? 'osm-height' : fl ? 'estimated' : 'unknown',
      entrances: main.target.entrances, footprintSource: 'OpenStreetMap', containsPin: main.target.containsPin,
    };
  } else {
    notes.push('物件位置に建物の外形データが見つかりませんでした。対象建物は表示せず、住戸は物件位置に仮配置します。');
  }

  return {
    version: 2,
    origin: { lat: origin.lat, lon: origin.lon },
    radius: DATA_RADIUS,
    fetchedAt: now,
    sources: { osm: { ok: true, fetchedAt: now, ways: main.walk.length, pois: main.pois.length }, plateau },
    target,
    excludedAtTarget: excluded,
    buildings: buildings.map(r2),
    walk: main.walk.map((w) => ({ ...w, pts: w.pts.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2)]) })),
    pois: main.pois,
    notes,
  };
}

const cacheKey = (o) => `area-v2:${o.lat.toFixed(5)},${o.lon.toFixed(5)}`;
export const clearAreaCache = (origin) => kvDel(cacheKey(origin));

export async function loadArea(origin, info, { onProgress, signal, force = false } = {}) {
  let data = null, from = 'fresh';
  if (!force) {
    data = await fetchBundled(origin);
    if (data) from = 'bundled';
  }
  if (!data && !force) {
    const c = await kvGet(cacheKey(origin));
    if (c && c.version === 2 && Date.now() - Date.parse(c.fetchedAt) < CACHE_DAYS * 864e5) { data = c; from = 'cache'; }
  }
  if (!data) {
    data = await fetchFresh(origin, info, { onProgress, signal });
    await kvPut(cacheKey(origin), data);
  }
  const frame = new LocalFrame(origin.lat, origin.lon);
  // 店舗公式情報などによる補足（OSM 未登録の施設）。範囲内のものだけ
  const sup = await fetchSupplements();
  const pois = data.pois.filter((p) => p.source !== 'supplement');
  for (const s of sup) {
    if (!s.lat || !s.lon || !s.name || !s.category) continue;
    const p = frame.toXZ(s.lat, s.lon);
    if (Math.hypot(p.x, p.z) > STATION_RADIUS) continue;
    const entrances = (s.entrances || []).map((e) => { const q = frame.toXZ(e.lat, e.lon); return { x: q.x, z: q.z, label: e.label || '入口' }; });
    pois.push({ id: `sup/${s.id || s.name}`, cat: s.category, name: s.name, x: p.x, z: p.z, lat: s.lat, lon: s.lon, hours: s.opening_hours || null, entrances, source: 'supplement', sourceTitle: s.source?.title || '', sourceUrl: s.source?.url || '', checked: s.source?.checked || '' });
  }
  return { ...data, pois, loadedFrom: from, frame };
}
