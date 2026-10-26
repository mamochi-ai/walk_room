// Playwright によるブラウザ動作確認（合成データを使用。実データではない）
// 使い方: python3 -m http.server 8765 &  → node tests/make-fixtures.mjs → node tests/e2e.mjs
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://localhost:8765/';
const SHOTS = process.env.SHOTS || new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const FX = new URL('./fixtures/', import.meta.url).pathname;
const fx = (n) => readFileSync(FX + n);
const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); }
}

async function setupRoutes(page, opts = {}) {
  const log = { far: 0, overpass: 0, geocode: 0, nominatim: 0 };
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith(BASE)) {
      if (url.includes('/data/area.json')) return route.fulfill({ status: 404, body: '' });
      return route.continue();
    }
    if (url.startsWith('https://overpass-api.de/')) {
      log.overpass++;
      if (opts.overpassFailTimes && log.overpass <= opts.overpassFailTimes) return route.fulfill({ status: 504, body: 'timeout' });
      const body = decodeURIComponent(req.postData() || '');
      return route.fulfill({ body: fx(body.includes('highway') ? 'overpass-main.json' : 'overpass-buildings.json'), contentType: 'application/json' });
    }
    if (url.startsWith('https://api.plateauview.mlit.go.jp/')) {
      if (url.endsWith('/all-bldg-lod1-latest/tileset.json')) return route.fulfill({ body: fx(opts.plateauFar ? 'tileset-far.json' : 'tileset.json'), contentType: 'application/json' });
      if (url.endsWith('/bldg.b3dm')) return route.fulfill({ body: fx('bldg.b3dm'), contentType: 'application/octet-stream' });
      if (url.endsWith('/far.b3dm')) { log.far++; return route.fulfill({ status: 404, body: '' }); }
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.startsWith('https://msearch.gsi.go.jp/')) { log.geocode++; return route.fulfill({ body: fx('gsi-geocode.json'), contentType: 'application/json' }); }
    if (url.startsWith('https://nominatim.openstreetmap.org/')) { log.nominatim++; return route.fulfill({ body: '[]', contentType: 'application/json' }); }
    if (url.startsWith('https://cyberjapandata.gsi.go.jp/')) return route.fulfill({ body: PNG1x1, contentType: 'image/png' });
    return route.abort();
  });
  return log;
}

async function newPage(browser, device, opts = {}) {
  const ctx = await browser.newContext({ ...device, permissions: ['clipboard-read', 'clipboard-write'] });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const log = await setupRoutes(page, opts);
  await page.goto(BASE);
  await page.waitForSelector('#home:not([hidden])');
  return { ctx, page, errors, log };
}

const S = (page, f, a) => page.evaluate(f, a);
const state = (page) => S(page, () => { const s = window.__app.state; return { mode: s.mode, pos: { ...s.pos }, yaw: s.yaw, dest: s.dest?.id || null }; });
const blockAt = (page) => S(page, () => { const s = window.__app.state; const nav = s.mode === 'indoor' ? s.interior.nav : s.nav; return nav.blockReason(s.pos.x, s.pos.z, 0.25); });
const clip = (page) => S(page, () => navigator.clipboard.readText());
async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 2, radiusY: 2, force: 1 })) });
}
function overlaps(a, b) { return a && b && !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y); }
async function noOverlap(page, ids, W, H) {
  const boxes = {};
  for (const id of ids) { const el = await page.$(id); boxes[id] = el && (await el.isVisible()) ? await el.boundingBox() : null; }
  let ok = true;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (overlaps(boxes[ids[i]], boxes[ids[j]])) { ok = false; console.log('    重なり:', ids[i], ids[j]); }
  const inside = Object.values(boxes).every((b) => !b || (b.x >= -1 && b.x + b.width <= W + 1 && b.y >= -1 && b.y + b.height <= H + 1));
  return ok && inside;
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const iPad = { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };
const iPhone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };

// ---------- 1. iPhone：画像登録 → 依頼文 → 貼り付け → 確認 → 位置 → 歩く ----------
console.log('\n[1] iPhone 縦：画像登録から歩くまで');
{
  const { ctx, page, errors, log } = await newPage(browser, iPhone);
  await page.screenshot({ path: SHOTS + 'iphone-home.png' });
  await page.click('#home-new');
  await page.waitForSelector('#wz-file', { state: 'attached' });
  await page.setInputFiles('#wz-file', [FX + 'floorplan.png', FX + 'overview.png']);
  await page.waitForFunction(() => document.querySelectorAll('.img-list img').length === 2);
  const roles = await page.$$eval('.img-list select', (s) => s.map((x) => x.value));
  check(roles[0] === 'floorplan' && roles[1] === 'overview', `複数画像を登録（種類: ${roles.join(',')}）`);
  await page.screenshot({ path: SHOTS + 'iphone-step1.png' });
  await page.click('#wz-next');

  // 依頼文
  await page.click('#wz-copy');
  const prompt = await clip(page);
  check(prompt.includes('画像1：間取り図') && prompt.includes('画像2：物件概要'), '依頼文に添付画像の順番と種類');
  check(['外周形状', '隣接しているだけの部屋に通路を作らない', '画像の上方向を根拠なく北にしない', '作らない。不明な値は value を null', '専有面積だけで各辺の正確な長さが決まるとは扱わない', '玄関から各居室へ', 'walk-room-floorplan/2'].every((t) => prompt.includes(t)), '依頼文に優先順位・読み取り方法・寸法・方位・検証・形式');
  check((await page.getAttribute('#wz-open', 'href')) === 'https://claude.ai/new', 'Claude を開くリンク');
  check((await page.textContent('#wiz-body')).includes('自動で送られることはありません'), '自動送信されないことを明記');
  await page.screenshot({ path: SHOTS + 'iphone-step2.png' });
  await page.click('#wz-next');

  // 不正な JSON：入力を消さず、位置を示す
  const bad = '回答です\n```json\n{\n  "format": "walk-room-floorplan/2",\n  "outline": [[0,0],[1,0],],\n  "walls": []\n}\n```';
  await page.fill('#wz-input', bad);
  await page.click('#wz-load');
  let msg = await page.textContent('#wz-msg');
  check(msg.includes('5 行目') && msg.includes('余分なカンマ'), `JSON の誤り箇所を表示: ${msg.match(/貼り付けた文章の[^。]*/)?.[0]}`);
  check((await page.inputValue('#wz-input')) === bad, '不正でも入力を消さない');
  await page.click('#wz-fix');
  msg = await page.textContent('#wz-msg');
  check(msg.includes('walls（壁）がありません') && msg.includes('再依頼文'), '自動修正後、内容の問題点と再依頼文を表示');
  await page.click('#wz-refix');
  check((await clip(page)).includes('walls（壁）がありません'), '問題点を添えた再依頼文をコピー');
  // 正しい回答
  const good = 'はい。\n```json\n' + fx('analysis-v2.json').toString() + '\n```\n以上です。';
  await page.fill('#wz-input', good);
  await page.click('#wz-load');
  await page.waitForSelector('#wz-canvas');
  check(true, '正しい回答を読み込んで確認画面へ');

  // 確認画面
  const infoTxt = await page.textContent('.info-form');
  check(await page.inputValue('#info-name') === 'テスト用マンション' && infoTxt.includes('画像記載'), '画像の物件情報を取り込み（画像記載）');
  check(await page.inputValue('#info-address') === '' && (await page.$('.info-row.missing #info-address')) !== null, '画像にない住所は空欄（未入力として表示）');
  check((await page.inputValue('#info-stations')).includes('テスト駅'), '最寄り駅を取り込み');
  await page.screenshot({ path: SHOTS + 'iphone-review-plan.png' });
  for (const m of ['image', 'side', 'overlay']) {
    await page.click(`[data-mode="${m}"]`);
    await page.waitForTimeout(150);
  }
  check(await page.isVisible('#ov-op'), '重ね合わせで透明度・縮尺・回転を調整できる');
  const box = await (await page.$('#wz-canvas')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10); await page.mouse.up();
  await page.waitForTimeout(800);
  const ov = await S(page, async () => (await (await import('/js/store.js')).listProjects())[0].overlay);
  check(Math.abs(ov.dx - 30) < 2, `ドラッグで位置合わせ（dx=${ov.dx}）`);
  await page.screenshot({ path: SHOTS + 'iphone-review-overlay.png' });
  // 修正の再依頼
  await page.fill('#wz-corr', '洋室の右側の窓はありません');
  await page.click('#wz-revise');
  const rev = await clip(page);
  check(rev.includes('洋室の右側の窓はありません') && rev.includes('"w5"') && rev.includes('それ以外の値・座標は維持'), '修正指示と前回の解析結果をまとめた再依頼文');
  // 住所を入力（利用者による入力）
  await page.fill('#info-address', 'テスト県テスト市1-2-3');
  await page.dispatchEvent('#info-address', 'change');
  await page.waitForTimeout(200);
  check((await page.textContent('.info-form')).includes('入力・修正'), '住所を入力すると「入力・修正」として区別');
  await page.click('#wz-next');

  // 位置
  await page.waitForSelector('#wz-map .leaflet-container, #wz-map.leaflet-container');
  check(await page.isDisabled('#geo-search'), '住所検索はサービスを選び利用条件を確認するまで使えない');
  await page.check('input[name=geo][value=gsi]');
  await page.check('#geo-consent');
  await page.click('#geo-search');
  await page.waitForSelector('.cand-list');
  const status0 = await page.textContent('#pin-status');
  check((await page.$$('.cand-list button')).length === 2 && status0.includes('物件の位置：未指定'), '候補が複数あっても自動で選ばない');
  check(await page.isDisabled('#loc-confirm'), '候補を選ぶまで確定できない');
  await page.screenshot({ path: SHOTS + 'iphone-location.png' });
  await page.click('[data-cand="1"]');
  await page.click('[data-pm="entrance"]');
  const mb = await (await page.$('#wz-map')).boundingBox();
  await page.mouse.click(mb.x + mb.width / 2 + 40, mb.y + mb.height / 2 + 40);
  const st = await page.textContent('#pin-status');
  check(st.includes('物件の位置：35.5792') && st.includes('建物入口：'), '物件位置と入口のピンを別々に置ける');
  await page.click('#loc-confirm');
  await page.waitForTimeout(300);
  check((await page.textContent('#wiz-body')).includes('確定済み'), '位置を確定');
  check(log.geocode === 1, '住所検索の問い合わせは1回だけ');
  await page.click('#wz-walk');
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  const d = await S(page, () => { const a = window.__app.state.data; return { b: a.buildings.length, target: a.target?.footprintSource, ex: a.excludedAtTarget.length, pois: a.pois.length, notes: a.notes }; });
  check(d.target === 'OpenStreetMap' && d.ex === 1, `物件位置の建物を対象に（PLATEAU の低い旧建物は階数と矛盾するため除外）`);
  await page.click('#btn-start');
  await page.waitForTimeout(700);
  let s = await state(page);
  check(s.mode === 'indoor' && (await blockAt(page)) === null, '室内から開始・初期位置が壁に埋まらない');
  check((await page.textContent('#title-name')) === 'テスト用マンション', '物件名を表示');
  const notes = await page.textContent('#notices');
  check(notes.includes('仮配置') && notes.includes('Claude読み取り'), '仮配置・読み取り由来を表示');
  const facing = await S(page, () => window.__app.state.facing);
  check(facing.bearing === 180 && facing.basis.includes('南'), `住戸の向きは画像の方位「南」から（${facing.basis}）`);
  await page.screenshot({ path: SHOTS + 'iphone-indoor.png' });
  // 室内の壁・扉
  const r = await S(page, () => {
    const i = window.__app.state.interior, nav = i.nav, w = i.toWorld;
    const at = (u, v) => { const p = w(u, v); return nav.blockReason(p[0], p[1], 0.25); };
    return { wall: at(3.0, 3.6), door: at(1.0, 3.6), sliding: at(1.6, 5.1), noLink: at(3.6, 5.0), balcony: at(3.2, -0.6), room: at(5.0, 5.0) };
  });
  check(r.wall === 'wall' && r.noLink === 'wall', '壁は通れない（開口のない間仕切りも）');
  check(r.door === null && r.sliding === null, 'ドア・引き戸は通れる');
  check(r.balcony === 'wall', 'バルコニー（室外）には出られない');
  await S(page, () => { const s = window.__app.state, p = s.interior.toWorld(1.0, 3.0), q = s.interior.toWorld(1.0, 5.0); s.pos.x = p[0]; s.pos.z = p[1]; s.yaw = Math.atan2(-(q[0] - p[0]), -(q[1] - p[1])); });
  await page.keyboard.down('w'); await page.waitForTimeout(1600); await page.keyboard.up('w');
  const passed = await S(page, () => { const s = window.__app.state, a = s.interior.toWorld(1.0, 3.6), b = s.interior.toWorld(1.0, 3.0); return (s.pos.x - a[0]) * (a[0] - b[0]) + (s.pos.z - a[1]) * (a[1] - b[1]) > 0.3; });
  check(passed, 'LD から扉を通って廊下へ歩ける');
  await S(page, () => { const s = window.__app.state, p = s.interior.toWorld(0.8, 5.9); s.pos.x = p[0]; s.pos.z = p[1]; });
  await page.waitForTimeout(200);
  check(await page.isVisible('#btn-action'), '玄関に近づくと「建物の外へ」');
  await page.click('#btn-action');
  await page.waitForTimeout(700);
  s = await state(page);
  check(s.mode === 'outdoor' && (await blockAt(page)) === null, '屋外へ（道路上・建物外）');
  const ent = await S(page, () => window.__app.state.entrance.status);
  check(ent === 'user', '地図で置いた入口ピンから屋外に出る');
  check(await noOverlap(page, ['.title', '.tools', '#notices', '#minimap', '#bottombar'], 390, 844), 'iPhone 縦で歩行画面の UI が重ならない');
  await page.screenshot({ path: SHOTS + 'iphone-outdoor.png' });
  check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);

  // 住所を変えると位置の確認が必要になる
  await page.click('#btn-settings');
  await page.click('#s-edit');
  await page.fill('#info-address', 'テスト県テスト市9-9-9');
  await page.dispatchEvent('#info-address', 'change');
  await page.waitForTimeout(300);
  await page.click('[data-step="location"]');
  check((await page.textContent('#wiz-body')).includes('住所が変わったため、位置を確認し直してください'), '住所を変更すると位置の再確認を求める');
  await page.click('#wz-walk');
  await page.waitForTimeout(500);
  check((await page.textContent('#load-text')).includes('位置が未確定'), '位置未確定なら周辺の街を作らない（室内のみ）');
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  check((await state(page)).mode === 'indoor' && (await page.textContent('#notices')).includes('周辺の街は未表示'), '外部データなしでも室内は使える');
  await ctx.close();
}

