// 物件の登録手順（iPad／iPhone だけで完結する）
// 1 画像 → 2 Claude に依頼 → 3 回答の貼り付け → 4 2D で確認・物件情報の修正 → 5 住所から位置を確定 → 歩く
import {
  buildAnalysisPrompt, buildRevisionPrompt, parseAnalysisText, validateAnalysis, mergeInfo, autoFixJson, drawPlan2D,
  INFO_FIELDS, SOURCE_LABEL, ROLE_LABEL, fmtValue, JsonInputError,
} from '../plan/format.js';
import { listProjects, getProject, putProject, deleteProject, putImage, getImage, deleteImage, imageFromFile, newId } from '../store.js';
import { newProject, displayName, steps, sampleProject } from '../project.js';
import { GEOCODERS } from '../config.js';
import { geocode } from '../geocode.js';
import { MapPicker } from './mappicker.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLAUDE_URL = 'https://claude.ai/new';
const STEPS = [['images', '画像'], ['request', 'Claudeに依頼'], ['paste', '貼り付け'], ['review', '確認'], ['location', '位置']];

let cur = null;
let step = 'images';
let onWalk = null;
let toast = (m) => console.log(m);
let map = null;
const urls = new Map(); // 画像 id → object URL
let reviewView = { mode: 'plan', opacity: 0.6 };
let geoResults = null;

export function initWizard(opts) {
  onWalk = opts.onWalk;
  toast = opts.toast || toast;
  $('wiz-home').addEventListener('click', () => showHome());
  $('home-new').addEventListener('click', async () => {
    const p = newProject();
    await putProject(p);
    openProject(p.id, 'images');
  });
  $('home-sample').addEventListener('click', async () => {
    const ex = await getProject('sample-latierra-312');
    if (!ex) await putProject(sampleProject());
    openProject('sample-latierra-312', 'review');
  });
}

// ---------------- 物件一覧 ----------------
export async function showHome() {
  destroyMap();
  $('wizard').hidden = true;
  $('home').hidden = false;
  const list = await listProjects();
  const el = $('home-list');
  if (!list.length) {
    el.innerHTML = '<p class="empty">まだ物件がありません。「新しい物件を登録」から間取り画像を追加してください。</p>';
    $('home-sample').hidden = false;
    return;
  }
  $('home-sample').hidden = list.some((p) => p.id === 'sample-latierra-312');
  el.innerHTML = list.map((p) => {
    const s = steps(p);
    const chip = (ok, label) => `<span class="chip ${ok ? 'ok' : 'miss'}">${ok ? '✓' : '・'} ${label}</span>`;
    const canWalk = s.analysis || s.location;
    return `<li class="proj">
      <div class="proj-main"><strong>${esc(displayName(p))}</strong>
        <small>${esc(p.info?.address?.value || '住所未入力')}</small>
        <div class="chips">${chip(s.images, '画像')}${chip(s.analysis, '間取り')}${chip(s.info, '住所')}${chip(s.location, '位置確定')}</div></div>
      <div class="proj-actions">
        <button type="button" data-open="${esc(p.id)}">開く</button>
        ${canWalk ? `<button type="button" class="primary" data-walk="${esc(p.id)}">歩く</button>` : ''}
        <button type="button" class="ghost" data-del="${esc(p.id)}">削除</button>
      </div></li>`;
  }).join('');
  el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openProject(b.dataset.open)));
  el.querySelectorAll('[data-walk]').forEach((b) => b.addEventListener('click', async () => { const p = await getProject(b.dataset.walk); $('home').hidden = true; onWalk(p); }));
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.confirm) {
      getProject(b.dataset.del).then((p) => p && deleteProject(p)).then(showHome);
    } else { b.dataset.confirm = '1'; b.textContent = 'もう一度押すと削除'; b.classList.add('danger'); }
  }));
}

// ---------------- 手順画面 ----------------
export async function openProject(id, startStep) {
  cur = await getProject(id);
  if (!cur) return showHome();
  const s = steps(cur);
  step = startStep || (!s.images ? 'images' : !s.analysis ? 'request' : !s.location ? 'review' : 'review');
  $('home').hidden = true;
  $('wizard').hidden = false;
  render();
}

async function save() {
  await putProject(cur);
}

