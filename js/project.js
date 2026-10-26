// 物件（プロジェクト）の作成・状態判定・旧データの移行
import { INFO_FIELDS, normalizeAnalysis } from './plan/format.js';
import { newId, putProject, listProjects } from './store.js';

const emptyInfo = () => Object.fromEntries(INFO_FIELDS.map(([k]) => [k, { value: null, source: null, evidence: null }]));

export function newProject() {
  const now = new Date().toISOString();
  return {
    id: newId('p'),
    createdAt: now,
    updatedAt: now,
    images: [], // {id, role, name, w, h}
    analysisText: '',
    analysis: null, // 貼り付けた JSON（形式 v1/v2）
    revisions: [], // {at, correction}
    info: emptyInfo(),
    location: null, // {lat, lon, label, provider, precision, confirmed, confirmedAt, forAddress}
    entrance: null, // {lat, lon, source:'user'}
    placement: { facade: 'auto', along: 0.5, storyHeight: 3.0 },
    overlay: { imageId: null, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0.6 },
  };
}

export function displayName(p) {
  const n = p.info?.name?.value, u = p.info?.unit?.value;
  return [n || '名称未入力の物件', u].filter(Boolean).join(' ');
}

// 手順の状態
export function steps(p) {
  return {
    images: (p.images || []).length > 0,
    analysis: !!p.analysis,
    info: !!p.info?.address?.value,
    location: !!p.location?.confirmed && p.location.forAddress === p.info?.address?.value,
  };
}

export function planOf(p) {
  if (!p?.analysis) return null;
  try {
    const plan = normalizeAnalysis(p.analysis);
    return plan.walls.length ? plan : null;
  } catch { return null; }
}

export function locationKey(p) {
  if (!p.location?.confirmed) return null;
  return `area-v2:${p.location.lat.toFixed(5)},${p.location.lon.toFixed(5)}`;
}

// 方位の文字（「南」「南東向き」など）→ 方位角
const DIR = { 北: 0, 北東: 45, 東: 90, 南東: 135, 南: 180, 南西: 225, 西: 270, 北西: 315 };
export function bearingFromText(t) {
  if (!t) return null;
  const s = String(t).replace(/\s/g, '');
  for (const k of ['北東', '南東', '南西', '北西', '北', '東', '南', '西']) if (s.includes(k)) return DIR[k];
  const m = s.match(/^(N|NE|E|SE|S|SW|W|NW)$/i);
  return m ? { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 }[m[1].toUpperCase()] : null;
}

// 窓の外向き方位（度）を決める。根拠も返す。
export function resolveFacing(p, plan) {
  const pl = p.placement || {};
  if (pl.facade && pl.facade !== 'auto') return { bearing: Number(pl.facade), basis: '利用者が設定', status: 'user' };
  const north = p.analysis?.drawing?.north;
  if (plan && north && typeof north.imageUpBearingDeg === 'number' && north.source === 'image') {
    // 画像上の主な窓の外向き（u 右, v 下）→ 画像上の角度（上=0, 時計回り）＋ 画像上方向の方位角
    const n = plan.primaryWindow.normal;
    const imgAngle = (Math.atan2(n[0], -n[1]) * 180) / Math.PI;
    return { bearing: (north.imageUpBearingDeg + imgAngle + 360) % 360, basis: '図面の方位記号と窓の位置', status: 'image' };
  }
  const o = p.info?.orientation;
  const b = bearingFromText(o?.value);
  if (b != null) return { bearing: b, basis: `方位「${o.value}」（${o.source === 'image' ? '画像記載' : o.source === 'user' ? '入力' : '推定'}）`, status: o.source === 'image' || o.source === 'user' ? o.source : 'estimated' };
  return { bearing: 180, basis: '不明のため南向きに仮置き', status: 'missing' };
}

// 旧版（固定物件）からの移行とサンプル物件
export const SAMPLE = {
  name: 'ラティエラ武蔵小杉', unit: '312号室', address: '神奈川県川崎市中原区小杉町2丁目220',
  floor: 3, areaM2: 35.95, layout: '1LDK+SIC', buildingFloors: 6,
  lat: 35.57927, lon: 139.6556,
};

export function sampleProject() {
  const p = newProject();
  p.id = 'sample-latierra-312';
  const src = '三井の賃貸 掲載ページ（2026-10 時点の検索抜粋）';
  for (const [k, v] of Object.entries({ name: SAMPLE.name, unit: SAMPLE.unit, address: SAMPLE.address, floor: SAMPLE.floor, areaM2: SAMPLE.areaM2, layout: SAMPLE.layout, buildingFloors: SAMPLE.buildingFloors })) {
    p.info[k] = { value: v, source: 'listing', evidence: src };
  }
  p.info.orientation = { value: '西', source: 'estimated', evidence: '1階の同面積住戸が「西」と掲載（312号室は未確認）' };
  p.location = { lat: SAMPLE.lat, lon: SAMPLE.lon, label: 'OSM 建物 way 1350297048 の代表点', provider: 'preset', precision: 'building', confirmed: true, confirmedAt: new Date().toISOString(), forAddress: SAMPLE.address };
  p.sample = true;
  return p;
}

export async function migrateLegacy() {
  const list = await listProjects();
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem('walk-room-plan:latierra-musashikosugi-312') || 'null'); } catch { /* noop */ }
  if (legacy && !list.some((p) => p.id === 'sample-latierra-312')) {
    const p = sampleProject();
    p.analysis = legacy;
    p.analysisText = JSON.stringify(legacy, null, 2);
    await putProject(p);
    try { localStorage.removeItem('walk-room-plan:latierra-musashikosugi-312'); } catch { /* noop */ }
    return true;
  }
  return false;
}