// ---------- 2. iPad 横：屋外の操作・施設・ミニマップ ----------
console.log('\n[2] iPad 横：サンプル物件で屋外の操作');
{
  const { ctx, page, errors } = await newPage(browser, iPad);
  await page.click('#home-sample');
  await page.waitForSelector('#wz-canvas, .info-form');
  check(await page.inputValue('#info-address') !== '', 'サンプル物件は住所・位置が設定済み');
  await page.screenshot({ path: SHOTS + 'ipad-review-empty.png' });
  await page.click('#wiz-home');
  await page.click('[data-walk="sample-latierra-312"]');
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  await page.click('#btn-start');
  await page.waitForTimeout(700);
  check((await state(page)).mode === 'window', '間取り未取り込みなら窓から見る（推定）');
  await page.click('#btn-action');
  await page.waitForTimeout(700);
  check((await state(page)).mode === 'outdoor' && (await blockAt(page)) === null, '屋外へ');
  // 建物への衝突
  await S(page, () => { const s = window.__app.state; s.pos.x = 40; s.pos.z = 0; s.yaw = -Math.PI / 2; });
  await page.keyboard.down('w'); await page.waitForTimeout(1500); await page.keyboard.up('w');
  let st = await state(page);
  check(st.pos.x < 55 && (await blockAt(page)) === null, `建物に入れない（x=${st.pos.x.toFixed(2)}）`);
  // 範囲の端（500m）
  await S(page, () => { const s = window.__app.state; s.pos.x = 40; s.pos.z = -495; s.yaw = 0; });
  await page.keyboard.down('w'); await page.waitForTimeout(2000); await page.keyboard.up('w');
  st = await state(page);
  check(Math.hypot(st.pos.x, st.pos.z) <= 500.01 && (await page.textContent('#toast')).includes('範囲外'), `範囲の端（500m）で停止し案内（r=${Math.hypot(st.pos.x, st.pos.z).toFixed(1)}）`);
  // 同時タッチ
  await S(page, () => window.__app.enterOutdoor());
  await page.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(page);
  const a0 = await state(page);
  await touch(cdp, 'touchStart', [{ x: 200, y: 600, id: 1 }, { x: 900, y: 400, id: 2 }]);
  for (let i = 1; i <= 10; i++) { await touch(cdp, 'touchMove', [{ x: 200, y: 600 - i * 5, id: 1 }, { x: 900 + i * 12, y: 400, id: 2 }]); await page.waitForTimeout(60); }
  const a1 = await state(page);
  check(Math.hypot(a1.pos.x - a0.pos.x, a1.pos.z - a0.pos.z) > 0.2 && Math.abs(a1.yaw - a0.yaw) > 0.2, '移動と視点変更を同時に操作');
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(150);
  const p2 = (await state(page)).pos; await page.waitForTimeout(400); const p3 = (await state(page)).pos;
  check(Math.hypot(p3.x - p2.x, p3.z - p2.z) < 0.01, '指を離すと停止');
  // 施設
  await page.click('#btn-poi');
  await page.click('[data-f="supermarket"]');
  await page.click('.poi-list button');
  await page.click('#poi-dest');
  await page.waitForTimeout(300);
  const hud = await page.textContent('#dest-hud');
  check(hud.includes('直線距離') && hud.includes('道路経路'), '目的地の直線距離と道路経路');
  // 方位の一致
  const dir = await S(page, () => { const app = window.__app, s = app.state; s.pos.x = 40; s.pos.z = 0; s.yaw = 0; s.pitch = 0;
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => { const cam = app.camera; const f = cam.getWorldDirection(new cam.position.constructor()); res({ fx: f.x, fz: f.z, px: new cam.position.constructor(400, 5, -300).project(cam).x }); }))); });
  check(Math.abs(dir.fx) < 0.01 && dir.fz < -0.99 && dir.px > 0, 'ミニマップ（北が上）と3Dの方位が一致');
  check(await noOverlap(page, ['.title', '.tools', '#notices', '#minimap', '#dest-hud', '#bottombar'], 1180, 820), 'iPad 横で UI が重ならない');
  await page.screenshot({ path: SHOTS + 'ipad-outdoor.png' });
  await page.click('#btn-data');
  const dt = await page.textContent('#panel-body');
  check(dt.includes('掲載情報') && dt.includes('地理院タイル') && dt.includes('PLATEAU') && dt.includes('住戸の向き'), '出典・物件情報の出所・配置の根拠を表示');
  await page.screenshot({ path: SHOTS + 'ipad-data.png' });
  check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------- 3. PLATEAU 整備範囲外・取得失敗 ----------