function render() {
  destroyMap();
  $('wiz-title').textContent = displayName(cur);
  const s = steps(cur);
  const done = { images: s.images, request: s.analysis, paste: s.analysis, review: s.info, location: s.location };
  $('wiz-steps').innerHTML = STEPS.map(([k, l], i) => `<button type="button" data-step="${k}" aria-current="${k === step ? 'step' : 'false'}" class="${done[k] ? 'done' : ''}"><b>${i + 1}</b>${l}</button>`).join('');
  $('wiz-steps').querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { step = b.dataset.step; render(); }));
  const body = $('wiz-body');
  body.scrollTop = 0;
  ({ images: renderImages, request: renderRequest, paste: renderPaste, review: renderReview, location: renderLocation })[step](body);
}

function go(k) { step = k; render(); }

async function imgUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const rec = await getImage(id);
  if (!rec) return null;
  const u = URL.createObjectURL(rec.blob);
  urls.set(id, u);
  return u;
}

async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    toast('コピーしました');
    return true;
  } catch {
    if (fallbackEl) {
      fallbackEl.closest('details')?.setAttribute('open', '');
      fallbackEl.focus();
      fallbackEl.select();
    }
    toast('自動でコピーできませんでした。選択された文章を「コピー」してください', 4500);
    return false;
  }
}

// ---- 1 画像 ----
async function renderImages(body) {
  const imgs = cur.images;
  body.innerHTML = `
    <h2>1. 物件の画像を登録</h2>
    <p>間取り図の画像を追加してください。間取り図に住所などが載っていない場合は、物件概要や募集ページのスクリーンショットも追加できます。</p>
    <div class="row"><label class="btn primary" for="wz-file">画像を追加</label>
      <input id="wz-file" type="file" accept="image/*" multiple hidden></div>
    <p class="note">画像はこの端末のブラウザ内にだけ保存され、外部には送信しません（2D 図との見比べに使います）。Claude にはあとで写真アプリやファイルから同じ画像を添付してください。</p>
    <ol class="img-list" id="wz-imgs">${imgs.length ? '' : '<li class="empty">まだ画像がありません</li>'}</ol>
    <div class="wiz-next"><button type="button" class="primary" id="wz-next" ${imgs.length ? '' : 'disabled'}>次へ：Claude に依頼する</button></div>`;
  const list = body.querySelector('#wz-imgs');
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i];
    const li = document.createElement('li');
    li.innerHTML = `<img alt="画像${i + 1}" src="${esc((await imgUrl(im.id)) || '')}">
      <div class="img-meta"><strong>画像${i + 1}</strong>
        <select data-role="${i}" aria-label="画像${i + 1}の種類">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${im.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <small>${esc(im.name || '')}</small>
        <div class="row tight"><button type="button" data-up="${i}" ${i ? '' : 'disabled'} aria-label="前へ">↑</button><button type="button" data-down="${i}" ${i < imgs.length - 1 ? '' : 'disabled'} aria-label="後ろへ">↓</button><button type="button" class="ghost" data-rm="${i}">削除</button></div>
      </div>`;
    list.appendChild(li);
  }
  body.querySelector('#wz-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try {
        const { blob, w, h } = await imageFromFile(f);
        const id = newId('img');
        await putImage({ id, blob });
        cur.images.push({ id, role: cur.images.some((x) => x.role === 'floorplan') ? 'overview' : 'floorplan', name: f.name, w, h });
      } catch (err) { toast(err.message, 5000); }
    }
    await save();
    render();
  });
  list.querySelectorAll('[data-role]').forEach((s) => s.addEventListener('change', async () => { cur.images[+s.dataset.role].role = s.value; await save(); }));
  const move = async (i, d) => { const a = cur.images; [a[i], a[i + d]] = [a[i + d], a[i]]; await save(); render(); };
  list.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.up, -1)));
  list.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.down, 1)));
  list.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    const [im] = cur.images.splice(+b.dataset.rm, 1);
    await deleteImage(im.id);
    await save();
    render();
  }));
  body.querySelector('#wz-next').addEventListener('click', () => go('request'));
}

