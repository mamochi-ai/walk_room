// 間取り・物件情報の解析データ（Claude とのコピー＆ペーストでやり取りする JSON）
// 形式: walk-room-floorplan/2（v1 も読み込み可能）
// アプリは AI API を呼ばない。利用者が Claude に画像と依頼文を渡し、返ってきた JSON を貼り付ける。
import { ringArea, pointInRing, closestOnSeg, ringCentroid } from '../geo.js';

export const FORMAT_V2 = 'walk-room-floorplan/2';
export const FORMAT_V1 = 'walk-room-floorplan/1';

export const INFO_FIELDS = [
  ['name', '物件名'], ['unit', '部屋番号'], ['address', '住所'], ['floor', '所在階'], ['areaM2', '専有面積(㎡)'],
  ['layout', '間取り'], ['orientation', '方位（住戸の向き）'], ['buildingFloors', '建物の階数'], ['stations', '最寄り駅'],
];
export const SOURCE_LABEL = { image: '画像記載', estimated: '推定', user: '入力・修正', listing: '掲載情報', null: '未入力' };
export const ROLE_LABEL = { floorplan: '間取り図', overview: '物件概要・募集ページ', other: 'その他' };

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(isNum);

// ---------------- 依頼文 ----------------
export function buildAnalysisPrompt(project) {
  const imgs = (project.images || []).map((im, i) => `- 画像${i + 1}：${ROLE_LABEL[im.role] || 'その他'}${im.name ? `（${im.name}）` : ''}`).join('\n') || '- （画像未登録）';
  const known = INFO_FIELDS.map(([k, label]) => {
    const f = project.info?.[k];
    return f && f.source === 'user' && f.value != null && f.value !== '' ? `- ${label}：${fmtValue(k, f.value)}（利用者が入力した値）` : null;
  }).filter(Boolean).join('\n');
  return `添付した画像は、賃貸・売買物件の間取り図と物件情報です。3Dで室内を歩くWebシステムに取り込むため、画像を読み取って、指定のJSONだけを返してください。

# 添付画像（この順で添付しています）
${imgs}
${known ? `\n# 利用者が入力済みの情報\n${known}\n` : ''}
# 1. 物件情報の読み取り
画像に書かれている次の情報を読み取ってください：物件名、部屋番号、住所、所在階、専有面積、間取り表記、方位、建物の階数、最寄り駅（記載があれば）。
- 各項目は {"value": 値, "source": "image" | "estimated" | null, "evidence": "どの画像のどこに書かれていたか"} で返す。
- 画像に書かれていない住所・部屋番号・方角は作らない。不明な値は value を null、source を null にする。
- 推定した値は source を "estimated" にし、evidence に根拠を書く。
- 複数の画像が別の物件・別の住戸のものである可能性があれば、"consistency" に理由を書く（物件名・部屋番号・面積・間取りの食い違いなど）。

# 2. 間取りの解析の優先順位
内装の見栄えより、間取りの形状と接続関係を優先してください。
1. 外周形状
2. 部屋の配置と大きさの比率
3. 廊下・玄関・各部屋のつながり
4. 壁の位置
5. ドア・引き戸・窓の位置と幅
6. 収納・水回り・キッチンの位置
7. 材質・色・家具などの装飾（不要）

# 3. 読み取り方法
いきなり一般的な間取りを作らず、画像内の実際の線・記号・文字を根拠に読み取ってください。
- 外周の凹凸を保つ。斜めの壁があれば斜めのまま保つ。
- 部屋を勝手に長方形に整えない（必要なら多角形で表す）。
- 廊下や収納を省略しない。
- 隣接しているだけの部屋に通路を作らない（開口は図に描かれているものだけ）。
- ドアの位置・開き方・引き戸かどうかを読み分ける。
- 窓と出入口を区別する（バルコニーへの掃き出し窓は "window_door"）。
- バルコニーは室内（outline・rooms）に含めず、balconies に入れる。
- 柱・PS（パイプスペース）など読み取れる固定部分も fixtures に入れる。
- 図面にない家具を置かない（furniture は空でよい）。
- 読めない箇所は推測で埋めず、uncertain に残す。

# 4. 寸法
- 画像に記載された寸法を最優先する。
- 寸法がない場合は、専有面積と図面上の比率から縮尺を推定する。ただし専有面積だけで各辺の正確な長さが決まるとは扱わない。
- 専有面積は通常「壁芯」面積なので、室内側の外周は少し小さくなる。
- dimensions に、主な寸法を「記載値（image）」「推定（estimated）」に分けて書く。
- 天井高・壁厚・窓の高さなど図面から分からない値は heights と thickness に仮値として入れ、source を "estimated" にする。

# 5. 座標と方位
- 単位はメートル。座標は画像の向きのまま：u＝画像の右方向、v＝画像の下方向。原点は間取りの外周（バルコニーを除く）を囲む矩形の左上。
- 画像の上方向を根拠なく北にしない。方位記号があれば drawing.north.imageUpBearingDeg に「画像の上方向が北から時計回りに何度か」を入れる（方位記号が無ければ null）。
- drawing.imageBox に、外周を囲む矩形が画像のどの範囲にあるかを、画像の幅・高さに対する割合 [左, 上, 右, 下]（0〜1）で入れる（重ね合わせ確認に使う）。
- 壁は中心線の両端 a・b。開口の at は a から開口中心までの距離、width は開口幅。

# 6. 出力前の検証
次を確認してから出力し、結果を checks に書いてください。解決できない不一致は隠さず toConfirm に書いてください。
- 各部屋が外周内に収まっているか
- 部屋同士が不自然に重なっていないか
- 壁や開口部の位置が整合しているか（開口が壁の範囲内か）
- 玄関から各居室へ、図面どおりに移動できるか（connections と開口が一致するか）
- 窓やドアが壁から浮いていないか
- 面積や縦横比に大きな矛盾がないか

# 7. 出力形式（JSONだけを1つのコードブロックで。数値は例）
\`\`\`json
{
  "format": "${FORMAT_V2}",
  "images": [{ "index": 1, "role": "floorplan", "content": "間取り図" }],
  "consistency": { "sameProperty": true, "notes": null },
  "property": {
    "name": { "value": "○○マンション", "source": "image", "evidence": "画像2 上部" },
    "unit": { "value": null, "source": null, "evidence": null },
    "address": { "value": null, "source": null, "evidence": null },
    "floor": { "value": 3, "source": "image", "evidence": "画像1 右下「3階」" },
    "areaM2": { "value": 35.95, "source": "image", "evidence": "画像1 右下" },
    "layout": { "value": "1LDK", "source": "image", "evidence": "画像1" },
    "orientation": { "value": null, "source": null, "evidence": "方位の記載なし" },
    "buildingFloors": { "value": null, "source": null, "evidence": null },
    "stations": { "value": [{ "name": "○○駅", "line": "○○線", "walkMin": 7 }], "source": "image", "evidence": "画像2 交通欄" }
  },
  "drawing": {
    "units": "m",
    "axes": "u=画像右, v=画像下, 原点=外周の外接矩形の左上",
    "scale": { "method": "dimension | area | ratio", "source": "estimated", "evidence": "専有面積と帖数から推定" },
    "north": { "imageUpBearingDeg": null, "source": null, "evidence": "方位記号なし" },
    "imageBox": { "imageIndex": 1, "box": [0.12, 0.10, 0.88, 0.92] }
  },
  "outline": [[0, 0], [6.2, 0], [6.2, 6.5], [0, 6.5]],
  "rooms": [
    { "id": "ld", "name": "LD", "type": "living", "area": { "value": "9.5帖", "source": "image" }, "poly": [[0, 0], [6.2, 0], [6.2, 3.6], [0, 3.6]] },
    { "id": "hall", "name": "廊下", "type": "hall", "poly": [[0, 3.6], [1.2, 3.6], [1.2, 6.5], [0, 6.5]] }
  ],
  "walls": [
    { "id": "w1", "a": [0, 0], "b": [6.2, 0], "exterior": true, "thickness": { "value": 0.18, "source": "estimated" },
      "openings": [{ "type": "window_door", "at": 3.1, "width": 1.7, "sill": 0, "head": 2.0, "between": ["ld", "balcony"], "source": "image" }] },
    { "id": "w2", "a": [0, 3.6], "b": [6.2, 3.6], "exterior": false, "thickness": { "value": 0.1, "source": "estimated" },
      "openings": [{ "type": "door", "at": 0.6, "width": 0.75, "swing": "LD側へ開く", "between": ["ld", "hall"], "source": "image" }] }
  ],
  "fixtures": [
    { "type": "kitchen", "label": "キッチン", "poly": [[4.4, 3.7], [6.1, 3.7], [6.1, 4.35], [4.4, 4.35]], "source": "image" },
    { "type": "ps", "label": "PS", "poly": [[5.8, 6.1], [6.2, 6.1], [6.2, 6.5], [5.8, 6.5]], "source": "image" }
  ],
  "balconies": [{ "poly": [[0, -1.4], [6.2, -1.4], [6.2, 0], [0, 0]], "source": "image" }],
  "furniture": [],
  "connections": [["entrance", "hall"], ["hall", "ld"]],
  "entrance": { "at": [0.6, 6.1], "source": "image" },
  "spawn": { "at": [3.1, 1.8], "lookAt": [3.1, 0] },
  "heights": {
    "ceiling": { "value": 2.4, "source": "estimated" },
    "doorHead": { "value": 2.0, "source": "estimated" },
    "windowSill": { "value": 0.9, "source": "estimated" },
    "windowHead": { "value": 2.0, "source": "estimated" }
  },
  "dimensions": [{ "label": "LD 横幅", "value": 6.2, "source": "estimated", "evidence": "面積と比率から" }],
  "checks": { "roomsInsideOutline": true, "noOverlap": true, "openingsOnWalls": true, "reachableFromEntrance": true, "areaConsistent": true, "notes": null },
  "uncertain": [],
  "toConfirm": []
}
\`\`\`
- 開口の type：door（開き戸）／sliding（引き戸）／opening（扉のない開口）／window（窓）／window_door（掃き出し窓）。
- 部屋の type：entrance／hall／living／dining／kitchen／bedroom／storage／closet／washroom／bath／toilet／other。
- fixtures の type：kitchen／bath／toilet／washbasin／washer／storage／shoebox／ps／column／other。
- 外周・間仕切りの壁はすべて walls に入れる。玄関の位置は entrance.at、最初に立つ位置は spawn.at。`;
}

