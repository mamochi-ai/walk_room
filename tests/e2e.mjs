// Playwright によるブラウザ動作確認（合成データを使用）
// 使い方: python3 -m http.server 8765 &  → node tests/make-fixtures.mjs → node tests/e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8765/';
const SHOTS = process.env.SHOTS || new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });
const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url));

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); }
}

async function setupRoutes(page, opts = {}) {
  const log = { far: 0, overpass: 0, tileset: [] };
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) {
      if (opts.floorplan && url.includes('/data/unit-312.json')) return route.fulfill({ body: fx('test-floorplan.json'), contentType: 'application/json' });
      return route.continue();
    }
    if (url.startsWith('https://overpass-api.de/')) {
      log.overpass++;
      if (opts.overpassFailTimes && log.overpass <= opts.overpassFailTimes) return route.fulfill({ status: 504, body: 'timeout' });
      return route.fulfill({ body: fx('overpass-main.json'), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.startsWith('https://api.plateauview.mlit.go.jp/')) {
      log.tileset.push(url);
      if (url.includes('/14133-')) return route.fulfill({ status: 404, body: 'not found' });
      if (url.endsWith('/14130-bldg-lod1-2022/tileset.json')) return route.fulfill({ body: fx('tileset.json'), contentType: 'application/json' });
      if (url.endsWith('/bldg.b3dm')) return route.fulfill({ body: fx('bldg.b3dm'), contentType: 'application/octet-stream' });
      if (url.endsWith('/far.b3dm')) { log.far++; return route.fulfill({ status: 404, body: '' }); }
    }
    return route.abort();
  });
  return log;
}

async function newPage(browser, device, opts) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // PLATEAU の候補URLの 404 は想定どおり（次の候補へフォールバック）
  page.on('console', (m) => { if (m.type() === 'error' && !(m.location().url || '').includes('api.plateauview')) errors.push(m.text()); });
  const log = await setupRoutes(page, opts);
  await page.goto(BASE);
  return { ctx, page, errors, log };
}

const S = (page, f) => page.evaluate(f);
const state = (page) => S(page, () => { const s = window.__app.state; return { mode: s.mode, pos: { ...s.pos }, yaw: s.yaw, pitch: s.pitch, dest: s.dest?.id || null }; });
const blockAt = (page) => S(page, () => { const s = window.__app.state; const nav = s.mode === 'indoor' ? s.interior.nav : s.nav; return nav.blockReason(s.pos.x, s.pos.z, 0.25); });

async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 2, radiusY: 2, force: 1 })) });
}

function overlaps(a, b) {
  return a && b && !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const iPad = { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };
const iPhone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 };

