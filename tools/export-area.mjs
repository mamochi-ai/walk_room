// 公開データ（OSM・PLATEAU）を対象範囲だけ取得し、data/area.json として同梱するためのスクリプト。
// アプリと同じ処理をヘッドレスブラウザ内で実行するので、表示内容と同梱データが一致する。
// 必要: Node.js 18+、Playwright（npm i -D playwright）、overpass-api.de・api.plateauview.mlit.go.jp・
//       assets.cms.plateau.reearth.io への通信。
// 使い方: node tools/export-area.mjs <緯度> <経度> [建物の階数]
//   例: node tools/export-area.mjs 35.57927 139.6556 6   （サンプル物件）
//   アプリは data/manifest.json の bundled が true で、物件位置が一致するときだけ同梱データを使う。
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(ROOT, p || 'index.html');
    if (!file.startsWith(ROOT)) throw new Error('forbidden');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
const [lat = '35.57927', lon = '139.6556', floors = ''] = process.argv.slice(2);
await page.goto(`http://localhost:${port}/index.html?export=1&lat=${lat}&lon=${lon}&floors=${floors}`);
await page.waitForFunction(() => window.__exportResult, null, { timeout: 10 * 60 * 1000 });
const r = await page.evaluate(() => window.__exportResult);
await browser.close();
server.close();
if (!r.ok) {
  console.error('取得に失敗しました:', r.error, r.cause || '', r.details || '');
  process.exit(1);
}
await writeFile(join(ROOT, 'data/area.json'), JSON.stringify(r.data));
await writeFile(join(ROOT, 'data/manifest.json'), JSON.stringify({ bundled: true, fetchedAt: r.data.fetchedAt, note: 'data/area.json を同梱中。false にすると実行時に公開APIから取得する' }, null, 2) + '\n');
const d = r.data;
console.log(`保存しました: 建物 ${d.buildings.length}棟（PLATEAU: ${d.sources.plateau.ok ? 'OK' : 'NG ' + d.sources.plateau.error}）, 道路 ${d.walk.length}本, 施設 ${d.pois.length}件, 対象敷地で除外 ${d.excludedAtTarget.length}件`);