// 修正内容を添えて再依頼（ゼロから解析し直さない）
export function buildRevisionPrompt(analysis, correction, project) {
  const json = JSON.stringify(stripInternal(analysis), null, 1);
  return `前回の解析結果（下のJSON）を、修正指示に従って直してください。
- 修正指示に関係する部分だけを変更し、それ以外の値・座標は維持してください。
- 画像に根拠がない値を作らないでください。直せない点は toConfirm に残してください。
- 出力形式は同じ "${FORMAT_V2}" のJSON全体を、1つのコードブロックで返してください。変更した点は "changes" 配列に短く書いてください。
- 同じ会話の続きなら画像の再添付は不要です。新しい会話の場合は、前回と同じ画像（${(project?.images || []).length}枚）を同じ順で添付してください。

# 修正指示（利用者より）
${correction.trim()}

# 前回の解析結果
\`\`\`json
${json}
\`\`\``;
}

function stripInternal(a) {
  const { _internal, ...rest } = a || {};
  void _internal;
  return rest;
}

export function fmtValue(k, v) {
  if (v == null || v === '') return '';
  if (k === 'stations' && Array.isArray(v)) return v.map((s) => [s.name, s.line, s.walkMin != null ? `徒歩${s.walkMin}分` : ''].filter(Boolean).join(' ')).join('、');
  if (k === 'areaM2') return `${v}㎡`;
  if (k === 'floor' || k === 'buildingFloors') return `${v}階`;
  return String(v);
}