console.log('\n[3] PLATEAU 範囲外／取得失敗と再試行');
{
  const { ctx, page } = await newPage(browser, iPad, { plateauFar: true });
  await page.click('#home-sample');
  await page.waitForSelector('.info-form');
  await page.click('#wiz-home');
  await page.click('[data-walk="sample-latierra-312"]');
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  const d = await S(page, () => { const a = window.__app.state.data; return { out: a.sources.plateau.outOfArea, osm: a.buildings.filter((b) => b.src === 'osm').length, notes: a.notes.join(' ') }; });
  check(d.out && d.osm === 1 && d.notes.includes('整備範囲外'), 'PLATEAU 範囲外を表示し、OSM の建物外形で代用（高さ推定）');
  await ctx.close();
}
{
  const { ctx, page } = await newPage(browser, iPad, { overpassFailTimes: 1 });
  // 間取り付きの物件を作る
  await S(page, async (j) => {
    const st = await import('/js/store.js'); const pr = await import('/js/project.js');
    const p = pr.sampleProject(); p.analysis = JSON.parse(j); await st.putProject(p);
  }, fx('analysis-v2.json').toString());
  await page.reload();
  await page.waitForSelector('[data-walk="sample-latierra-312"]');
  await page.click('[data-walk="sample-latierra-312"]');
  await page.waitForSelector('#load-error:not([hidden])', { timeout: 30000 });
  check((await page.textContent('#load-error-text')).includes('取得できませんでした'), '取得失敗を表示');
  check(!(await page.isDisabled('#btn-start')), '取得失敗でも室内は表示できる');
  await page.click('#btn-retry');
  await page.waitForFunction(() => document.getElementById('load-text').textContent.includes('準備完了'), null, { timeout: 30000 });
  check(true, '再試行で成功');
  await ctx.close();
}

