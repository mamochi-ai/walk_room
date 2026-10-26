// OpenStreetMap（Overpass API）から道路・店舗・駅・対象建物を取得して、ローカル座標に変換する
import { SOURCES, TARGET_OSM_WAY, PROPERTY } from '../config.js';
import { ringArea, ringCentroid } from '../geo.js';

export async function overpass(query, { signal, timeoutMs = 90000 } = {}) {
  let lastErr;
  for (const ep of SOURCES.overpass.endpoints) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Overpass API が HTTP ${res.status} を返しました`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

const bb = (b) => `(${b.s.toFixed(6)},${b.w.toFixed(6)},${b.n.toFixed(6)},${b.e.toFixed(6)})`;

export function mainQuery(bbox) {
  const B = bb(bbox);
  return `[out:json][timeout:90];
(
  way["highway"]${B};
  nwr["shop"~"^(convenience|supermarket)$"]${B};
  nwr["railway"="station"]${B};
  node["railway"~"^(train_station_entrance|subway_entrance)$"]${B};
  way(${TARGET_OSM_WAY});
  way["name"="${PROPERTY.name}"]${B};
)->.a;
(.a; >;)->.b;
.b out body qt;`;
}

export function buildingQuery(bbox) {
  const B = bb(bbox);
  return `[out:json][timeout:90];
(
  way["building"]${B};
)->.a;
(.a; >;)->.b;
.b out body qt;`;
}

// ---- 歩行可能な道路の判定 ----
// 私有地や未確認の通路を近道として扱わないため、アクセス制限や私道の可能性があるものは除外する。
const EXCLUDED_HW = new Set([
  'motorway', 'motorway_link', 'construction', 'proposed', 'raceway', 'bus_guideway',
  'escape', 'abandoned', 'platform', 'corridor', 'elevator', 'busway', 'rest_area', 'services',
]);
const HALF_WIDTH = {
  trunk: 7, trunk_link: 4, primary: 7, primary_link: 4, secondary: 6, secondary_link: 4,
  tertiary: 5, tertiary_link: 3.5, unclassified: 3.5, residential: 3.5, living_street: 3,
  service: 2.5, road: 3, pedestrian: 3, footway: 1.6, path: 1.5, cycleway: 1.8, steps: 1.3, track: 2,
};

export function walkableInfo(tags) {
  const hw = tags.highway;
  if (!hw || EXCLUDED_HW.has(hw)) return null;
  if (!(hw in HALF_WIDTH)) return null;
  const okFoot = ['yes', 'designated', 'permissive'].includes(tags.foot);
  if (['no', 'private'].includes(tags.foot)) return null;
  if (['private', 'no', 'customers', 'delivery', 'agricultural', 'forestry'].includes(tags.access) && !okFoot) return null;
  if (hw === 'service' && ['driveway', 'parking_aisle', 'drive-through'].includes(tags.service) && !okFoot) return null;
  if (hw === 'cycleway' && !okFoot && tags.foot !== undefined) return null;
  if (tags.indoor === 'yes') return null;
  if ((hw === 'trunk' || hw === 'trunk_link') && tags.sidewalk === 'no' && !okFoot) return null;
  let hwid = HALF_WIDTH[hw];
  const w = parseFloat(tags.width);
  if (isFinite(w) && w > 0.5 && w < 60) hwid = Math.max(1.2, w / 2 + 0.5);
  return { hw, half: hwid, widthFromTag: isFinite(w) };
}

const CAT_LABEL = { convenience: 'コンビニ', supermarket: 'スーパー', station: '駅' };
export { CAT_LABEL };

function poiCategory(t) {
  if (t.shop === 'convenience') return 'convenience';
  if (t.shop === 'supermarket') return 'supermarket';
  if (t.railway === 'station' && !t.disused && t['railway:historic'] === undefined) return 'station';
  return null;
}

const OPERATOR_SHORT = [
  [/東日本旅客鉄道|JR東日本/, 'JR'],
  [/東急|東京急行/, '東急'],
];
function stationLabel(t) {
  let name = t.name || '駅（名称未登録）';
  const op = t.operator || t.network || '';
  for (const [re, s] of OPERATOR_SHORT) if (re.test(op)) return `${name}駅（${s}）`;
  return op ? `${name}駅（${op}）` : `${name}駅`;
}

// Overpass の結果をローカル座標のデータに変換
export function parseMain(json, frame) {
  const nodes = new Map();
  const ways = [];
  const rels = [];
  for (const el of json.elements || []) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.push(el);
    else if (el.type === 'relation') rels.push(el);
  }
  const xz = (n) => {
    const p = frame.toXZ(n.lat, n.lon);
    return [p.x, p.z];
  };

  // 歩行可能な道路
  const walk = [];
  for (const w of ways) {
    const info = walkableInfo(w.tags || {});
    if (!info) continue;
    const pts = [], ids = [];
    for (const id of w.nodes) {
      const n = nodes.get(id);
      if (!n) continue;
      pts.push(xz(n));
      ids.push(id);
    }
    if (pts.length < 2) continue;
    walk.push({ id: w.id, pts, nodeIds: ids, hw: info.hw, half: info.half, name: w.tags.name || '' });
  }

  // 対象建物
  let target = null;
  const tw = ways.find((w) => w.id === TARGET_OSM_WAY) || ways.find((w) => w.tags?.name === PROPERTY.name && w.tags?.building);
  if (tw) {
    const ring = tw.nodes.map((id) => nodes.get(id)).filter(Boolean).map(xz);
    if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    const entrances = tw.nodes
      .map((id) => nodes.get(id))
      .filter((n) => n && n.tags && n.tags.entrance)
      .map((n) => ({ x: xz(n)[0], z: xz(n)[1], kind: n.tags.entrance, id: n.id }));
    target = {
      osmId: tw.id,
      ring,
      levels: parseInt(tw.tags['building:levels'] || '0', 10) || null,
      entrances,
      tags: tw.tags,
    };
  }

  // 施設
  const pois = [];
  const entrNodes = [];
  for (const n of nodes.values()) {
    const t = n.tags || {};
    if (t.railway === 'train_station_entrance' || t.railway === 'subway_entrance') entrNodes.push(n);
  }
  const elems = [...nodes.values(), ...ways, ...rels];
  for (const el of elems) {
    const t = el.tags || {};
    const cat = poiCategory(t);
    if (!cat) continue;
    let pos = null, entrances = [];
    if (el.type === 'node') {
      pos = xz(el);
    } else if (el.type === 'way') {
      const ring = el.nodes.map((id) => nodes.get(id)).filter(Boolean).map(xz);
      if (!ring.length) continue;
      pos = ring.length >= 3 ? ringCentroid(ring) : ring[0];
      entrances = el.nodes
        .map((id) => nodes.get(id))
        .filter((n) => n && n.tags && n.tags.entrance)
        .map((n) => ({ x: xz(n)[0], z: xz(n)[1], label: n.tags.name || n.tags.ref || '入口（OSM）', id: n.id }));
    } else {
      // relation: メンバーのノード座標の平均（近似）
      const pts = [];
      for (const m of el.members || []) {
        if (m.type === 'node' && nodes.has(m.ref)) pts.push(xz(nodes.get(m.ref)));
        if (m.type === 'way') {
          const w = ways.find((w) => w.id === m.ref);
          if (w) for (const id of w.nodes) if (nodes.has(id)) pts.push(xz(nodes.get(id)));
        }
      }
      if (!pts.length) continue;
      pos = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    }
    const ll = frame.toLatLon(pos[0], pos[1]);
    const name = cat === 'station' ? stationLabel(t) : t.name || t.brand || `${CAT_LABEL[cat]}（名称未登録）`;
    pois.push({
      id: `${el.type}/${el.id}`,
      cat,
      name,
      brand: t.brand || '',
      x: pos[0],
      z: pos[1],
      lat: ll.lat,
      lon: ll.lon,
      hours: t.opening_hours || null,
      entrances,
      source: 'OpenStreetMap',
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      baseName: t.name || '',
    });
  }

  // 駅：同名・同事業者で近接する要素を統合し、駅入口ノードを関連付ける
  const stations = pois.filter((p) => p.cat === 'station');
  const keep = new Set(pois.filter((p) => p.cat !== 'station'));
  const merged = [];
  for (const s of stations) {
    const dup = merged.find((m) => m.name === s.name && Math.hypot(m.x - s.x, m.z - s.z) < 200);
    if (dup) continue;
    merged.push(s);
  }
  for (const n of entrNodes) {
    const [x, z] = xz(n);
    const t = n.tags;
    let best = null, bd = Infinity;
    for (const s of merged) {
      const d = Math.hypot(s.x - x, s.z - z);
      const nameMatch = s.baseName && ((t.name || '').includes(s.baseName) || (t['railway:ref'] || '') === s.baseName);
      const score = nameMatch ? d * 0.5 : d;
      if (score < bd && d < 350) { bd = score; best = s; }
    }
    if (best) best.entrances.push({ x, z, label: t.name || (t.ref ? `${t.ref}出口` : '駅入口（OSM）'), id: n.id });
  }
  for (const s of merged) keep.add(s);

  return { walk, target, pois: [...keep] };
}

export function parseBuildings(json, frame) {
  const nodes = new Map();
  const out = [];
  for (const el of json.elements || []) if (el.type === 'node') nodes.set(el.id, el);
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !el.tags?.building) continue;
    const ring = el.nodes.map((id) => nodes.get(id)).filter(Boolean).map((n) => {
      const p = frame.toXZ(n.lat, n.lon);
      return [p.x, p.z];
    });
    if (ring.length > 3) ring.pop();
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 4) continue;
    const t = el.tags;
    let h = parseFloat(t.height), hSrc = 'OSM height';
    if (!isFinite(h)) {
      const lv = parseFloat(t['building:levels']);
      if (isFinite(lv)) { h = lv * 3; hSrc = '階数×3m（推定）'; }
      else { h = 7; hSrc = '高さ不明（7mで仮置き）'; }
    }
    out.push({ id: `osm:way/${el.id}`, rings: [ring], h, base: 0, src: 'osm', hSrc });
  }
  return out;
}