// ---- 2 Claude に依頼 ----
async function renderRequest(body) {
  const prompt = buildAnalysisPrompt(cur);
  const thumbs = await Promise.all(cur.images.map(async (im, i) => `<li><img alt="" src="${esc((await imgUrl(im.id)) || '')}"><span>画像${i + 1}<br><small>${ROLE_LABEL[im.role]}</small></span></li>`));
  body.innerHTML = `
    <h2>2. Claude に解析を依頼</h2>
    <ol class="howto">
      <li><button type="button" class="primary" id="wz-copy">依頼文をコピー</button></li>
      <li><a class="btn" id="wz-open" href="${CLAUDE_URL}" target="_blank" rel="noopener">Claude を開く</a>（新しい会話）</li>
      <li>入力欄を長押しして「ペースト」で依頼文を貼り付ける</li>
      <li>＋ボタンから、下の画像を<strong>この順番で</strong>添付する（写真アプリやファイルから）</li>
      <li>送信し、返ってきた JSON のコードブロックの「コピー」を押す</li>
      <li>このページに戻って「3. 貼り付け」へ進む</li>
    </ol>
    <p class="warn">Claude を開いても、依頼文や画像が自動で送られることはありません。貼り付けと添付はご自身で行ってください。</p>
    <ul class="thumb-row">${thumbs.join('') || '<li class="empty">画像が未登録です</li>'}</ul>
    <details><summary>依頼文を表示</summary><textarea id="wz-prompt" class="mono" rows="10" readonly>${esc(prompt)}</textarea></details>
    <div class="wiz-next"><button type="button" class="primary" id="wz-next">次へ：回答を貼り付ける</button></div>`;
  body.querySelector('#wz-copy').addEventListener('click', () => copyText(prompt, body.querySelector('#wz-prompt')));
  body.querySelector('#wz-next').addEventListener('click', () => go('paste'));
}

// ---- 3 貼り付け ----
function renderPaste(body) {
  body.innerHTML = `
    <h2>3. Claude の回答を貼り付け</h2>
    <p>Claude の回答（JSON のコードブロック）をそのまま貼り付けて「読み込む」を押してください。前後の説明文が混ざっていても構いません。</p>
    <textarea id="wz-input" class="mono" rows="12" placeholder="ここに貼り付け">${esc(cur.analysisText || '')}</textarea>
    <div class="row"><button type="button" id="wz-paste">クリップボードから貼り付け</button>
      <button type="button" class="primary" id="wz-load">読み込む</button></div>
    <div id="wz-msg"></div>`;
  const ta = body.querySelector('#wz-input');
  let timer;
  ta.addEventListener('input', () => { cur.analysisText = ta.value; clearTimeout(timer); timer = setTimeout(save, 600); });
  body.querySelector('#wz-paste').addEventListener('click', async () => {
    try { ta.value = await navigator.clipboard.readText(); cur.analysisText = ta.value; save(); } catch { toast('貼り付けできませんでした。入力欄を長押しして「ペースト」してください', 4500); }
  });
  body.querySelector('#wz-load').addEventListener('click', () => loadAnalysis(body, ta.value));
}