// ---------- 4. 旧版データの移行と WebGL 非対応 ----------
console.log('\n[4] 旧版の保存データ・WebGL 非対応');
{
  const legacy = fx('test-floorplan.json').toString();
  const { ctx, page } = await newPage(browser, iPad, { init: `if (!sessionStorage.getItem('x')) { localStorage.setItem('walk-room-plan:latierra-musashikosugi-312', ${JSON.stringify(legacy)}); sessionStorage.setItem('x','1'); }` });
  await page.waitForSelector('[data-walk="sample-latierra-312"]');
  check(true, '旧版で取り込んだ間取りをサンプル物件として引き継ぐ');
  await page.click('[data-walk="sample-latierra-312"]');
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  check((await state(page)).mode === 'indoor' && (await blockAt(page)) === null, '旧形式（v1）の間取りでも室内を歩ける');
  await ctx.close();
}
{
  const ctx = await browser.newContext(iPad);
  await ctx.addInitScript(() => { const o = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : o.call(this, t, ...a); }; });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(500);
  check(await page.isVisible('#nowebgl'), 'WebGL が使えない場合は説明を表示');
  await ctx.close();
}

// ---------- 5. iPad 横：手順画面のレイアウト ----------
console.log('\n[5] iPad 横：確認画面');
{
  const { ctx, page } = await newPage(browser, iPad);
  await S(page, async (j) => { const st = await import('/js/store.js'); const pr = await import('/js/project.js'); const p = pr.newProject(); p.analysis = JSON.parse(j); await st.putProject(p); }, fx('analysis-v2.json').toString());
  await page.reload();
  await page.waitForSelector('[data-open]');
  await page.click('[data-open]');
  await page.click('[data-step="review"]');
  await page.waitForSelector('#wz-canvas');
  const sw = await S(page, () => document.documentElement.scrollWidth <= window.innerWidth);
  check(sw, '横スクロールが発生しない');
  await page.screenshot({ path: SHOTS + 'ipad-review.png' });
  await ctx.close();
}

await browser.close();
console.log(`\n結果: ${passes} 件成功 / ${failures} 件失敗`);
process.exit(failures ? 1 : 0);