// ---------- 1. iPad 横：屋外・施設・ミニマップ ----------
console.log('\n[1] iPad 横画面：読み込み〜屋外〜施設');
{
  const { ctx, page, errors, log } = await newPage(browser, iPad);
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  const d = await S(page, () => { const a = window.__app.state.data; return { b: a.buildings.length, ex: a.excludedAtTarget.length, ids: a.buildings.map((x) => x.id), target: !!a.target, pois: a.pois.length, walkHw: a.walk.map((w) => w.hw), plateau: a.sources.plateau.ok, h: a.buildings.map((x) => x.h) }; });
  check(d.plateau, 'PLATEAU 3D Tiles（合成）を解析できた（候補URLのフォールバック込み）');
  check(d.b === 3 && d.ids.includes('TEST_bldg_L'), `建物3棟（L字含む）を取得: ${d.ids.join(',')}`);
  check(d.h.every((h) => h > 11 && h < 46), `高さを b3dm の形状から算出: ${d.h.join(', ')}`);
  check(d.ex === 1 && !d.ids.includes('TEST_bldg_OLD_AT_TARGET'), '対象敷地に重なる旧建物を除外');
  check(d.target, '対象建物の外形（OSM）を取得');
  check(d.pois === 3, `施設3件（コンビニ・スーパー・駅）: ${d.pois}`);
  check(!d.walkHw.includes('service'), '私道（service=driveway）を歩行可能道路から除外');
  check(log.far === 0, '範囲外のタイルを取得しない');
  const ring = await S(page, () => window.__app.state.data.buildings.find((b) => b.id === 'TEST_bldg_L').rings[0].length);
  check(ring === 6, `L字建物の外形を6頂点で復元: ${ring}`);
  await page.screenshot({ path: SHOTS + 'ipad-start.png' });

  await page.click('#btn-start');
  await page.waitForTimeout(700);
  let st = await state(page);
  check(st.mode === 'window', '間取り未取得のため「窓からの眺め（推定）」で開始');
  check(await page.isVisible('#btn-action'), '「建物の外へ」ボタンを表示');
  const notices = await page.textContent('#notices');
  check(notices.includes('住戸位置は仮配置'), '「住戸位置は仮配置」を表示');
  await page.screenshot({ path: SHOTS + 'ipad-window.png' });

  await page.click('#btn-action');
  await page.waitForTimeout(700);
  st = await state(page);
  check(st.mode === 'outdoor', '屋外へ切り替え');
  check((await blockAt(page)) === null, `出口位置が安全（道路上・建物外）: (${st.pos.x.toFixed(1)}, ${st.pos.z.toFixed(1)})`);
  check((await page.textContent('#notices')).includes('地形は簡略化'), '「地形は簡略化」を表示');
  await page.screenshot({ path: SHOTS + 'ipad-outdoor.png' });

  // キーボード移動
  const p0 = (await state(page)).pos;
  await page.keyboard.down('w'); await page.waitForTimeout(1200); await page.keyboard.up('w');
  const p1 = (await state(page)).pos;
  check(Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.3, 'W キーで前進');
  check((await blockAt(page)) === null, '移動後も道路上・建物外');

  // 建物への衝突：建物 A（x 55..105）の西側の道路 x=40 から東へ押し込む
  await S(page, () => { const s = window.__app.state; s.pos.x = 40; s.pos.z = 0; s.yaw = -Math.PI / 2; });
  await page.keyboard.down('w'); await page.waitForTimeout(2500); await page.keyboard.up('w');
  st = await state(page);
  check(st.pos.x < 55 && (await blockAt(page)) === null, `建物に入れない（x=${st.pos.x.toFixed(2)} < 55）`);

  // 道路外へ出られない：道路 x=40（半幅6m）から西のブロックへ
  await S(page, () => { const s = window.__app.state; s.pos.x = 40; s.pos.z = -10; s.yaw = Math.PI / 2; });
  await page.keyboard.down('w'); await page.waitForTimeout(3000); await page.keyboard.up('w');
  st = await state(page);
  check(st.pos.x > 33.5, `確認できない場所（道路外）へ進めない（x=${st.pos.x.toFixed(2)}）`);

  // 範囲の端
  await S(page, () => { const s = window.__app.state; s.pos.x = 40; s.pos.z = -697; s.yaw = 0; });
  await page.keyboard.down('w'); await page.waitForTimeout(2500); await page.keyboard.up('w');
  st = await state(page);
  const toastTxt = await page.textContent('#toast');
  check(Math.hypot(st.pos.x, st.pos.z) <= 700 && toastTxt.includes('範囲外'), `範囲の端で停止し案内を表示（r=${Math.hypot(st.pos.x, st.pos.z).toFixed(1)}）`);

  // タッチ：移動と視点変更を同時に
  await S(page, () => window.__app.enterOutdoor());
  await page.waitForTimeout(300);
  const cdp = await ctx.newCDPSession(page);
  const a0 = await state(page);
  await touch(cdp, 'touchStart', [{ x: 200, y: 600, id: 1 }]);
  await touch(cdp, 'touchStart', [{ x: 200, y: 600, id: 1 }, { x: 900, y: 400, id: 2 }]);
  for (let i = 1; i <= 10; i++) {
    await touch(cdp, 'touchMove', [{ x: 200, y: 600 - i * 5, id: 1 }, { x: 900 + i * 12, y: 400, id: 2 }]);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  const a1 = await state(page);
  check(Math.hypot(a1.pos.x - a0.pos.x, a1.pos.z - a0.pos.z) > 0.2, '左スティックで移動');
  check(Math.abs(a1.yaw - a0.yaw) > 0.2, '右ドラッグで視点変更（同時操作）');
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(150);
  const a2 = (await state(page)).pos;
  await page.waitForTimeout(500);
  const a3 = (await state(page)).pos;
  check(Math.hypot(a3.x - a2.x, a3.z - a2.z) < 0.01, '指を離すと停止');
  // 操作中のフォーカス喪失（タブ切り替え相当）で停止
  await touch(cdp, 'touchStart', [{ x: 200, y: 600, id: 3 }]);
  await touch(cdp, 'touchMove', [{ x: 200, y: 540, id: 3 }]);
  await page.waitForTimeout(200);
  await S(page, () => window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(100);
  const b1 = (await state(page)).pos;
  await page.waitForTimeout(500);
  const b2 = (await state(page)).pos;
  check(Math.hypot(b2.x - b1.x, b2.z - b1.z) < 0.01, 'フォーカス喪失（別タブ等）で停止');
  await touch(cdp, 'touchCancel', []);
  const scrollY = await S(page, () => window.scrollY + document.documentElement.scrollTop);
  check(scrollY === 0, '操作中にページがスクロールしない');

  // 施設の絞り込みと目的地
  await page.click('#btn-poi');
  await page.click('[data-f="convenience"]');
  const names = await page.$$eval('.poi-list .nm', (els) => els.map((e) => e.textContent));
  check(names.length === 1 && names[0] === 'テスト用コンビニ', `絞り込み「コンビニ」: ${names.join(',')}`);
  const vis = await S(page, () => window.__app.state.data.pois.length);
  void vis;
  await page.click('[data-f="supermarket"]');
  await page.click('.poi-list button');
  const detail = await page.textContent('#panel-body');
  check(detail.includes('入口') && detail.includes('OpenStreetMap'), '詳細に入口・情報源を表示');
  check(detail.includes('営業時間') && detail.includes('未取得'), '営業時間が未登録なら「未取得」');
  check(detail.includes('約') && detail.includes('分'), '道路経路を計算できた場合に徒歩距離・時間を表示');
  await page.click('#poi-dest');
  await page.waitForTimeout(400);
  st = await state(page);
  check(st.dest === 'way/' + (await S(page, () => window.__app.state.dest.id.split('/')[1])), '目的地を設定');
  const hud = await page.textContent('#dest-hud');
  check(hud.includes('直線距離') && hud.includes('道路経路'), `方向表示に「直線距離」と道路経路を明記: ${hud.replace(/\s+/g, ' ')}`);
  await page.click('#btn-poi');
  await page.click('[data-f="all"]');
  await page.click('.poi-list button >> text=テスト用コンビニ');
  const d2 = await page.textContent('#panel-body');
  check(d2.includes('入口位置未確認'), '入口が不明な施設は「入口位置未確認」');
  check(d2.includes('24/7') && d2.includes('OSM登録値'), 'OSMの営業時間は登録値として表示');
  await page.click('#panel-close');

  // ミニマップと3Dの方向の一致：北を向いたとき、東の施設は両方で右側
  const dir = await S(page, () => {
    const app = window.__app, s = app.state;
    s.pos.x = 40; s.pos.z = 0; s.yaw = 0; s.pitch = 0;
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const cam = app.camera;
      const fwd = cam.getWorldDirection(new cam.position.constructor());
      const p = new cam.position.constructor(400, 5, -300).project(cam); // 北東
      res({ fwd: [fwd.x, fwd.z], px: p.x });
    })));
  });
  check(Math.abs(dir.fwd[0]) < 0.01 && dir.fwd[1] < -0.99, 'yaw=0 で3Dカメラは北（-z）を向く＝ミニマップ上向き');
  check(dir.px > 0, '北東の地点は3Dで画面右側（ミニマップでも右上）');
  await page.screenshot({ path: SHOTS + 'ipad-dest.png' });
  await page.click('#minimap');
  await page.waitForTimeout(200);
  await page.screenshot({ path: SHOTS + 'ipad-bigmap.png' });
  await page.click('#minimap', { position: { x: 5, y: 5 } });

  // 部屋へ戻る・リセット
  await page.click('#btn-room');
  await page.waitForTimeout(700);
  check((await state(page)).mode === 'window', '屋外から「部屋へ戻る」');
  await page.click('#btn-action');
  await page.waitForTimeout(700);
  await page.keyboard.down('w'); await page.waitForTimeout(800); await page.keyboard.up('w');
  await page.click('#btn-reset');
  const ent = await S(page, () => window.__app.state.entrance);
  st = await state(page);
  check(Math.hypot(st.pos.x - ent.x, st.pos.z - ent.z) < 0.01, '位置をリセットで入口位置へ');
  await page.click('#btn-data');
  const dataTxt = await page.textContent('#panel-body');
  check(dataTxt.includes('PLATEAU') && dataTxt.includes('OpenStreetMap') && dataTxt.includes('取得日'), '出典と取得日を表示');
  await page.screenshot({ path: SHOTS + 'ipad-data.png' });
  check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------- 2. iPhone 縦：UI の重なり ----------