// ---------------- JSON の取り出しとエラー位置 ----------------
export class JsonInputError extends Error {
  constructor(msg, info = {}) { super(msg); Object.assign(this, info); this.message = msg; }
}

export function extractJsonText(text, withOffset = false) {
  const raw = String(text || '');
  const t = raw.trim();
  if (!t) throw new JsonInputError('貼り付け欄が空です。Claude の回答を貼り付けてください。');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : t;
  const s = body.indexOf('{'), e = body.lastIndexOf('}');
  if (s < 0) throw new JsonInputError('JSON（{ から始まる部分）が見つかりません。Claude の回答のコードブロックをそのまま貼り付けてください。');
  if (e <= s) throw new JsonInputError('JSON の終わり（}）が見つかりません。回答が途中で切れている可能性があります。Claude に「続きを出力して」と頼むか、もう一度出力してもらってください。');
  const json = body.slice(s, e + 1);
  return withOffset ? { json, offset: raw.indexOf(json) } : json;
}

// 標準の JSON.parse は Safari で位置を返さないため、自前で位置を特定する
export function locateJsonError(src) {
  let i = 0;
  const err = (msg) => { throw Object.assign(new Error(msg), { pos: i }); };
  const ws = () => { while (i < src.length && ' \t\n\r'.includes(src[i])) i++; };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') return obj();
    if (c === '[') return arr();
    if (c === '"') return str();
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    for (const lit of ['true', 'false', 'null']) if (src.startsWith(lit, i)) { i += lit.length; return; }
    if (c === '“' || c === '”' || c === '「') err('全角の引用符（“ ” など）が使われています。半角の " にしてください');
    if (c === "'") err('シングルクォート（\'）は使えません。" にしてください');
    if (c === '/') err('コメント（// や /* */）は JSON に書けません');
    if (c === undefined) err('途中で終わっています（閉じ括弧が足りない可能性）');
    err(`ここに値が必要です（「${c}」は使えません）`);
  };
  const str = () => {
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') { i++; return; }
      if (c === '\n') err('文字列の途中で改行しています（" の閉じ忘れ）');
      i++;
    }
    err('文字列が閉じていません（" の閉じ忘れ）');
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (!m) err('数値の形式が正しくありません');
    i += m[0].length;
  };
  const arr = () => {
    i++; ws();
    if (src[i] === ']') { i++; return; }
    for (;;) {
      value(); ws();
      if (src[i] === ',') { i++; ws(); if (src[i] === ']') err('配列の最後に余分なカンマがあります'); continue; }
      if (src[i] === ']') { i++; return; }
      err(src[i] === undefined ? '配列が閉じていません（] が足りない）' : 'カンマ（,）または ] が必要です');
    }
  };
  const obj = () => {
    i++; ws();
    if (src[i] === '}') { i++; return; }
    for (;;) {
      ws();
      if (src[i] !== '"') err(src[i] === '}' ? 'オブジェクトの最後に余分なカンマがあります' : '項目名は " で囲んでください');
      str(); ws();
      if (src[i] !== ':') err('項目名のあとにコロン（:）が必要です');
      i++; value(); ws();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === '}') { i++; return; }
      err(src[i] === undefined ? 'オブジェクトが閉じていません（} が足りない）' : 'カンマ（,）または } が必要です');
    }
  };
  try {
    value(); ws();
    if (i < src.length) err('JSON の後ろに余分な文字があります');
    return null;
  } catch (e) {
    const before = src.slice(0, e.pos);
    const line = before.split('\n').length;
    const col = e.pos - before.lastIndexOf('\n');
    const lines = src.split('\n');
    const snippet = [line - 1, line].filter((n) => n >= 1).map((n) => `${String(n).padStart(4)}| ${lines[n - 1]}`).join('\n') + `\n      ${' '.repeat(Math.max(0, col - 1))}^`;
    return { message: e.message, line, col, snippet };
  }
}