function loadAnalysis(body, text) {
  const msg = body.querySelector('#wz-msg');
  cur.analysisText = text;
  save();
  let a;
  try {
    a = parseAnalysisText(text);
  } catch (e) {
    const info = e instanceof JsonInputError ? e : {};
    msg.innerHTML = `<div class="msg error"><p><strong>読み込めませんでした。</strong>入力はそのまま残しています。</p><p>${esc(e.message)}</p>
      ${info.snippet ? `<pre class="snippet">${esc(info.snippet)}</pre>` : ''}
      <p class="note">よくある原因：回答の途中で切れている／全角の “ ” が混ざっている／最後の要素の後ろに余分なカンマ。</p>
      <div class="row"><button type="button" id="wz-fix">よくある誤りを自動修正して再読み込み</button></div></div>`;
    msg.querySelector('#wz-fix').addEventListener('click', () => {
      const ta = body.querySelector('#wz-input');
      ta.value = autoFixJson(ta.value);
      loadAnalysis(body, ta.value);
    });
    return;
  }
  const v = validateAnalysis(a, cur.info);
  if (v.errors.length) {
    const fixPrompt = buildRevisionPrompt(a, `次の問題を直してください：\n- ${v.errors.join('\n- ')}`, cur);
    msg.innerHTML = `<div class="msg error"><p><strong>JSON は読めましたが、室内を作れない問題があります。</strong></p>
      <ul>${v.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <p>下のボタンで、問題点を添えた再依頼文をコピーできます。Claude の同じ会話に貼り付けてください。</p>
      <div class="row"><button type="button" class="primary" id="wz-refix">問題点の再依頼文をコピー</button><a class="btn" href="${CLAUDE_URL}" target="_blank" rel="noopener">Claude を開く</a></div>
      <details><summary>再依頼文を表示</summary><textarea class="mono" rows="6" readonly id="wz-refix-text">${esc(fixPrompt)}</textarea></details></div>`;
    msg.querySelector('#wz-refix').addEventListener('click', () => copyText(fixPrompt, msg.querySelector('#wz-refix-text')));
    return;
  }
  cur.analysis = a;
  cur.info = mergeInfo(cur.info, a.property || {});
  // 重ね合わせの初期値（Claude が示した間取りの位置）
  const box = a.drawing?.imageBox;
  const idx = (box?.imageIndex || 1) - 1;
  const im = cur.images[idx] || cur.images.find((x) => x.role === 'floorplan') || cur.images[0];
  cur.overlay = { imageId: im?.id || null, box: Array.isArray(box?.box) ? box.box : null, dx: 0, dy: 0, scale: 1, rot: 0, opacity: 0.6 };
  save().then(() => { toast('読み込みました。2D 図を確認してください'); go('review'); });
}