console.log('\n[2] iPhone 縦画面：UI の重なり');
{
  const { ctx, page, errors } = await newPage(browser, iPhone);
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  await page.screenshot({ path: SHOTS + 'iphone-start.png' });
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  await page.click('#btn-action');
  await page.waitForTimeout(600);
  await S(page, () => window.__app.setDest(window.__app.state.data.pois.find((p) => p.cat === 'station')));
  await page.waitForTimeout(400);
  const box = async (sel) => (await page.$(sel))?.boundingBox();
  const ids = ['.title', '.tools', '#notices', '#minimap', '#dest-hud', '#bottombar'];
  const boxes = {};
  for (const id of ids) boxes[id] = await box(id);
  let ok = true;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (overlaps(boxes[ids[i]], boxes[ids[j]])) { ok = false; console.log('    重なり:', ids[i], ids[j]); }
  }
  check(ok, 'iPhone 縦で主要UIが重ならない');
  const inside = Object.values(boxes).every((b) => b && b.x >= 0 && b.x + b.width <= 390 && b.y >= 0 && b.y + b.height <= 844);
  check(inside, 'UI が画面内に収まる');
  await page.screenshot({ path: SHOTS + 'iphone-outdoor.png' });
  await page.click('#btn-poi');
  await page.waitForTimeout(200);
  await page.screenshot({ path: SHOTS + 'iphone-poi.png' });
  await page.click('#panel-close');
  // 横向き
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(400);
  const boxes2 = {};
  for (const id of ids) boxes2[id] = await box(id);
  let ok2 = true;
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (overlaps(boxes2[ids[i]], boxes2[ids[j]])) { ok2 = false; console.log('    重なり:', ids[i], ids[j]); }
  }
  check(ok2, 'iPhone 横で主要UIが重ならない');
  await page.screenshot({ path: SHOTS + 'iphone-landscape.png' });
  check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------- 3. 室内エンジン（テスト用の架空間取りで検証） ----------