export function parseAnalysisText(text) {
  const { json: body, offset } = extractJsonText(text, true);
  try {
    return JSON.parse(body);
  } catch {
    const loc = locateJsonError(body);
    // 貼り付け欄の中での行番号にそろえる（JSON の前の説明文の行数を足す）
    const before = offset > 0 ? String(text).slice(0, offset).split('\n').length - 1 : 0;
    if (loc) throw new JsonInputError(`貼り付けた文章の ${loc.line + before} 行目 ${loc.col} 文字目：${loc.message}`, loc);
    throw new JsonInputError('JSON として読めません。');
  }
}

// よくある誤りの自動修正（利用者がボタンを押したときだけ）
export function autoFixJson(text) {
  return String(text)
    .replace(/[“”＂]/g, '"')
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------- 正規化（v1/v2 → 室内生成用） ----------------
const WET = new Set(['bath', 'toilet', 'washroom', 'wc', 'unitbath']);
const FIXTURE_H = { kitchen: 0.85, bath: 0.55, toilet: 0.45, washbasin: 0.85, washer: 0.9, storage: 2.2, closet: 2.2, shoebox: 1.0, ps: 9, column: 9, other: 0.9 };
const val = (x, d) => (x && typeof x === 'object' && 'value' in x ? (isNum(x.value) ? x.value : d) : isNum(x) ? x : d);

export function normalizeAnalysis(a) {
  const v1 = a.format === FORMAT_V1 || (!a.format && !a.drawing && !a.property);
  const h = a.heights || {};
  const ceiling = v1 ? val(a.ceilingHeight, 2.5) : val(h.ceiling, 2.4);
  const doorHead = val(h.doorHead, 2.0), sill = val(h.windowSill, 0.9), wHead = val(h.windowHead, 2.0);
  const walls = (a.walls || []).map((w) => ({
    id: w.id,
    a: w.a, b: w.b,
    exterior: !!w.exterior,
    thickness: val(w.thickness, w.exterior ? 0.18 : 0.12),
    openings: (w.openings || []).map((o) => {
      const type = o.type === 'window_door' ? 'window_door' : o.type;
      const isWin = type === 'window' || type === 'window_door';
      return {
        type, at: o.at, width: o.width,
        sill: isWin ? (type === 'window_door' ? 0 : val(o.sill, sill)) : 0,
        head: val(o.head, isWin ? wHead : doorHead),
        swing: o.swing || null,
      };
    }),
  }));
  const rooms = (a.rooms || []).filter((r) => Array.isArray(r.poly) && r.poly.length >= 3 && r.poly.every(isPt)).map((r) => ({
    id: r.id || r.name,
    name: r.name || '',
    type: r.type || null,
    area: typeof r.area === 'object' && r.area ? r.area.value : r.area,
    poly: r.poly,
    labelAt: isPt(r.labelAt) ? r.labelAt : ringCentroid(r.poly),
    wet: r.wet ?? WET.has(r.type),
  }));
  const fixtures = (a.fixtures || []).map((f) => {
    const H = isNum(f.h) ? f.h : isNum(f.height) ? f.height : FIXTURE_H[f.type] ?? 0.9;
    if (Array.isArray(f.poly) && f.poly.length >= 3 && f.poly.every(isPt)) return { type: f.type, label: f.label, poly: f.poly, h: H, solid: f.solid !== false };
    if (isNum(f.x) && isNum(f.y) && f.w > 0 && f.d > 0) return { type: f.type, label: f.label, x: f.x, y: f.y, w: f.w, d: f.d, rot: f.rot || 0, h: H, solid: f.solid !== false };
    return null;
  }).filter(Boolean);
  const entrance = isPt(a.entrance) ? a.entrance : isPt(a.entrance?.at) ? a.entrance.at : null;
  const spawn = a.spawn?.at && isPt(a.spawn.at) ? { at: a.spawn.at, lookAt: isPt(a.spawn.lookAt) ? a.spawn.lookAt : null, yawDeg: v1 ? a.spawn.yawDeg : undefined } : null;
  const plan = {
    version: v1 ? 1 : 2,
    outline: a.outline,
    walls, rooms, fixtures,
    furniture: (a.furniture || []).filter((f) => isNum(f.x) && isNum(f.y) && f.w > 0 && f.d > 0),
    balconies: (a.balconies || []).filter((b) => Array.isArray(b.poly) && b.poly.length >= 3 && b.poly.every(isPt)).map((b) => ({ poly: b.poly })),
    entrance, spawn,
    ceilingHeight: { value: ceiling, status: 'estimated' },
  };
  plan.primaryWindow = findPrimaryWindow(plan, v1);
  return plan;
}

// 外向きの主な窓（住戸の向き・配置の基準）。v1 は v=0 の壁が窓側。
export function findPrimaryWindow(plan, v1 = false) {
  let best = null;
  for (const w of plan.walls) {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.1) continue;
    const width = w.openings.filter((o) => o.type === 'window' || o.type === 'window_door').reduce((s, o) => s + o.width * (o.type === 'window_door' ? 1.5 : 1), 0);
    if (!width) continue;
    const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
    let n = [uy, -ux];
    const m = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    if (plan.outline && pointInRing(m[0] + n[0] * 0.3, m[1] + n[1] * 0.3, plan.outline)) n = [-n[0], -n[1]];
    const outside = !plan.outline || !pointInRing(m[0] + n[0] * 0.3, m[1] + n[1] * 0.3, plan.outline);
    const score = width * (outside ? 2 : 0.5) * (v1 && Math.abs(m[1]) < 0.05 ? 3 : 1);
    if (!best || score > best.score) best = { score, mid: m, normal: n, thickness: w.thickness };
  }
  if (best) return best;
  // 窓が無い場合：外周の最初の辺を仮の基準にする
  const o = plan.outline;
  const a = o[0], b = o[1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
  const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (pointInRing(m[0] + n[0] * 0.3, m[1] + n[1] * 0.3, o)) n = [-n[0], -n[1]];
  return { mid: m, normal: n, thickness: 0.18, fallback: true };
}

// 解析データの物件情報 → プロジェクトの info へ（利用者が修正済みの項目は上書きしない）
export function mergeInfo(oldInfo = {}, property = {}) {
  const out = { ...oldInfo };
  for (const [k] of INFO_FIELDS) {
    const f = property[k];
    if (out[k]?.source === 'user') continue;
    if (f && typeof f === 'object' && 'value' in f) {
      const v = f.value === '' ? null : f.value;
      out[k] = { value: v, source: v == null ? null : f.source === 'image' ? 'image' : 'estimated', evidence: f.evidence || null };
    } else if (!out[k]) out[k] = { value: null, source: null, evidence: null };
  }
  return out;
}

// ---------------- 検証 ----------------
export function validateAnalysis(a, info = {}) {
  const errors = [], warnings = [];
  const add = (arr, msg) => arr.push(msg);
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { errors: ['JSON の一番外側が { } になっていません'], warnings, area: 0 };
  if (a.format && ![FORMAT_V1, FORMAT_V2].includes(a.format)) add(warnings, `形式 "${a.format}" は想定外です（${FORMAT_V2} として読み込みます）`);
  if (!Array.isArray(a.outline) || a.outline.length < 3 || !a.outline.every(isPt)) add(errors, 'outline（外周）：[u, v] の座標が3点以上必要です');
  if (!Array.isArray(a.walls) || !a.walls.length) add(errors, 'walls（壁）がありません');
  if (errors.length) return { errors, warnings, area: 0 };

  const plan = normalizeAnalysis(a);
  const O = plan.outline;
  const area = Math.abs(ringArea(O));
  const xs = O.map((p) => p[0]), ys = O.map((p) => p[1]);
  const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys);
  if (W > 40 || H > 40) add(errors, `外周が ${W.toFixed(1)}m × ${H.toFixed(1)}m と大きすぎます。単位が m か確認してください`);
  if (W < 1.5 || H < 1.5) add(errors, `外周が ${W.toFixed(1)}m × ${H.toFixed(1)}m と小さすぎます。単位が m か確認してください`);
  const aspect = Math.max(W, H) / Math.max(0.1, Math.min(W, H));
  if (aspect > 6) add(warnings, `外周の縦横比が ${aspect.toFixed(1)} と極端です`);
  const target = info.areaM2?.value ?? a.property?.areaM2?.value;
  if (isNum(target) && target > 0) {
    const r = area / target;
    if (r < 0.75 || r > 1.08) add(warnings, `外周の面積 ${area.toFixed(2)}㎡ が専有面積 ${target}㎡ の ${Math.round(r * 100)}% です（壁芯との差を考えても大きい）。縮尺を確認してください`);
  }
  const near = (p, ring, tol) => pointInRing(p[0], p[1], ring) || ring.some((q, i) => closestOnSeg(p[0], p[1], q[0], q[1], ring[(i + 1) % ring.length][0], ring[(i + 1) % ring.length][1]).d <= tol);

  // 壁と開口
  let doors = 0, windows = 0;
  plan.walls.forEach((w, i) => {
    const n = `壁${w.id ? `「${w.id}」` : i + 1}`;
    if (!isPt(w.a) || !isPt(w.b)) { add(errors, `${n}：a・b が座標になっていません`); return; }
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.05) add(errors, `${n}：長さが 0 です`);
    if (!(w.thickness >= 0.03 && w.thickness <= 0.6)) add(errors, `${n}：厚さ ${w.thickness}m は範囲外です（0.03〜0.6m）`);
    if (!near(w.a, O, 0.5) || !near(w.b, O, 0.5)) add(warnings, `${n}：外周から離れた位置にあります`);
    w.openings.forEach((o, j) => {
      const on = `${n}の開口${j + 1}`;
      if (!['door', 'sliding', 'opening', 'window', 'window_door'].includes(o.type)) { add(errors, `${on}：type「${o.type}」は使えません（door／sliding／opening／window／window_door）`); return; }
      if (!(o.width > 0.3 && o.width < 6)) add(errors, `${on}：幅 ${o.width}m が不自然です`);
      if (!isNum(o.at) || o.at - o.width / 2 < -0.03 || o.at + o.width / 2 > L + 0.03) add(errors, `${on}：壁（長さ ${L.toFixed(2)}m）の範囲からはみ出しています（at=${o.at}, 幅=${o.width}）`);
      if (o.type === 'window' || o.type === 'window_door') {
        windows++;
        const m = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
        const onEdge = O.some((q, k) => closestOnSeg(m[0], m[1], q[0], q[1], O[(k + 1) % O.length][0], O[(k + 1) % O.length][1]).d < 0.35);
        if (!onEdge) add(warnings, `${on}：窓が外周の壁にありません（内壁の窓は珍しいので確認してください）`);
      } else doors++;
    });
  });
  if (!windows) add(warnings, '窓がありません');
  if (!doors) add(warnings, 'ドア・開口がありません（部屋の間を移動できません）');

  // 部屋
  if (!plan.rooms.length) add(warnings, 'rooms（部屋）がありません。部屋名と床の色分けが表示されません');
  for (const r of plan.rooms) {
    const out = r.poly.filter((p) => !near(p, O, 0.15)).length;
    if (out) add(warnings, `部屋「${r.name}」の頂点 ${out} 個が外周の外にあります`);
  }
  const overlaps = roomOverlaps(plan.rooms);
  for (const [r1, r2, ar] of overlaps) add(warnings, `部屋「${r1}」と「${r2}」が約 ${ar.toFixed(1)}㎡ 重なっています`);

  // 玄関からの到達
  if (!plan.entrance) add(errors, 'entrance（玄関の位置）がありません');
  else if (!pointInRing(plan.entrance[0], plan.entrance[1], O)) add(errors, '玄関の位置が外周の外です');
  if (plan.spawn && !pointInRing(plan.spawn.at[0], plan.spawn.at[1], O)) add(errors, 'spawn（最初に立つ位置）が外周の外です');
  if (plan.entrance && plan.rooms.length) {
    const unreached = unreachableRooms(plan);
    if (unreached.length) add(warnings, `玄関から開口を通って行けない部屋があります：${unreached.join('、')}（扉の抜けや壁の位置を確認）`);
  }
  for (const f of plan.fixtures) {
    const pts = f.poly || [[f.x, f.y]];
    if (pts.some((p) => !near(p, O, 0.3))) add(warnings, `設備「${f.label || f.type}」が外周の外にあります`);
  }
  if (!isNum(plan.ceilingHeight.value) || plan.ceilingHeight.value < 2 || plan.ceilingHeight.value > 3.5) add(errors, `天井高 ${plan.ceilingHeight.value}m が範囲外です（2.0〜3.5m）`);

  // Claude 自身の申告
  if (a.consistency && a.consistency.sameProperty === false) add(warnings, `画像が別の物件・住戸の可能性：${a.consistency.notes || '理由の記載なし'}`);
  else if (a.consistency?.notes) add(warnings, `画像の整合性について：${a.consistency.notes}`);
  if (a.mismatch) add(warnings, `対象と違う可能性：${a.mismatch}`);
  for (const [k, v] of Object.entries(a.checks || {})) if (v === false) add(warnings, `Claude の自己検証で不合格：${k}`);
  if (Array.isArray(a.toConfirm) && a.toConfirm.length) add(warnings, `要確認（Claude 申告）：${a.toConfirm.join('、')}`);
  if (Array.isArray(a.uncertain) && a.uncertain.length) add(warnings, `読み取れなかった点：${a.uncertain.join('、')}`);
  return { errors, warnings, area, plan };
}