// ---- 4 確認 ----
async function renderReview(body) {
  const a = cur.analysis;
  const v = a ? validateAnalysis(a, cur.info) : null;
  const ov = cur.overlay || {};
  const imgOpts = cur.images.map((im, i) => `<option value="${im.id}" ${ov.imageId === im.id ? 'selected' : ''}>画像${i + 1}（${ROLE_LABEL[im.role]}）</option>`).join('');
  const missing = INFO_FIELDS.filter(([k]) => cur.info?.[k]?.value == null || cur.info[k].value === '').map(([, l]) => l);
  const seg = (k, l) => `<button type="button" data-mode="${k}" aria-pressed="${reviewView.mode === k}">${l}</button>`;
  body.innerHTML = `
    <h2>4. 再現内容と物件情報を確認</h2>
    ${!a ? '<p class="msg warn">まだ解析結果がありません。「2. Claude に依頼」から進めてください。物件情報だけ先に入力することもできます。</p>' : `
    <div class="seg" id="wz-modes">${seg('plan', '2D図')}${seg('image', '元画像')}${seg('side', '並べる')}${seg('overlay', '重ねる')}</div>
    <div class="canvas-wrap"><canvas id="wz-canvas" class="plan-canvas"></canvas></div>
    <div id="wz-ovctl" class="ovctl" ${reviewView.mode === 'overlay' ? '' : 'hidden'}>
      <label>比べる画像 <select id="ov-img">${imgOpts}</select></label>
      <label>透明度 <input id="ov-op" type="range" min="0.1" max="1" step="0.05" value="${ov.opacity ?? 0.6}"></label>
      <label>縮尺 <input id="ov-sc" type="range" min="0.5" max="1.6" step="0.01" value="${ov.scale ?? 1}"></label>
      <label>回転 <input id="ov-rot" type="range" min="-180" max="180" step="1" value="${ov.rot ?? 0}"></label>
      <p class="note">2D 図を指でドラッグすると位置を動かせます。<button type="button" id="ov-reset" class="small">位置を戻す</button></p>
    </div>
    <p class="legend"><span class="lg wall"></span>壁 <span class="lg win"></span>窓 <span class="lg door"></span>ドア・引き戸 <span class="lg ent"></span>玄関 <span class="lg spawn"></span>最初の位置</p>
    <h3>確認事項</h3>
    ${v.errors.length ? `<ul class="msg error">${v.errors.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${v.warnings.length ? `<ul class="msg warn">${v.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="msg ok">自動チェックで大きな問題は見つかりませんでした。元画像と見比べて確認してください。</p>'}
    <p class="note">外周の面積 ${v.area.toFixed(2)}㎡。寸法は${a.drawing?.scale?.source === 'image' ? '図面の記載値を基に' : '推定を含む値で'}作られています（${esc(a.drawing?.scale?.evidence || '根拠の記載なし')}）。天井高・壁厚・窓の高さは仮値です。</p>
    ${Array.isArray(a.dimensions) && a.dimensions.length ? `<details><summary>寸法の根拠（${a.dimensions.length}件）</summary><dl class="kv">${a.dimensions.map((d) => `<dt>${esc(d.label)}</dt><dd>${esc(d.value)}m <span class="chip ${d.source === 'image' ? 'ok' : 'est'}">${SOURCE_LABEL[d.source] || '推定'}</span> ${esc(d.evidence || '')}</dd>`).join('')}</dl></details>` : ''}`}
    <h3>物件情報 ${missing.length ? `<span class="chip miss">未入力 ${missing.length}</span>` : ''}</h3>
    <p class="note">画像に書かれていた値は「画像記載」、Claude の推定は「推定」です。画像にない住所・部屋番号・方位は空欄のままにしてあります。必要なら入力してください。</p>
    <div class="info-form">${INFO_FIELDS.map(([k, label]) => infoRow(k, label)).join('')}</div>
    ${a ? `<h3>誤りを Claude に直してもらう</h3>
    <p class="note">間違っている点を短く書いてください（例：「洋室の右側の壁に窓はありません」「玄関は左下です」）。前回の解析結果と一緒に再依頼文を作るので、最初から解析し直す必要はありません。</p>
    <textarea id="wz-corr" class="mono" rows="3" placeholder="修正してほしい点">${esc(cur.lastCorrection || '')}</textarea>
    <div class="row"><button type="button" id="wz-revise" class="primary">再依頼文をコピー</button><a class="btn" href="${CLAUDE_URL}" target="_blank" rel="noopener">Claude を開く</a><button type="button" id="wz-topaste">新しい回答を貼り付ける</button></div>
    <details><summary>再依頼文を表示</summary><textarea id="wz-revtext" class="mono" rows="6" readonly></textarea></details>` : ''}
    <div class="wiz-next"><button type="button" class="primary" id="wz-next">次へ：住所から位置を確認</button></div>`;

  // 物件情報の編集
  body.querySelectorAll('[data-info]').forEach((inp) => inp.addEventListener('change', async () => {
    const k = inp.dataset.info;
    let val = inp.value.trim();
    if (['floor', 'buildingFloors'].includes(k)) val = val === '' ? null : parseInt(val, 10);
    else if (k === 'areaM2') val = val === '' ? null : parseFloat(val);
    else if (val === '') val = null;
    if (typeof val === 'number' && !isFinite(val)) val = null;
    cur.info[k] = { value: val, source: val == null ? null : 'user', evidence: val == null ? null : '利用者が入力・修正' };
    await save();
    render();
    if (k === 'address' && cur.location?.confirmed) toast('住所が変わりました。5. 位置で地図の位置を確認し直してください', 5000);
  }));
  body.querySelector('#wz-next').addEventListener('click', () => go('location'));
  if (!a) return;

  // 図の表示
  const canvas = body.querySelector('#wz-canvas');
  let image = null;
  const loadImage = async () => {
    image = null;
    const id = cur.overlay?.imageId || cur.images[0]?.id;
    const u = id ? await imgUrl(id) : null;
    if (u) image = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = u; });
  };
  const draw = () => drawPlan2D(canvas, a, { ...cur.overlay, image, mode: reviewView.mode, opacity: cur.overlay?.opacity ?? 0.6 });
  await loadImage();
  draw();
  body.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    reviewView.mode = b.dataset.mode;
    body.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    body.querySelector('#wz-ovctl').hidden = reviewView.mode !== 'overlay';
    if (reviewView.mode !== 'plan' && !image) toast('比べる画像がありません。1. 画像で登録してください', 4000);
    draw();
  }));
  const ovSave = () => { clearTimeout(ovSave.t); ovSave.t = setTimeout(save, 500); };
  body.querySelector('#ov-img')?.addEventListener('change', async (e) => { cur.overlay.imageId = e.target.value; await loadImage(); draw(); ovSave(); });
  for (const [id, key] of [['ov-op', 'opacity'], ['ov-sc', 'scale'], ['ov-rot', 'rot']]) {
    body.querySelector('#' + id)?.addEventListener('input', (e) => { cur.overlay[key] = parseFloat(e.target.value); draw(); ovSave(); });
  }
  body.querySelector('#ov-reset')?.addEventListener('click', () => { Object.assign(cur.overlay, { dx: 0, dy: 0, scale: 1, rot: 0 }); render(); save(); });
  // ドラッグで位置合わせ
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { if (reviewView.mode !== 'overlay') return; drag = { x: e.clientX, y: e.clientY, dx: cur.overlay.dx || 0, dy: cur.overlay.dy || 0 }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (!drag) return; cur.overlay.dx = drag.dx + e.clientX - drag.x; cur.overlay.dy = drag.dy + e.clientY - drag.y; draw(); });
  const end = () => { if (drag) { drag = null; ovSave(); } };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  const ro = new ResizeObserver(() => draw());
  ro.observe(canvas);

  // 再依頼
  const corr = body.querySelector('#wz-corr');
  corr.addEventListener('input', () => { cur.lastCorrection = corr.value; ovSave(); });
  body.querySelector('#wz-revise').addEventListener('click', () => {
    if (!corr.value.trim()) { toast('修正してほしい点を入力してください'); corr.focus(); return; }
    const withInfo = { ...a, property: { ...(a.property || {}), ...Object.fromEntries(INFO_FIELDS.filter(([k]) => cur.info[k]?.source === 'user').map(([k]) => [k, { value: cur.info[k].value, source: 'user', evidence: '利用者が入力・修正（変更しないこと）' }])) } };
    const text = buildRevisionPrompt(withInfo, corr.value, cur);
    const ta = body.querySelector('#wz-revtext');
    ta.value = text;
    cur.revisions = [...(cur.revisions || []), { at: new Date().toISOString(), correction: corr.value.trim() }];
    save();
    copyText(text, ta);
  });
  body.querySelector('#wz-topaste').addEventListener('click', () => { cur.analysisText = ''; save(); go('paste'); });
}

