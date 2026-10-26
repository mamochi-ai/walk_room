// 間取りの取り込み：Claude に渡す指示文、返ってきた JSON の取り出し・検査・プレビュー・端末内保存。
// アプリは AI API を呼ばない。利用者が Claude（アプリ／Web）で画像を読ませ、結果をコピーして貼り付ける。
import { ringArea, pointInRing } from '../geo.js';

export const PLAN_FORMAT = 'walk-room-floorplan/1';

// 物件情報から指示文を作る（物件名は固定しない）
export function buildPrompt(property) {
  const u = property.unitInfo || {};
  return `添付する画像は賃貸住宅の間取り図です。3D で室内を歩くアプリに読み込むため、図を読み取って下記の JSON を作ってください。

# 対象住戸（掲載情報で確認済み）
- 物件：${property.name} ${property.unit}
- 階：${u.floor ?? '不明'}階 / 間取り：${u.layout ?? '不明'} / 専有面積：${u.areaM2 ?? '不明'}㎡

# 守ること
- 図に描かれていない壁・扉・窓・設備を作り足さない。読み取れない部分は省略し "uncertain" に書く。
- 図が対象住戸と違う可能性（間取りタイプ・面積・部屋番号の不一致など）があれば "mismatch" に理由を書く。
- 寸法が図に書かれていない場合は、専有面積（壁芯面積）や帖数（1帖≒1.62㎡）から縮尺を推定し、"dimensionStatus" に根拠を書く。

# 座標の決め方（単位 m）
- 窓・バルコニー側を上にして図を置く。u＝右方向、v＝下方向（窓側の外壁の室内側の面から奥へ）。
- 原点 [0,0] は窓側外壁の室内側の面の左端。バルコニーは含めない。
- 壁は中心線の両端 a・b で表す。開口の at は a からの開口中心までの距離。

# 出力（JSON だけをコードブロックで）
\`\`\`json
{
  "format": "${PLAN_FORMAT}",
  "unit": "${property.name} ${property.unit}",
  "mismatch": null,
  "ceilingHeight": { "value": 2.5, "status": "estimated" },
  "outline": [[0,0],[6.0,0],[6.0,6.5],[0,6.5]],
  "walls": [
    { "a": [0,0], "b": [6.0,0], "thickness": 0.15,
      "openings": [{ "type": "window", "at": 3.0, "width": 1.7, "sill": 0.0, "head": 2.0 }] },
    { "a": [0,3.5], "b": [6.0,3.5], "thickness": 0.1,
      "openings": [{ "type": "door", "at": 1.0, "width": 0.75, "head": 2.0 }] }
  ],
  "rooms": [{ "name": "LD", "area": "約9帖", "poly": [[0,0],[6.0,0],[6.0,3.5],[0,3.5]], "labelAt": [3.0,1.7], "wet": false }],
  "fixtures": [{ "type": "kitchen", "x": 5.0, "y": 4.5, "w": 1.8, "d": 0.65, "h": 0.85, "rot": 90, "label": "キッチン" }],
  "furniture": [],
  "entrance": [0.6, 6.0],
  "spawn": { "at": [3.0, 2.0], "yawDeg": 0 },
  "dimensionStatus": { "全体寸法": "専有面積35.95㎡と帖数から推定", "天井高": "記載なし・一般値で推定" },
  "uncertain": ["例：洗面所の扉の位置が判読できない"]
}
\`\`\`
（上の数値は形式の例です。実際の図から作ってください）
- 外周の壁・間仕切り壁をすべて walls に入れる。開口の type は door（開き戸・引き戸）／opening（扉のない開口）／window（窓・掃き出し窓。通れない）。
- rooms の wet は浴室・洗面・トイレなら true。fixtures の type は kitchen／bath／toilet／washbasin／washer／closet など。
- entrance は玄関の土間の中心、spawn は最初に立つ位置（yawDeg 0＝窓側を向く）。`;
}

// 貼り付けられた文から JSON を取り出す（```json ブロックや前後の文章を許容）
export function extractJson(text) {
  const t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('JSON が見つかりません。Claude の回答のコードブロックをそのまま貼り付けてください。');
  try {
    return JSON.parse(body.slice(s, e + 1));
  } catch (err) {
    throw new Error('JSON として読めません（' + err.message + '）。回答の途中で切れていないか確認してください。');
  }
}

const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && isFinite(v));
const OPEN_TYPES = new Set(['door', 'opening', 'window']);