console.log('\n[3] 室内：壁・扉・玄関→屋外');
{
  const { ctx, page, errors } = await newPage(browser, iPad, { floorplan: true });
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  await page.click('#btn-start');
  await page.waitForTimeout(700);
  let st = await state(page);
  check(st.mode === 'indoor', '間取りデータがあれば室内から開始');
  check((await blockAt(page)) === null, '初期位置が壁に埋まらない');
  await page.waitForTimeout(200);
  check(!(await page.isVisible('#btn-action')), '玄関から離れていると「建物の外へ」は非表示');
  await page.screenshot({ path: SHOTS + 'indoor.png' });
  // 窓（外壁）に向かって歩き続けても抜けない
  await page.keyboard.down('w'); await page.waitForTimeout(3500); await page.keyboard.up('w');
  const inside = await S(page, () => { const s = window.__app.state; return s.interior.nav.blockReason(s.pos.x, s.pos.z, 0.25) === null; });
  check(inside, '窓・壁を通り抜けない');
  const r = await S(page, () => {
    const s = window.__app.state, i = s.interior, nav = i.nav;
    const w = i.toWorld;
    const at = (u, v) => { const p = w(u, v); return nav.blockReason(p[0], p[1], 0.25); };
    return { wall: at(3.0, 4.0), door: at(1.0, 4.0), room: at(2.5, 5.0), outside: at(2.5, -0.5) };
  });
  check(r.wall === 'wall', '間仕切り壁の位置は通れない');
  check(r.door === null, '扉の位置は通れる');
  check(r.outside === 'wall', '住戸の外（窓の外）には出られない');
  // 扉を通って玄関へ歩く: (1.0, 3.0) → (1.0, 5.5)
  await S(page, () => { const s = window.__app.state, p = s.interior.toWorld(1.0, 3.0), q = s.interior.toWorld(1.0, 5.5); s.pos.x = p[0]; s.pos.z = p[1]; s.yaw = Math.atan2(-(q[0] - p[0]), -(q[1] - p[1])); });
  await page.keyboard.down('w'); await page.waitForTimeout(2200); await page.keyboard.up('w');
  const passed = await S(page, () => { const s = window.__app.state, a = s.interior.toWorld(1.0, 4.0), b = s.interior.toWorld(1.0, 3.0); const dir = [a[0] - b[0], a[1] - b[1]]; return (s.pos.x - a[0]) * dir[0] + (s.pos.z - a[1]) * dir[1] > 0.5; });
  check(passed, '扉を通って隣の部屋へ歩ける');
  await S(page, () => { const s = window.__app.state, p = s.interior.toWorld(0.9, 6.3); s.pos.x = p[0]; s.pos.z = p[1]; });
  await page.waitForTimeout(200);
  check(await page.isVisible('#btn-action'), '玄関に近づくと「建物の外へ」を表示');
  // 家具の表示切替
  await page.click('#btn-settings');
  await page.click('[data-seg="furniture"] [data-v="false"]');
  const fOff = await S(page, () => window.__app.state.interior.nav.walls.some((w) => w.furniture));
  check(!fOff, '家具を非表示にすると家具の当たり判定も外れる');
  await page.click('[data-seg="furniture"] [data-v="true"]');
  await page.click('#panel-close');
  await page.click('#btn-action');
  await page.waitForTimeout(700);
  st = await state(page);
  check(st.mode === 'outdoor' && (await blockAt(page)) === null, '室内→屋外（埋まらない位置）');
  await page.click('#btn-room');
  await page.waitForTimeout(700);
  check((await state(page)).mode === 'indoor' && (await blockAt(page)) === null, '屋外→室内に戻れる');
  check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------- 4. 取得失敗と再試行 ----------
console.log('\n[4] 取得失敗→再試行');
{
  const { ctx, page } = await newPage(browser, iPad, { overpassFailTimes: 1 });
  await page.waitForSelector('#load-error:not([hidden])', { timeout: 30000 });
  check((await page.textContent('#load-error-text')).includes('取得できませんでした'), '取得失敗を表示');
  await page.screenshot({ path: SHOTS + 'error.png' });
  await page.click('#btn-retry');
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  check(true, '再試行で読み込み成功');
  // 2回目はキャッシュから（通信しない）
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  check((await page.textContent('#load-text')).includes('端末に保存済み'), '2回目以降は端末内キャッシュを使用');
  await ctx.close();
}

// ---------- 6. 同梱データ（tools/export-area.mjs と同じ経路） ----------
console.log('\n[6] 書き出しモードと同梱データ');
{
  const ctx = await browser.newContext(iPad);
  const page = await ctx.newPage();
  await setupRoutes(page);
  await page.goto(BASE + '?export=1');
  await page.waitForFunction(() => window.__exportResult, null, { timeout: 30000 });
  const r = await page.evaluate(() => window.__exportResult);
  check(r.ok && r.data.buildings.length === 3, '書き出しモードで area.json 相当のデータを生成');
  await ctx.close();
  const ctx2 = await browser.newContext(iPad);
  const p2 = await ctx2.newPage();
  let net = 0;
  await p2.route('**/*', (route) => {
    const u = route.request().url();
    if (u.includes('/data/manifest.json')) return route.fulfill({ body: JSON.stringify({ bundled: true }), contentType: 'application/json' });
    if (u.includes('/data/area.json')) return route.fulfill({ body: JSON.stringify(r.data), contentType: 'application/json' });
    if (u.startsWith(BASE)) return route.continue();
    net++;
    return route.abort();
  });
  await p2.goto(BASE);
  await p2.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  check((await p2.textContent('#load-text')).includes('同梱データ') && net === 0, '同梱データがあれば外部APIに問い合わせない');
  await ctx2.close();
}

// ---------- 7. 間取りの取り込み・俯瞰・視野角・速度 ----------
console.log('\n[7] 間取りの取り込み（Claude の回答を貼り付け）・俯瞰・視野角');
{
  const { ctx, page, errors } = await newPage(browser, iPhone);
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  const fov = await S(page, () => window.__app.camera.fov);
  check(fov >= 85, `縦画面でも横方向の視野を確保（縦の視野角 ${fov.toFixed(0)}°）`);
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  check(await page.isVisible('#btn-plan'), '窓からの眺めで「間取りを取り込む」を表示');
  await page.click('#btn-plan');
  const prompt = await page.inputValue('#pi-prompt');
  check(prompt.includes('ラティエラ武蔵小杉 312号室') && prompt.includes('35.95') && prompt.includes('作り足さない'), '指示文に物件情報と「作り足さない」規則を含む');
  check((await page.getAttribute('#pi-open', 'href')) === 'https://claude.ai/new', 'Claude を開くリンク');
  // 不正な回答
  await page.fill('#pi-input', 'こちらです\n```json\n{"outline":[[0,0],[5,0],[5,7],[0,7]],"walls":[{"a":[0,0],"b":[5,0],"openings":[{"type":"door","at":4.8,"width":0.8}]}],"entrance":[9,9]}\n```');
  await page.click('#pi-check');
  const err = await page.textContent('#pi-result');
  check(err.includes('取り込めません') && err.includes('はみ出し') && err.includes('玄関の位置が外周の外'), '不正な内容は理由つきで取り込まない');
  check(!(await page.isVisible('#pi-apply')), '不正なときは作成ボタンを出さない');
  // 正しい回答（コードブロック＋前後の文章）
  const fp = JSON.parse(fx('test-floorplan.json'));
  delete fp.status; fp.dimensionStatus = { 全体寸法: 'テスト' };
  await page.fill('#pi-input', '読み取りました。\n```json\n' + JSON.stringify(fp, null, 2) + '\n```\n以上です。');
  await page.click('#pi-check');
  check(await page.isVisible('#pi-preview'), '平面図プレビューを表示');
  check((await page.textContent('#pi-result')).includes('35.00㎡'), '外周の面積を表示');
  await page.screenshot({ path: SHOTS + 'iphone-plan-import.png' });
  await page.click('#pi-apply');
  await page.waitForTimeout(800);
  let st = await state(page);
  check(st.mode === 'indoor' && (await blockAt(page)) === null, '取り込み後は室内を歩ける');
  check((await page.textContent('#notices')).includes('Claude読み取り'), '室内に「Claude読み取り（寸法推定）」を表示');
  await page.screenshot({ path: SHOTS + 'iphone-indoor-imported.png' });
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('btn-start').disabled, null, { timeout: 30000 });
  await page.click('#btn-start');
  await page.waitForTimeout(600);
  check((await state(page)).mode === 'indoor', '取り込んだ間取りは再読み込み後も残る');
  // 屋外の速度・俯瞰
  await S(page, () => window.__app.enterOutdoor());
  await page.waitForTimeout(200);
  check(await S(page, () => window.__app.settings.speedOut === 4 && window.__app.settings.speedIn === 1.3), '屋外 4m/秒・室内 1.3m/秒が初期値');
  await page.click('#btn-view');
  await page.waitForTimeout(200);
  const cam = await S(page, () => ({ y: window.__app.camera.position.y }));
  check(cam.y > 30, `俯瞰視点に切り替え（カメラ高さ ${cam.y.toFixed(0)}m）`);
  await page.screenshot({ path: SHOTS + 'iphone-bird.png' });
  await page.click('#btn-view');
  await page.waitForTimeout(200);
  check(await S(page, () => window.__app.camera.position.y < 2), '目線に戻す');
  // 削除
  await S(page, () => window.__app.enterRoom());
  await page.click('#btn-settings');
  await page.click('#s-plan');
  await page.click('#pi-delete');
  await page.waitForTimeout(600);
  check((await state(page)).mode === 'window', '取り込んだ間取りを削除すると窓からの眺めに戻る');
  check(errors.length === 0, `コンソールエラーなし ${errors.join(' | ')}`);
  await ctx.close();
}

// ---------- 5. WebGL 非対応 ----------
console.log('\n[5] WebGL 非対応');
{
  const ctx = await browser.newContext(iPad);
  await ctx.addInitScript(() => { const o = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : o.call(this, t, ...a); }; });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.waitForTimeout(500);
  check(await page.isVisible('#nowebgl'), 'WebGL が使えない場合は説明を表示');
  await ctx.close();
}

await browser.close();
console.log(`\n結果: ${passes} 件成功 / ${failures} 件失敗`);
process.exit(failures ? 1 : 0);