function infoRow(k, label) {
  const f = cur.info?.[k] || { value: null, source: null };
  const has = f.value != null && f.value !== '';
  const src = has ? f.source || 'estimated' : null;
  const cls = { image: 'ok', user: 'ok', listing: 'ok', estimated: 'est' }[src] || 'miss';
  const type = ['floor', 'buildingFloors', 'areaM2'].includes(k) ? 'number' : 'text';
  const v = k === 'stations' ? fmtValue(k, f.value) : f.value ?? '';
  return `<div class="info-row ${has ? '' : 'missing'}">
    <label for="info-${k}">${label} <span class="chip ${cls}">${SOURCE_LABEL[src] || SOURCE_LABEL.null}</span></label>
    <input id="info-${k}" data-info="${k}" type="${type}" ${type === 'number' ? 'inputmode="decimal" step="any"' : ''} value="${esc(v)}" placeholder="${has ? '' : '未入力（不明なら空欄のまま）'}">
    ${f.evidence ? `<small>${esc(f.evidence)}</small>` : ''}
  </div>`;
}

// ---- 5 位置 ----
function renderLocation(body) {
  const addr = cur.info?.address?.value || '';
  const loc = cur.location;
  const stale = loc?.confirmed && loc.forAddress !== addr;
  let provider = null;
  try { provider = localStorage.getItem('walk-room-geocoder'); } catch { /* noop */ }
  const consent = (p) => { try { return localStorage.getItem('walk-room-geocoder-ok:' + p) === '1'; } catch { return false; } };
  body.innerHTML = `
    <h2>5. 住所から物件の位置を確定</h2>
    <div class="info-row"><label for="loc-addr">住所 <span class="chip ${addr ? (cur.info.address.source === 'estimated' ? 'est' : 'ok') : 'miss'}">${SOURCE_LABEL[addr ? cur.info.address.source : null]}</span></label>
      <input id="loc-addr" type="text" value="${esc(addr)}" placeholder="例：神奈川県川崎市中原区小杉町2丁目220"></div>
    ${stale ? '<p class="msg warn">住所が変わったため、位置を確認し直してください。</p>' : loc?.confirmed ? `<p class="msg ok">確定済み：${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}（${esc(loc.label || '')}）</p>` : ''}
    <h3>住所から候補を探す</h3>
    <div class="geo-choice">${Object.entries(GEOCODERS).map(([k, g]) => `
      <label class="geo-opt"><input type="radio" name="geo" value="${k}" ${provider === k ? 'checked' : ''}>
        <span><strong>${esc(g.label)}</strong><br><small>${esc(g.terms)} <a href="${g.policy}" target="_blank" rel="noopener">利用条件</a></small></span></label>`).join('')}
      <label class="geo-ok"><input type="checkbox" id="geo-consent"> 選んだサービスの利用条件を確認しました</label>
    </div>
    <div class="row"><button type="button" id="geo-search" class="primary">候補を探す</button></div>
    <div id="geo-results"></div>
    <h3>地図で確認</h3>
    <div class="seg" id="pin-mode">
      <button type="button" data-pm="pin" aria-pressed="true">物件の位置を置く</button>
      <button type="button" data-pm="entrance" aria-pressed="false">建物入口を置く</button>
      <button type="button" data-pm="none" aria-pressed="false">地図を動かすだけ</button></div>
    <div id="wz-map" class="map-box"></div>
    <p class="note">地図をタップするとピンを置けます。ピンはドラッグで動かせます。住所の位置は町丁目の代表点のこともあるため、建物の上に合わせてください。建物入口が分からない場合は置かなくて構いません（道路側の仮位置になります）。</p>
    <p id="pin-status" class="note"></p>
    <div class="row"><button type="button" id="loc-confirm" class="primary">この位置で確定</button><button type="button" id="ent-clear">入口を未確認に戻す</button></div>
    <div class="wiz-next"><button type="button" class="primary big" id="wz-walk">歩いてみる</button></div>`;

  const radios = body.querySelectorAll('input[name=geo]');
  const cb = body.querySelector('#geo-consent');
  const sync = () => { const p = [...radios].find((r) => r.checked)?.value; cb.checked = p ? consent(p) : false; body.querySelector('#geo-search').disabled = !p || !cb.checked; };
  radios.forEach((r) => r.addEventListener('change', () => { try { localStorage.setItem('walk-room-geocoder', r.value); } catch { /* noop */ } sync(); }));
  cb.addEventListener('change', () => { const p = [...radios].find((r) => r.checked)?.value; if (p) try { localStorage.setItem('walk-room-geocoder-ok:' + p, cb.checked ? '1' : '0'); } catch { /* noop */ } sync(); });
  sync();

  const addrInput = body.querySelector('#loc-addr');
  addrInput.addEventListener('change', async () => {
    const v = addrInput.value.trim() || null;
    cur.info.address = { value: v, source: v ? 'user' : null, evidence: v ? '利用者が入力・修正' : null };
    geoResults = null;
    await save();
    render();
  });

  // 地図
  const pending = { pin: loc ? { lat: loc.lat, lon: loc.lon, label: loc.label, provider: loc.provider, precision: loc.precision } : null, entrance: cur.entrance ? { ...cur.entrance } : null };
  const center = loc || pending.pin || { lat: 35.681, lon: 139.767, zoom: 12 };
  map = new MapPicker(body.querySelector('#wz-map'), { lat: center.lat, lon: center.lon, zoom: loc ? 18 : center.zoom || 16 });
  window.__wizardMap = map;
  const status = () => {
    body.querySelector('#pin-status').textContent = [
      pending.pin ? `物件の位置：${pending.pin.lat.toFixed(6)}, ${pending.pin.lon.toFixed(6)}${pending.pin.provider === 'manual' ? '（地図で指定）' : ''}` : '物件の位置：未指定',
      pending.entrance ? `建物入口：${pending.entrance.lat.toFixed(6)}, ${pending.entrance.lon.toFixed(6)}（地図で指定）` : '建物入口：未確認',
    ].join(' ／ ');
    body.querySelector('#loc-confirm').disabled = !pending.pin || !addr;
  };
  map.onChange = (kind, ll, user) => {
    if (kind === 'pin') pending.pin = { ...(user ? { label: '地図で指定', provider: 'manual', precision: { level: 'user', label: '利用者が地図で指定' } } : pending.pin), lat: ll.lat, lon: ll.lng };
    else pending.entrance = { lat: ll.lat, lon: ll.lng, source: 'user' };
    status();
  };
  if (pending.pin) map.setPin(pending.pin.lat, pending.pin.lon);
  if (pending.entrance) map.setEntrance(pending.entrance.lat, pending.entrance.lon);
  status();
  body.querySelectorAll('[data-pm]').forEach((b) => b.addEventListener('click', () => {
    map.mode = b.dataset.pm === 'none' ? null : b.dataset.pm;
    body.querySelectorAll('[data-pm]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));
  body.querySelector('#ent-clear').addEventListener('click', () => { pending.entrance = null; map.clearEntrance(); status(); });

  const showResults = (r) => {
    const el = body.querySelector('#geo-results');
    if (!r) { el.innerHTML = ''; return; }
    if (!r.list.length) { el.innerHTML = `<p class="msg warn">候補が見つかりませんでした。住所の表記を変えて探すか、地図をタップして位置を指定してください。</p>`; map.showCandidates([]); return; }
    el.innerHTML = `<p class="note">候補 ${r.list.length} 件（${esc(GEOCODERS[r.provider].label)}${r.cached ? '・保存済みの結果' : ''}）。自動では選びません。正しい候補をタップしてください。</p>
      <ol class="cand-list">${r.list.map((c, i) => `<li><button type="button" data-cand="${i}"><b>${i + 1}</b><span>${esc(c.label)}<br><small>${esc(c.precision.label)}</small></span></button></li>`).join('')}</ol>
      <p class="note">${esc(GEOCODERS[r.provider].attribution)}</p>`;
    const pick = (i) => {
      const c = r.list[i];
      pending.pin = { lat: c.lat, lon: c.lon, label: c.label, provider: c.provider, precision: c.precision };
      map.setPin(c.lat, c.lon);
      map.focus(c.lat, c.lon, c.precision.level === 'building' ? 18 : 17);
      el.querySelectorAll('[data-cand]').forEach((b) => b.classList.toggle('picked', +b.dataset.cand === i));
      status();
      if (c.precision.level !== 'building') toast('この候補は建物の位置ではない可能性があります。ピンを建物の上に動かしてください', 5000);
    };
    el.querySelectorAll('[data-cand]').forEach((b) => b.addEventListener('click', () => pick(+b.dataset.cand)));
    map.showCandidates(r.list, pick);
  };
  if (geoResults && geoResults.query === addr) showResults(geoResults);
  body.querySelector('#geo-search').addEventListener('click', async () => {
    const p = [...radios].find((r) => r.checked)?.value;
    if (!addr) { toast('住所を入力してください'); return; }
    const btn = body.querySelector('#geo-search');
    btn.disabled = true; btn.textContent = '検索中…';
    try {
      geoResults = await geocode(p, addr);
      showResults(geoResults);
    } catch (e) {
      body.querySelector('#geo-results').innerHTML = `<p class="msg error">${esc(e.message)}。通信状況を確認するか、地図をタップして位置を指定してください。</p>`;
    } finally { btn.disabled = false; btn.textContent = '候補を探す'; }
  });

  body.querySelector('#loc-confirm').addEventListener('click', async () => {
    cur.location = { ...pending.pin, confirmed: true, confirmedAt: new Date().toISOString(), forAddress: addr };
    cur.entrance = pending.entrance ? { ...pending.entrance, source: 'user' } : null;
    await save();
    toast('物件の位置を確定しました');
    // 地図は作り直さず、表示だけ更新する
    const note = body.querySelector('#loc-done') || body.querySelector('#pin-status').insertAdjacentElement('beforebegin', Object.assign(document.createElement('p'), { id: 'loc-done', className: 'msg ok' }));
    note.textContent = `確定済み：${cur.location.lat.toFixed(6)}, ${cur.location.lon.toFixed(6)}（${cur.location.label || ''}）`;
    $('wiz-steps').querySelector('[data-step="location"]')?.classList.add('done');
  });
  body.querySelector('#wz-walk').addEventListener('click', async () => {
    const s = steps(cur);
    if (!s.analysis && !s.location) { toast('間取りの読み込みか位置の確定のどちらかが必要です'); return; }
    if (!s.location) toast('位置が未確定のため、周辺の街は表示されません', 4000);
    destroyMap();
    $('wizard').hidden = true;
    onWalk(cur);
  });
}

function destroyMap() {
  if (map) { map.destroy(); map = null; }
}