// 検査：errors があれば取り込まない。warnings は確認を促す。
export function validatePlan(plan, property) {
  const errors = [], warnings = [];
  if (!plan || typeof plan !== 'object') return { errors: ['JSON の形式が違います'], warnings, area: 0 };
  if (!Array.isArray(plan.outline) || plan.outline.length < 3 || !plan.outline.every(isPt)) errors.push('outline（住戸の外周）が3点以上の座標になっていません');
  if (!Array.isArray(plan.walls) || !plan.walls.length) errors.push('walls（壁）がありません');
  let area = 0, minU = 0, maxU = 0, minV = 0, maxV = 0;
  if (!errors.length) {
    area = Math.abs(ringArea(plan.outline));
    minU = Math.min(...plan.outline.map((p) => p[0])); maxU = Math.max(...plan.outline.map((p) => p[0]));
    minV = Math.min(...plan.outline.map((p) => p[1])); maxV = Math.max(...plan.outline.map((p) => p[1]));
    if (maxU - minU > 40 || maxV - minV > 40) errors.push(`外周が大きすぎます（${(maxU - minU).toFixed(1)}m × ${(maxV - minV).toFixed(1)}m）。単位が m か確認してください`);
    if (minU < -0.3 || minV < -0.3) warnings.push('外周に負の座標があります（原点は窓側外壁の左端の想定）');
    const target = property?.unitInfo?.areaM2;
    if (target && area > 0) {
      const r = area / target;
      // 専有面積は壁芯。室内側の外周は 1割程度小さくなるのが普通
      if (r < 0.75 || r > 1.08) warnings.push(`外周の面積 ${area.toFixed(2)}㎡ が専有面積 ${target}㎡ と大きく違います（${Math.round(r * 100)}%）。縮尺を確認してください`);
    }
  }
  let doors = 0, windows = 0;
  (plan.walls || []).forEach((w, i) => {
    const n = `壁${i + 1}`;
    if (!isPt(w?.a) || !isPt(w?.b)) { errors.push(`${n}：a・b が座標になっていません`); return; }
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.05) errors.push(`${n}：長さが 0 です`);
    if (w.thickness !== undefined && !(w.thickness >= 0.03 && w.thickness <= 0.5)) errors.push(`${n}：厚さ ${w.thickness}m は範囲外です（0.03〜0.5m）`);
    for (const p of [w.a, w.b]) {
      if (p[0] < minU - 0.5 || p[0] > maxU + 0.5 || p[1] < minV - 0.5 || p[1] > maxV + 0.5) { errors.push(`${n}：外周から離れた位置にあります`); break; }
    }
    (w.openings || []).forEach((o, j) => {
      const on = `${n}の開口${j + 1}`;
      if (!OPEN_TYPES.has(o?.type)) { errors.push(`${on}：type は door／opening／window のいずれかにしてください`); return; }
      if (!(o.width > 0.3 && o.width < 6)) errors.push(`${on}：幅 ${o.width}m が不自然です`);
      if (!(typeof o.at === 'number') || o.at - o.width / 2 < -0.02 || o.at + o.width / 2 > L + 0.02) errors.push(`${on}：壁の範囲（長さ ${L.toFixed(2)}m）からはみ出しています`);
      if (o.type === 'window') windows++; else doors++;
    });
  });
  if (!windows) warnings.push('窓がありません');
  if (!doors) warnings.push('扉・開口がありません（部屋の間を移動できない可能性があります）');
  if (!isPt(plan.entrance)) errors.push('entrance（玄関の位置）がありません');
  else if (plan.outline?.every?.(isPt) && !pointInRing(plan.entrance[0], plan.entrance[1], plan.outline)) errors.push('玄関の位置が外周の外です');
  if (plan.spawn?.at && (!isPt(plan.spawn.at) || (plan.outline?.every?.(isPt) && !pointInRing(plan.spawn.at[0], plan.spawn.at[1], plan.outline)))) errors.push('spawn（最初に立つ位置）が外周の外です');
  for (const [k, list] of [['fixtures', plan.fixtures], ['furniture', plan.furniture]]) {
    (list || []).forEach((f, i) => {
      if (!(typeof f?.x === 'number' && typeof f?.y === 'number' && f.w > 0 && f.d > 0)) errors.push(`${k}${i + 1}：x・y・w・d を確認してください`);
    });
  }
  const h = plan.ceilingHeight?.value;
  if (h !== undefined && !(h >= 2.0 && h <= 3.5)) errors.push(`天井高 ${h}m が範囲外です（2.0〜3.5m）`);
  if (plan.mismatch) warnings.push(`対象住戸と違う可能性：${plan.mismatch}`);
  if (Array.isArray(plan.uncertain) && plan.uncertain.length) warnings.push(`読み取れなかった点：${plan.uncertain.join('、')}`);
  return { errors, warnings, area };
}

// 取り込んだ間取りを室内生成用に正規化
export function normalizePlan(plan, property) {
  return {
    ...plan,
    status: 'draft',
    importedFrom: 'claude-paste',
    importedAt: new Date().toISOString(),
    propertyId: property.id,
    ceilingHeight: plan.ceilingHeight?.value ? plan.ceilingHeight : { value: 2.5, status: 'estimated' },
    fixtures: plan.fixtures || [],
    furniture: plan.furniture || [],
    rooms: plan.rooms || [],
  };
}