// 格子点で重なり面積を概算
function roomOverlaps(rooms) {
  const res = [];
  const step = 0.1;
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const A = rooms[i].poly, B = rooms[j].poly;
      const ax = A.map((p) => p[0]), ay = A.map((p) => p[1]), bx = B.map((p) => p[0]), by = B.map((p) => p[1]);
      const x0 = Math.max(Math.min(...ax), Math.min(...bx)), x1 = Math.min(Math.max(...ax), Math.max(...bx));
      const y0 = Math.max(Math.min(...ay), Math.min(...by)), y1 = Math.min(Math.max(...ay), Math.max(...by));
      if (x1 <= x0 || y1 <= y0) continue;
      let n = 0;
      for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) if (pointInRing(x, y, A) && pointInRing(x, y, B)) n++;
      const ar = n * step * step;
      if (ar > 0.3) res.push([rooms[i].name, rooms[j].name, ar]);
    }
  }
  return res;
}

// 開口（door/sliding/opening）の両側にある部屋をつないで、玄関の部屋から幅優先探索
export function unreachableRooms(plan) {
  const roomAt = (p) => plan.rooms.findIndex((r) => pointInRing(p[0], p[1], r.poly));
  const adj = plan.rooms.map(() => new Set());
  for (const w of plan.walls) {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.05) continue;
    const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
    for (const o of w.openings) {
      if (!['door', 'sliding', 'opening'].includes(o.type)) continue;
      const c = [w.a[0] + ux * o.at, w.a[1] + uy * o.at];
      const d = w.thickness / 2 + 0.2;
      const r1 = roomAt([c[0] + uy * d, c[1] - ux * d]), r2 = roomAt([c[0] - uy * d, c[1] + ux * d]);
      if (r1 >= 0 && r2 >= 0 && r1 !== r2) { adj[r1].add(r2); adj[r2].add(r1); }
    }
  }
  // 壁で仕切られていない隣接部屋（同じ空間を2つに分けた LD など）もつなぐ
  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      if (sharesOpenEdge(plan.rooms[i].poly, plan.rooms[j].poly, plan.walls)) { adj[i].add(j); adj[j].add(i); }
    }
  }
  const start = roomAt(plan.entrance);
  if (start < 0) return [];
  const seen = new Set([start]);
  const q = [start];
  while (q.length) for (const n of adj[q.shift()]) if (!seen.has(n)) { seen.add(n); q.push(n); }
  return plan.rooms.filter((r, i) => !seen.has(i) && !['storage', 'closet', 'ps'].includes(r.type)).map((r) => r.name);
}