// ---- 端末内保存（失敗しても動作は継続） ----
const key = (property) => `walk-room-plan:${property.id}`;
export function loadStoredPlan(property) {
  try { const s = localStorage.getItem(key(property)); return s ? JSON.parse(s) : null; } catch { return null; }
}
export function storePlan(property, plan) {
  try { localStorage.setItem(key(property), JSON.stringify(plan)); return true; } catch { return false; }
}
export function clearStoredPlan(property) {
  try { localStorage.removeItem(key(property)); } catch { /* noop */ }
}

// ---- 平面図プレビュー（元の間取り図と見比べる用。窓側が上） ----
export function drawPlanPreview(canvas, plan) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 320, H = canvas.clientHeight || 320;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const pts = [...plan.outline, ...(plan.walls || []).flatMap((w) => [w.a, w.b])].filter(isPt);
  const minU = Math.min(...pts.map((p) => p[0])), maxU = Math.max(...pts.map((p) => p[0]));
  const minV = Math.min(...pts.map((p) => p[1])), maxV = Math.max(...pts.map((p) => p[1]));
  const pad = 26;
  const s = Math.min((W - pad * 2) / (maxU - minU || 1), (H - pad * 2) / (maxV - minV || 1));
  const ox = (W - (maxU - minU) * s) / 2, oy = (H - (maxV - minV) * s) / 2;
  const T = (p) => [ox + (p[0] - minU) * s, oy + (p[1] - minV) * s];
  // 部屋
  for (const r of plan.rooms || []) {
    if (!r.poly?.every?.(isPt)) continue;
    g.fillStyle = r.wet ? '#dfe9ef' : '#f3ece0';
    g.beginPath(); r.poly.forEach((p, i) => { const [x, y] = T(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.fill();
  }
  g.strokeStyle = '#bbb'; g.lineWidth = 1; g.setLineDash([4, 3]);
  g.beginPath(); plan.outline.forEach((p, i) => { const [x, y] = T(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); g.stroke();
  g.setLineDash([]);
  // 設備
  for (const [list, col] of [[plan.fixtures, '#9aa7b0'], [plan.furniture, '#c8ab88']]) {
    for (const f of list || []) {
      if (typeof f.x !== 'number') continue;
      const [cx, cy] = T([f.x, f.y]);
      g.save(); g.translate(cx, cy); g.rotate(((f.rot || 0) * Math.PI) / 180);
      g.fillStyle = col; g.globalAlpha = 0.6; g.fillRect((-f.w / 2) * s, (-f.d / 2) * s, f.w * s, f.d * s); g.restore();
    }
  }
  // 壁と開口
  for (const w of plan.walls || []) {
    if (!isPt(w.a) || !isPt(w.b)) continue;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
    const at = (d) => T([w.a[0] + ux * d, w.a[1] + uy * d]);
    const ops = (w.openings || []).filter((o) => typeof o.at === 'number').map((o) => [o.at - o.width / 2, o.at + o.width / 2, o.type]).sort((a, b) => a[0] - b[0]);
    g.lineCap = 'butt';
    let cur = 0;
    const seg = (a, b, col, lw) => { const p = at(a), q = at(b); g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(...p); g.lineTo(...q); g.stroke(); };
    for (const [a, b, type] of ops) {
      if (a > cur) seg(cur, a, '#2b2f33', Math.max(2, (w.thickness ?? 0.12) * s));
      if (type === 'window') seg(a, b, '#4a90c8', 3);
      else if (type === 'door') seg(a, b, '#e0a050', 2);
      cur = Math.max(cur, b);
    }
    if (cur < L) seg(cur, L, '#2b2f33', Math.max(2, (w.thickness ?? 0.12) * s));
  }
  // ラベル・玄関・初期位置
  g.font = '600 12px -apple-system, "Hiragino Sans", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const r of plan.rooms || []) if (isPt(r.labelAt)) { const [x, y] = T(r.labelAt); g.fillStyle = '#333'; g.fillText(`${r.name || ''}${r.area ? ' ' + r.area : ''}`, x, y); }
  for (const f of plan.fixtures || []) if (f.label && typeof f.x === 'number') { const [x, y] = T([f.x, f.y]); g.fillStyle = '#334'; g.font = '11px -apple-system, sans-serif'; g.fillText(f.label, x, y); }
  if (isPt(plan.entrance)) { const [x, y] = T(plan.entrance); g.fillStyle = '#d9773b'; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.fillStyle = '#333'; g.fillText('玄関', x, y - 13); }
  if (isPt(plan.spawn?.at)) { const [x, y] = T(plan.spawn.at); g.fillStyle = '#2f6fae'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
  g.fillStyle = '#4a90c8'; g.textAlign = 'center'; g.font = '600 11px -apple-system, sans-serif';
  g.fillText('▲ 窓側（外）', W / 2, 11);
  // 縮尺 1m
  g.fillStyle = '#333'; g.fillRect(10, H - 12, s, 3); g.textAlign = 'left'; g.fillText('1m', 12 + s, H - 11);
}