function sharesOpenEdge(A, B, walls) {
  for (let i = 0; i < A.length; i++) {
    const p = A[i], q = A[(i + 1) % A.length];
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const onB = B.some((s, k) => closestOnSeg(m[0], m[1], s[0], s[1], B[(k + 1) % B.length][0], B[(k + 1) % B.length][1]).d < 0.05);
    if (!onB) continue;
    const walled = walls.some((w) => closestOnSeg(m[0], m[1], w.a[0], w.a[1], w.b[0], w.b[1]).d < Math.max(0.08, w.thickness));
    if (!walled) return true;
  }
  return false;
}

// ---------------- 2D プレビュー（元画像との重ね合わせ対応） ----------------
// view: { image: HTMLImageElement|null, mode: 'plan'|'image'|'overlay'|'side', opacity, dx, dy, scale, rot }
export function drawPlan2D(canvas, a, view = {}) {
  const plan = a.walls ? normalizeAnalysis(a) : a;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.clientWidth || 320, H = canvas.clientHeight || 320;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  const mode = view.mode || 'plan';
  const img = view.image;
  const halves = mode === 'side' && img ? (W >= H ? [[0, 0, W / 2, H], [W / 2, 0, W / 2, H]] : [[0, 0, W, H / 2], [0, H / 2, W, H / 2]]) : null;
  const imgArea = halves ? halves[0] : [0, 0, W, H];
  const planArea = halves ? halves[1] : [0, 0, W, H];

  const pts = [...plan.outline, ...plan.walls.flatMap((w) => [w.a, w.b]), ...plan.balconies.flatMap((b) => b.poly)].filter(isPt);
  const minU = Math.min(...pts.map((p) => p[0])), maxU = Math.max(...pts.map((p) => p[0]));
  const minV = Math.min(...pts.map((p) => p[1])), maxV = Math.max(...pts.map((p) => p[1]));
  const oMinU = Math.min(...plan.outline.map((p) => p[0])), oMaxU = Math.max(...plan.outline.map((p) => p[0]));
  const oMinV = Math.min(...plan.outline.map((p) => p[1])), oMaxV = Math.max(...plan.outline.map((p) => p[1]));

  // 画像の配置（画像全体を領域に収める）
  let imgRect = null;
  if (img && mode !== 'plan') {
    const [ax, ay, aw, ah] = imgArea;
    const s = Math.min((aw - 16) / img.naturalWidth, (ah - 16) / img.naturalHeight);
    imgRect = { x: ax + (aw - img.naturalWidth * s) / 2, y: ay + (ah - img.naturalHeight * s) / 2, w: img.naturalWidth * s, h: img.naturalHeight * s };
    g.globalAlpha = mode === 'overlay' ? 1 : 1;
    g.drawImage(img, imgRect.x, imgRect.y, imgRect.w, imgRect.h);
  }
  if (mode === 'image') return;

  // 平面図の座標変換
  let T;
  if (mode === 'overlay' && imgRect) {
    // imageBox（外周の外接矩形が画像のどこか）を初期位置にし、利用者の調整を加える
    const box = Array.isArray(view.box) && view.box.length === 4 ? view.box : [0.1, 0.1, 0.9, 0.9];
    const bx = imgRect.x + box[0] * imgRect.w, by = imgRect.y + box[1] * imgRect.h;
    const bw = (box[2] - box[0]) * imgRect.w, bh = (box[3] - box[1]) * imgRect.h;
    const sx = bw / Math.max(0.1, oMaxU - oMinU), sy = bh / Math.max(0.1, oMaxV - oMinV);
    const s = ((sx + sy) / 2) * (view.scale || 1);
    const cx = bx + bw / 2 + (view.dx || 0), cy = by + bh / 2 + (view.dy || 0);
    const rot = ((view.rot || 0) * Math.PI) / 180;
    const mu = (oMinU + oMaxU) / 2, mv = (oMinV + oMaxV) / 2;
    T = (p) => {
      const x = (p[0] - mu) * s, y = (p[1] - mv) * s;
      return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
    };
    g.globalAlpha = view.opacity ?? 0.6;
    T.s = s;
  } else {
    const [ax, ay, aw, ah] = planArea;
    const pad = 22;
    const s = Math.min((aw - pad * 2) / (maxU - minU || 1), (ah - pad * 2) / (maxV - minV || 1));
    const ox = ax + (aw - (maxU - minU) * s) / 2, oy = ay + (ah - (maxV - minV) * s) / 2;
    T = (p) => [ox + (p[0] - minU) * s, oy + (p[1] - minV) * s];
    T.s = s;
  }
  const s = T.s;
  const poly = (ps) => { g.beginPath(); ps.forEach((p, i) => { const [x, y] = T(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };
  const overlay = mode === 'overlay';
  for (const b of plan.balconies) { poly(b.poly); g.fillStyle = overlay ? 'rgba(160,200,160,0.35)' : '#e7efe2'; g.fill(); g.strokeStyle = '#8fb08a'; g.lineWidth = 1; g.stroke(); }
  for (const r of plan.rooms) { poly(r.poly); g.fillStyle = overlay ? (r.wet ? 'rgba(80,150,210,0.25)' : 'rgba(230,170,90,0.22)') : r.wet ? '#dfe9ef' : '#f3ece0'; g.fill(); g.strokeStyle = 'rgba(0,0,0,0.15)'; g.lineWidth = 1; g.stroke(); }
  poly(plan.outline); g.setLineDash([4, 3]); g.strokeStyle = overlay ? '#d33' : '#aaa'; g.lineWidth = 1.2; g.stroke(); g.setLineDash([]);
  for (const f of plan.fixtures) {
    g.fillStyle = overlay ? 'rgba(90,110,130,0.45)' : '#c3ccd3';
    if (f.poly) { poly(f.poly); g.fill(); } else {
      const [cx, cy] = T([f.x, f.y]);
      g.save(); g.translate(cx, cy); g.rotate(((f.rot || 0) * Math.PI) / 180 + ((view.rot || 0) * Math.PI) / 180 * (overlay ? 1 : 0));
      g.fillRect((-f.w / 2) * s, (-f.d / 2) * s, f.w * s, f.d * s); g.restore();
    }
  }
  for (const w of plan.walls) {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 0.01) continue;
    const ux = (w.b[0] - w.a[0]) / L, uy = (w.b[1] - w.a[1]) / L;
    const at = (d) => T([w.a[0] + ux * d, w.a[1] + uy * d]);
    const seg = (d0, d1, col, lw) => { const p = at(d0), q = at(d1); g.strokeStyle = col; g.lineWidth = lw; g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); };
    const ops = w.openings.filter((o) => isNum(o.at)).map((o) => [o.at - o.width / 2, o.at + o.width / 2, o.type]).sort((x, y) => x[0] - y[0]);
    let cur = 0;
    const wallCol = overlay ? 'rgba(200,30,30,0.9)' : '#2b2f33';
    const lw = Math.max(2, w.thickness * s);
    g.lineCap = 'butt';
    for (const [d0, d1, type] of ops) {
      if (d0 > cur) seg(cur, d0, wallCol, lw);
      if (type === 'window' || type === 'window_door') seg(d0, d1, '#3a8fd0', type === 'window_door' ? 4 : 3);
      else if (type === 'door') { seg(d0, d1, '#e09a3e', 2); const p = at(d0), q = at(d1); g.strokeStyle = '#e09a3e'; g.lineWidth = 1; g.beginPath(); g.arc(p[0], p[1], Math.hypot(q[0] - p[0], q[1] - p[1]), Math.atan2(q[1] - p[1], q[0] - p[0]) - Math.PI / 2, Math.atan2(q[1] - p[1], q[0] - p[0])); g.stroke(); }
      else if (type === 'sliding') { seg(d0, d1, '#e09a3e', 2); }
      cur = Math.max(cur, d1);
    }
    if (cur < L) seg(cur, L, wallCol, lw);
  }
  g.globalAlpha = 1;
  if (plan.entrance) { const [x, y] = T(plan.entrance); g.fillStyle = '#d9773b'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
  if (plan.spawn) { const [x, y] = T(plan.spawn.at); g.fillStyle = '#2f6fae'; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const r of plan.rooms) {
    const [x, y] = T(r.labelAt);
    g.font = '600 12px -apple-system, "Hiragino Sans", sans-serif';
    const t = `${r.name}${r.area ? ' ' + r.area : ''}`;
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.strokeText(t, x, y);
    g.fillStyle = overlay ? '#7a1010' : '#333';
    g.fillText(t, x, y);
  }
  for (const f of plan.fixtures) if (f.label) {
    const c = f.poly ? ringCentroid(f.poly) : [f.x, f.y];
    const [x, y] = T(c); g.font = '10px -apple-system, sans-serif'; g.fillStyle = '#334'; g.fillText(f.label, x, y);
  }
  if (plan.entrance) { const [x, y] = T(plan.entrance); g.font = '600 11px sans-serif'; g.fillStyle = '#333'; g.fillText('玄関', x, y - 12); }
  if (!overlay) {
    const [ax, , , ah] = planArea;
    g.fillStyle = '#333'; g.fillRect(ax + 10, planArea[1] + ah - 12, s, 3);
    g.textAlign = 'left'; g.font = '11px sans-serif'; g.fillText('1m', ax + 14 + s, planArea[1] + ah - 11);
  }
}
